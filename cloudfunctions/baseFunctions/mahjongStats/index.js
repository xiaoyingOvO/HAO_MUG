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
  'suankou', 'daisangen', 'kokushi', 'shousuushii', 'tsuuiisou', 'chinroutou',
  'daisuushii', 'chuuren', 'ryuuiisou', 'suukantsu', 'tenhou', 'chihou', 'nagashi', 'chonbo'
];

/* ============================================================
 * 麻将对局战绩模块（挂载在 baseFunctions 聚合函数下，通过 event.type 分发）：
 *   · mahjongAddGame    管理员录入一局（4 名玩家 + 点数，自动算顺位）
 *   · mahjongGetMyStats 我的战绩聚合（四率/平均顺位/最高点数/最近趋势）
 *   · mahjongGetRanking 排行榜（按平均顺位升序，同平均顺位局数多者在前）
 *   · mahjongGetGames   全部对局（分页）
 *
 * 数据集合 mahjong_game 文档结构：
 * {
 *   _id,
 *   game_date: 'YYYY-MM-DD',            // 对局日期（业务日期，非录入时间）
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
  if (!Array.isArray(players) || players.length !== 4) {
    return { success: false, errMsg: '一局需要恰好 4 名玩家' };
  }

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
 * 我的战绩聚合
 * 返回：总局数、1~4 位次数与率、被飞率、平均顺位、平均点数、最高点数、最近 20 局趋势
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

  const games = res.data || [];
  // games 是按时间倒序的；最近 20 局趋势要「从旧到新」（最新在右）
  const recentGames = games.slice(0, 20).reverse();

  const rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let pointsSum = 0, rankSum = 0, maxPoints = null, total = 0;
  games.forEach(g => {
    const mine = (g.players || []).find(p => p.openid === openid);
    if (!mine) return;
    total += 1;
    if (rankCounts[mine.rank] !== undefined) rankCounts[mine.rank] += 1;
    pointsSum += Number(mine.points) || 0;
    rankSum += Number(mine.rank) || 0;
    if (maxPoints === null || mine.points > maxPoints) maxPoints = mine.points;
  });

  const stats = {
    total: total,
    rankCounts: rankCounts,
    rankRates: {
      1: total ? +(rankCounts[1] * 100 / total).toFixed(2) : 0,
      2: total ? +(rankCounts[2] * 100 / total).toFixed(2) : 0,
      3: total ? +(rankCounts[3] * 100 / total).toFixed(2) : 0,
      4: total ? +(rankCounts[4] * 100 / total).toFixed(2) : 0
    },
    // 被飞率 = 末位率（4 位率）
    flyRate: total ? +(rankCounts[4] * 100 / total).toFixed(2) : 0,
    avgRank: total ? +(rankSum / total).toFixed(2) : null,
    avgPoints: total ? +(pointsSum / total).toFixed(1) : null,
    maxPoints: total ? maxPoints : null,
    recent: recentGames.map(g => {
      const mine = (g.players || []).find(p => p.openid === openid);
      return {
        game_id: g._id,
        game_date: g.game_date,
        rank: mine ? mine.rank : null,
        points: mine ? mine.points : null
      };
    })
  };

  // 我的称号（每个称号带获得次数 count）
  const titleRes = await db.collection(db_title).where({ openid }).get();
  stats.titles = (titleRes.data || []).map(t => ({
    title: t.title,
    count: t.count || 1
  }));

  return { success: true, data: stats };
}

/**
 * 排行榜：所有用户按平均顺位升序，同平均顺位局数多者在前
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

  const games = res.data || [];
  const agg = {};   // openid -> {games, rankSum, pointsSum, win}
  games.forEach(g => {
    (g.players || []).forEach(p => {
      if (!p.openid) return;
      if (!agg[p.openid]) agg[p.openid] = { games: 0, rankSum: 0, pointsSum: 0, win: 0 };
      agg[p.openid].games += 1;
      agg[p.openid].rankSum += Number(p.rank) || 0;
      agg[p.openid].pointsSum += Number(p.points) || 0;
      if (p.rank === 1) agg[p.openid].win += 1;
    });
  });

  const openids = Object.keys(agg);
  if (openids.length === 0) return { success: true, data: [] };

  // 批量补昵称头像
  const usersRes = await db.collection(db_user).where({
    openid: db_cmd.in(openids)
  }).get();
  const userInfoMap = {};
  (usersRes.data || []).forEach(u => { userInfoMap[u.openid] = u; });

  // 批量取称号
  const titleMap = await fetchTitlesByOpenids(openids);

  const list = openids.map(oid => {
    const a = agg[oid];
    const u = userInfoMap[oid] || {};
    return {
      openid: oid,
      nickname: u.nickname || '未知用户',
      avatar: u.avatar || '',
      games: a.games,
      win: a.win,
      winRate: +(a.win * 100 / a.games).toFixed(2),
      avgRank: +(a.rankSum / a.games).toFixed(2),
      totalPoints: a.pointsSum,
      titles: titleMap[oid] || [],
      displayTitle: u.display_title || null
    };
  }).sort((x, y) => x.avgRank - y.avgRank || y.games - x.games);

  return { success: true, data: list };
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
