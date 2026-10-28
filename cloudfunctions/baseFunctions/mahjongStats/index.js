const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_game = 'mahjong_game';
const db_user = 'user';
const db_title = 'mahjong_title';
const db_player = 'mahjong_player';   // 玩家统计汇总（一人一条，_id = openid）

// 合法称号 key 白名单（与前端 utils/mahjongTitles.js 保持一致）
const VALID_TITLE_KEYS = [
  'suankou', 'suankoutanki', 'daisangen',
  'kokushi', 'kokushijuusanmen', 'shousuushii',
  'tsuuiisou', 'chinroutou', 'daisuushii',
  'chuuren', 'chuurenjunsei', 'ryuuiisou',
  'suukantsu', 'tenhou', 'chihou', 'kazoe', 'nagashi', 'chonbo'
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

/**
 * 日期合法性。只校验 `${yyyy}-${mm}-${dd}` 的格式是不够的：
 * 2026-13-99 照样能过正则，而 game_date 参与字符串排序，
 * 一条这种数据会把整条时间轴排错，麻币的顺序也就跟着错。
 */
function isValidDate(str) {
  const s = String(str || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split('-').map(Number);
  const y = parts[0], mo = parts[1], d = parts[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * 顺位计算：点数降序，同分同名次（竞赛排名，跳过后续名次）。
 *   例：80/80/40/10 → 1,1,3,4
 * 录分和改分共用这一份，避免两处口径走偏。
 */
function computeRankMap(list) {
  const sorted = list.slice().sort((a, b) => b.points - a.points);
  const rankMap = {};
  sorted.forEach((p, idx) => {
    if (idx > 0 && p.points === sorted[idx - 1].points) {
      rankMap[p.openid] = rankMap[sorted[idx - 1].openid];   // 同分同名次
    } else {
      rankMap[p.openid] = idx + 1;
    }
  });
  return rankMap;
}

function calcPower(mode, games, rankSum) {
  if (!games) return null;
  const avgRank = rankSum / games;
  return Math.round(POWER_BASE + (POWER_BASE_RANK[mode] - avgRank) * POWER_COEF);
}

/* ============================================================
 * 玩家统计汇总（集合 mahjong_player，一人一条，_id = openid）
 *
 * 为什么要有这张表：明细 mahjong_game 只有一个集合，而云函数端单次
 * get() 最多返回 1000 条。原来「排行榜」每次都把全表拉下来在内存里
 * 重算，一旦总对局数超过 1000，最早的一批就被静默丢弃 —— 麻币是逐局
 * 正序推进的，丢掉开头等于把余额基数抹成 0，真值会系统性偏低，而且
 * 每多录一局就再挤掉一局历史，误差随时间持续漂移。
 *
 * 汇总表把「算」这一步从读路径挪到写路径：录分/改分/删分时更新，
 * 读的时候直接排序返回。明细表仍然是唯一真相源，汇总表只是它的缓存，
 * 任何时候都可以用 rebuildAllStats() 全量重来。
 *
 * 只存原始累加量（局数、顺位和、点数和、最大点数），**不存派生值**
 * （平均顺位、雀力、各种比率）。雀力公式以后要调的话，派生值全部作废，
 * 而顺位和还在，换公式重算一遍即可 —— 这是这张表能长期用下去的前提。
 * ============================================================ */

function emptyModeBox() {
  return {
    games: 0,                             // 该模式对局数
    rankCounts: { 1: 0, 2: 0, 3: 0, 4: 0 }, // 各顺位次数
    rankSum: 0,                           // 顺位和（算平均顺位、雀力用）
    pointsSum: 0,                         // 点数和（算平均得点用）
    maxPoints: null                       // 单局最高点
  };
}

function emptyPlayerStat(openid) {
  return {
    _id: openid,
    openid: openid,
    four: emptyModeBox(),
    three: emptyModeBox(),
    coin: 0,                 // 麻币（三麻四麻统一账户）
    gamesTotal: 0,           // 跨模式总对局数
    lastGameDate: '',        // 已纳入统计的最新一局日期，用于判断新局是否追加
    updated_at: new Date()
  };
}

/** 把一局结算进某个玩家的统计（增量）。调用方保证 game 是按时间正序的下一局。 */
function applyGameToStat(stat, game, openid) {
  const mine = (game.players || []).find(p => p.openid === openid);
  if (!mine) return stat;

  const mode = normalizeMode(game);
  const rank = Number(mine.rank) || 0;
  const box = stat[mode];

  box.games += 1;
  if (rank >= 1 && rank <= 4) box.rankCounts[rank] = (box.rankCounts[rank] || 0) + 1;
  box.rankSum += rank;

  const pts = Number(mine.points) || 0;
  box.pointsSum += pts;
  if (box.maxPoints === null || pts > box.maxPoints) box.maxPoints = pts;

  stat.gamesTotal = (stat.gamesTotal || 0) + 1;

  // 麻币逐局钳制：余额为 0 时输一局是「扣不动」，不是先欠 1 分
  const delta = COIN_BY_RANK[mode][rank];
  if (delta !== undefined) stat.coin = Math.max(0, (stat.coin || 0) + delta);

  const date = game.game_date || '';
  if (date > (stat.lastGameDate || '')) stat.lastGameDate = date;

  stat.updated_at = new Date();
  return stat;
}

/** 从该玩家的全部对局（倒序）一次性算出完整统计 */
function summarizePlayer(openid, gamesDesc) {
  const stat = emptyPlayerStat(openid);
  // 麻币有顺序依赖，必须从最早一局往最新一局推进
  for (let i = gamesDesc.length - 1; i >= 0; i -= 1) {
    applyGameToStat(stat, gamesDesc[i], openid);
  }
  stat.lastGameDate = gamesDesc.length ? (gamesDesc[0].game_date || '') : '';
  return stat;
}

/** 分页拉某个玩家的全部对局（倒序）。云函数单次上限 1000 条。 */
async function fetchAllGamesOfPlayer(openid) {
  const PAGE = 1000;
  const out = [];
  for (let skip = 0; skip < 50000; skip += PAGE) {
    const res = await db.collection(db_game)
      .where({ 'players.openid': openid })
      .orderBy('game_date', 'desc').orderBy('create_time', 'desc')
      .skip(skip).limit(PAGE).get();
    const list = res.data || [];
    out.push.apply(out, list);
    if (list.length < PAGE) break;
  }
  return out;
}

/** 分页拉全表对局（倒序），仅重建时使用 */
async function fetchAllGames() {
  const PAGE = 1000;
  const out = [];
  for (let skip = 0; skip < 50000; skip += PAGE) {
    const res = await db.collection(db_game)
      .orderBy('game_date', 'desc').orderBy('create_time', 'desc')
      .skip(skip).limit(PAGE).get();
    const list = res.data || [];
    out.push.apply(out, list);
    if (list.length < PAGE) break;
  }
  return out;
}

async function getPlayerStat(openid) {
  const res = await db.collection(db_player).where({ openid: openid }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function savePlayerStat(stat) {
  const doc = Object.assign({}, stat);
  delete doc._id;                    // _id 由 doc(openid) 指定，不能出现在 data 里
  await db.collection(db_player).doc(stat.openid).set({ data: doc });
}

/** 重算单个玩家（删局、改分、补录历史局之后用） */
async function rebuildPlayerStat(openid) {
  const games = await fetchAllGamesOfPlayer(openid);
  const stat = summarizePlayer(openid, games);
  await savePlayerStat(stat);
  return stat;
}

/**
 * 全量重建：一次读完所有对局，在内存里按玩家聚合，再批量写回。
 * 只给「首次上线回填」和「数据对不上时兜底」用，日常不走这里。
 */
async function rebuildAllStats() {
  const games = await fetchAllGames();     // 倒序
  const map = {};
  for (let i = games.length - 1; i >= 0; i -= 1) {
    const g = games[i];
    (g.players || []).forEach(p => {
      if (!p || !p.openid) return;
      if (!map[p.openid]) map[p.openid] = emptyPlayerStat(p.openid);
      applyGameToStat(map[p.openid], g, p.openid);
    });
  }
  const ids = Object.keys(map);
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(id => savePlayerStat(map[id])));
  }
  return ids.length;
}

/**
 * 录分后的同步：新局一定是最新一局，可以增量；
 * 但如果补录的是历史日期（早于该玩家已纳入统计的最新一局），
 * 它在时间轴上不落在末尾，麻币的推进顺序会变，只能整人重算。
 */
async function syncStatAfterAdd(game, openid) {
  const cur = await getPlayerStat(openid);
  if (!cur || (game.game_date || '') < (cur.lastGameDate || '')) {
    return await rebuildPlayerStat(openid);
  }
  applyGameToStat(cur, game, openid);
  await savePlayerStat(cur);
  return cur;
}

/**
 * 汇总表是否为空。为空说明是首次部署（或集合被清过），
 * 排行榜在这种情况下先全量回填一次，否则会返回空榜。
 */
async function ensureStatsReady() {
  const res = await db.collection(db_player).limit(1).get();
  if (res.data && res.data.length) return false;
  const n = await rebuildAllStats();
  console.log('[mahjong_player] 汇总表为空，已全量回填 %d 人', n);
  return true;
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
  if (!isValidDate(game_date)) {
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
  const rankMap = computeRankMap(parsed);

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

  let gameId = '';
  try {
    const res = await db.collection(db_game).add({ data: doc });
    gameId = res._id;
  } catch (err) {
    console.error('录入对局失败:', err);
    return { success: false, errMsg: '录入失败，请重试' };
  }

  // 明细写成功后再同步汇总。汇总失败就把刚写入的对局删掉并报错，
  // 保证「明细里有这局」和「统计里含这局」永远同时成立 —— 否则
  // 明细多一局、汇总少一局，事后从数据本身看不出来。
  try {
    const added = Object.assign({}, doc, { _id: gameId });
    for (let i = 0; i < doc.players.length; i += 1) {
      await syncStatAfterAdd(added, doc.players[i].openid);
    }
  } catch (err) {
    console.error('同步玩家统计失败，回滚本局:', err);
    try {
      await db.collection(db_game).doc(gameId).remove();
    } catch (e2) {
      console.error('回滚对局失败，需手动重建统计:', e2);
      return { success: false, errMsg: '统计同步失败且回滚未完成，请到管理入口执行一次「重建统计」' };
    }
    return { success: false, errMsg: '统计同步失败，本局已撤销，请重试' };
  }

  return { success: true, data: { game_id: gameId } };
}

/**
 * 修改历史对局（仅 admin / master）
 * params: { game_id, game_date?, players?: [{ openid, points }] }
 *
 * 只允许改「对局日期」和「各玩家点数」，不允许换人 —— 换人等于删了重建，
 * 而且原玩家和新玩家的统计都要动，界面上也说不清到底改了什么。要换人
 * 请删掉这局重新录入。
 *
 * 改点数会改变顺位，所以这局的每一位玩家都必须整人重算，不能增量。
 */
async function updateGameMain(event, context) {
  const wxContext = cloud.getWXContext();
  const opOpenid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!opOpenid) return { success: false, errMsg: '无法获取操作者身份' };

  const me = await db.collection(db_user).where({ openid: opOpenid }).get();
  if (!me.data || me.data.length === 0) return { success: false, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') {
    return { success: false, errMsg: '无权限，仅管理员可修改对局' };
  }

  const params = event.params || {};
  const game_id = params.game_id;
  if (!game_id) return { success: false, errMsg: '未指定对局' };

  let game = null;
  try {
    const gRes = await db.collection(db_game).doc(game_id).get();
    game = gRes.data;
  } catch (err) {
    return { success: false, errMsg: '对局不存在或已被删除' };
  }
  if (!game) return { success: false, errMsg: '对局不存在或已被删除' };

  const oldPlayers = game.players || [];
  if (!oldPlayers.length) return { success: false, errMsg: '这局没有玩家记录，无法修改' };

  // 日期：不传就沿用原日期
  const game_date = params.game_date || game.game_date;
  if (!isValidDate(game_date)) {
    return { success: false, errMsg: '对局日期格式错误' };
  }

  const mode = normalizeMode(game);
  const expectedTotal = POINTS_TOTAL[mode];

  // 点数：不传就沿用原点数（只改日期时用）
  const pointsMap = {};
  const submitted = Array.isArray(params.players) ? params.players : [];
  if (submitted.length) {
    if (submitted.length !== oldPlayers.length) {
      return { success: false, errMsg: '不能增删玩家，只能修改点数' };
    }
    const oldSet = new Set(oldPlayers.map(p => p.openid));
    const seen = new Set();
    for (const p of submitted) {
      const pid = p && p.openid ? String(p.openid) : '';
      if (!pid || !oldSet.has(pid)) return { success: false, errMsg: '不能增删玩家，只能修改点数' };
      if (seen.has(pid)) return { success: false, errMsg: '同一玩家重复出现' };
      seen.add(pid);
      const points = Number(p.points);
      if (!Number.isFinite(points)) return { success: false, errMsg: '点数必须为数字' };
      pointsMap[pid] = points;
    }
  } else {
    oldPlayers.forEach(p => { pointsMap[p.openid] = Number(p.points) || 0; });
  }

  // 点数守恒：与录分同一条规则，改完也不能把总量改歪
  const parsed = oldPlayers.map(p => ({
    openid: p.openid,
    nickname: p.nickname,
    avatar: p.avatar,
    points: pointsMap[p.openid]
  }));
  const totalPoints = parsed.reduce((sum, p) => sum + p.points, 0);
  if (Math.abs(totalPoints - expectedTotal) > 0.5) {
    const diff = totalPoints - expectedTotal;
    return {
      success: false,
      errMsg: `点数合计应为 ${expectedTotal}（${mode === 'three' ? '三麻每人 35000' : '四麻每人 25000'}），` +
        `当前 ${totalPoints}，${diff > 0 ? '多' : '少'} ${Math.abs(diff)}`
    };
  }

  const rankMap = computeRankMap(parsed);
  const newPlayers = parsed.map(p => ({
    openid: p.openid,
    nickname: p.nickname,
    avatar: p.avatar,
    points: p.points,
    rank: rankMap[p.openid]
  }));

  try {
    await db.collection(db_game).doc(game_id).update({
      data: {
        game_date: game_date,
        players: newPlayers,
        update_time: new Date(),
        update_by: opOpenid
      }
    });
  } catch (err) {
    console.error('修改对局失败:', err);
    return { success: false, errMsg: '修改失败，请重试' };
  }

  const failed = [];
  for (let i = 0; i < newPlayers.length; i += 1) {
    try {
      await rebuildPlayerStat(newPlayers[i].openid);
    } catch (err) {
      console.error('重算玩家统计失败:', newPlayers[i].openid, err);
      failed.push(newPlayers[i].openid);
    }
  }

  return {
    success: true,
    data: { game_id: game_id },
    warn: failed.length ? `${failed.length} 名玩家的统计未能同步，请执行一次「重建统计」` : ''
  };
}

/** 取单局详情（编辑页回填用） */
async function getGameDetailMain(event, context) {
  const params = event.params || {};
  const game_id = params.game_id;
  if (!game_id) return { success: false, errMsg: '未指定对局' };
  try {
    const res = await db.collection(db_game).doc(game_id).get();
    if (!res.data) return { success: false, errMsg: '对局不存在或已被删除' };
    return { success: true, data: res.data };
  } catch (err) {
    console.error('查询对局详情失败:', err);
    return { success: false, errMsg: '对局不存在或已被删除' };
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

  // 读汇总表。第一次访问（新玩家、或还没回填过）时表里没有记录，就地补算一次
  let stat = null;
  try {
    stat = await getPlayerStat(openid);
  } catch (err) {
    console.error('读取玩家统计失败:', err);
  }
  if (!stat) {
    try {
      stat = await rebuildPlayerStat(openid);
    } catch (err) {
      console.error('重建玩家统计失败:', err);
      return { success: false, errMsg: '查询战绩失败，请稍后重试' };
    }
  }

  // 趋势图只画最近 20 格，这里取 200 条明细再按模式分配。
  // 不能直接 where({ mode }) —— 历史对局没有 mode 字段，会被全部漏掉。
  let recentSource = [];
  try {
    const rRes = await db.collection(db_game)
      .where({ 'players.openid': openid })
      .orderBy('game_date', 'desc').orderBy('create_time', 'desc')
      .limit(200).get();
    recentSource = rRes.data || [];
  } catch (err) {
    console.error('查询最近对局失败:', err);
  }

  const buildMode = (mode) => {
    const box = stat[mode] || emptyModeBox();
    const total = box.games || 0;
    const topRank = mode === 'three' ? 3 : 4;

    const rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (let r = 1; r <= 4; r += 1) rankCounts[r] = Number((box.rankCounts || {})[r]) || 0;

    // 只给该模式真实存在的名次出率；三麻没有 4 位，不硬塞一个 0
    const rankRates = {};
    for (let r = 1; r <= topRank; r += 1) {
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
      avgRank: total ? +((box.rankSum || 0) / total).toFixed(2) : null,
      avgPoints: total ? +((box.pointsSum || 0) / total).toFixed(1) : null,
      maxPoints: total ? box.maxPoints : null,
      power: calcPower(mode, total, box.rankSum || 0),
      // 最近 20 局，从旧到新（最新在右），与趋势图方向一致
      recent: recentSource
        .filter(g => normalizeMode(g) === mode)
        .slice(0, 20)
        .reverse()
        .map(g => {
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
      coin: stat.coin || 0,
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
  // 首次部署（或集合被清过）时汇总表是空的，先全量回填一次，
  // 否则玩家明明打过对局，这里却返回空榜
  try {
    await ensureStatsReady();
  } catch (err) {
    console.error('初始化玩家统计失败:', err);
  }

  // 汇总表一人一条，玩家量级几十人，分页拉完
  const statList = [];
  try {
    for (let skip = 0; skip < 5000; skip += 100) {
      const res = await db.collection(db_player).skip(skip).limit(100).get();
      const list = res.data || [];
      statList.push.apply(statList, list);
      if (list.length < 100) break;
    }
  } catch (err) {
    console.error('查询玩家统计失败:', err);
    return { success: false, errMsg: '查询排行榜失败' };
  }

  if (statList.length === 0) {
    return { success: true, data: { coin: [], power3: [], power4: [], config: buildRankConfig() } };
  }

  const openids = statList.map(s => s.openid).filter(Boolean);
  const userInfoMap = await fetchUsersByOpenids(openids);
  const titleMap = await fetchTitlesByOpenids(openids);

  const rows = statList.map((s) => {
    if (!s.openid) return null;
    const u = userInfoMap[s.openid] || {};
    const four = s.four || emptyModeBox();
    const three = s.three || emptyModeBox();
    const gamesAll = s.gamesTotal || 0;
    const winAll = Number((four.rankCounts || {})[1] || 0) + Number((three.rankCounts || {})[1] || 0);
    const rankSumAll = (four.rankSum || 0) + (three.rankSum || 0);
    return {
      openid: s.openid,
      nickname: u.nickname || '未知用户',
      avatar: u.avatar || '',
      displayTitle: u.display_title || null,
      titles: titleMap[s.openid] || [],
      coin: s.coin || 0,
      gamesAll: gamesAll,
      winAll: winAll,
      rankSumAll: rankSumAll,
      four: four,
      three: three
    };
  }).filter(Boolean);

  // 三个榜共用的展示字段
  const publicOf = (r) => ({
    openid: r.openid,
    nickname: r.nickname,
    avatar: r.avatar,
    displayTitle: r.displayTitle,
    titles: r.titles
  });

  const coin = rows.map(r => Object.assign(publicOf(r), {
    value: r.coin,
    games: r.gamesAll,
    avgRank: r.gamesAll ? +(r.rankSumAll / r.gamesAll).toFixed(2) : null,
    winRate: r.gamesAll ? +(r.winAll * 100 / r.gamesAll).toFixed(2) : 0
  })).sort((x, y) => y.value - x.value || y.games - x.games);

  const buildPower = (mode) => rows
    .filter(r => (r[mode].games || 0) >= POWER_MIN_GAMES)
    .map((r) => {
      const box = r[mode];
      return Object.assign(publicOf(r), {
        value: calcPower(mode, box.games, box.rankSum || 0),
        games: box.games,
        avgRank: +(box.rankSum / box.games).toFixed(2),
        winRate: +(Number((box.rankCounts || {})[1] || 0) * 100 / box.games).toFixed(2)
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

  // 先取出这局有谁，删完才知道要重算哪几位
  let players = [];
  try {
    const gRes = await db.collection(db_game).doc(game_id).get();
    players = (gRes.data && gRes.data.players) || [];
  } catch (err) {
    return { success: false, errMsg: '对局不存在或已被删除' };
  }

  try {
    await db.collection(db_game).doc(game_id).remove();
  } catch (err) {
    console.error('删除对局失败:', err);
    return { success: false, errMsg: '删除失败，请重试' };
  }

  // 删局不能靠加减回滚：麻币是逐局钳制推进的，少掉中间一局，
  // 后面所有局的钳制状态都可能变，只能把这几位玩家的全部对局重算。
  const failed = [];
  for (let i = 0; i < players.length; i += 1) {
    const oid = players[i] && players[i].openid;
    if (!oid) continue;
    try {
      await rebuildPlayerStat(oid);
    } catch (err) {
      console.error('重算玩家统计失败:', oid, err);
      failed.push(oid);
    }
  }

  if (failed.length) {
    return { success: true, warn: `${failed.length} 名玩家的统计未能同步，请执行一次「重建统计」` };
  }
  return { success: true };
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
    // 历史对局没有 mode 字段，统一补一个，前端才好显示三麻/四麻标签
    const list = (res.data || []).map(g => Object.assign({}, g, { mode: normalizeMode(g) }));
    return { success: true, data: list };
  } catch (err) {
    console.error('查询对局列表失败:', err);
    return { success: false, errMsg: '查询对局列表失败' };
  }
}

/**
 * 全量重建玩家统计（仅管理员）
 *
 * 汇总表是缓存，明细才是真相。这个入口用于：首次上线回填、
 * 手动改过数据库之后对齐、以及怀疑汇总漂了的时候兜底重来。
 */
async function rebuildPlayerStatsMain(event, context) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!openid) return { success: false, errMsg: '无法获取操作者身份' };

  const me = await db.collection(db_user).where({ openid }).get();
  if (!me.data || me.data.length === 0) return { success: false, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') {
    return { success: false, errMsg: '无权限，仅管理员可重建统计' };
  }

  try {
    const count = await rebuildAllStats();
    return { success: true, data: { players: count } };
  } catch (err) {
    console.error('重建玩家统计失败:', err);
    return { success: false, errMsg: '重建失败：' + (err.message || '未知错误') };
  }
}

module.exports = {
  addGameMain,
  updateGameMain,
  getGameDetailMain,
  getMyStatsMain,
  getRankingMain,
  getGamesMain,
  grantTitleMain,
  revokeTitleMain,
  getPlayerTitlesMain,
  deleteGameMain,
  rebuildPlayerStatsMain,
  fetchTitlesByOpenids
};
