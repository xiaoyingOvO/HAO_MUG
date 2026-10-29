/**
 * 上机先后的判断口径 + 「切换为单刷」确认文案
 * ================================================================
 * 切成单刷会改变机台上谁能坐：**先上机的人留在台上，后上机的人让位**。
 * 于是同一个按钮，在不同位置点，后果完全相反，文案必须跟着变：
 *   · 我是先上机的 → 把后上机的人移到队首，我继续单刷独占这台机台；
 *   · 我是后上机的 → 我自己被移到队首，我的座位由等候区的拼机玩家补上。
 * 弹窗说一套、云端（queueFunctions/switchMulti）做另一套是最容易挨骂的 bug，
 * 所以判断口径和云端 embarkOrder.js 一模一样：
 *   上机时云端写一个递增的 embark_seq，它就是「上机先后」的权威值（越小越先上机）；
 *   老数据的毫秒时间戳算「最早」；没标签时分不出先后，按链序（= 上机的先后）算。
 *
 * 同一个值也用来排游玩区的顺序（sortByEmbarkOrder）：先上机的排在最上面。
 */

// 超过这个值的一定不是序号，而是早期写的毫秒时间戳（和云端 embarkOrder.js 同一个阈值）
const SEQ_LIMIT = 1e9

// 三档（越小越先上机）：0 = 早期毫秒时间戳（上线前上机的，比任何新序号都早）；
//   1 = 新序号；2 = 没有标签（当作最晚上机）。规则和云端 embarkOrder.js 完全一致。
const RANK_LEGACY = 0
const RANK_SEQ = 1
const RANK_NONE = 2

// 读上机标签 → { rank, value }。
//   新字段优先，老数据的 board_seq 只读不写（部署前就在台上、还没下机的人）
function seqInfo(p) {
  if (!p) return { rank: RANK_NONE, value: 0 }
  const n = Number((p.embarkSeq !== undefined && p.embarkSeq !== null) ? p.embarkSeq : NaN)
  const o = Number((p.boardSeq !== undefined && p.boardSeq !== null) ? p.boardSeq : NaN)
  const v = (n > 0 && !isNaN(n)) ? n : ((o > 0 && !isNaN(o)) ? o : 0)
  if (!v) return { rank: RANK_NONE, value: 0 }
  return v > SEQ_LIMIT ? { rank: RANK_LEGACY, value: v } : { rank: RANK_SEQ, value: v }
}

// 上机序号（越小越先上机）；不是有效序号 → null
function embarkSeqOf(p) {
  const info = seqInfo(p)
  return info.rank === RANK_SEQ ? info.value : null
}

/**
 * 比较谁先上机：<0 = a 先，>0 = b 先，0 = 分不出来。
 *
 *   ⚠️ 以前「两人都没标签」时退回**座位号**比大小，这是个坏兜底：
 *      新上机的人一定坐进空出来的低号位（A 从 0 号座下机，下一个上机的就是 0 号座），
 *      按座位号比，新人永远被当成「先上机」，真正先来的人反而成了「后上机」。
 *      现在不再看座位号：分不出来就返回 0，由调用方保持原有顺序
 *      （链序 = 队列里游玩区的先后，本来就是上机的先后）。
 */
function compareSeq(a, b) {
  const ia = seqInfo(a)
  const ib = seqInfo(b)
  if (ia.rank !== ib.rank) return ia.rank - ib.rank
  if (ia.rank === RANK_NONE) return 0
  return ia.value - ib.value
}

/**
 * a 是不是比 b 先上机。分不出先后时返回 false（不硬说自己先上机）。
 *   和云端 queueFunctions/embarkOrder.js 的判断完全一致。
 */
function isEarlier(a, b) {
  return compareSeq(a, b) < 0
}

/**
 * 我是不是「先上机的那个人」。
 * @param {Object} me            我（需要 embarkSeq / playPosition）
 * @param {Array}  playingOthers 同台的其他玩家
 */
function isFirstOnMachine(me, playingOthers) {
  const others = playingOthers || []
  if (!others.length) return true
  return others.every(o => isEarlier(me, o))
}

/**
 * 按上机先后排序：先上机的排前面（越小越前）。
 *   Array.prototype.sort 是稳定排序 —— 分不出先后（都没标签）时保持传进来的顺序，
 *   而传进来的顺序就是链序（队列里游玩区的先后），本来就是上机的先后。
 * 排卡页的游玩区、设置页的「正在游玩」列表都用它，保证「从上往下 = 先上机到后上机」。
 */
function sortByEmbarkOrder(list) {
  return (list || []).filter(Boolean).slice().sort(compareSeq)
}

/**
 * 「切换为单刷」的确认文案。
 * @param {Object} params
 * @param {Object} params.me             我
 * @param {Array}  params.playingOthers  同台的其他玩家（不含自己）
 * @param {boolean} params.isPlaying     我当前是否在游玩
 * @returns {string}
 */
function buildSwitchToSingleText(params) {
  const me = (params && params.me) || {}
  const others = ((params && params.playingOthers) || []).filter(o => o && o.openid !== me.openid)
  const isPlaying = !!(params && params.isPlaying)

  // 没上机（还在等候区）：切成单刷只是「排到自己的时候一个人玩」，不影响任何人
  if (!isPlaying) {
    return '切成单刷后，你上机时会独占这台机台，另一个座位不会排人。'
  }

  // 一个人在用这台机台
  if (!others.length) {
    return '切成单刷后，这台机台归你一个人用，另一个座位不会排人。'
  }

  const names = others.map(o => o.nickname || '同台的人').join('、')
  if (isFirstOnMachine(me, others)) {
    return `点击后会把「${names}」移到队首（等候区第 1 位），你继续以单刷独占这台机台。`
  }
  return '点击后你会被移到队首（等候区第 1 位），你的座位由一位拼机玩家补上。'
}

module.exports = {
  isEarlier,
  compareSeq,
  embarkSeqOf,
  isFirstOnMachine,
  sortByEmbarkOrder,
  buildSwitchToSingleText,
}
