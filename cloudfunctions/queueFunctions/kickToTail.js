/**
 * 把一个人从游玩位放回等候区（**不结算费用**）
 * ================================================================
 * 用在两处：
 *   1. ForceDeplain —— 店员强制下机 → 回到**队尾**（params.position = 'tail'）
 *   2. switchMulti  —— 某人切成单刷时，同台的人让位 → 回到**等候区第 1 位**
 *      （params.position = 'head'，店员要求：他是被挤下来的，不该排到最后面去）
 *
 * 为什么两处要共用：
 *   两边都要做「摘链 → 插回等候区 → 整体重算 next_id → 清游玩字段 → enter_state=2」，
 *   复制两遍的话，以后改队列规则必然漏掉一份。
 *   注意：插回的位置只由 position（队首 / 队尾）决定，这里不按上机标签排 ——
 *   embark_seq 是「谁先上机」的标签（见 embarkOrder.js），只影响切单刷时谁让位、
 *   拼机一起下机时回队尾的先后，和「被挤下机的人插在哪」没关系。
 *
 * ⚠️ 调用方必须已经持有 machine_lock，并且负责后面的补位（autoEmbarkAfterDeplain）。
 *    这里只改数据，不补位、不加锁、不结算。
 */
const cloud = require('wx-server-sdk')
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT } = require('./queueChain')

/**
 * @param {Object} params
 * @param {string} params.machine_id 机台 ID
 * @param {string} params.openid     要被移下机的人
 * @param {string} [params.position] 'head' = 插到等候区第 1 位；'tail' = 排到队尾（默认，
 *                                   和 ForceDeplain 原来的「回队尾」语义一致）
 * @returns {Promise<{success:boolean, errMsg?:string}>}
 */
async function kickToTail(params) {
  const machine_id = params && params.machine_id
  const openid = params && params.openid
  const position = (params && params.position) === 'head' ? 'head' : 'tail'
  if (!machine_id || !openid) return { success: false, errMsg: '缺少机台或用户参数' }

  const db = cloud.database()
  const dbQueue = 'queue_' + machine_id

  try {
    // ① 必须真的在游玩（并发下可能已经被别人请下来了）
    const rows = (await db.collection(dbQueue).limit(QUEUE_FETCH_LIMIT).get()).data
    const chain = buildChain(rows)
    const node = chain.find(r => r.openid === openid)
    if (!node) return { success: false, errMsg: '该用户不在队列中' }
    if (node.play_status !== true) return { success: false, errMsg: '该用户当前不在游玩状态' }

    // ② 摘链 → 插回等候区 → 整体重算
    //    链上顺序 = [游玩中的人...] + [等候的人...]：
    //      'head' → 插在「其余游玩者」之后，正好是等候区第 1 位
    //      'tail' → 直接追加到最后
    //    不能只改前驱/后继（漏改一条链表就断了），也不按 embark_seq 排 ——
    //    被挤下机的人排哪儿由 position 决定，跟他的上机先后无关。
    const rest = chain.filter(r => r.openid !== openid)
    const newOrder = position === 'tail'
      ? rest.concat([node])
      : rest.filter(r => r.play_status === true)
        .concat([node])
        .concat(rest.filter(r => r.play_status !== true))
    await rewriteChain(db, dbQueue, newOrder)

    // ③ 清游玩字段。**is_multi 保持不动** —— 被挤下机 / 被强制下机不等于放弃单刷，
    //   切成单刷的人回到等候区仍然是单刷（switchMulti 会在后面写它自己选的目标状态）。
    await db.collection(dbQueue).where({ openid: openid }).update({
      data: {
        play_status: false,
        play_position: null,
        embark_seq: 0,
        embark_time: null,
      }
    })

    // ④ 人还在店里、还排在这台机台的队列里
    await db.collection('user').where({ openid: openid }).update({
      data: { enter_state: 2 }
    })

    return { success: true }
  } catch (e) {
    console.error('[kickToTail] 失败：', e)
    return { success: false, errMsg: '移下机失败，请重试' }
  }
}

module.exports = { kickToTail }
