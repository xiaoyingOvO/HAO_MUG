/**
 * 下机后「自动上机」（等候区 1、2 号位直接上位）
 * ================================================================
 * 业务背景：
 *   舞萌官机是 2 个座位，一组人（拼机）打完一起下机之后，
 *   原来要店员/顾客自己再去等候区把 1、2 号位拖到座位上，
 *   中间会空出一段时间没人玩。这里改成下机的同时自动把人排上去。
 *
 * 上几个人：
 *   · 拼机优先：有空座时按队列顺序找**拼机**的人，遇到单刷的人跳过继续往后找，
 *     直到把空座填满（最多 2 个）。
 *   · 机台完全空着、而整个等候区都是单刷时，才让等候区第 1 位的单刷独占上机。
 *   · 机上有人单刷 → 整台机被独占，这一轮谁都不上。
 *   · 挑选细节集中在 seatPlan.js，Embark（手动上机）用的是同一份规则，
 *     否则「自动补位」和「手动上机」会对「谁是下一位」给出不同答案。
 *
 * 上机标签（embark_seq / embark_time）：
 *   每个人上机时写一个递增的 embark_seq（队列现有最大值 +1，同一批依次 +1），
 *   它就是「先上机 / 后上机」的标签（见 embarkOrder.js）：
 *     · 切成单刷时，先上机的人留下、后上机的人让位；
 *     · 拼机两人一起下机时，先上机的排在队尾靠前。
 *   不要换成毫秒时间戳 —— 同一批上机会撞值，分不出先后。
 *
 * ⚠️ 这个文件被 Deplain / DeplainAll 共同 require（同一次部署里共享代码），
 *    不要在这里 cloud.init —— 由各入口函数初始化，这里只取 database()。
 */

const cloud = require('wx-server-sdk')
// 链表还原抽到 queueChain.js，Enqueue / Deplain / Embark 用的是同一份实现，
// 避免「自动补位」和「手动上机」对队列顺序的理解出现分歧。
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT } = require('./queueChain')
// 上机挑选规则（拼机优先、跳过单刷）—— 和 Embark 共用，避免两处口径不一致
const { planSeats } = require('./seatPlan')
// 上机标签（先上机 / 后上机）的字段名和读取口径，只定义在 embarkOrder.js 一处
const { SEQ_FIELD, prepareEmbarkSeq } = require('./embarkOrder')

// 自动上机只针对「一个或两个座位」的音游机台（舞萌官机 = 2 座）。
//   日麻（4 座一桌）和桌游（人数自由，max_player = -1）保持原样：
//   它们靠人工拖卡上机，一次自动排 4 个人上去反而容易排错座位。
const AUTO_EMBARK_MAX_PLAYER = 2

/**
 * 下机后自动把人排上机。
 *
 *   一句话：**先让人下去（回队尾），再按队首顺序往上挑人。**
 *
 * @param {Object}   params
 * @param {string}   params.machine_id        机台 ID
 * @param {string[]} [params.exclude_openids] 完全不参与本轮上机的人
 *                                            （被强制下机、被切单刷挤下来的人：他们是被请下去的，
 *                                              不能再被系统自动排回去）
 * @param {string[]} [params.downed_openids]  正常下机、已经回到队尾的人：
 *                                            正常参与挑选（他们排在队尾，轮到就上），
 *                                            但如果这一轮挑中的**全是**他们，就一个人都不上 ——
 *                                            否则 2 人机台点下机后立刻又被排回去，等于没点。
 *                                            3 个人全拼机时靠这个形成 123 → 312 → 231 的轮转。
 * @returns {Promise<{success:boolean, embarked:Array, errMsg?:string}>}
 */
async function autoEmbarkAfterDeplain(params) {
  const machine_id = params && params.machine_id
  if (!machine_id) return { success: false, embarked: [], errMsg: '缺少机台 ID' }

  const excludeOpenids = new Set((params && params.exclude_openids) || [])
  const downedSet = new Set((params && params.downed_openids) || [])
  const db = cloud.database()
  const db_queue = 'queue_' + machine_id

  try {
    // ① 机台座位数
    const machineRes = await db.collection('machine')
      .where({ _id: machine_id })
      .field({ max_player: true, is_disabled: true })
      .get()
    if (!machineRes.data.length) {
      return { success: false, embarked: [], errMsg: '机台不存在' }
    }
    const machine = machineRes.data[0]
    if (machine.is_disabled) {
      return { success: true, embarked: [] }
    }
    const maxPlayer = Number(machine.max_player)
    // 座位数不是 1~2 的机台（日麻 4 座、桌游 -1）不自动上机
    if (!(maxPlayer >= 1 && maxPlayer <= AUTO_EMBARK_MAX_PLAYER)) {
      return { success: true, embarked: [] }
    }

    // ② 读整条队列，按 next_id 单链表还原顺序
    const queueRes = await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()
    const chain = buildChain(queueRes.data)
    if (!chain.length) return { success: true, embarked: [] }

    const playing = chain.filter(r => r.play_status === true)
    const waiting = chain.filter(r => r.play_status !== true && !excludeOpenids.has(r.openid))
    if (!waiting.length) return { success: true, embarked: [] }

    // ③ 挑人（规则集中写在 seatPlan.js）
    //   · 机上有人单刷 → 整台机被独占，一个都不上
    //   · 机台完全空着 → 就是排队顺序：队首是单刷就他独占上机，队首是拼机就带上后面的拼机者
    //   · 机上已经有人在玩 → 单刷的人上不来，跳过他们让拼机的人补空座
    //   刚下机的人不用特殊处理：他们已经排在队尾，队首的人天然排在他们前面。
    const plan = planSeats({ chain, maxPlayer, exclude_openids: excludeOpenids })
    let picks = plan.picks
    let seats = plan.seats
    if (!picks.length) {
      console.log('[autoEmbark] 本轮没有可上机的人：', plan.reason, '机上', playing.length, '人')
      return { success: true, embarked: [] }
    }

    // ③.5 挑中的全是刚下机的人 → 换一批：把他们也去掉再挑一次
    //   3 人全拼机：台上 1、2，等候 3；1 点下机 → 1、2 回队尾，队列变成 3、1、2
    //     → 队首是外人 3，正常挑到 3 和 1（不是「全是刚下机」）→ 台上 3、1（「12 3 → 31 2」）。
    //   需要兜底的是这两种：
    //     · 队列里只有刚下机的这几个人（两人机台；DeplainAll 入口已经先拦掉了，
    //       这里兜底单人下机）→ 换一批也挑不到人，直接不上，否则点下机等于没点；
    //     · 队首就是刚下机的人、后面还跟着单刷的人（机台空着，队首那个拼机的人被挑中）
    //       → 去掉他们再挑，让后面那个单刷的人独占上机，否则机台白白空着。
    if (picks.every(p => downedSet.has(p.openid))) {
      const skipAll = new Set([...excludeOpenids, ...downedSet])
      const plan2 = planSeats({ chain, maxPlayer, exclude_openids: skipAll })
      if (!plan2.picks.length) {
        console.log('[autoEmbark] 挑中的全是刚下机的人，本轮不补：', picks.map(p => p.openid))
        return { success: true, embarked: [] }
      }
      picks = plan2.picks
      seats = plan2.seats
    }

    // ⑥ 昵称（写日志用）
    const pickOpenids = picks.map(p => p.openid)
    const nameMap = {}
    try {
      const userRes = await db.collection('user')
        .where({ openid: db.command.in(pickOpenids) })
        .field({ openid: true, nickname: true })
        .get()
      userRes.data.forEach(u => { nameMap[u.openid] = u.nickname })
    } catch (e) {
      console.warn('[autoEmbark] 查询昵称失败，日志用 openid 前缀代替', e)
    }

    // ⑦ 逐个上机：写座位号 + 上机标签，并把入店状态改成「游玩中」
    //    起始号由 prepareEmbarkSeq 算：它先把台上已有的标签整成 1、2、3…（脏数据顺手治好），
    //    再返回「下一个号」。所以**新上机的人一定排在台上所有人后面**，
    //    不会出现「A 下机、C 补 0 号座，C 反而成了先上机」。
    //    ⚠️ 不要再用毫秒时间戳：同一毫秒内连着上机（自动补位紧跟在手动上机后面）
    //    会拿到相同或倒挂的值，「谁先上机」就判断错了（切成单刷时靠它决定谁让位）。
    const now = new Date()
    const baseSeq = await prepareEmbarkSeq(db, db_queue, chain)
    const embarked = []
    for (let i = 0; i < picks.length; i++) {
      const person = picks[i]
      const seat = seats[i]
      const seq = baseSeq + i

      await db.collection(db_queue)
        .where({ openid: person.openid })
        .update({
          data: {
            play_status: true,
            play_position: seat,
            [SEQ_FIELD]: seq,         // 上机标签（越小越先上机）
            embark_time: now,         // 上机时间
          }
        })

      await db.collection('user')
        .where({ openid: person.openid })
        .update({
          data: {
            enter_state: 3,          // 3 = 游玩中
            machine_id: machine_id,
          }
        })

      embarked.push({
        openid: person.openid,
        nickname: nameMap[person.openid] || person.openid,
        position: seat,
        embark_seq: seq,
      })
    }

    // ⑦.5 把上机的人从等候区挪到游玩区（链上顺序）
    //   链表的约定是 [游玩中的人...] + [等候的人...]。以前只会轮到队首 1、2 号位，
    //   顺序天然满足；现在会「跳过单刷的人」，被安排上机的可能是队伍中间的人，
    //   不重排就会出现「游玩中的人排在等候的人后面」，后续 Embark 按游玩人数算插入
    //   位置时会把顺序算错。
    try {
      const pickSet = new Set(pickOpenids)
      const playingOrder = chain.filter(r => r.play_status === true || pickSet.has(r.openid))
      const waitingOrder = chain.filter(r => r.play_status !== true && !pickSet.has(r.openid))
      await rewriteChain(db, db_queue, playingOrder.concat(waitingOrder))
    } catch (e) {
      console.error('[autoEmbark] 重排链表失败', e)
    }

    // ⑧ 写队列日志：谁被自动排上去了，店员在日志里能看到
    //    文案写成「名字 + 上机了（自动上机）」而不是「名字自动上机了」：
    //    日志页是按「上机」这类关键词切分「名字」和「动作」的，
    //    「自动上机了」会把「自动」切进名字里（显示成名称为「小影自动」）。
    //    时间戳：这一批共用一个基准 logBase，共 n 个人，占用 [logBase-(n-1), logBase]。
    //    日志页是「时间倒序」（时间大的在上、越上面的越晚），所以：
    //      · 先上机的人（embarked[i=0]，如队首 oyyq）动作最早，时间戳最小 → 显示在下面
    //      · 后上机的人（i=n-1）动作最晚，时间戳最大 → 显示在上面
    //    即第 i 个人用 logBase - (n-1-i)，而不是 logBase - i（后者会把先上机的压到上面，
    //    和「先上机更早、该在下」的口径相反）。
    //    ⚠️ 整批最大值 logBase 不变，logTimeBeforeEmbark 用 base-n-1 压起因日志，
    //      仍稳稳落在整批上机日志下面，调用方无需改动。
    const db_log = 'queue_log_' + machine_id
    const logBase = Date.now()
    const n = embarked.length
    for (let i = 0; i < embarked.length; i++) {
      await db.collection(db_log).add({
        data: {
          timestamp: new Date(logBase - (n - 1 - i)),
          openid: embarked[i].openid,
          log_info: '[' + bjTimeStr() + '] ' + embarked[i].nickname + '上机了（自动上机）',
        }
      }).catch(err => console.error('[autoEmbark] 写日志失败', err))
    }

    console.log('[autoEmbark] 自动上机完成', machine_id, embarked)
    return { success: true, embarked, log_time: embarked.length ? logBase : 0 }
  } catch (e) {
    // 自动上机失败不能让「下机」跟着失败 —— 下机本身已经写库完成了，
    // 这里只把错误抛给日志，人工再手工排一次即可。
    console.error('[autoEmbark] 自动上机出错：', e)
    return { success: false, embarked: [], errMsg: e && e.message ? e.message : '自动上机出错' }
  }
}

// 北京时间 HH:MM:SS（云函数跑在 UTC，统一 +8h 转北京时间再取时分秒）
function bjTimeStr() {
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000)
  return pad2(bjNow.getHours()) + ':' + pad2(bjNow.getMinutes()) + ':' + pad2(bjNow.getSeconds())
}

/**
 * 「下机 / 离开队列 / 切换」这类**因**日志该用的时间戳
 * ================================================================
 * 一次操作里的真实先后是「先下机（腾出游玩位）→ 才有人自动上机」，
 * 所以「下机 / 切换」这条的时间**比这一批上机日志都小**。
 *
 * 日志页是**时间倒序**（越上面的越晚 / 越新），于是显示出来是：
 *     上机了（自动上机）      ← 最晚发生，压在顶部
 *     下机了 / 切换为拼机      ← 最早发生，在下面
 * 从上往下读是「倒着走」，但和页面「新的在上」的规则一致。
 *
 * autoEmbark 的上机日志占 [base-(n-1), base] 这几毫秒（base = 返回的 log_time，
 * n = 这次上机的人数）。「因」日志就贴在这一批的**前 1 毫秒**：base - n - 1。
 * 不能用一个固定的「往前 50ms」——那会越过上一个操作的时间戳，
 * 让「切换为拼机」跑到别人的「加入了队列」上面去。贴着这批发就永远不会穿帮。
 *
 * 一批因日志（如「全部下机」两个人）再在这个起点上依次递减，先发生的给大一点，
 * 倒序时先发生的就排在前面。
 *
 * ⚠️ 不能直接用 new Date()：两批日志是同一个云函数里连着写的，
 *    Date.now() 往往就是同一毫秒，时间相同就退化成数据库返回顺序（不可控），
 *    表现出来就是日志顺序一会儿对、一会儿反。
 *    几毫秒的偏差页面看不出来（只显示到秒），但顺序永远是确定的。
 */
function logTimeBeforeEmbark(autoRes) {
  const base = autoRes && autoRes.log_time ? Number(autoRes.log_time) : 0
  // 这一次没人自动上机：本批里没有上机日志要避让，直接取当前时刻。
  // ⚠️ 千万别往后加偏移（以前写过 +5ms）：这条日志是在操作末尾写的，
  //    往后挪会越过下一件事的时间点，出现「上个操作的文字压在新操作上面」。
  if (!base) return new Date()
  const n = (autoRes && Array.isArray(autoRes.embarked) && autoRes.embarked.length) || 1
  return new Date(base - n - 1)
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

module.exports = { autoEmbarkAfterDeplain, logTimeBeforeEmbark, buildChain }
