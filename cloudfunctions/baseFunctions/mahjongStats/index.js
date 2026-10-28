const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_game = 'mahjong_game';
const db_user = 'user';
const db_title = 'mahjong_title';
const db_player = 'mahjong_player';   // 玩家统计（一人一条，_id = openid）
// 管理员改记录的留痕表（一条 = 一个字段的一次变更，只追加，从不改写已有记录）。
// 只做审计，不参与任何统计计算 —— 删掉它不影响战绩，只会丢掉「谁在什么时候改了什么」。
const db_log = 'mahjong_adjust';

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
 *     四麻  1位 +3   2位 +1   3位 0    4位 -2
 *     三麻  1位 +2   2位  0   3位 -1
 *   四麻四人合计 +2、三麻三人合计 +1 —— 每局都凭空派发这么多枚，
 *   所以麻币是「越打越多」的鼓励型货币，不是零和积分。
 *   新规则（+3/+1/0/-2）把一三位差距拉到 5 枚、末位惩罚加重一倍，
 *   但每局派发总量仍是 +2，不影响整体通胀速度。
 *   「最低为 0」是**逐局钳制**，不是最后对总和钳制 —— 余额 0 时再输一局
 *   应该是「扣不动」，而不是先欠 1 分、下次赢一局只补回 0 分。所以结算
 *   必须按时间正序逐局推进。
 *   钳制带来一个后果：删掉中间某一局之后，后面每一局的余额状态都可能变，
 *   没法用「余额 - 该局增减」回滚，只能对该玩家整人重算（见 rebuildPlayerStat）。
 *
 * 【雀力】用平均顺位换算，不累加、不落库：
 *     雀力 = 1000 + (基准顺位 - 平均顺位) × 300
 *     四麻基准顺位 2.5   三麻基准顺位 2.0
 *   用「相对基准的偏离」而不是绝对顺位，三麻和四麻的雀力才可比：
 *   四麻平均 2.0 与三麻平均 1.5 都偏离基准 0.5 位，都是 1150。
 * ============================================================ */
const COIN_BY_RANK = {
  four: { 1: 3, 2: 1, 3: 0, 4: -2 },
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
 * 读的时候直接排序返回。
 *
 * 【真相源已经变成两个】明细只保留最近 ARCHIVE_DAYS 天，超期的会被
 * 折算进本表的 base 字段后删除。所以：
 *   · 保留期内    → mahjong_game 是真相，本表是它的缓存
 *   · 更早的历史  → 本表的 base 是唯一载体，明细已经不存在
 * rebuildAllStats() 因此必须从 base 起手，绝不能从零重算（见该函数）。
 *
 * 只存原始累加量（局数、顺位和、点数和、最大点数），**不存派生值**
 * （平均顺位、雀力、各种比率）。雀力公式以后要调的话，派生值全部作废，
 * 而顺位和还在，换公式重算一遍即可 —— 这是这张表能长期用下去的前提。
 * ============================================================ */

/**
 * 明细保留天数。一个月，按 30 个日历日算（今天 + 前 29 天）。
 *
 * 超过这个天数的对局，会先把它的结果折算进 mahjong_player.base，
 * 然后从 mahjong_game 里删掉。之后查询对局列表、改分、删局都只对
 * 保留期内的对局有效。
 *
 * 【为什么敢删】出问题的局基本当场就改，几个月前的数据没人动。
 * 一个月足够覆盖「当天发现当天改」「过几天才发现」「月底对账时才
 * 发现某局点数错了」这些真实场景。
 *
 * 【窗口越长代价越大】删掉之后 base 就从「可作废的缓存」变成
 * 「唯一真相源」—— 明细没了，没法再从零重算。所以窗口越长，能安全
 * 纠错的时间就越长，但存储和查询成本也越大。30 天是这两者的平衡点，
 * 按日历日算，不是按小时。
 *
 * 【不可逆的后果】以下三件事必须同时成立，否则会静默丢历史：
 *   1. rebuildAllStats 必须从现有 base 起手，不能从零重来
 *   2. 补录早于归档线的日期必须拒绝（插不进已经算好的累计值）
 *   3. 改日期到归档线之前必须拒绝（同理）
 */
const ARCHIVE_DAYS = 30;

/**
 * 今天的日期串（'YYYY-MM-DD'），按东八区算。
 *
 * 云函数容器默认跑在 UTC，直接用 new Date().toISOString() 会在
 * 每天 8:00 之前返回前一天，导致归档线整体偏移一天。这里先加 8 小时
 * 再取日期，等价于「按北京时间算今天是哪天」。
 */
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 加减天数，用 Date.UTC 反查避免夏令时/时区干扰 */
function shiftDate(dateStr, days) {
  const p = String(dateStr).split('-');
  const t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 归档线：这一日（含）之前的一律归档。
 *
 * 保留的是「今天 + 前 29 天」共 30 个日历日，所以线画在 today-30。
 * 用「整日」而不是「整小时」切分是硬要求：同一天可能录好几局，
 * 切在半天中间会让 baseUntil 落在当天，剩下的同天对局就再也进不了统计。
 */
function archiveCutoff(today) {
  return shiftDate(today || todayStr(), -ARCHIVE_DAYS);
}

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
    // base 是「截至 baseUntil（含当天）全部结算完」的累计状态。
    // 明细里 <= baseUntil 的局已经被删除，所以 base 一旦存在就是这段
    // 历史的唯一载体，不能再作废重来。
    base: null,
    baseUntil: '',
    // 归档水位：'YYYY-MM-DD'，表示此日（含）之前的明细已确认为删除。
    // 与 baseUntil 绝大多数时候相等，单独留一个字段是为了在「baseUntil
    // 之后那几天恰好没打牌」时仍能准确告诉前端可以改到哪一天。
    archiveUntil: '',
    updated_at: new Date()
  };
}

/** 从 base 快照起手，得到一个可继续推进的 stat */
function statFromBase(openid, base, baseUntil) {
  const stat = emptyPlayerStat(openid);
  stat.base = base || null;
  stat.baseUntil = baseUntil || '';
  stat.archiveUntil = baseUntil || '';
  if (!base) return stat;
  stat.coin = Number(base.coin) || 0;
  stat.gamesTotal = Number(base.gamesTotal) || 0;
  ['four', 'three'].forEach((mode) => {
    const b = base[mode];
    if (!b) return;
    const box = stat[mode];
    box.games = Number(b.games) || 0;
    box.rankSum = Number(b.rankSum) || 0;
    box.pointsSum = Number(b.pointsSum) || 0;
    box.maxPoints = (b.maxPoints === null || b.maxPoints === undefined) ? null : Number(b.maxPoints);
    Object.keys(b.rankCounts || {}).forEach((r) => {
      box.rankCounts[r] = Number(b.rankCounts[r]) || 0;
    });
  });
  stat.lastGameDate = baseUntil || '';
  return stat;
}

/** 把当前状态压成快照（不含 openid / lastGameDate 这些身份和游标字段） */
function packBase(stat) {
  return {
    coin: stat.coin || 0,
    gamesTotal: stat.gamesTotal || 0,
    four: JSON.parse(JSON.stringify(stat.four)),
    three: JSON.parse(JSON.stringify(stat.three))
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

/**
 * 分页拉某个玩家的对局（倒序）。云函数单次上限 1000 条。
 *
 * since 传日期时只拉 game_date > since 的部分 —— 有了 base 快照之后，
 * 已经压进快照的历史不用再读。game_date 是 'YYYY-MM-DD'，字符串比较
 * 等价于时间比较（isValidDate 保证格式统一）。
 *
 * 投影掉 nickname / avatar：重算只用到 rank 和 points，头像 URL 一条就
 * 六七十字节，1000 条能省下好几百 KB。
 *
 * 【mode 千万不能省】normalizeMode 对没有 mode 字段的记录按四麻兜底，
 * 投影掉它等于把所有三麻局都算成四麻 —— 三麻只有 3 个名次，混进来
 * 之后顺位率、雀力、麻币全都会歪，而且歪得很隐蔽。
 */
async function fetchGamesOfPlayer(openid, since) {
  const PAGE = 500;
  const out = [];
  for (let skip = 0; skip < 50000; skip += PAGE) {
    const where = { 'players.openid': openid };
    if (since) where.game_date = db_cmd.gt(since);
    const res = await db.collection(db_game)
      .where(where)
      .field({ game_date: true, mode: true, players: true })
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

/**
 * 取一批待归档的对局（game_date <= cutoff），按日期升序。
 *
 * 用升序而不是倒序是刻意的：归档要「从最早的一天往后推」，每处理完
 * 一批就删掉，下一轮再取自然换到下一批，不会被刚删的空洞卡住。
 * 只投影三个字段 —— 归档只需要知道这局是谁、哪天打的、是三麻还是四麻。
 * mode 一定要带上：以后若有人在这里直接算统计，缺了它会静默按四麻处理。
 */
async function fetchGamesBefore(cutoff, limit) {
  const res = await db.collection(db_game)
    .where({ game_date: db_cmd.lte(cutoff) })
    .field({ game_date: true, mode: true, players: true })
    .orderBy('game_date', 'asc').orderBy('create_time', 'asc')
    .limit(limit || 200).get();
  return res.data || [];
}

/** 分页拉全表玩家汇总。rebuildAllStats 要给每个人接上 base，必须先摸清谁有快照 */
async function fetchAllPlayerStats() {
  const PAGE = 1000;
  const out = [];
  for (let skip = 0; skip < 50000; skip += PAGE) {
    const res = await db.collection(db_player).skip(skip).limit(PAGE).get();
    const list = res.data || [];
    out.push.apply(out, list);
    if (list.length < PAGE) break;
  }
  return out;
}

async function getPlayerStat(openid) {
  try {
    const res = await db.collection(db_player).where({ openid: openid }).limit(1).get();
    return (res.data && res.data[0]) || null;
  } catch (err) {
    // 表还没建 = 这个人还没有记录。不能让它把整个重算/读取链路带崩，
    // 后面写库时会自动把表建出来（见 withCollection）。
    if (isCollectionMissing(err)) return null;
    throw err;
  }
}

/** 递归整理字段值：undefined / 函数写成 null，Date 原样保留（转成字符串会丢类型） */
function cleanValue(v) {
  if (v === undefined || typeof v === 'function') return null;
  if (v === null || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(cleanValue);
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = cleanValue(v[k]); });
    return out;
  }
  return v;
}

function errText(err) {
  if (!err) return '未知错误';
  const parts = [];
  if (err.errCode !== undefined) parts.push('code=' + err.errCode);
  if (err.errMsg) parts.push(err.errMsg);
  if (err.message && err.message !== err.errMsg) parts.push(err.message);
  return parts.length ? parts.join(' ') : String(err);
}

/**
 * 把统计对象整理成「能写进数据库」的形状。
 *
 * 必须去掉的两个字段：
 *   · `_id`     —— 由 doc(id) 指定，混在 data 里数据库会直接报错
 *   · `_openid` —— 记录创建者，由云开发自管，整条回写时不允许开发者指定
 *
 * 为什么偏偏手改会踩到：录分/删局走的是 rebuildPlayerStat，从空统计起算，
 * 本来就带不上 `_openid`；手改是「把读出来的文档整条写回去」，读出来什么样
 * 就带着什么样 —— 于是同一句 set，录分成功、手改失败。这个差异不写下来
 * 几乎不可能想到。
 */
function toWritableStat(stat) {
  const doc = cleanValue(stat) || {};
  delete doc._id;
  delete doc._openid;
  doc.updated_at = new Date();
  return doc;
}

/** 判断是不是「表不存在」（云开发 -502005）。读/写都可能撞上 */
function isCollectionMissing(err) {
  if (!err) return false;
  if (Number(err.errCode) === -502005) return true;
  const msg = String(err.errMsg || err.message || '');
  return /-502005|COLLECTION_NOT_EXIST|Table not exist|collection not exists/i.test(msg);
}

/**
 * 建表。微信云开发不像某些数据库那样在首次写入时自动建集合，
 * 缺表时每一句写入都报 -502005，而读路径多半有兜底 —— 表现出来就是
 * 「能看、不能存」，从现象几乎反推不出是缺表。所以缺表时自己补上。
 */
async function ensureCollection(name) {
  if (!db || typeof db.createCollection !== 'function') return false;
  try {
    await db.createCollection(name);
    console.log('[db] 已自动创建集合:', name);
    return true;
  } catch (err) {
    // 已存在也算成功（并发下两个请求同时建，后到的会报已存在）
    const msg = String((err && (err.errMsg || err.message)) || '');
    if (/exist|已存在/i.test(msg)) return true;
    console.warn('[db] 自动创建集合失败:', name, errText(err));
    return false;
  }
}

/** 跑一次写入；若失败原因是缺表，补建后重试一次 */
async function withCollection(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isCollectionMissing(err)) throw err;
    const created = await ensureCollection(name);
    if (!created) throw err;
    return await fn();
  }
}

async function savePlayerStat(stat) {
  const doc = toWritableStat(stat);
  const openid = String((stat && stat.openid) || '');
  if (!openid) throw new Error('记录缺少 openid，无法定位要写的文档');

  const tried = [];
  // 主路径：一人一条，_id 就是 openid
  try {
    await withCollection(db_player, () => db.collection(db_player).doc(openid).set({ data: doc }));
    return;
  } catch (err) {
    tried.push('doc(openid).set → ' + errText(err));
    console.warn('[mahjong_player] doc(openid).set 失败，尝试兜底:', errText(err));
  }

  // 兜底一：控制台手工建过的文档 _id 可能是随机串，按原 _id 写回
  const rawId = stat && stat._id ? String(stat._id) : '';
  if (rawId && rawId !== openid) {
    try {
      await withCollection(db_player, () => db.collection(db_player).doc(rawId).set({ data: doc }));
      return;
    } catch (err) {
      tried.push('doc(_id).set → ' + errText(err));
    }
  }

  // 兜底二：按 openid 条件更新（文档已存在时一定走得通）
  try {
    const res = await withCollection(db_player,
      () => db.collection(db_player).where({ openid: openid }).update({ data: doc }));
    const n = res && res.stats ? res.stats.updated : 0;
    if (n > 0) return;
    tried.push('where(openid).update → 影响 0 条');
  } catch (err) {
    tried.push('where(openid).update → ' + errText(err));
  }

  throw new Error(tried.join('；'));
}

/**
 * 重算单个玩家（删局、改分、补录历史局之后用）。
 *
 * 有 base 时只重放 baseUntil 之后的局 —— 明细里 <= baseUntil 的部分
 * 已经被归档删掉了，读也读不到。
 *
 * opts.invalidateBefore  被改动/删除的那局的日期。**超过归档线时直接抛错**：
 *                        那一段明细已经不存在了，base 里存的是聚合值，
 *                        把新数字插进去在数学上做不到，作废 base 等于
 *                        永久丢掉这段历史。调用方必须先在入口处拦下来。
 *
 * 唯一不变量：这次算出的结果，必须与「用 base 起手 + 重放全部剩余明细」
 * 逐字节一致。测试里有一条混沌序列专门盯它。
 */
async function rebuildPlayerStat(openid, opts) {
  const opt = opts || {};

  const cur = await getPlayerStat(openid);
  const base = (cur && cur.base) || null;
  const baseUntil = (cur && cur.baseUntil) || '';

  if (base && baseUntil && opt.invalidateBefore &&
      String(opt.invalidateBefore) <= baseUntil) {
    const err = new Error('ARCHIVE_LOCKED');
    err.code = 'ARCHIVE_LOCKED';
    err.archiveUntil = baseUntil;
    err.touched = String(opt.invalidateBefore);
    throw err;
  }

  const recent = await fetchGamesOfPlayer(openid, baseUntil);   // 倒序
  const stat = statFromBase(openid, base, baseUntil);
  for (let i = recent.length - 1; i >= 0; i -= 1) applyGameToStat(stat, recent[i], openid);
  if (!recent.length) stat.lastGameDate = baseUntil || '';

  await savePlayerStat(stat);
  return stat;
}

/**
 * 把某个玩家 <= cutoff 的明细折算进 base 快照。
 *
 * 只改 mahjong_player，不删明细 —— 删除是 archiveOldGames 统一做的事，
 * 而且要等这一批里所有参与者都折算完才敢删。这样即使中途失败，
 * 也只是「快照多算了一点、明细还在」，下次重跑是幂等的。
 *
 * 返回 rolled = 本次折叠的局数，0 表示这个人没有需要归档的局。
 */
async function rollupPlayer(openid, cutoff) {
  const cur = await getPlayerStat(openid);
  const base = (cur && cur.base) || null;
  const baseUntil = (cur && cur.baseUntil) || '';

  // 已经归档过这一天（或更晚），无事可做。
  // 这一条短路让「同一批里同一个人出现多次」几乎不花成本。
  if (baseUntil && baseUntil >= cutoff) return { rolled: 0 };

  const recent = await fetchGamesOfPlayer(openid, baseUntil);   // 全部 > baseUntil，倒序
  const old = recent.filter(g => (g.game_date || '') <= cutoff);
  if (!old.length) return { rolled: 0 };

  // old 是倒序，old[0] 就是这批里最新的一天 —— 快照正好覆盖到它。
  const newBaseUntil = old[0].game_date || '';

  const frozen = statFromBase(openid, base, baseUntil);
  for (let i = old.length - 1; i >= 0; i -= 1) applyGameToStat(frozen, old[i], openid);
  const newBase = packBase(frozen);

  // 再把留在窗口里的局重放到新快照上，得到完整的当前状态
  const stat = statFromBase(openid, newBase, newBaseUntil);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if ((recent[i].game_date || '') > cutoff) applyGameToStat(stat, recent[i], openid);
  }
  if (!recent.length) stat.lastGameDate = newBaseUntil;

  await savePlayerStat(stat);
  return { rolled: old.length, baseUntil: newBaseUntil };
}

/**
 * 全量重建：给「首次上线回填」和「数据对不上时兜底」用，日常不走这里。
 *
 * 【关键】必须先用现有的 base 给每个人起手。归档过的明细已经删了，
 * 如果还按「从零遍历所有对局」来算，被归档的那段历史会整段蒸发 ——
 * 汇总表看起来「重建了」，实际是悄悄少了几十局。这是本方案里最危险的
 * 一个坑：明细不再是完整的真相源，base 才是那段历史的唯一载体。
 *
 * 顺带：baseUntil 之后才重放，所以同一个玩家的对局不会被算两遍。
 */
async function rebuildAllStats() {
  const map = {};

  const existing = await fetchAllPlayerStats();
  existing.forEach(s => {
    if (!s || !s.openid) return;
    const stat = statFromBase(s.openid, s.base || null, s.baseUntil || '');
    stat.archiveUntil = s.archiveUntil || s.baseUntil || '';
    map[s.openid] = stat;
  });

  const games = await fetchAllGames();     // 倒序
  for (let i = games.length - 1; i >= 0; i -= 1) {
    const g = games[i];
    (g.players || []).forEach(p => {
      if (!p || !p.openid) return;
      if (!map[p.openid]) map[p.openid] = emptyPlayerStat(p.openid);
      // 已经压进 base 的局不再重放
      if ((g.game_date || '') <= (map[p.openid].baseUntil || '')) return;
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
 * 归档：把 <= cutoff 的明细折算进各自的 base，然后删掉这些明细。
 *
 * 分三步，顺序不能反：
 *   1. 取一批待归档的局（升序，最早的一批）
 *   2. 对涉及到的每个玩家 rollupPlayer —— 只写汇总表，不动明细
 *   3. 复核「这批里每一局的每个参与者，baseUntil 都已覆盖该局日期」，
 *      确认无误才删。任何一个人折算失败，这一局就留着，下次再试。
 *
 * 分批而不是一次做完：首次上线可能积压几千局，一轮 20 秒跑不完会超时。
 * 因为第 3 步是「删掉已确认的」，下一轮取到的自然是剩下的，天然幂等。
 */
async function archiveOldGames(opts) {
  const opt = opts || {};
  const cutoff = opt.cutoff || archiveCutoff(opt.today);
  const BATCH = Number(opt.batch) > 0 ? Number(opt.batch) : 200;
  const MAX_ROUNDS = Number(opt.maxRounds) > 0 ? Number(opt.maxRounds) : 50;

  let removed = 0;
  let rolled = 0;
  const failedPlayers = [];
  const confirmed = new Set();     // 本轮已确认归档到 cutoff 的玩家，跨批复用
  // 跨批缓存：同一个人会在很多批里反复出现，每批都重查一次纯属浪费。
  // 这里缓存的是「折算完成后」的汇总，baseUntil 不会再变。
  const statCache = {};

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const batch = await fetchGamesBefore(cutoff, BATCH);
    if (!batch.length) break;

    const pending = [];            // 本批新出现、还没折算过的玩家
    batch.forEach(g => (g.players || []).forEach(p => {
      const oid = p && p.openid;
      if (oid && !confirmed.has(oid) && pending.indexOf(oid) < 0) pending.push(oid);
    }));

    for (const oid of pending) {
      try {
        const r = await rollupPlayer(oid, cutoff);
        rolled += r.rolled;
        confirmed.add(oid);
        statCache[oid] = await getPlayerStat(oid);
      } catch (err) {
        console.error('[archive] 折算失败:', oid, err && err.message);
        if (failedPlayers.indexOf(oid) < 0) failedPlayers.push(oid);
      }
    }

    // 复核：这一局**每个**参与者都得折算到位，才敢删。
    // 少一个人没折算完就删，那个人的历史就永久少了这一局。
    const deletable = batch.filter(g => (g.players || []).every(p => {
      const s = statCache[p.openid] || null;
      return !!s && (s.baseUntil || '') >= (g.game_date || '');
    }));

    if (!deletable.length) {
      // 这一批全都不满足条件：说明涉及到的玩家折算失败，再取下一批也是同样
      // 的日期区间，会原地打转。直接退出，等下次重试。
      console.warn('[archive] 本批无一条可删，停止本轮（cutoff=%s）', cutoff);
      break;
    }

    let roundRemoved = 0;
    for (let i = 0; i < deletable.length; i += 100) {
      const ids = deletable.slice(i, i + 100).map(g => g._id);
      try {
        const res = await db.collection(db_game).where({ _id: db_cmd.in(ids) }).remove();
        roundRemoved += (res && res.stats && res.stats.removed) || ids.length;
      } catch (err) {
        console.error('[archive] 删除明细失败:', err && err.message);
      }
    }
    removed += roundRemoved;

    // 一条都没删掉就说明卡住了（比如删权限问题），再循环是原地打转
    if (!roundRemoved) break;

    // 取到的批次比预期小，说明已经到尾部了
    if (batch.length < BATCH) break;
  }

  return { cutoff, removed, rolled, failed: failedPlayers };
}

/**
 * 录分后的同步：新局一定是最新一局，可以增量；
 * 但如果补录的是历史日期（早于该玩家已纳入统计的最新一局），
 * 它在时间轴上不落在末尾，麻币的推进顺序会变，只能整人重算。
 *
 * 【归档线拦截】早于 baseUntil 的日期直接拒绝。那一段明细已经被删，
 * base 里只有聚合值（局数、顺位和、麻币余额），没有逐局的先后关系。
 * 硬要把一局塞进去，只能作废 base —— 而那等于把这段历史永久删掉。
 * 这不是「暂不支持」，是没有办法做到，所以必须明确报错。
 */
async function syncStatAfterAdd(game, openid) {
  const cur = await getPlayerStat(openid);
  const baseUntil = (cur && cur.baseUntil) || '';
  if (baseUntil && (game.game_date || '') <= baseUntil) {
    const err = new Error('ARCHIVE_LOCKED');
    err.code = 'ARCHIVE_LOCKED';
    err.archiveUntil = baseUntil;
    err.touched = game.game_date || '';
    throw err;
  }
  if (!cur || (game.game_date || '') < (cur.lastGameDate || '')) {
    return await rebuildPlayerStat(openid, { invalidateBefore: game.game_date });
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

/* ============================================================
 * 管理员手改玩家数据（直接读写 mahjong_player 那条记录）
 *
 * 页面读到的是这条记录本身，改完写回去，记录里就是新数字 ——
 * 没有第二层「覆盖值」，也没有「自动值 / 手填值」两套语义。
 *
 * 【能改的字段】
 *   · 麻币             —— 唯一不能从明细反推的量（逐局钳制有顺序依赖）
 *   · 各顺位次数        —— 顺位率和平均顺位的来源
 *   · 最高点数          —— 纯展示值，不参与任何派生计算
 *
 * 【不能改的字段】
 *   · 局数 = Σ(各顺位次数)，随「各顺位次数」的变化自动平移。
 *     每录一局 games 与 rankCounts 是同一行代码同步 +1 的，所以两者
 *     在结构上恒等（不可能出现「加了局数却没有名次」），单独让管理员
 *     填局数只会制造出明细复现不出来的不对称状态
 *   · 顺位和 = Σ(名次 × 该名次次数)，同样随次数平移。
 *     让人自己去凑 1×c1+2×c2+3×c3+4×c4，只会和次数互相矛盾
 *   · 点数和 没有对应的分布字段可推，只能随明细走；要纠正去「全部对局」改那一局
 *
 * 想加 N 局 → 去加对应位次的次数（一共 +N），局数和顺位和会一起跟上。
 *
 * 【为什么手改还要同步 base 快照】
 * 汇总表随时可能被整体重算：改分、删局、每天 4 点的归档、手动重建，
 * 走的都是「base 快照 + 重放保留期内的明细」，算完 set() 整条覆盖。
 * 如果手改只写顶层数字，下一次重算就把它洗掉，而且不留任何痕迹。
 * 所以手改的增量同时写进 base —— 语义上等于「这段历史的累计值本来
 * 就是这个数」，之后重算、归档、全量重建都会带着它走。
 *
 * 【由此得到的硬约束：改小有下限】
 * base 是非负累计量，所以一个字段最多只能减到「base 已经吸收的部分」；
 * 麻币的下限则是「保留期内明细钳制出来的量」。想真正减少，只能去
 * 「全部对局」删掉或修正那一局 —— 硬把数字改得比明细还小，下次重算
 * 就会被拉回去，那才是真正的静默不一致。
 * ============================================================ */

/** 允许手改的字段（扁平 path）。派生值和游标类字段一律拒绝 */
function isEditablePath(path) {
  if (path === 'coin') return true;
  const parts = String(path).split('.');
  const mode = parts[0];
  if (mode !== 'four' && mode !== 'three') return false;
  if (parts.length === 2) return parts[1] === 'maxPoints';   // 局数不在此列：由次数推出来
  if (parts.length === 3 && parts[1] === 'rankCounts') {
    const r = Number(parts[2]);
    return r >= 1 && r <= (mode === 'three' ? 3 : 4);
  }
  return false;
}

/** 被拒绝的常见字段给出具体出路，不要笼统说「不允许修改」 */
const DERIVED_MSG = {
  games: '局数就是各顺位次数之和，不用填 —— 想加几局，就把对应位次的次数加上去，它会自己跟上。',
  rankSum: '顺位和由各顺位次数自动算出，不用填 —— 改「N 位次数」它就会跟着变。',
  pointsSum: '点数和由对局自动累计，改不了。要纠正它，请到「全部对局」修改或删除那一局。',
};

/** path -> 中文名，只给报错信息和变更历史用 */
function labelOfPath(path) {
  if (path === 'coin') return '麻币';
  const parts = String(path).split('.');
  // 顶层标量（gamesTotal 之类）没有模式前缀，单独映射，别拼出「gamesTotalundefined」
  if (parts.length < 2) {
    const flat = { gamesTotal: '总对局数', openid: 'openid' };
    return flat[path] || String(path);
  }
  const prefix = MODE_LABEL[parts[0]] || parts[0];
  if (parts[1] === 'rankCounts') return prefix + parts[2] + '位次数';
  const map = { games: '局数', rankSum: '顺位和', pointsSum: '点数和', maxPoints: '最高点数' };
  return prefix + (map[parts[1]] || parts[1]);
}


/** 读变更历史。集合没建或查询失败都降级成空数组，不能拖垮改数据页
 *
 * field 存在是「新格式日志」的判据：这个集合在改成留痕表之前存过覆盖值，
 * 那些老文档只有 openid 没有 field，必须过滤掉，否则会被当成一条空变更渲染出来。
 */
async function readStatLogs(openid, limit) {
  if (!openid) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  try {
    const res = await db.collection(db_log)
      .where({ openid, field: db_cmd.exists(true) })
      .orderBy('at', 'desc')
      .limit(n)
      .get();
    return res.data || [];
  } catch (err) {
    console.warn('[mahjong_adjust] 读取修改记录失败，按无记录处理:', err && err.errMsg);
    return [];
  }
}

/** 追加一批变更记录（一条一次变更，永不改写已有记录）
 *
 * 日志是附属品：写失败只打日志，不能让本次保存失败 ——
 * 数据已经落库了，历史少一条比「保存报错但其实存进去了」要好。
 */
async function appendStatLogs(entries) {
  if (!entries || !entries.length) return 0;
  const results = await Promise.all(entries.map(e =>
    // 集合没建时先补建再写，否则改动历史会一条都留不下来
    withCollection(db_log, () => db.collection(db_log).add({ data: e }))
      .then(() => 1)
      .catch((err) => {
        console.warn('[mahjong_adjust] 写修改记录失败:', err && err.errMsg);
        return 0;
      })
  ));
  return results.reduce((a, b) => a + b, 0);
}

/** 按 path 取值（path 形如 four.rankCounts.1） */
function valueAtPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 把 path 写进嵌套结构 */
function writeAtPath(target, path, value) {
  const keys = String(path).split('.');
  let cur = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 校验并规整管理员提交的字段（扁平 path -> 数值）。
 */
function normalizeStatValues(input) {
  const values = {};
  if (!input || typeof input !== 'object') return { values, errMsg: '' };

  const paths = Object.keys(input);
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    const label = labelOfPath(path);
    if (!isEditablePath(path)) {
      const key = String(path).split('.').pop();
      return {
        values: {},
        errMsg: DERIVED_MSG[key] || ('「' + label + '」不能手改，它由对局自动累计。')
      };
    }

    const n = Number(input[path]);
    if (!Number.isFinite(n)) return { values: {}, errMsg: label + ' 必须是数字' };
    if (!Number.isInteger(n)) return { values: {}, errMsg: label + ' 必须是整数' };
    if (n < 0) return { values: {}, errMsg: label + ' 不能为负数' };

    values[path] = n;
  }
  return { values: values, errMsg: '' };
}

/**
 * 把手改应用到记录上。
 *
 * · gamesTotal 是四麻 + 三麻的合计，必须跟着重算
 * · 局数 = Σ(各顺位次数)，跟着次数的变化量平移：次数合计 +N，局数就 +N
 * · 顺位和 = Σ(名次 × 次数)，同样跟着平移：某一位次数 +1，顺位和 + 该名次
 *
 * 都是增量平移、不是「按次数全量重算」。原因：base 快照里可能存着历史差额
 * （旧版本数据、之前手工修过），全量重算会把那部分历史压掉；平移只吸收
 * 这次改动的部分，存量原样不动。
 */
function applyStatEdits(stored, values) {
  const next = JSON.parse(JSON.stringify(stored));

  // 先记下改之前的次数，用来推导局数 / 顺位和应该平移多少
  const before = {};
  ['four', 'three'].forEach((mode) => {
    const counts = (stored && stored[mode] && stored[mode].rankCounts) || {};
    before[mode] = {};
    for (let r = 1; r <= 4; r += 1) before[mode][r] = Number(counts[r]) || 0;
  });

  Object.keys(values).forEach((path) => writeAtPath(next, path, values[path]));

  ['four', 'three'].forEach((mode) => {
    if (!next[mode]) return;
    if (!next[mode].rankCounts) next[mode].rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let dGames = 0;    // ΣΔ次数 -> 局数
    let dRank = 0;     // Σ(名次 × Δ次数) -> 顺位和
    for (let r = 1; r <= 4; r += 1) {
      const d = (Number(next[mode].rankCounts[r]) || 0) - before[mode][r];
      if (!d) continue;
      dGames += d;
      dRank += d * r;
    }
    if (dGames) next[mode].games = (Number(next[mode].games) || 0) + dGames;
    if (dRank) next[mode].rankSum = (Number(next[mode].rankSum) || 0) + dRank;
  });

  next.gamesTotal = (Number(next.four && next.four.games) || 0) +
                    (Number(next.three && next.three.games) || 0);
  return next;
}

/**
 * 自洽性校验：局数、顺位和、顺位次数三者必须能对上，
 * 否则页面上会出现「平均顺位 0.83」或「一位率 130%」这种明显荒谬的值。
 *
 * 局数现在是跟着次数平移的，正常路径下 games ≡ countSum，这条基本不会触发；
 * 留着挡两类脏数据：历史记录里次数本来就记全不了，以及万一哪天又把局数
 * 加回可改字段、有人只改局数不改次数。
 */
function statConsistency(stat) {
  const errors = [];
  ['four', 'three'].forEach((mode) => {
    const box = (stat && stat[mode]) || emptyModeBox();
    const label = MODE_LABEL[mode];
    const topRank = mode === 'three' ? 3 : 4;
    const games = Number(box.games) || 0;
    const rankSum = Number(box.rankSum) || 0;
    let countSum = 0;
    for (let r = 1; r <= topRank; r += 1) {
      countSum += Number((box.rankCounts || {})[r]) || 0;
    }
    if (games > 0) {
      if (countSum > games) {
        errors.push(`${label}：顺位次数合计 ${countSum} 超过局数 ${games}`);
      } else if (rankSum < games || rankSum > games * topRank) {
        // 顺位和是次数推出来的，加局数却不加次数必然撑不住，直接点出缺多少
        errors.push(countSum < games
          ? `${label}：有 ${games - countSum} 局没有名次归属，顺位和 ${rankSum} 撑不住 ${games} 局 —— 请同时补上各顺位次数`
          : `${label}：${games} 局的顺位和应在 ${games}~${games * topRank} 之间，当前 ${rankSum}`);
      }
    } else if (rankSum > 0 || countSum > 0) {
      errors.push(`${label}：局数为 0 时，顺位和与顺位次数都必须为 0`);
    }
  });
  return errors.length ? errors.join('；') : '';
}

/**
 * 把手改同步进 base 快照。
 *
 * base 是「归档前那段历史的累计值」，以后每次重算都以它为起点。手改如果
 * 只写顶层数字，下一次重算（改分、删局、每日归档、手动重建）就会把改过的
 * 数字洗回去，而且不留痕迹 —— 所以必须同时落进 base。
 *
 * 规则：
 *   · 局数 / 顺位和 / 点数和 / 顺位次数是纯累加量，按「记录的变化量」平移
 *   · 最高点数取最大值而非累加，直接把目标值写进快照
 *   · 麻币有「逐局钳制在 0」，平移会改变钳制发生的时机（差一两个币），
 *     所以沿明细从最新往回反解，再正推验算一遍
 *   · 平移后 base 出现负数 = 想把数字改得比明细还小，这种改动活不过
 *     下一次重算，当场拒绝比事后静默拉回要好
 *
 * 传的是 next（已经应用过手改的完整记录），因为局数和顺位和都是从次数
 * 推出来的、不在 values 里 —— 只能比较前后差值才知道该往 base 平移多少。
 */
async function shiftBase(openid, stored, next) {
  const oldBase = stored.base || null;
  const base = oldBase ? JSON.parse(JSON.stringify(oldBase))
    : { coin: 0, gamesTotal: 0, four: emptyModeBox(), three: emptyModeBox() };
  ['four', 'three'].forEach((mode) => {
    if (!base[mode]) base[mode] = emptyModeBox();
    if (!base[mode].rankCounts) base[mode].rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  });

  const num = (o, k) => Number(o && o[k]) || 0;
  const ACC = ['games', 'rankSum', 'pointsSum'];

  for (let i = 0; i < 2; i += 1) {
    const mode = i === 0 ? 'four' : 'three';
    const was = stored[mode] || {};
    const now = next[mode] || {};

    // 先查次数：局数的变化量是次数变化量推出来的，减少时先报「N 位次数」，
    // 提示才指着用户真正动过的那一栏（否则会说成「四麻局数最低只能到 N」）
    for (let r = 1; r <= 4; r += 1) {
      const delta = num(now.rankCounts, r) - num(was.rankCounts, r);
      if (!delta) continue;
      const absorbed = num(base[mode].rankCounts, r);
      if (absorbed + delta < 0) {
        return {
          base: base,
          errMsg: '「' + labelOfPath(mode + '.rankCounts.' + r) + '」最低只能到 ' + (num(was.rankCounts, r) - absorbed) +
            '：保留期内的对局还会把它加回来。要真正减少，请到「全部对局」删掉或修正那一局。'
        };
      }
      base[mode].rankCounts[r] = absorbed + delta;
    }

    for (let j = 0; j < ACC.length; j += 1) {
      const k = ACC[j];
      const delta = num(now, k) - num(was, k);
      if (!delta) continue;
      const absorbed = num(base[mode], k);
      if (absorbed + delta < 0) {
        return {
          base: base,
          errMsg: '「' + labelOfPath(mode + '.' + k) + '」最低只能到 ' + (num(was, k) - absorbed) +
            '：保留期内的对局还会把它加回来。要真正减少，请到「全部对局」删掉或修正那一局。'
        };
      }
      base[mode][k] = absorbed + delta;
    }

    // 最高点数是取最大值，平移没有意义，直接写目标值
    if (num(now, 'maxPoints') !== num(was, 'maxPoints')) {
      base[mode].maxPoints = now.maxPoints;
    }
  }

  // ---- 麻币：反解，不能平移 ----
  const coinBefore = num(stored, 'coin');
  const coinAfter = num(next, 'coin');
  if (coinAfter !== coinBefore) {
    const games = await fetchGamesOfPlayer(openid, stored.baseUntil || '');
    const solved = solveBaseCoin(coinAfter, games, openid);
    const check = replayCoin(solved, games, openid);
    if (check !== coinAfter) {
      return {
        base: base,
        errMsg: '「麻币」最低只能到 ' + check + '：保留期内对局的钳制决定了这个下限。' +
          '要真正减少，请到「全部对局」删掉或修正那一局。'
      };
    }
    base.coin = solved;
  }

  base.gamesTotal = num(base.four, 'games') + num(base.three, 'games');
  return { base: base, errMsg: '' };
}

/** 一局给某人带来的麻币变动（与 applyGameToStat 同一套规则） */
function coinDeltaOf(game, openid) {
  const mine = (game.players || []).find(p => p.openid === openid);
  if (!mine) return undefined;
  return COIN_BY_RANK[normalizeMode(game)][Number(mine.rank) || 0];
}

/**
 * 反解 base.coin：钳制是 max(0, ·)，它的逆也是 max(0, ·−d)。
 * games 必须是倒序（最新在前），从最新一局往回推到最早一局。
 */
function solveBaseCoin(target, gamesDesc, openid) {
  let x = target;
  for (let i = 0; i < gamesDesc.length; i += 1) {
    const d = coinDeltaOf(gamesDesc[i], openid);
    if (d === undefined) continue;
    x = Math.max(0, x - d);
  }
  return x;
}

/** 正推验算：从反解出的 base.coin 出发重放，确认真的落在目标值上 */
function replayCoin(baseCoin, gamesDesc, openid) {
  let y = baseCoin;
  for (let i = gamesDesc.length - 1; i >= 0; i -= 1) {
    const d = coinDeltaOf(gamesDesc[i], openid);
    if (d === undefined) continue;
    y = Math.max(0, y + d);
  }
  return y;
}

/** 对外暴露的统计形状：base 是内部快照，不发给前端（只会让人困惑） */
function publicStat(stat) {
  const box = (mode) => {
    const b = (stat && stat[mode]) || emptyModeBox();
    const top = mode === 'three' ? 3 : 4;
    const rankCounts = {};
    for (let r = 1; r <= top; r += 1) rankCounts[r] = Number((b.rankCounts || {})[r]) || 0;
    return {
      games: Number(b.games) || 0,
      rankSum: Number(b.rankSum) || 0,
      pointsSum: Number(b.pointsSum) || 0,
      maxPoints: (b.maxPoints === null || b.maxPoints === undefined) ? null : Number(b.maxPoints),
      rankCounts: rankCounts
    };
  };
  return {
    openid: stat.openid,
    coin: Number(stat.coin) || 0,
    gamesTotal: Number(stat.gamesTotal) || 0,
    four: box('four'),
    three: box('three'),
    lastGameDate: stat.lastGameDate || '',
    baseUntil: stat.baseUntil || '',
    archiveUntil: stat.archiveUntil || stat.baseUntil || '',
    updated_at: stat.updated_at || null
  };
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
  const synced = [];        // 已经算进汇总的玩家，回滚时要把他们退回去
  try {
    const added = Object.assign({}, doc, { _id: gameId });
    for (let i = 0; i < doc.players.length; i += 1) {
      await syncStatAfterAdd(added, doc.players[i].openid);
      synced.push(doc.players[i].openid);
    }
  } catch (err) {
    console.error('同步玩家统计失败，回滚本局:', err);

    try {
      await db.collection(db_game).doc(gameId).remove();
    } catch (e2) {
      console.error('回滚对局失败，需手动重建统计:', e2);
      return { success: false, errMsg: '统计同步失败且回滚未完成，请到管理入口执行一次「重建统计」' };
    }

    // 回滚明细之后，前面已经算进汇总的人还多着一局，必须退回来。
    // 只做加法不做减法的路径（增量）没法反向抠掉，只能重算。
    for (const oid of synced) {
      try {
        await rebuildPlayerStat(oid);
      } catch (e3) {
        console.error('回滚统计失败:', oid, e3);
      }
    }

    if (err && err.code === 'ARCHIVE_LOCKED') {
      return {
        success: false,
        errMsg: `对局记录只保留最近 ${ARCHIVE_DAYS} 天，` +
          `早于 ${err.archiveUntil} 的历史已折算进战绩、不能再补录（本局为 ${err.touched}）`
      };
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

  // 【归档线校验】改成更早的日期，等于往已经算好的历史里插一局。
  // base 里只有聚合值，插不进去；唯一的办法是作废 base，而那会把
  // 这段已经删掉明细的历史一起丢掉。所以在写库之前就拦死。
  //
  // 只改点数、或把日期往后改时，touchedDate 是原日期，一定在归档线
  // 之后（局还在明细里，说明它没被归档），不会误拦。
  const touchedDate = (game.game_date || '') < game_date ? (game.game_date || '') : game_date;
  const statList = await Promise.all(newPlayers.map(p => getPlayerStat(p.openid)));
  const lockedBy = statList
    .map(s => (s && s.baseUntil) || '')
    .filter(bu => bu && touchedDate <= bu)[0];
  if (lockedBy) {
    return {
      success: false,
      errMsg: `对局记录只保留最近 ${ARCHIVE_DAYS} 天，` +
        `不能把日期改到 ${lockedBy} 之前（那是已归档的历史）`
    };
  }

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
      await rebuildPlayerStat(newPlayers[i].openid, { invalidateBefore: touchedDate });
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
 *     four:  { mode, topRank, games, rankCounts, rankRates,
 *              pointsSum, avgRank, avgPoints, maxPoints, power, recent },
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

  // 读出来的就是记录本身：管理员手改的增量已经落在这条记录里（见 shiftBase）

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
      // 末位率与四位率/三位率是同一个数（末位就是最末一位），已从页面撤下，
      // 换成「累计点数」pointsSum —— 它和平均点数互补：一个总量、一个单局均值
      flyRate: total ? +(rankCounts[topRank] * 100 / total).toFixed(2) : 0,
      pointsSum: total ? Number(box.pointsSum || 0) : null,
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
      })),
      // 趋势图只画保留期内的明细，比这更早的已经折算进上面的局数/顺位率，
      // 前端据此提示，免得「趋势图突然变短」被当成数据丢失
      retentionDays: ARCHIVE_DAYS,
      archiveUntil: stat.archiveUntil || stat.baseUntil || ''
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
 *
 * 库里只有最近 ARCHIVE_DAYS 天的明细，翻到底就没了 —— 这不是分页 bug。
 * 顺手把保留天数带回去，前端才能在列表末尾说明「更早的已折算进战绩」，
 * 而不是让人以为数据丢了。
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
    return {
      success: true,
      data: list,
      retentionDays: ARCHIVE_DAYS,
      archiveCutoff: archiveCutoff()
    };
  } catch (err) {
    console.error('查询对局列表失败:', err);
    return { success: false, errMsg: '查询对局列表失败' };
  }
}

/**
 * 归档入口（仅管理员）
 *
 * 定时器每天会自动跑一次，这个入口是给「手动补一次」用的：
 * 首次上线、或者定时器没配好的时候，管理员点一下就把积压的历史清掉。
 */
async function archiveMain(event, context) {
  const auth = await requireAdmin(event);
  if (auth.errMsg) return { success: false, errMsg: auth.errMsg };

  const params = event.params || {};
  try {
    // 整个 params 透传，支持 today / batch / maxRounds 覆盖（运维和测试会用到）
    const r = await archiveOldGames(params);
    console.log('[archive] 完成', JSON.stringify(r));
    return { success: true, data: r };
  } catch (err) {
    console.error('[archive] 失败:', err);
    return { success: false, errMsg: '归档失败：' + (err.message || '未知错误') };
  }
}

/**
 * 定时触发器入口（每天 4:00）
 *
 * 不走 requireAdmin —— 触发器的 event 里没有 OPENID，校验一定失败。
 * 这个函数只做一件事：删掉超过保留期的明细，删之前先把值折算进汇总。
 */
async function timerArchive(event, context) {
  try {
    const r = await archiveOldGames({});
    console.log('[archive] 定时归档完成', JSON.stringify(r));
    return { success: true, data: r };
  } catch (err) {
    console.error('[archive] 定时归档失败:', err);
    return { success: false, errMsg: String(err && err.message) };
  }
}

/**
 * 全量重建玩家统计（仅管理员）
 *
 * 用于：首次上线回填、手动改过数据库之后对齐、怀疑汇总漂了时兜底。
 *
 * 注意它并不是「从明细重来」—— 超过保留期的明细已经被删，重建会
 * 沿用每个人现有的 base 快照接续计算。也就是说这个入口能把保留期内
 * 的偏差抹平，但修不了 base 本身出错的情况（那时只能手工改数据）。
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

/* ============================================================
 * 管理员手改玩家数据
 *   · mahjongGetPlayerStatDetail 读 mahjong_player 那条记录 + 变更历史
 *   · mahjongSetPlayerStat       写回记录（逐字段记日志）
 * ============================================================ */

/** 校验操作者身份与权限，返回 { openid, user, errMsg } */
async function requireAdmin(event) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event?.params?.openid;
  if (!openid) return { openid: '', user: null, errMsg: '无法获取操作者身份' };

  let me = null;
  try {
    me = await db.collection(db_user).where({ openid }).get();
  } catch (err) {
    return { openid, user: null, errMsg: '查询操作者信息失败' };
  }
  if (!me.data || me.data.length === 0) return { openid, user: null, errMsg: '未查询到操作者信息' };
  const role = me.data[0].role;
  if (role !== 'admin' && role !== 'master') {
    return { openid, user: me.data[0], errMsg: '无权限，仅管理员可修改玩家数据' };
  }
  return { openid, user: me.data[0], errMsg: '' };
}

/** 取某玩家的统计记录（没有记录就现算一次；从没打过牌的返回空统计） */
async function loadPlayerStat(openid) {
  let stat = null;
  try {
    stat = await getPlayerStat(openid);
  } catch (err) {
    stat = null;
  }
  if (!stat) {
    try {
      stat = await rebuildPlayerStat(openid);
    } catch (err) {
      stat = emptyPlayerStat(openid);
    }
  }
  return stat;
}

async function getPlayerStatDetailMain(event, context) {
  const auth = await requireAdmin(event);
  if (auth.errMsg) return { success: false, errMsg: auth.errMsg };

  const params = event.params || {};
  const openid = params.openid;
  if (!openid) return { success: false, errMsg: '未指定玩家' };

  const stat = await loadPlayerStat(openid);
  const logs = await readStatLogs(openid, 100);
  console.log('[stat] 读取玩家记录', openid, '四麻', (stat.four || {}).games, '三麻', (stat.three || {}).games, '历史', logs.length);

  return {
    success: true,
    data: {
      stat: publicStat(stat),
      logs: logs
    }
  };
}

/**
 * 改玩家记录。目前只有麻币能改（其余字段由明细自动累计，见上方说明）。
 *
 * params.values 是扁平 path -> 新值，只传改动过的字段：
 *   { coin: 12 }
 *
 * 流程：读记录 → 覆盖字段 → 增量写进 base → 整条写回 → 记历史。
 */
async function setPlayerStatMainInner(event, context) {
  const auth = await requireAdmin(event);
  if (auth.errMsg) return { success: false, errMsg: auth.errMsg };

  const params = event.params || {};
  const openid = params.openid;
  if (!openid) return { success: false, errMsg: '未指定玩家' };

  const normalized = normalizeStatValues(params.values);
  if (normalized.errMsg) return { success: false, errMsg: normalized.errMsg };
  const values = normalized.values;
  if (!Object.keys(values).length) return { success: false, errMsg: '没有需要修改的字段' };

  const stored = await loadPlayerStat(openid);
  const next = applyStatEdits(stored, values);

  // 改完之后局数 / 顺位和 / 顺位次数必须还能对上，
  // 否则页面上会出现「平均顺位 0.83」或「一位率 130%」这种荒谬值
  const bad = statConsistency(next);
  if (bad) return { success: false, errMsg: bad };

  const shifted = await shiftBase(openid, stored, next);
  if (shifted.errMsg) return { success: false, errMsg: shifted.errMsg };

  // 只有真的变了才写，并逐字段留痕
  const now = new Date();
  const by = (auth.user && auth.user.nickname) || auth.openid;
  const note = String(params.note || '').slice(0, 200);
  const changes = Object.keys(values)
    .filter(path => Number(valueAtPath(stored, path)) !== Number(values[path]))
    .map(path => ({
      openid: openid,
      at: now,
      by: by,
      field: path,
      before: valueAtPath(stored, path),
      after: values[path],
      note: note
    }));

  // 局数、顺位和都不接受手改，但会随次数自动平移 —— 也要留痕，
  // 否则事后只看到次数变了，看不出局数和顺位和为什么也跟着变
  ['four', 'three'].forEach((mode) => {
    ['games', 'rankSum'].forEach((key) => {
      const path = mode + '.' + key;
      const b = Number(valueAtPath(stored, path)) || 0;
      const a = Number(valueAtPath(next, path)) || 0;
      if (a === b) return;
      changes.push({
        openid: openid,
        at: now,
        by: by,
        field: path,
        before: b,
        after: a,
        note: note || '随各顺位次数自动调整'
      });
    });
  });

  if (!changes.length) return { success: false, errMsg: '数值没有变化' };

  next.openid = openid;
  next.base = shifted.base;
  next.baseUntil = stored.baseUntil || '';                       // 手改不改变「哪些明细还在」
  next.archiveUntil = stored.archiveUntil || stored.baseUntil || '';
  next.updated_at = now;

  try {
    await savePlayerStat(next);
  } catch (err) {
    // 不要把原因吞掉：以前这里只回一句「请重试」，线上根本没法定位
    console.error('保存玩家统计失败:', err);
    return { success: false, errMsg: '保存失败：' + ((err && err.message) || '未知原因') };
  }

  // 数据落库之后再记历史；历史写失败不影响本次保存的结果
  const logged = await appendStatLogs(changes);

  return { success: true, data: { stat: publicStat(next), changes: changes, logged: logged } };
}

/**
 * 对外入口：把内部异常收成一条能看懂的话。
 *
 * 原样抛出去的话，云开发那边只会给前端一个空的 result，页面就只能显示
 * 「未知错误」—— 既不知道是自己填错了还是代码坏了。这里至少把异常消息
 * 带回去，管理员能直接照着报。
 */
async function setPlayerStatMain(event, context) {
  try {
    return await setPlayerStatMainInner(event, context);
  } catch (err) {
    console.error('[mahjong] 修改玩家数据异常:', err);
    return { success: false, errMsg: '修改失败：' + ((err && err.message) || '未知异常') };
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
  getPlayerStatDetailMain,
  setPlayerStatMain,
  getPlayerTitlesMain,
  deleteGameMain,
  rebuildPlayerStatsMain,
  archiveMain,
  timerArchive,
  fetchTitlesByOpenids
};
