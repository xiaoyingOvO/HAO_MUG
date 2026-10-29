const cloud = require('wx-server-sdk');
// 机台分布式锁（和 Deplain / Enqueue 里那份实现一致，抽出来避免再复制一遍）
const { acquireQueueLock, releaseQueueLock } = require('../queueLock')
// 切换拼机状态可能让空位立刻能坐人（单刷 → 拼机），切完顺手补位
const { autoEmbarkAfterDeplain, logTimeBeforeEmbark } = require('../autoEmbark')
// 切成单刷时把同台的人放回等候区队尾（不结算费用）
const { kickToTail } = require('../kickToTail')
// 「谁先上机」的标签（embark_seq）判断，和 DeplainAll / 前端共用同一份口径
const { isEarlier, sortByEmbarkOrder } = require('../embarkOrder')
const { QUEUE_FETCH_LIMIT } = require('../queueChain')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';

// 切换拼机 / 单刷云函数入口
exports.main = async (event, context) => {
  const params = (event && event.params) || {}
  // 只能切「自己的」拼机状态：
  //   openid 一律取登录态（wxContext.OPENID），不再接受前端指定的别人。
  //   拼机/单刷会直接改变座位能不能坐人，让别人替你切（或者替别人切）
  //   很容易把「单刷独占」的规则搞乱，所以这里硬性拦住。
  //   旧版本前端 / 被改过的包如果传了别人的 openid，直接拒绝，不静默忽略，
  //   免得提示「切换成功」但其实切的是自己。
  const wxContext = cloud.getWXContext();
  const operatorOpenid = wxContext != null && 'OPENID' in wxContext ? wxContext.OPENID : '';
  if (params.openid && params.openid !== operatorOpenid) {
    return { success: false, errMsg: '只能切换自己的拼机状态' }
  }
  const openid = operatorOpenid || params.openid;
  const machine_id = params.machine_id;
  // 只有显式 false 才算单刷，其余（含历史缺失值）按拼机处理 —— 和前端 `is_multi !== false` 的口径一致
  const nextIsMulti = params.is_multi !== false;
  console.log('openid:', openid, 'machine_id:', machine_id, 'is_multi:', nextIsMulti);

  if (!machine_id) return { success: false, errMsg: '缺少机台 ID' }
  if (!openid) return { success: false, errMsg: '缺少用户信息，请重新登录' }

  // 改队列状态要在机台锁内做，否则和同时进行的入队/下机/调序交叉改数据
  const lockOwner = openid
  const lockRes = await acquireQueueLock({ openid: lockOwner, machine_id: machine_id })
  if (!lockRes.success) {
    return {
      success: false,
      errMsg: lockRes.errMsg || '这台机台正在被操作，请稍后重试',
    }
  }

  try {
    // 修改用户单双刷状态
    var db_queue = 'queue_' + machine_id;

    // ① 自己在不在这台机台的队列里
    let myRow = null
    try {
      const mine = await db.collection(db_queue).where({ openid: openid }).limit(1).get()
      if (!mine.data.length) {
        return {
          success: false,
          errMsg: '该用户已不在这台机台的队列中，请刷新重试',
        }
      }
      myRow = mine.data[0]
    } catch (e) {
      console.error('切换单双刷前校验失败:', e)
      return { success: false, errMsg: '切换失败，请重试' }
    }

    // ② 切成单刷 = 一个人独占整台机，机上其他人必须先让位。
    //    谁让位，按**上机标签**（embark_seq，越小越早上机）定：
    //      · 我是先上机的 → 后上机的人退回等候区第 1 位；
    //      · 我是后上机的 → 我自己退回等候区第 1 位，我的座位由等候区的拼机玩家补上。
    //        先来的人不该被后来的人顶走，所以这种情况下不是把对方赶下去，而是自己让位。
    //    让位不结算费用（人家正玩到一半，不该扣费），人也还在店里、还在这台机台的队列里。
    //    注意是第 1 位不是队尾：他是被挤下来的，不该因此排到所有人后面。
    //    多人时按标签倒着插，插完顺序才不会反（先上机的仍在前面）。
    const displaced = []
    let selfMoved = false
    if (nextIsMulti === false && myRow.play_status === true) {
      try {
        const playing = await db.collection(db_queue).where({ play_status: true }).limit(QUEUE_FETCH_LIMIT).get()
        const others = (playing.data || []).filter(r => r.openid !== openid)
        if (others.length) {
          // 我比台上所有人都早上机 → 我先来，留下；否则我自己让位
          const iAmFirst = others.every(r => isEarlier(myRow, r))
          if (iAmFirst) {
            // 后上机的人从最晚上机的开始逐个插到队首，插完顺序才是「先上机的靠前」
            const sorted = sortByEmbarkOrder(others).reverse()
            for (let i = 0; i < sorted.length; i++) {
              const kicked = await kickToTail({
                machine_id: machine_id,
                openid: sorted[i].openid,
                position: 'head',
              })
              if (kicked.success) displaced.unshift(sorted[i].openid)
              else console.error('[switchMulti] 移下机失败：', sorted[i].openid, kicked && kicked.errMsg)
            }
          } else {
            // 自己让位：退回等候区第 1 位（此时是单刷，机台还有人，自然上不去，
            //   等整台机空出来才轮到自己一个人玩）
            const kicked = await kickToTail({
              machine_id: machine_id,
              openid: openid,
              position: 'head',
            })
            if (!kicked.success) {
              return { success: false, errMsg: kicked.errMsg || '切换失败，请重试' }
            }
            selfMoved = true
          }
        }
      } catch (e) {
        console.error('[switchMulti] 移下同台的人失败：', e)
      }
    }

    // ③ 昵称（写日志用）：自己 + 被移下机的人
    const nameMap = {}
    try {
      const ids = [openid].concat(displaced)
      const userRecord = await db.collection(db_user)
        .where({ openid: db.command.in(ids) })
        .field({ openid: true, nickname: true })
        .get()
      ;(userRecord.data || []).forEach(u => { if (u.nickname) nameMap[u.openid] = u.nickname })
    } catch (e) {
      console.warn('查询用户昵称失败，使用 openid 前缀:', e)
    }
    const nickname = nameMap[openid] || String(openid).substring(0, 8)

    // ④ 写回自己的拼机 / 单刷状态
    await db.collection(db_queue)
      .where({
        openid: openid
      })
      .limit(1)
      .update({
        data: {
          is_multi: nextIsMulti
        }
      })
      .then(res => {
        console.log(res);
      })

    // ⑤ 切成拼机后，原来被「单刷独占」锁住的空位可能马上就能坐人了（比如 1 号位改拼机，
    //   2 号位一直等着）。切成单刷时自己是独占，补位自然一个人都不会排上来。
    //   补位失败不影响切换结果本身，只记日志。
    //   让位的人（不管是被请下去的队友，还是后上机让位的自己）不能在同一轮又被排回台上。
    let autoRes = { embarked: [] }
    try {
      autoRes = await autoEmbarkAfterDeplain({
        machine_id: machine_id,
        exclude_openids: selfMoved ? displaced.concat([openid]) : displaced,
      })
      if (autoRes && autoRes.embarked && autoRes.embarked.length) {
        console.log('[switchMulti] 切换后自动补位:', autoRes.embarked)
      }
    } catch (e) {
      console.error('[switchMulti] 切换后自动补位失败:', e)
    }

    // ⑥ 写队列日志：切换单双刷（只有本人操作，所以不再有「A让B」的写法）
    //    这件事要写清楚「从哪来、为什么、去哪」：
    //      · 我是后上机的，自己让位 → 「B因为切换为单刷从游玩位移至等候区首位了」
    //      · 我是先上机的，把队友请下去 → 「C因为A切换为单刷从游玩位移至等候区首位了」
    //    带上「从游玩位」才能看出这次操作是在台上发生的（否则像普通排队挪位）；
    //    人没被踢出队列，只是回到等候区最前面，所以是「移至」不是「移下机」。
    //    切成拼机不会有人被移走，仍然只写一条「昵称切换为拼机」。
    //    时间戳要按**真实先后**排：先「切换为单刷」，后「有人被移走」。
    //    日志页是时间倒序（新的在上），所以页面上看到的是「B因为A切换为单刷…」在上、
    //    「A切换为单刷」在它下面一行 —— 从上往下读正是倒着走的流程。
    var db_log = "queue_log_" + machine_id
    var now = new Date();
    var bjNow = new Date(now.getTime() + 8 * 3600 * 1000);
    var timeStr = pad2(bjNow.getHours()) + ":" + pad2(bjNow.getMinutes()) + ":" + pad2(bjNow.getSeconds());
    var switchText = nextIsMulti ? "切换为拼机" : "切换为单刷"
    // 时间基准落在那一批「自动上机」日志**之前**（日志页时间倒序：时间大的在上）：
    //   切换 / 移至首位显示在上机下面 = 先切换，后有人上机。
    // 这批日志每条都取 logBase - x（x ≥ 0），所以整批都稳稳压在上机日志下面，
    //   不会和刚才写下的「上机了」撞在同一毫秒（撞了就退化成数据库返回顺序，顺序会飘）。
    var logBase = logTimeBeforeEmbark(autoRes).getTime()
    // 自己让位时，「切换为单刷」和「从游玩位移至等候区首位」是同一件事，合成一条说清楚
    var content = selfMoved
      ? "[" + timeStr + "] " + nickname + "因为切换为单刷从游玩位移至等候区首位了"
      : "[" + timeStr + "] " + nickname + switchText
    await db.collection(db_log).add({
      data: {
        // 「切换」是因，发生在最前面 → 时间戳取这一批里最小的那个
        timestamp: new Date(logBase - displaced.length),
        openid: openid,
        log_info: content
      }
    }).catch(console.error)

    for (let i = 0; i < displaced.length; i++) {
      const who = nameMap[displaced[i]] || String(displaced[i]).substring(0, 8)
      // 是我把他请下去的：带上我的名字，店员才知道「他为什么突然回队首了」
      const why = nextIsMulti
        ? "从游玩位移至等候区首位了"
        : "因为" + nickname + "切换为单刷从游玩位移至等候区首位了"
      await db.collection(db_log).add({
        data: {
          // 「被移走」是果，发生在切换之后 → 比切换那条晚 1ms，倒序展示时排在它上面
          timestamp: new Date(logBase - i),
          openid: displaced[i],
          log_info: '[' + timeStr + '] ' + who + why,
        }
      }).catch(console.error)
    }

    return {
      success: true,
      data: {
        machine_id: machine_id,
        openid: openid,
        is_multi: nextIsMulti,
        displaced: displaced,
        // 是不是「自己让位」（后上机的人切成单刷）
        self_moved: selfMoved,
      }
    };
  } finally {
    // 无论成功失败都要放锁，否则这台机台会被卡到 2 秒锁过期
    await releaseQueueLock({ openid: lockOwner, machine_id: machine_id })
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
