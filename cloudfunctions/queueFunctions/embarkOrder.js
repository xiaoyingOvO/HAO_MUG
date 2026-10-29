/**
 * 「先上机 / 后上机」标签
 * ================================================================
 * 一个座位上的人，只要上机成功就写一个 `embark_seq`（上机顺序号，越小越早上机）。
 * **这就是标签本身**，不用再从座位号、排队顺序、时间戳去猜谁先谁后：
 *   · 上机时写入：Embark（手动上机）和 autoEmbark（下机后自动补位）都调
 *     prepareEmbarkSeq —— 它先把台上已有的标签整成 1、2、3…，再返回下一个号，
 *     所以**新上机的人一定排在台上所有人后面**，永远不会出现「刚上来的人反而先上机」。
 *   · 下机 / 让位时清 0（本次上机作废），下次上机重新领号。
 *
 * 谁在用这个标签：
 *   1. switchMulti —— 切成单刷时谁留下、谁让位（先上机的留下）；
 *   2. DeplainAll —— 拼机两人一起下机时，回队尾的先后（先上机的排在前面）；
 *   3. 设置页 / 排卡页 —— 显示「先上机 / 后上机」角标，让店员一眼看出点了会怎样。
 *
 * 为什么不能靠别的信号：
 *   · 座位号：手动上机时店员可以把人拖到任意空座，座位号跟先后无关；
 *   · 链表顺序：排队顺序，和上机顺序本来就是两回事（跳单刷补位就会错开）；
 *   · embark_time 时间戳：同一毫秒连着写两条会拿到相同的值，分不出先后。
 *
 * 字段名为什么是 embark_seq：
 *   项目里 `board` 已经是「桌游区」的区域标识（machine.area = 'board'、AREA_BOARD、
 *   board_num 桌游区人数），字段再叫 board_seq 会被当成「桌游区的序号」。
 *   上机这件事在代码里一直叫 Embark（Embark / autoEmbark / embarked 返回值），
 *   所以字段跟着叫 embark_seq，一眼就能看出是上机顺序。
 *   字段名只在这个文件里定义一次（SEQ_FIELD），写入方都用 `[SEQ_FIELD]: n`，
 *   以后再改名只改这一行常量。
 *
 * ⚠️ 前端 miniprogram/utils/multiSwitch.js 有一份同口径实现（小程序不能 require
 *    云函数目录），改这里的判断规则时两边一起改。
 * ⚠️ 这里只做纯计算，不要 cloud.init —— 被 switchMulti / DeplainAll 共同 require。
 */

// 上机顺序号现在的字段名（写入方一律引用它，不要写死字符串）
const SEQ_FIELD = 'embark_seq'

// 历史字段名。线上老数据是 board_seq（早期还是毫秒时间戳），只读不写，
// 让没下过机的老数据在部署新版后仍能判断先后。
const LEGACY_SEQ_FIELD = 'board_seq'

// 超过这个值的一定不是序号，而是早期写的毫秒时间戳
const SEQ_LIMIT = 1e9

// 标签的三档（越小越「先上机」）。**不能只比数值大小**：
//   0 = 早期版本写的毫秒时间戳（1.7e12 那种）：一定是「上机顺序号」上线之前上机的，
//       所以比任何新序号都早。直接拿它跟新序号 3、4 比大小会把老玩家判成「最后上机」；
//   1 = 新序号（1、2、3…）；
//   2 = 没有标签（还没上过机 / 已清零 / 老数据压根没写）——
//       当作「最晚上机」，而不是拿座位号去猜（见下面 isEarlier 的说明）。
const RANK_LEGACY = 0
const RANK_SEQ = 1
const RANK_NONE = 2

// 依次取第一个有值的候选项（云端用下划线，前端用驼峰）
function pick(row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = row[keys[i]]
    if (v !== undefined && v !== null) return v
  }
  return null
}

/**
 * 读上机标签 → { rank, value }。
 *   新字段优先，老字段兜底；没有标签 / 已清零 → { rank: RANK_NONE }。
 *   早期毫秒时间戳 → { rank: RANK_LEGACY, value: 时间戳 }，它之间仍能按时间先后比。
 */
function seqInfo(row) {
  if (!row) return { rank: RANK_NONE, value: 0 }
  const n = Number(pick(row, [SEQ_FIELD, 'embarkSeq']))
  const o = Number(pick(row, [LEGACY_SEQ_FIELD, 'boardSeq']))
  const v = (n > 0 && !Number.isNaN(n)) ? n : ((o > 0 && !Number.isNaN(o)) ? o : 0)
  if (!v) return { rank: RANK_NONE, value: 0 }
  return v > SEQ_LIMIT ? { rank: RANK_LEGACY, value: v } : { rank: RANK_SEQ, value: v }
}

/**
 * 读上机标签的序号值（越小越先上机）；没有可用标签时返回 null。
 *   只有 rank=SEQ 才有「序号」的意义，老时间戳不算序号。
 */
function embarkSeqOf(row) {
  const info = seqInfo(row)
  return info.rank === RANK_SEQ ? info.value : null
}

/**
 * a 是不是比 b 先上机。
 *
 *   ⚠️ 以前「两边都没有标签」时退回**座位号**兜底，这是个坏兜底：
 *      新上机的人一定坐进空出来的低号位（A 从 0 号座下机，下一个上机的就是 0 号座），
 *      按座位号比，新人永远被当成「先上机」，而真正先来的人反而成了「后上机」。
 *      所以不再看座位号：分不出来就返回 false（「我不算先上机的」）——
 *      排序时保持原顺序（链序 = 排队链上游玩区的顺序，本来就是上机的先后），
 *      切单刷时让位的是自己：宁可自己多等一轮，也不把可能先来的人顶走。
 */
function isEarlier(a, b) {
  return compareSeq(a, b) < 0
}

/**
 * 比较两个人的上机先后：<0 = a 先上机，>0 = b 先上机，0 = 分不出来。
 */
function compareSeq(a, b) {
  const ia = seqInfo(a)
  const ib = seqInfo(b)
  if (ia.rank !== ib.rank) return ia.rank - ib.rank
  if (ia.rank === RANK_NONE) return 0
  return ia.value - ib.value
}

/**
 * 按上机标签排序：先上机的在前。
 *   返回新数组，不改原数组。分不出先后的保持原顺序（V8 的 sort 是稳定排序，
 *   传进来的链序本身也就是上机的先后）。
 */
function sortByEmbarkOrder(rows) {
  return (rows || []).slice().sort(compareSeq)
}

/**
 * 给同台的人打标签：{ [openid]: 'first' | 'later' }
 *   · 只有一个人 → 他也是 'first'（先上机的就是他自己）；
 *   · 多人 → 标签最小的那个是 'first'，其余 'later'。
 *   用来在界面上显示「先上机 / 后上机」，以及校验「我是不是先上机的」。
 */
function embarkTags(playingRows) {
  const list = (playingRows || []).filter(Boolean)
  const tags = {}
  if (!list.length) return tags
  const sorted = sortByEmbarkOrder(list)
  tags[sorted[0].openid] = 'first'
  for (let i = 1; i < sorted.length; i++) tags[sorted[i].openid] = 'later'
  return tags
}

/**
 * 上机前先把台上已有的标签「整成 1、2、3…」，并返回新上机的人该用的起始序号。
 * ================================================================
 * 目的只有一个：**新上机的人一定排在台上所有人后面**（后上机 = 后领号）。
 *   台上没人 → 返回 1；
 *   台上有 2 人（1、2）→ 原样不动，返回 3；
 *   台上有老数据（毫秒时间戳 / 压根没写）→ 按「谁先上机」重排成 1、2、3…，
 *     顺手把脏数据治好，否则新上机的人拿到的是小数字，
 *     跟老时间戳一比就成了「先上机」（详见上面 RANK_LEGACY 的说明）。
 * 正常情况（序号本来就是连续的）一行都不写库。
 *
 * @param {Object} db       cloud.database()
 * @param {string} dbQueue  队列集合名 queue_<machineId>
 * @param {Array}  chain    这台机台的整条队列（已按 next_id 还原顺序）
 * @returns {Promise<number>} 新上机的人应使用的起始序号
 */
async function prepareEmbarkSeq(db, dbQueue, chain) {
  const playing = sortByEmbarkOrder((chain || []).filter(r => r.play_status === true))
  let base = 0
  for (let i = 0; i < playing.length; i++) {
    const want = i + 1
    base = want
    if (embarkSeqOf(playing[i]) !== want) {
      await db.collection(dbQueue)
        .where({ openid: playing[i].openid })
        .update({ data: { [SEQ_FIELD]: want } })
    }
  }
  return base + 1
}

module.exports = {
  SEQ_FIELD,
  LEGACY_SEQ_FIELD,
  RANK_LEGACY,
  RANK_SEQ,
  RANK_NONE,
  seqInfo,
  compareSeq,
  embarkSeqOf,
  isEarlier,
  sortByEmbarkOrder,
  embarkTags,
  prepareEmbarkSeq,
}
