const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_game = 'mahjong_game';
const db_user = 'user';
const db_title = 'mahjong_title';

// 合法称号 key 白名单（与前端 utils/mahjongTitles.js 保持一致）
const VALID_TITLE_KEYS = [
  'suankou', 'suankoutanki', 'daisangen',
  'kokushi', 'kokushijuusanmen', 'shousuushii',
  'tsuuiisou', 'chinroutou', 'daisuushii',
  'chuuren', 'chuurenjunsei', 'ryuuiisou',
  'suukantsu', 'tenhou', 'chihou', 'nagashi', 'chonbo'
];

/* ============================================================
 * 麻币 / 雀力规则
 *
 * 【麻币】按顺位发放，四麻比三麻多一个末位惩罚位：
 *     四麻  1位 +2   2位 +1   3位 0    4位 -1
 *     三麻  1位 +2   2位  0   3位 -1
 *   「最低为 0」是**逐局钳制**，不是最后对总和钳制 —— 余额 0 时再输一局
 *   应该是「扣不动」，而不是先欠 1 分、下次赢一局只补回 0 分。所以结算
 *   必须按时间正序逐局推进。麻币不落库，每次都从对局记录实时重算，这样
 *   管理员删除某局后，该局之后所有人的余额都会自动重新结算。
 *
 * 【雀力】用平均顺位换算，不累加、不落库：
 *     雀力 = 1000 + (基准顺位 - 平均顺位) × 300
 *     四麻基准顺位 2.5   三麻基准顺位 2.0
 *   用「相对基准的偏离」而不是绝对顺位，三麻和四麻的雀力才可比：
 *   四麻平均 2.0 与三麻平均 1.5 都偏离基准 0.5 位，都是 1150。
 * ============================================================ */
const COIN_BY_RANK = {
  four: { 1: 2, 2: 1, 3: 0, 4: -1 },
  three: { 1: 2, 2: 0, 3: -1 }
};

// 一局的点数总量（原点 × 人数）。录分时校验总和守恒，
// 与前端 pages/mahjong/record.js 里的 POINTS_TOTAL 保持一致。
const POINTS_TOTAL = {
  three: 105000,   // 三麻 35000 × 3
  four: 100000     // 四麻 25000 × 4
};

const POWER_BASE = 1000;
const POWER_COEF = 300;
const POWER_BASE_RANK = { four: 2.5, three: 2.0 };
// 雀力榜最低局数门槛：平均顺位在小样本下噪声极大，3 局全胜就能刷到榜首
const POWER_MIN_GAMES = 10;

const MODE_LABEL = { four: '四麻', three: '三麻' };

// 历史对局没有 mode 字段（那时只允许 4 人），一律按四麻处理
function normalizeMode(game) {
  return game && game.mode === 'three' ? 'three' : 'four';
}

function calcPower(mode, games, rankSum) {
  if (!games) return null;
  const avgRank = rankSum / games;
  return Math.round(POWER_BASE + (POWER_BASE_RANK[mode] - avgRank) * POWER_COEF);
}

/**
 * 全员麻币结算。
 * gamesDesc 必须按 game_date/create_time **倒序**（数据库查询的默认顺序）。
 *
 * 麻币是三麻四麻**统一**计算的一个账户（它本质是积分，玩家只关心总额），
 * 但结算必须逐局钳制在 0：余额为 0 时输一局是「扣不动」，不是先欠 1 分。
 * 所以要把倒序列表反转成正序再推进。
 */
function computeCoinBalances(gamesDesc) {
  const bal = {};
  gamesDesc.slice().reverse().forEach(g => {
    const table = COIN_BY_RANK[normalizeMode(g)];
    (g.players || []).forEach(p => {
      if (!p.openid) return;
      const delta = table[Number(p.rank)];
      if (delta === undefined) return;   // 脏顺位（如 5 位）跳过，不让一条坏数据拖垮整榜
      bal[p.openid] = Math.max(0, (bal[p.openid] || 0) + delta);
    });
  });
  return bal;
}

/**
 * 单个玩家的麻币结算，口径与 computeCoinBalances 完全一致。
 * 个人页只查到自己参与的对局就够了 —— 麻币只取决于本人每局的顺位。
 */
function settleCoinForPlayer(openid, gamesDesc) {
  let bal = 0;
  gamesDesc.slice().reverse().forEach(g => {
    const mine = (g.players || []).find(p => p.openid === openid);
    if (!mine) return;
    const delta = COIN_BY_RANK[normalizeMode(g)][Number(mine.rank)];
    if (delta === undefined) return;
    bal = Math.max(0, bal + delta);
  });
  return bal;
}

// 云开发单次 in 查询上限 100，超出会直接报错，统一在这里分块
async function fetchUsersByOpenids(openids) {
  const map = {};
  if (!openids || openids.length === 0) return map;
  const chunks = [];
  for (let i = 0; i < openids.length; i += 100) chunks.push(openids.slice(i, i + 100));
  for (const chunk of chunks) {
    const res = await db.collection(db_user).where({ openid: db_cmd.in(chunk) }).get();
    (res.data || []).forEach(u => { map[u.openid] = u; });
  }
  return map;
}

/* ============================================================
 * 麻将对局战绩模块（挂载在 baseFunctions 聚合函数下，通过 event.type 分发）：
 *   · mahjongAddGame    管理员录入一局（3 人三麻 / 4 人四麻，自动算顺位与模式）
 *   · mahjongGetMyStats 我的战绩聚合（三麻四麻分开：顺位次数/率/平均顺位/雀力/趋势，麻币统一）
 *   · mahjongGetRanking 排行榜（麻币 / 三麻雀力 / 四麻雀力 三榜一次返回）
 *   · mahjongGetGames   全部对局（分页）
 *
 * 数据集合 mahjong_game 文档结构：
 * {
 *   _id,
 *   game_date: 'YYYY-MM-DD',            // 对局日期（业务日期，非录入时间）
 *   mode: 'three' | 'four',              // 三麻 / 四麻；历史数据无此字段，按四麻兜底
 *   players: [{ openid, nickname, avatar, points, rank }],
 *   recorder_openid,                     // 录入人
 *   create_time: Date
 * }
 *
 * 顺位规则：按点数降序，同分同名次（竞赛排名，跳过后续名次）。
 *   例：80/80/40/10 → 1,1,3,4
 * ============================================================ */

/**
 * 录入一局对局（仅 admin / master）
 * params: { game_date: 'YYYY-MM-DD', players: [{openid, points}] × 4 }
 */
async function addGameMain(event, context) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!openid) return { success: false, errMsg: '无法获取操作者身份' };

  // 权限校验：只有 admin / master 能录入
  const me = await db.collection(db_user).where({ openid }).get();
  if (!me.data || me.data.length === 0) {
    return { success: false, errMsg: '未查询到操作者信息' };
  }
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') {
    return { success: false, errMsg: '无权限，仅管理员可录入对局' };
  }

  const params = event.params || {};
  const game_date = params.game_date;
  const players = params.players;
  if (!game_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(game_date))) {
    return { success: false, errMsg: '对局日期格式错误' };
  }
  if (!Array.isArray(players) || (players.length !== 4 && players.length !== 3)) {
    return { success: false, errMsg: '一局需要 3 名（三麻）或 4 名（四麻）玩家' };
  }
  // 三麻 / 四麻由人数直接判定：3 人即三麻，4 人即四麻
  const mode = players.length === 3 ? 'three' : 'four';

  // 校验 openid 与点数
  const seen = new Set();
  const parsed = [];
  for (const p of players) {
    const pid = p && p.openid ? String(p.openid) : '';
    if (!pid) return { success: false, errMsg: '有玩家未选择' };
    if (seen.has(pid)) return { success: false, errMsg: '同一玩家不能重复入局' };
    seen.add(pid);
    const points = Number(p.points);
    if (!Number.isFinite(points)) return { success: false, errMsg: '点数必须为数字' };
    parsed.push({ openid: pid, points });
  }

  // 点数总和必须守恒：三麻原点 35000（3 人合计 105000）、四麻原点 25000
  // （4 人合计 100000）。
  // 这一条不校验的话，管理员少打或多打一位数字也能存进去，而且事后无法
  // 从数据本身看出哪一局是错的 —— 它只会让所有人的雀力和麻币慢慢失真。
  const totalPoints = parsed.reduce((sum, p) => sum + p.points, 0);
  const expectedTotal = POINTS_TOTAL[mode];
  if (Math.abs(totalPoints - expectedTotal) > 0.5) {
    const diff = totalPoints - expectedTotal;
    return {
      success: false,
      errMsg: `点数合计应为 ${expectedTotal}（${mode === 'three' ? '三麻每人 35000' : '四麻每人 25000'}），` +
        `当前 ${totalPoints}，${diff > 0 ? '多' : '少'} ${Math.abs(diff)}`
    };
  }

  // 补全昵称头像（一次 in 查询）
  const usersRes = await db.collection(db_user).where({
    openid: db_cmd.in(parsed.map(p => p.openid))
  }).get();
  const userInfoMap = {};
  (usersRes.data || []).forEach(u => { userInfoMap[u.openid] = u; });

  // 计算顺位：点数降序，同分同名次（竞赛排名）
  const sorted = parsed.slice().sort((a, b) => b.points - a.points);
  const rankMap = {};   // openid -> rank
  sorted.forEach((p, idx) => {
    if (idx > 0 && p.points === sorted[idx - 1].points) {
      rankMap[p.openid] = rankMap[sorted[idx - 1].openid]; // 同分同名次
    } else {
      rankMap[p.openid] = idx + 1;
    }
  });

  const doc = {
    game_date: game_date,
    mode: mode,          // 'three' | 'four'，历史数据无此字段按四麻兜底
    players: parsed.map(p => {
      const u = userInfoMap[p.openid] || {};
      return {
        openid: p.openid,
        nickname: u.nickname || '未知用户',
        avatar: u.avatar || '',
        points: p.points,
        rank: rankMap[p.openid]
      };
    }),
    recorder_openid: openid,
    create_time: new Date()
  };

  try {
    const res = await db.collection(db_game).add({ data: doc });
    return { success: true, data: { game_id: res._id } };
  } catch (err) {
    console.error('录入对局失败:', err);
    return { success: false, errMsg: '录入失败，请重试' };
  }
}

/**
 * 我的战绩聚合 —— 三麻与四麻**完全分开统计**，麻币统一
 *
 * 返回：
 * {
 *   coin,                    // 麻币总额（三麻四麻合并结算的一个账户）
 *   modes: {
 *     four:  { mode, topRank, games, rankCounts, rankRates, flyRate,
 *              avgRank, avgPoints, maxPoints, power, recent },
 *     three: { 同上 }
 *   },
 *   titles: [{ title, count }]   // 称号不分模式
 * }
 *
 * 为什么必须分开：三麻只有 1~3 位，混在一起算的话「四位率」恒被稀释、
 * 平均顺位也会被拉低，两个模式的战绩互相污染，看不出一项真实水平。
 */
async function getMyStatsMain(event, context) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!openid) return { success: false, errMsg: '无法获取用户身份' };

  let res;
  try {
    res = await db.collection(db_game).where({
      'players.openid': openid
    }).orderBy('game_date', 'desc').orderBy('create_time', 'desc').limit(1000).get();
  } catch (err) {
    console.error('查询对局失败:', err);
    return { success: false, errMsg: '查询对局数据失败' };
  }

  const games = res.data || [];   // 按时间倒序

  const buildMode = (mode) => {
    const list = games.filter(g => normalizeMode(g) === mode);
    const total = list.length;
    const topRank = mode === 'three' ? 3 : 4;

    const rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let pointsSum = 0, rankSum = 0, maxPoints = null;
    list.forEach(g => {
      const mine = (g.players || []).find(p => p.openid === openid);
      if (!mine) return;
      const rank = Number(mine.rank) || 0;
      if (rankCounts[rank] !== undefined) rankCounts[rank] += 1;
      pointsSum += Number(mine.points) || 0;
      rankSum += rank;
      if (maxPoints === null || mine.points > maxPoints) maxPoints = mine.points;
    });

    // 只给该模式真实存在的名次出率；三麻没有 4 位，不硬塞一个 0
    const rankRates = {};
    for (let r = 1; r <= topRank; r++) {
      rankRates[r] = total ? +(rankCounts[r] * 100 / total).toFixed(2) : 0;
    }

    return {
      mode: mode,
      topRank: topRank,
      games: total,
      rankCounts: rankCounts,
      rankRates: rankRates,
      // 末位率（原「被飞率」）：四麻看 4 位，三麻看 3 位，两种模式语义一致
      flyRate: total ? +(rankCounts[topRank] * 100 / total).toFixed(2) : 0,
      avgRank: total ? +(rankSum / total).toFixed(2) : null,
      avgPoints: total ? +(pointsSum / total).toFixed(1) : null,
      maxPoints: total ? maxPoints : null,
      power: calcPower(mode, total, rankSum),
      // 最近 20 局，从旧到新（最新在右），与趋势图方向一致
      recent: list.slice(0, 20).reverse().map(g => {
        const mine = (g.players || []).find(p => p.openid === openid);
        return {
          game_id: g._id,
          game_date: g.game_date,
          rank: mine ? mine.rank : null,
          points: mine ? mine.points : null
        };
      })
    };
  };

  const titleRes = await db.collection(db_title).where({ openid }).get();

  return {
    success: true,
    data: {
      coin: settleCoinForPlayer(openid, games),
      modes: {
        four: buildMode('four'),
        three: buildMode('three')
      },
      titles: (titleRes.data || []).map(t => ({
        title: t.title,
        count: t.count || 1
      }))
    }
  };
}

/**
 * 排行榜：一次拉取，同时聚合出三个榜，前端切 tab 无需再请求
 *   · coin    麻币榜（所有打过对局的人）
 *   · power3  三麻雀力榜（≥ POWER_MIN_GAMES 局）
 *   · power4  四麻雀力榜（≥ POWER_MIN_GAMES 局）
 *
 * 每条记录结构统一为：
 *   { openid, nickname, avatar, value, games, avgRank, winRate, displayTitle }
 * value 是该榜的主数值（麻币数 / 雀力）。
 */
async function getRankingMain(event, context) {
  let res;
  try {
    res = await db.collection(db_game).orderBy('game_date', 'desc')
      .orderBy('create_time', 'desc').limit(1000).get();
  } catch (err) {
    console.error('查询对局失败:', err);
    return { success: false, errMsg: '查询对局数据失败' };
  }

  const gamesDesc = res.data || [];
  if (gamesDesc.length === 0) {
    return { success: true, data: { coin: [], power3: [], power4: [], config: buildRankConfig() } };
  }

  /* ---- 麻币：统一账户，逐局钳制在 0 ---- */
  const coinBalance = computeCoinBalances(gamesDesc);

  /* ---- 局数 / 顺位和 / 一位数：分模式分别统计 ---- */
  const agg = {};
  gamesDesc.forEach(g => {
    const mode = normalizeMode(g);
    (g.players || []).forEach(p => {
      if (!p.openid) return;
      if (!agg[p.openid]) {
        agg[p.openid] = {
          four: { games: 0, rankSum: 0, win: 0 },
          three: { games: 0, rankSum: 0, win: 0 },
          all: { games: 0, rankSum: 0, win: 0 }
        };
      }
      const a = agg[p.openid];
      const rank = Number(p.rank) || 0;
      [a[mode], a.all].forEach(box => {
        box.games += 1;
        box.rankSum += rank;
        if (rank === 1) box.win += 1;
      });
    });
  });

  const openids = Object.keys(agg);
  const userInfoMap = await fetchUsersByOpenids(openids);
  const titleMap = await fetchTitlesByOpenids(openids);

  // 三个榜共用的基础字段，value 由各榜自己补
  const base = openids.map(oid => {
    const u = userInfoMap[oid] || {};
    return {
      openid: oid,
      nickname: u.nickname || '未知用户',
      avatar: u.avatar || '',
      displayTitle: u.display_title || null,
      titles: titleMap[oid] || []
    };
  });

  const statOf = (box) => ({
    games: box.games,
    avgRank: box.games ? +(box.rankSum / box.games).toFixed(2) : null,
    winRate: box.games ? +(box.win * 100 / box.games).toFixed(2) : 0
  });

  const coin = base.map(b => Object.assign({}, b, statOf(agg[b.openid].all), {
    value: coinBalance[b.openid] || 0
  })).sort((x, y) => y.value - x.value || y.games - x.games);

  const buildPower = (mode) => base
    .filter(b => agg[b.openid][mode].games >= POWER_MIN_GAMES)
    .map(b => {
      const box = agg[b.openid][mode];
      return Object.assign({}, b, statOf(box), {
        value: calcPower(mode, box.games, box.rankSum)
      });
    })
    .sort((x, y) => y.value - x.value || y.games - x.games);

  return {
    success: true,
    data: {
      coin: coin,
      power3: buildPower('three'),
      power4: buildPower('four'),
      // 规则下发给前端做「≥10 局才入榜」之类的说明文案，避免前后端各写一份
      config: buildRankConfig()
    }
  };
}

function buildRankConfig() {
  return {
    powerMinGames: POWER_MIN_GAMES,
    powerBase: POWER_BASE,
    powerCoef: POWER_COEF,
    powerBaseRank: POWER_BASE_RANK,
    coinByRank: COIN_BY_RANK,
    modeLabel: MODE_LABEL
  };
}

/**
 * 管理员给玩家发称号（役满 / 流局满贯 / 诈胡）
 * params: { openid: 目标玩家, title: 称号key }
 * 可多人拥有同一称号；同一人同一称号可重复获得，重复发放累计次数（count）。
 */
async function grantTitleMain(event, context) {
  const wxContext = cloud.getWXContext();
  const opOpenid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!opOpenid) return { success: false, errMsg: '无法获取操作者身份' };

  const params = event.params || {};
  const targetOpenid = params.openid;
  const title = params.title;

  // 权限校验
  const me = await db.collection(db_user).where({ openid: opOpenid }).get();
  if (!me.data || me.data.length === 0) return { success: false, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') return { success: false, errMsg: '无权限，仅管理员可发称号' };

  if (!targetOpenid) return { success: false, errMsg: '未指定玩家' };
  if (!VALID_TITLE_KEYS.includes(title)) return { success: false, errMsg: '未知称号' };

  try {
    const exist = await db.collection(db_title).where({ openid: targetOpenid, title }).get();
    if (exist.data && exist.data.length > 0) {
      // 已有该称号：累计次数 +1
      await db.collection(db_title).doc(exist.data[0]._id).update({
        data: {
          count: db_cmd.inc(1),
          grant_by: opOpenid,
          update_time: new Date()
        }
      });
    } else {
      // 首次获得：新增记录，count = 1
      await db.collection(db_title).add({
        data: {
          openid: targetOpenid,
          title,
          count: 1,
          grant_by: opOpenid,
          create_time: new Date()
        }
      });
    }
    return { success: true };
  } catch (err) {
    console.error('发称号失败:', err);
    return { success: false, errMsg: '发放失败，请重试' };
  }
}

/**
 * 撤销/减少玩家称号次数（仅 admin / master）
 * params: { openid: 目标玩家, title: 称号key, count?: 减少数量（默认 1） }
 * count 减到 0 或以下时删除该称号记录。
 */
async function revokeTitleMain(event, context) {
  const wxContext = cloud.getWXContext();
  const opOpenid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!opOpenid) return { success: false, errMsg: '无法获取操作者身份' };

  const params = event.params || {};
  const targetOpenid = params.openid;
  const title = params.title;
  let dec = Number(params.count) || 1;
  if (dec < 1) dec = 1;

  // 权限校验
  const me = await db.collection(db_user).where({ openid: opOpenid }).get();
  if (!me.data || me.data.length === 0) return { success: false, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') return { success: false, errMsg: '无权限，仅管理员可撤销称号' };

  if (!targetOpenid) return { success: false, errMsg: '未指定玩家' };
  if (!VALID_TITLE_KEYS.includes(title)) return { success: false, errMsg: '未知称号' };

  try {
    const exist = await db.collection(db_title).where({ openid: targetOpenid, title }).get();
    if (!exist.data || exist.data.length === 0) {
      return { success: false, errMsg: '该玩家没有此称号' };
    }
    const doc = exist.data[0];
    const cur = Number(doc.count) || 1;
    if (cur <= dec) {
      // 减到 0 或以下：删除记录
      await db.collection(db_title).doc(doc._id).remove();
    } else {
      await db.collection(db_title).doc(doc._id).update({
        data: { count: db_cmd.inc(-dec), grant_by: opOpenid, update_time: new Date() }
      });
    }
    return { success: true };
  } catch (err) {
    console.error('撤销称号失败:', err);
    return { success: false, errMsg: '撤销失败，请重试' };
  }
}

/**
 * 查询某玩家的称号列表（仅 admin / master，发称号页用）
 * params: { openid: 目标玩家 }
 * 返回: [{ title, count }]
 */
async function getPlayerTitlesMain(event, context) {
  const wxContext = cloud.getWXContext();
  const opOpenid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!opOpenid) return { success: false, errMsg: '无法获取操作者身份' };

  const params = event.params || {};
  const targetOpenid = params.openid;
  if (!targetOpenid) return { success: false, errMsg: '未指定玩家' };

  // 权限校验
  const me = await db.collection(db_user).where({ openid: opOpenid }).get();
  if (!me.data || me.data.length === 0) return { success: false, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') return { success: false, errMsg: '无权限' };

  try {
    const res = await db.collection(db_title).where({ openid: targetOpenid }).get();
    const titles = (res.data || []).map(t => ({ title: t.title, count: t.count || 1 }));
    return { success: true, data: titles };
  } catch (err) {
    console.error('查询玩家称号失败:', err);
    return { success: false, errMsg: '查询失败' };
  }
}

/**
 * 删除一局对局记录（仅 admin / master）
 * params: { game_id: 对局 _id }
 */
async function deleteGameMain(event, context) {
  const wxContext = cloud.getWXContext();
  const opOpenid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!opOpenid) return { success: false, errMsg: '无法获取操作者身份' };

  const params = event.params || {};
  const game_id = params.game_id;

  // 权限校验
  const me = await db.collection(db_user).where({ openid: opOpenid }).get();
  if (!me.data || me.data.length === 0) return { success: false, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') return { success: false, errMsg: '无权限，仅管理员可删除对局' };

  if (!game_id) return { success: false, errMsg: '未指定对局' };

  try {
    await db.collection(db_game).doc(game_id).remove();
    return { success: true };
  } catch (err) {
    console.error('删除对局失败:', err);
    return { success: false, errMsg: '删除失败，请重试' };
  }
}

/**
 * 查询某批玩家的称号（内部用，返回 openid -> [{title, count}, ...]）
 */
async function fetchTitlesByOpenids(openids) {
  const map = {};
  if (!openids || openids.length === 0) return map;
  openids.forEach(oid => { map[oid] = []; });
  // 云开发单次 in 最多 100 个，这里分块查
  const chunks = [];
  for (let i = 0; i < openids.length; i += 100) chunks.push(openids.slice(i, i + 100));
  for (const chunk of chunks) {
    const res = await db.collection(db_title).where({ openid: db_cmd.in(chunk) }).get();
    (res.data || []).forEach(t => {
      if (map[t.openid]) map[t.openid].push({ title: t.title, count: t.count || 1 });
    });
  }
  return map;
}

/**
 * 全部对局（分页，按日期倒序）
 * params: { page_no?: 0, page_size?: 20 }
 */
async function getGamesMain(event, context) {
  const params = event.params || {};
  const page_no = Number(params.page_no) || 0;
  const page_size = Math.min(Math.max(Number(params.page_size) || 20, 1), 50);

  try {
    const res = await db.collection(db_game)
      .orderBy('game_date', 'desc').orderBy('create_time', 'desc')
      .skip(page_no * page_size).limit(page_size)
      .get();
    return { success: true, data: res.data || [] };
  } catch (err) {
    console.error('查询对局列表失败:', err);
    return { success: false, errMsg: '查询对局列表失败' };
  }
}

module.exports = {
  addGameMain,
  getMyStatsMain,
  getRankingMain,
  getGamesMain,
  grantTitleMain,
  revokeTitleMain,
  getPlayerTitlesMain,
  deleteGameMain,
  fetchTitlesByOpenids
};
