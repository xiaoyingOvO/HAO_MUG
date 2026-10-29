/**
 * 上机挑选规则（座位数 ≤ 2 的机台）
 * ================================================================
 * 一句话：**机台空着按队首顺序上；机台上已经有人在玩，才把单刷的人跳过去。**
 *
 * 为什么要有这个文件：
 *   以前 autoEmbark 只认「等候区 1、2 号位」，1 号位是单刷就整轮不上人（后面拼机的人
 *   也跟着干等），1 号位拼机才带 2 号位一起上。实际店里会出现这种卡壳：
 *     机上 A 在拼机（还有 1 个空座），等候区是 [B 单刷, C 拼机]
 *     → 旧逻辑：B 单刷不能跟 A 拼，又不能跳过 B 安排 C，结果座位一直空着。
 *   现在的规则（店员确认过的）：
 *     ① 机台上有人单刷 → 整台机被独占，谁都别上。
 *     ② **机台完全空着 → 就是排队顺序**：队首是单刷，他自己独占上机（空机台正好够他
 *        一个人玩）；队首是拼机，就带上后面拼机的人凑满座位。
 *        这一步不能因为「后面有拼机的人」把队首的单刷跳过去 —— 那不叫优先，那叫插队，
 *        而且刚下机的人还排在队尾时，会出现「下机的人立刻又被排回台上、队首的单刷
 *        永远上不去」。
 *     ③ 机台上已经有人在玩 → 单刷的人上不来（他要独占整台机），跳过他们继续往后找
 *        拼机的人补空座，直到座位填满或队列扫完。
 *     ④ 机上有人、等候区又全是单刷 → 这一轮谁都不上（单刷要等整台机空出来）。
 *
 *   举例（2 座机台，T 表示拼机、S 表示单刷）：
 *     机上空，等候 [A(S), B(T), C(T)]     → 上 A（队首单刷独占，B、C 等下一轮）
 *     机上空，等候 [A(S), B(S)]           → 上 A（队首单刷独占）
 *     机上空，等候 [A(T), B(S), C(T)]     → 上 A、C（跳过单刷的 B）
 *     机上 A(T)，等候 [B(S), C(T)]        → 上 C（B 单刷跟 A 拼不了，跳过 B）
 *     机上 A(T)，等候 [B(S), C(S)]        → 谁都不上（单刷要等整台空）
 *
 * ⚠️ 被 autoEmbark / Embark 共同 require，这里只做纯计算，不要 cloud.init。
 */

// 一轮最多安排几个人上机（对应 2 座机台的 1、2 号位）
const MAX_PICK = 2

/**
 * 算出这一轮该让谁上机。
 *
 * @param {Object}   params
 * @param {Array}    params.chain            整条队列（buildChain 的结果，游玩的人在前）
 * @param {number}   params.maxPlayer        机台座位数
 * @param {Array}    params.exclude_openids  这些人不参与（被强制下机、被挤下机的人，
 * @returns {{picks:Array, seats:number[], reason:string, freeSeats:number[]}}
 *          picks 已按「先上机的在前」排好，seats 与之一一对应
 */
function planSeats(params) {
  const chain = (params && params.chain) || []
  const maxPlayer = Number(params && params.maxPlayer)
  const rawExclude = params && params.exclude_openids
  const exclude = rawExclude instanceof Set ? rawExclude : new Set(rawExclude || [])

  const playing = chain.filter(r => r.play_status === true)
  const waiting = chain.filter(r => r.play_status !== true && !exclude.has(r.openid))

  // ① 机上有人单刷 → 整台机被独占，空座也算锁住
  if (playing.some(r => r.is_multi === false)) {
    return { picks: [], seats: [], freeSeats: [], reason: 'single_locked' }
  }

  // ② 可用座位（跳过已被占用的座位号）
  const usedSeats = new Set()
  playing.forEach(r => {
    const p = Number(r.play_position)
    if (r.play_position !== null && r.play_position !== undefined && !Number.isNaN(p)) {
      usedSeats.add(p)
    }
  })
  const freeSeats = []
  const seatCount = maxPlayer > 0 ? maxPlayer : 0
  for (let i = 0; i < seatCount; i++) {
    if (!usedSeats.has(i)) freeSeats.push(i)
  }
  if (!freeSeats.length || !waiting.length) {
    return { picks: [], seats: [], freeSeats, reason: freeSeats.length ? 'no_waiting' : 'full' }
  }

  const capacity = Math.min(freeSeats.length, MAX_PICK)

  // ③ 机台完全空着 → 就是排队顺序，不跳过任何人
  //   队首是单刷：让他一个人独占整台机（空机台正好满足「一个人玩」），后面的拼机者等
  //     他下机。不能因为后面有拼机的人就把队首的单刷跳过去，否则会出现：
  //     台上 A、B 打完下机回队尾，等候区的 C 是单刷 → 又把 A、B 排回台上，C 永远上不去。
  //   队首是拼机：带上后面拼机的人凑满座位（遇到单刷的人跳过，等他单独上）。
  if (playing.length === 0) {
    const head = waiting[0]
    if (head.is_multi === false) {
      return { picks: [head], seats: [freeSeats[0]], freeSeats, reason: 'single_alone' }
    }
    const headPicks = waiting.filter(r => r.is_multi !== false).slice(0, capacity)
    return {
      picks: headPicks,
      seats: headPicks.map((r, i) => freeSeats[i]),
      freeSeats,
      reason: 'head_first',
    }
  }

  // ④ 机台上已经有人在玩 → 单刷的人上不来（他要独占整台机），
  //    跳过他们继续往后找拼机的人补空座。
  const multiPicks = waiting.filter(r => r.is_multi !== false).slice(0, capacity)
  if (multiPicks.length) {
    return {
      picks: multiPicks,
      seats: multiPicks.map((r, i) => freeSeats[i]),
      freeSeats,
      reason: 'multi_first',
    }
  }

  // ⑤ 机上有人在玩，等候区又全是单刷 → 这一轮谁都不上（单刷要等整台空）
  return { picks: [], seats: [], freeSeats, reason: 'wait_single' }
}

/**
 * 「我」前面还有几个**挡路的人**（Embark 校验插队时用）。
 *   · 机台完全空着 → 队首优先，前面每一个人都挡路（哪怕他是单刷）；
 *   · 机台上已经有人在玩 → 单刷的人反正上不去，不算挡路，只有拼机的人挡。
 *   口径必须和 planSeats 一致，否则会出现「界面说轮到我了，点上去又说前面有人排队」。
 */
function countBlockersAhead(chain, openid) {
  const playing = chain.filter(r => r.play_status === true)
  const waiting = chain.filter(r => r.play_status !== true)
  const idx = waiting.findIndex(r => r.openid === openid)
  if (idx <= 0) return 0
  const ahead = waiting.slice(0, idx)
  if (playing.length === 0) return ahead.length
  return ahead.filter(r => r.is_multi !== false).length
}

module.exports = { planSeats, countBlockersAhead, MAX_PICK }
