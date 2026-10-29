const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
var db_machine = 'machine'
var db_machine_lock = 'machine_lock'

const max_retry_time = 5;
const retry_wait_seconds = 0.5;
const max_machine_lock_seconds = 2;

// 链表还原 / 重排写库（和 Enqueue、Deplain、Embark、autoEmbark 共用同一份实现）
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT } = require('../queueChain')
// 下机后自动把等候区 1、2 号位排上机（公共模块，和 Deplain 共用）
const { autoEmbarkAfterDeplain, logTimeBeforeEmbark } = require('../autoEmbark')
// 「先上机 / 后上机」标签（embark_seq）：一起下机的人回队尾时按标签排先后
const { sortByEmbarkOrder } = require('../embarkOrder')

/* ================================================================
 * 拼机一起下机
 * ================================================================
 * 规则（2026-10 定）：
 *   · 2 座机（舞萌官机）且自己在拼机状态 → 把同机台「正在游玩 + 拼机」的队友一起下机，
 *     两个人一起回队尾，座位一次性空出来，然后按 autoEmbark 规则补位。
 *   · 单刷（is_multi = false）           → 只下自己（单刷本来就一个人，本来也没队友）
 *   · 日麻 4 座 / 桌游（-1）/ 单人机台   → 只下自己
 *
 * 下机的顺序很重要：**先把人移下去（结算 + 回队尾），再往上补人**。
 *   下机的人排在队尾，等候区的外人先上，空位还有剩才轮到他们
 *   （见 autoEmbark 的 downed_openids）。
 *   几个人一起下机时，回队尾的**先后按上机标签**（embark_seq，越小越先上机），
 *   先上机的人排在前面 —— 和他们在台上谁先坐下是一致的：
 *     3 个人全是拼机：台上 A+B（A 先上机）、等候 C，A 点下机
 *       → A、B 一起下机回队尾（队尾顺序 A、B）
 *       → C 先补上 0 号座，A 接着补上 1 号座
 *       → 台上变成 C+A「两两互拼」，B 在等候区第 1 位
 *   只有「本轮一个外人都没上机」时才不允许下机的人回到台上，
 *   否则 2 个人下机后会立刻把自己排回去，等于下机无效。
 *
 * 为什么不能无脑「把本机台所有 play_status=true 的人下机」：
 *   日麻是一桌 4 个人，彼此可能不是一组的。一个人点下机把另外 3 个陌生人也下了，
 *   属于严重误操作 —— 所以必须限定 max_player === 2 且对方也是拼机。
 *
 * 链表怎么改：
 *   旧实现用 `where({ next_id: "-1" }).update(...)` 找队尾，库里一旦有两条队尾
 *   （历史脏数据），会把多条记录同时指向同一个人，链表当场分叉、之后谁都排不对。
 *   现在统一走 queueChain：读整条链 → 内存里排出最终顺序 → 只写真的变了的 next_id。
 */

// 一键下机云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
  // 实际调用者 openid（拼机一起下机的日志按「一人一条：昵称下机了」写，
  //   不再区分「谁让谁」，这里保留给锁和后续扩展用）
  const operatorOpenid = wxContext && wxContext.OPENID ? wxContext.OPENID : openid
  // 获取参数
  const machine_id = event.params.machine_id
  const db_queue = 'queue_' + machine_id

  // 获取分布式锁（拿不到锁说明别人正在操作这台机台，直接返回即可 —— 此时锁不归我，不能释放）
  let lockRes = await acquireQueueLock({
    openid: openid,
    machine_id: machine_id
  });
  console.log("Get Lock!")
  if (!lockRes.success) {
    return {
      success: false,
      errMsg: "一键下机人数太多，下机失败，请重试...",
    }
  }

  try {
    // ============ 一、机台座位数 ============
    //   决定「一起下机」能不能成立：只有 2 座机才可能是拼机
    const machineRes = await db.collection(db_machine)
      .where({ _id: machine_id })
      .field({ max_player: true })
      .get()
    const maxPlayer = machineRes.data.length ? Number(machineRes.data[0].max_player) : 1

    // ============ 二、读整条队列，确认我在玩 ============
    const rows = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
    const chain = buildChain(rows)
    const me = chain.find(r => r.openid === openid)

    if (!me) {
      return { success: false, errMsg: "当前用户排队状态有误，请刷新页面重试" }
    }
    if (me.play_status !== true) {
      return { success: false, errMsg: "当前用户不在游玩中，请刷新页面重试" }
    }

    // ============ 三、要下机的人 ============
    //   默认只下自己；只有「2 座机 + 拼机」才把队友带上（两个人一组，一起结算、一起回队尾）
    let targets = [me]
    if (me.is_multi === true && maxPlayer === 2) {
      targets = chain.filter(r =>
        r.play_status === true && (r.openid === me.openid || r.is_multi === true)
      )
    }
    // 按上机标签下机：先上机的先下机，先下机的人回队尾时也排在前面（见第五步）
    targets = sortByEmbarkOrder(targets)
    console.log('[DeplainAll] 本次下机名单（按上机标签）：', targets.map(t => t.openid))

    // ============ 三.5、机台上就这一组人、没人排队 → 不下机 ============
    //   2 座机上只有 A、B 两个拼机的人，队列里再没别人：
    //   下机后没人能补位，座位空着也是空着，还白结算一次、白改一遍状态。
    //   这种情况什么都不做，只提示继续游玩（真想离店请点「退队」）。
    const targetSet = new Set(targets.map(t => t.openid))
    const others = chain.filter(r => !targetSet.has(r.openid))
    if (targets.length >= 2 && !others.length) {
      console.log('[DeplainAll] 机台上只有这一组人且无人排队，跳过下机')
      return {
        success: true,
        no_queue: true,
        errMsg: '当前无人排队，可以继续游玩',
        data: chain,
      }
    }

    // ============ 四、逐人计费 + 下机 ============
    const downed = []      // 正常下机 → 回队尾
    const removed = []     // 余额不足 → 直接移出队列
    let errMsg = ""
    // 一批下机的日志共用一个基准时间，再按上机先后往下递减 1 毫秒：
    //   日志页是「时间倒序」显示（queueLog 按 timestamp desc 取最新 100 条），
    //   先上机的人时间戳大 1ms，就会排在上面 —— 顺序稳定，不依赖数据库对同时间记录的顺序。
    //   显示只到秒，毫秒差看不出来。
    const logTime = new Date()
    // 日志先攒着，等第六步「自动上机」之后再一起写：
    //   日志页时间倒序，下机日志要比这一批上机日志**更晚**才显示在它们上面，
    //   读起来才是「先下机，再上机」。写在这里的话时间比上机早，顺序就反了。
    const pendingLogs = []

    for (let i = 0; i < targets.length; i++) {
      const cur_openID = targets[i].openid

      const user_res = await db.collection(db_user).where({ openid: cur_openID }).get()
      if (!user_res.data.length) {
        // 用户记录都没了：没法计费，也不该继续卡在队列里
        console.warn('[DeplainAll] 用户记录不存在，移出队列：', cur_openID)
        await db.collection(db_queue).where({ openid: cur_openID }).remove()
        removed.push(cur_openID)
        continue
      }
      const userDoc = user_res.data[0]
      const remain_total = (Number(userDoc.real_point) || 0) + (Number(userDoc.extra_point) || 0)

      // 每人单独算一次消费额：不能用发起人的 openid，否则第二个人会被按第一个人的消费额扣
      const result = await cloud.callFunction({
        name: 'queueFunctions',
        data: {
          type: "getConsumePoint",
          params: {
            openid: cur_openID
          }
        },
      })
      const remain_need = result.result.data.points
      const notEnough = (remain_need > remain_total || remain_need == -1)

      if (notEnough) {
        // 余额不足 / 信用不足：人不能继续占着座位，直接移出队列并置为「离店」
        //   （和 Deplain 的单人下机口径一致：欠费的人不留在候机队列里）
        if (cur_openID == openid) {
          errMsg = (remain_need == -1) ? "信用不好" : "余额不足"
        }
        await db.collection(db_queue).where({ openid: cur_openID }).remove()
        await db.collection(db_user).where({ openid: cur_openID }).update({
          data: { enter_state: 1 }
        })
        removed.push(cur_openID)
      } else {
        // 正常下机：先只改状态，next_id 在下面整体重算（不在这里零散改指针）
        await db.collection(db_queue).where({ openid: cur_openID }).update({
          data: {
            play_status: false,
            play_position: null,   // 不清的话下一个人会看到座位号串位
            // 拼机 / 单刷保持不动：下机不改用户自己选的拼机状态
            embark_seq: 0,          // 上机标签作废（下次上机重新领号）
            embark_time: null
          }
        })
        await db.collection(db_user).where({ openid: cur_openID }).update({
          data: { enter_state: 2 }
        })
        downed.push(cur_openID)
      }

      // 写队列日志：**一人一条**「[时间] 昵称下机了」
      //   拼机两人一起下机，是「两个人各自下机」，不是「谁让谁下机」，
      //   所以不写「A让B下机了」——日志里两条都是「昵称下机了」。
      //   （店员把占座的人请下去叫「强制下机」，那个才是「让」，在 ForceDeplain 里写）
      const bjNow = new Date(logTime.getTime() + 8 * 3600 * 1000)
      const timeStr = pad2(bjNow.getHours()) + ":" + pad2(bjNow.getMinutes()) + ":" + pad2(bjNow.getSeconds())
      let content = "[" + timeStr + "] " + (userDoc.nickname || '未知用户') + "下机了"
      if (notEnough) {
        content = content + "（余额不足，已移出队列）"
      }
      // 先攒着，第六步之后统一写（那时才知道自动上机那批日志用的时间）
      pendingLogs.push({ openid: cur_openID, content })
    }

    // ============ 五、重排链表：下机的人追加到队尾，先后按上机标签 ============
    //   先重新读一次（循环里已经删掉/改过记录），再整体重算 next_id。
    //   这样不管同时下几个人，链表都还是完整的一条单链。
    //
    //   队尾这俩人谁先谁后，用**上机标签**（embark_seq，越小越先上机），不用链表顺序：
    //     · 链表顺序是排队顺序，和上机顺序本来就可能错开（跳过单刷补位、手动上机拖座位）；
    //     · 用户要的是「先上机的人回队尾也排在前面」，和自己的上机先后对得上。
    //   downed 是在第四步按 targets 顺序 push 的，而 targets 已经按标签排好序，
    //   所以 downed 的顺序就是标签顺序，直接拿它当队尾顺序。
    //   ⚠️ embark_seq 在第四步已经被清 0，不能再读库里的标签来排，必须用这个快照顺序。
    {
      const rowsAfter = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
      const chainAfter = buildChain(rowsAfter)
      const downSet = new Set(downed)
      const rest = chainAfter.filter(r => !downSet.has(r.openid))
      const tail = downed
        .map(id => chainAfter.find(r => r.openid === id))
        .filter(Boolean)
      await rewriteChain(db, db_queue, rest.concat(tail))
    }

    // ============ 六、下机后自动上机 ============
    //   一组人全部下机后座位一次性空出来，按规则把人排上去：
    //   · 1 号位单刷 → 只上 1 个；1、2 号位拼机 → 两个一起上；
    //   · 2 号位单刷 → 只上 1 号位（不硬拼）。
    //   刚下机的人全部排除，否则空机器时他们会被自己排回去。
    const autoRes = await autoEmbarkAfterDeplain({
      machine_id: machine_id,
      // 正常下机的人已经排到队尾：外人先上，空位还有剩就按队列顺序把他们补回来
      //   （余额不足被移出队列的人不在 downed 里，不会被补回去）
      downed_openids: downed
    })
    console.log("自动上机结果:", autoRes)

    // ============ 六点五、写下机日志 ============
    //   基准时间取「这一批自动上机日志之前」（logTimeBeforeEmbark）：
    //   日志页时间倒序，下机日志才会显示在上机**下面** = 先下机、再上机。
    //   同批内按「越上面越晚」排：pendingLogs 按上机先后（targets 已 sortByEmbarkOrder，
    //   先上机的人在前），所以先上机的人动作更早、该在下面（时间戳小），
    //   后上机的人更晚、在上面（时间戳大）。第 i 个人用 baseTime - (n-1-i)，
    //   整批占用 [baseTime-(n-1), baseTime]，最大值 baseTime 不变，仍压在自动上机日志下面。
    if (pendingLogs.length) {
      const baseTime = logTimeBeforeEmbark(autoRes).getTime()
      const cnt = pendingLogs.length
      for (let i = 0; i < pendingLogs.length; i++) {
        await db.collection('queue_log_' + machine_id).add({
          data: {
            timestamp: new Date(baseTime - (cnt - 1 - i)),
            openid: pendingLogs[i].openid,
            log_info: pendingLogs[i].content
          }
        }).catch(e => console.error('[DeplainAll] 写日志失败', e))
      }
    }

    // ============ 七、返回最新的排队情况 ============
    return await buildQueueResult(db, db_queue, errMsg)
  } catch (e) {
    console.error('[DeplainAll] 异常：', e)
    return {
      success: false,
      errMsg: (e && e.message) ? e.message : '下机失败，请重试'
    }
  } finally {
    // 无论成功、失败还是中途 return，锁一定要还回去
    await releaseQueueLock({
      openid: openid,
      machine_id: machine_id
    })
  }
};

// 读队列 + 补用户信息 + 按链表排序（返回结构和 Deplain 保持一致）
async function buildQueueResult(db, db_queue, errMsg) {
  const queue_record = await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()
  const rows = queue_record.data

  // 批量补用户信息（原实现是 for 循环里一人一次查询，20 个人就是 20 次往返）
  const qOpenids = rows.map(q => q.openid).filter(Boolean)
  const qUserMap = {}
  if (qOpenids.length > 0) {
    const chunks = []
    for (let ci = 0; ci < qOpenids.length; ci += 100) chunks.push(qOpenids.slice(ci, ci + 100))
    for (const chunk of chunks) {
      const ur = await db.collection(db_user).where({
        openid: db.command.in(chunk)
      }).field({ openid: true, avatar: true, nickname: true }).get()
      ur.data.forEach(u => { qUserMap[u.openid] = u })
    }
  }
  rows.forEach(q => { q.user_info = qUserMap[q.openid] || null })

  const sortedQ = buildChain(rows)
  return {
    success: errMsg === "",
    data: sortedQ,
    errMsg: errMsg
  }
}

// 分布式锁获取函数
async function acquireQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
  // var db_machine_lock = 'machine_lock_' + machine_id;
  let updated = 0;
  // 重试流程
  for (var retry_time = 1; retry_time <= max_retry_time; retry_time++) {
    // 查询分布式锁当前状况
    console.log(db_machine_lock)
    let machine_lock_record = await db.collection(db_machine_lock)
      .where({
        machine_id: machine_id,
      })
      .field({
        openid: true,
        release_time: true
      })
      .get({
        success: function (res) {
          console.log('query machine lock success!!!');
          return res;
        },
        fail: console.error
      });

    // 如果锁不存在，报错
    if (machine_lock_record != null && machine_lock_record.data.length == 0) {
      console.log("该机器分布式锁不存在");
      return {
        success: false,
        errMsg: "该机器分布式锁不存在，请联系管理员！"
      };
    }

    const old_openid = machine_lock_record.data[0].openid;
    const old_release_time = machine_lock_record.data[0].release_time;
    // 锁被其他占有，重试
    const release_time = new Date();
    if (old_openid != openid && release_time < old_release_time) {
      console.log("machine lock retry time: " + retry_time);
      await sleep(retry_wait_seconds);
      continue;
    }

    // CAS尝试获取分布式锁
    release_time.setSeconds(release_time.getSeconds() + max_machine_lock_seconds);
    await db.collection(db_machine_lock)
      .where({
        machine_id: machine_id,
        openid: old_openid,
        release_time: old_release_time
      })
      .update({
        data: {
          openid: openid,
          release_time: release_time
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })

    // 上锁成功
    if (updated != 0) {
      console.log("上锁成功");
      return {
        success: true
      }
    }

    // 重试
    console.log("machine lock retry time: " + retry_time);
    await sleep(retry_wait_seconds);
  }

  // 上锁失败
  console.log("上锁失败");
  return {
    success: false
  }
}

async function releaseQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
  // var db_machine_lock = 'machine_lock_' + machine_id;
  await db.collection(db_machine_lock)
    .where({
      machine_id: machine_id,
      openid: openid
    })
    .update({
      data: {
        release_time: new Date(0)
      }
    })
    .then(res => {
      console.log(res);
    });
  console.log("释放锁成功");
}

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// 时间补零。原来的文件里用了 pad2 却没定义 —— 一键下机走到写日志那一步会直接
// 抛 "pad2 is not defined"，整个函数 500。补上之后一键下机才真的能用。
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}
