/**
 * 排队链表工具
 * ================================================================
 * queue_<machineId> 集合里每个人一条记录，靠 next_id 串成单链表：
 *   · 表头 = 没有任何人把它当作 next_id 的那个人（也就是等候区第 1 位）
 *   · 队尾 = next_id 为 "-1"
 *   · 游玩中的人和排队的人在同一条链上，游玩的人固定排在链的前半段
 *
 * 为什么单独抽出来：
 *   原来 Enqueue / Deplain / Embark 各自用
 *     `where({ next_id: "-1" }).update(...)`
 *   去「找队尾 / 追加到队尾」。这条语句在脏数据下（历史遗留的两个队尾）
 *   会把多条记录同时改成指向同一个人 —— 链表直接分叉，之后谁都排不对，
 *   只能全员退队重建。这里改成：先把链读出来 → 在内存里算出新顺序 →
 *   只写「真的变了的 next_id」，和 delay/index.js 的做法保持一致。
 *
 * 关于 queue_seq（排队顺序号）：
 *   单链表 next_id 一旦在某次历史操作里被写乱（两个队尾 / 断链 / 顺序错），
 *   就没有可靠依据还原「谁该排在前面」——尤其「被请下台插到队首」的人
 *   入队时间晚、却该排最前，光看 timestamp 会判错。
 *   所以引入 queue_seq：**越小越靠前**，它是排队先后的唯一真相。
 *   · buildChain 优先按 queue_seq 排序（每个节点都写了就用它）；
 *   · 老数据没有 queue_seq 时，退回 next_id 链 + 入队时间兜底；
 *   · 每次重排链（rewriteChain）时同时把 queue_seq 写成 1、2、3…，
 *     这样脏链下次读回来也能自动恢复正确顺序。
 *
 * ⚠️ 被 Enqueue / Deplain / Embark / autoEmbark 共同 require，
 *    这里不要 cloud.init，只做纯数据运算。
 */

// 一次最多读多少条队列记录。
//   云函数里 get() 默认只返回 100 条，这里显式放大；超过这个量级的店要改成翻页。
const QUEUE_FETCH_LIMIT = 1000

// 排队顺序号字段（越小越靠前）
const SEQ_FIELD = 'queue_seq'

/**
 * 按 queue_seq（优先）→ next_id 链（兜底）还原队列顺序（头 → 尾）。
 *   老数据没有 queue_seq 时退回 next_id 链；断链 / 有环时把没走到的
 *   记录按入队时间补到队尾，至少保证「不丢人」。
 */
function buildChain(rows) {
  if (!rows || !rows.length) return []

  // ① 只要每个人都写了有效的 queue_seq，就直接按它排序（这是最可靠的真相）。
  const allSeq = rows.every(r => seqOf(r) > 0)
  if (allSeq) {
    return rows.slice().sort((a, b) => seqOf(a) - seqOf(b))
  }

  // ② 部分 / 全部没写 queue_seq（老数据）：退回 next_id 链。
  const nodeMap = new Map()
  rows.forEach(r => nodeMap.set(r.openid, r))

  // 头节点 = 没有任何人把它当作 next_id 的那个人
  //   正常情况只有一个。历史脏数据可能出现多个（两个队尾、断链），
  //   这时候必须挑一个**确定**的当表头，不能靠 get() 的返回顺序（顺序不保证）：
  //   优先「在游玩」的人（游玩区本来就在链的前段），其次入队时间早的。
  const heads = rows.filter(r => !rows.some(n => n.next_id === r.openid))
  if (!heads.length) return sortByTimestamp(rows)
  const head = heads.slice().sort((a, b) => {
    const pa = a.play_status === true ? 0 : 1
    const pb = b.play_status === true ? 0 : 1
    if (pa !== pb) return pa - pb
    return tsOf(a) - tsOf(b)
  })[0]

  const chain = []
  const seen = new Set()
  let cur = head
  while (cur && !seen.has(cur.openid)) {
    chain.push(cur)
    seen.add(cur.openid)
    if (cur.next_id === '-1') break
    cur = nodeMap.get(cur.next_id) || null
  }

  if (chain.length < rows.length) {
    const rest = sortByTimestamp(rows.filter(r => !seen.has(r.openid)))
    rest.forEach(r => chain.push(r))
  }
  return chain
}

function sortByTimestamp(rows) {
  return rows.slice().sort((a, b) => tsOf(a) - tsOf(b))
}

// 入队时间戳（毫秒）；缺失 / 非法值当 0（最老）处理
function tsOf(row) {
  const t = row && row.timestamp ? new Date(row.timestamp).getTime() : 0
  return Number.isNaN(t) ? 0 : t
}

// 排队顺序号（越小越靠前）；缺失 / 非法当 0（未写）
function seqOf(row) {
  const n = row && row[SEQ_FIELD]
  const v = Number(n)
  return (n !== undefined && n !== null && !Number.isNaN(v) && v > 0) ? v : 0
}

/**
 * 按「期望的最终顺序」算出需要写库的 next_id 变更。
 *   只包含真的变了的记录，没变的一条都不写（减少写库次数，也避免无谓的并发冲突）。
 *
 * @param {Array} order 期望顺序（头 → 尾）的节点数组
 * @returns {Array<{openid:string, next_id:string}>}
 */
function computeNextIdWrites(order) {
  const writes = []
  if (!order || !order.length) return writes
  for (let i = 0; i < order.length; i++) {
    const want = (i === order.length - 1) ? '-1' : order[i + 1].openid
    if (order[i].next_id !== want) {
      writes.push({ openid: order[i].openid, next_id: want })
    }
  }
  return writes
}

/** 把 next_id 变更逐条写回数据库 */
async function applyNextIdWrites(db, dbQueue, writes) {
  if (!writes || !writes.length) return 0
  for (let i = 0; i < writes.length; i++) {
    await db.collection(dbQueue).where({ openid: writes[i].openid }).update({
      data: { next_id: writes[i].next_id }
    })
  }
  return writes.length
}

/**
 * 按期望顺序同时写回 next_id + queue_seq（唯一真相）。
 * ================================================================
 * 这是「改链」的**唯一**正确入口：一次把 next_id 链和排队顺序号都写对，
 * 之后 buildChain 即使遇到 next_id 脏了，也能靠 queue_seq 还原正确顺序。
 *
 * @param {Object} db       cloud.database()
 * @param {string} dbQueue  集合名 queue_<machineId>
 * @param {Array}  order    期望顺序（头 → 尾）的节点数组
 * @returns {Promise<number>} 写库次数
 */
async function rewriteChain(db, dbQueue, order) {
  if (!order || !order.length) return 0
  let count = 0
  for (let i = 0; i < order.length; i++) {
    const node = order[i]
    const wantNext = (i === order.length - 1) ? '-1' : order[i + 1].openid
    const wantSeq = i + 1
    const needNext = node.next_id !== wantNext
    const needSeq = seqOf(node) !== wantSeq
    if (!needNext && !needSeq) continue
    const data = {}
    if (needNext) data.next_id = wantNext
    if (needSeq) data[SEQ_FIELD] = wantSeq
    await db.collection(dbQueue).where({ openid: node.openid }).update({ data })
    count++
  }
  return count
}

module.exports = {
  QUEUE_FETCH_LIMIT,
  SEQ_FIELD,
  buildChain,
  sortByTimestamp,
  computeNextIdWrites,
  applyNextIdWrites,
  rewriteChain,
}
