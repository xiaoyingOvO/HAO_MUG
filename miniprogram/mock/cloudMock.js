/* eslint-disable */
/**
 * ============================================================
 *  本地离线模拟层（Mock Cloud）—— HAO_MUG
 * ============================================================
 *  为什么需要它：
 *    本项目是微信云开发架构，所有数据都通过 wx.cloud.callFunction
 *    调用 baseFunctions / queueFunctions 两套云函数。使用「测试号」
 *    AppID 导入时无法使用云开发能力，页面会一直卡在未注册/无数据。
 *    这一层把云调用拦截下来，返回与真实云函数结构一致的假数据，
 *    并把当前用户伪装成「已注册、已联网」的正式用户。
 *
 *  开关：
 *    MOCK_ENABLED = true  → 走本地假数据（测试号 / 无云环境时用）
 *    MOCK_ENABLED = false → 恢复真实云开发（填回正式 AppID 后）
 *
 *  常用操作（开发者工具 Console 里执行）：
 *    wx.resetMockData()      重置假数据到初始状态
 *    wx.getMockState()       查看当前假数据
 *    wx.mockGrantPoints(500) 给当前用户加 500 点（方便演示）
 *    wx.mockSetPoints(20)    直接把余额设成 20 点（初始余额是 0，测欠费前先给钱）
 *    wx.mockSetCredit(55)    改信用分切等级：92→S / 78→A / 65→B / 55→C（不用改代码重编译）
 *
 *    ===== 虚拟时间（测夜场必备，不用真等到晚上 11 点）=====
 *    wx.mockSetTime('23:30')    虚拟时间设到今天 23:30
 *    wx.mockSetTime('01:15', 1) 设到明天 01:15（第二个参数是偏移天数）
 *    wx.mockAddHours(2)         虚拟时间再加 2 小时（可传负数）
 *    wx.mockResetTime()         回到真实时间
 *    wx.mockNow()               查看当前虚拟时间
 *
 *  想进「管理」页：把下面的 MOCK_ROLE 改成 'master' 再编译
 * ============================================================
 */

export const MOCK_ENABLED = false;
export const MOCK_ROLE = 'user';

const DB_KEY = 'haomug_mock_db_v1';
// 假数据版本号：改动初始数据时把它 +1，旧的本地缓存会自动失效重建
// （避免"代码改了但页面还是老数据"的困惑）
const DB_VERSION = 24;
// 22：夜场票发卡对齐云端 chargeReserve 的时段算法（预约日 23:00 ~ 次日 10:00）
// 21：桌游/日麻区标识由 'mahjong' 改回 'board'（机台 M05/M06 的 area + group_id 同步）
// 13：机台拆成 舞萌·官机 / MML / ADX + 中二节奏，入店改为选设备直接排队
// 14：初始余额改为 0 点（方便测「扣成负数也只提醒、不踢出排队」）
// 15：新增日麻机台 M05（桌游区，4 人一桌，可排队）；三区域人数统计改为互斥分区
// 16：三区域改为按「在干什么」分区（休息区 = enter_state 1，两个区都算），
//     桌游区退队后回到休息区
// 17：（已废弃）调试用假数据 —— 三个区域各 4 人 + 铺满 queues
// 18：改回默认空店状态：店内只有 2 人在休息，所有机台队列为空
// ⚠️⚠️ 改了 seed() 里的 machines / queues / 用户 / 卡片，就**必须**把版本号 +1，
//      否则本地 storage 里是旧缓存，页面还显示老数据 —— 加 M05 时就漏了这一次，
//      导致桌游区排队报「机器不可用」（旧缓存里根本没有 M05 机台）。
// 19：机台新增 tag 字段，弹层子项文案改由 tag 提供
// 20：机台新增 is_disabled 字段（不可用）；不可用机台仍显示在弹层，但不可选、tag 显示「机台不可用」
const ME_OPENID = 'mock-openid-me';

// 夜场可入店的两类卡（与云端 queueFunctions/ifNight 的常量对齐）
const NIGHT_CARD_ID = 'e33be08d678e255a0189586d3b0d8a79';          // 夜场畅玩卡（与云端 card 集合真实 _id 一致）
const BOARD_NIGHT_CARD_ID = 'df40db4d6ad4af26010239057dae6a3c';    // 桌游麻将票·夜场（与云端一致）

const AVATAR_ME = '/images/avatar.png';
const AVATAR_OTHER = '/images/default-avatar.png';

/* ============================================================
 *  入店区域
 * ============================================================
 *  arcade = 音游区：0.2 点/分（12 点/小时，老版计费），23 点被定时任务强制离店
 *  board  = 桌游区：0.1 点/分（ 6 点/小时），23 点**不**离店、继续计费
 *           （桌游一把时间可能过长，所以不走夜场免单、也不被 23 点清场）
 *  11 点之后离店仍不能再次入店，需要夜场票/预约 —— 这条与原版一致，前端 checkAccess 已处理。
 *
 *  【收费规则】
 *   · **音游区的收费方式全部覆盖桌游区** —— 优惠卡（免单时段卡、折扣会员卡）
 *     对两个区一视同仁，不看区域（见 cardEffects，它不区分 area）。
 *     也就是说：买了「全天畅玩套餐」的人，去桌游区同样免单。
 *   · TODO：桌游区**单独的包夜收费**方案还没定，当前按 6 点/小时 一直计到离店。
 *     定了之后在这里加 BOARD_NIGHT_RATE（或改成包夜一口价），并把
 *     boardBillingMinutes 改成「超过某个时间点后按包夜价结算」。
 * ============================================================ */
export const AREA_ARCADE = 'arcade';
export const AREA_BOARD = 'board';
const AREA_RATE = { [AREA_ARCADE]: 0.2, [AREA_BOARD]: 0.1 };
// TODO: 桌游区包夜价未定，暂时与日间同价（6 点/小时）
const BOARD_NIGHT_RATE = null;
const normalizeArea = (a) => (a === AREA_BOARD ? AREA_BOARD : AREA_ARCADE);
// 机台所属区域：machine.area === 'board' 才是桌游区机台，缺省按音游区
// ⚠️ 云端 machine 集合需要补 area 字段；没补之前所有机台都按音游区处理（兼容老数据）
const machineArea = (m) => (m && m.area === AREA_BOARD ? AREA_BOARD : AREA_ARCADE);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

function dayStr(offset = 0) {
  const d = new Date(nowTs() + offset * DAY);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 生成从「今天」起 28 天（4 行日历）的预约数据，对应云端 getReserveInfo 返回的 reserve_data。
// 造几组不同人数的演示数据，方便测试四档着色：
//   i=1 明天 1 人(<3 绿)、i=2 后天 4 人(3~5 橙)、i=3 大后天 6 人(5~8 红)、i=4 第四天 9 人(>8 深红)
function monthReserve() {
  const now = new Date(nowTs());
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const list = [];
  // 每个档位预置一批 mock openid，方便构造不同人数
  const ids = [];
  for (let k = 1; k <= 9; k++) ids.push(`mock-openid-${String(k).padStart(2, '0')}`);
  const demoCount = [0, 1, 4, 6, 9]; // 下标对应 i=0..4 的预约人数
  for (let i = 0; i < 28; i++) {
    const d = new Date(year, month, date + i);
    const dateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const cnt = demoCount[i] || 0;
    const openids = cnt > 0 ? ids.slice(0, cnt) : [];
    list.push({ _id: `rsv-${d.getDate()}`, day: dateStr, openids });
  }
  return list;
}

/* ============================================================
 *  虚拟时间（仅测试用）
 * ============================================================
 *  本地跑测试号时没法真等到晚上 11 点去看夜场逻辑，所以给 mock 加一层时间偏移：
 *  所有云端的「当前时间」都走 nowTs() / nowDate()，改一次偏移，整条链路
 *  （入店校验、计费、夜场判定、优惠卡时段、预约日期）都会跟着变。
 *
 *  开发者工具 Console 里：
 *    wx.mockSetTime('23:30')   把虚拟时间设为今天 23:30（时间会继续正常流逝）
 *    wx.mockSetTime('01:15', 1) 设为「明天」01:15（+1 天）
 *    wx.mockAddHours(2)        在当前虚拟时间上再加 2 小时
 *    wx.mockResetTime()        回到真实时间
 *    wx.mockNow()              查看当前虚拟时间
 * ============================================================ */
const REAL_NOW = Date.now;

function timeOffset() {
  try {
    const s = wx.getStorageSync(DB_KEY);
    return (s && s.timeOffset) || 0;
  } catch (e) {
    return 0;
  }
}
// 虚拟「当前时间戳」
function nowTs() {
  return REAL_NOW() + timeOffset();
}
// 虚拟「当前时间」对象
function nowDate() {
  return new Date(nowTs());
}

// 夜场卡有效期：预约日期当天 23:00 ~ 次日 10:00，返回时间戳（与 mock 里其他卡一致）。
// 算法对齐云端 buyReserve/index.js 的 chargeReserve（预约日 CST 午夜做基准 + UTC 换算）。
// 注意：base 先 +DAY（推到次日 CST 午夜），再 setUTCHours(cstHourToUTC(23)=15)，
//      这样 15:00 UTC 才落在「预约日」当天（否则会落在前一天的 15:00 UTC）。
function nightCardPeriod(reserveDay, duration) {
  const [year, month, day] = reserveDay.split('-').map(Number);
  // 基准：预约日期次日的 CST 午夜（UTC 表示），配合 setUTCHours 得到「预约日 23:00 北京」
  const base = new Date(Date.UTC(year, month - 1, day) - 8 * 3600 * 1000 + DAY);
  const cstHourToUTC = (hourCST) => (Number(hourCST) - 8 + 24) % 24;
  const start_time = new Date(base.getTime());
  start_time.setUTCHours(cstHourToUTC(duration.start_hour), 0, 0, 0);
  const end_time = new Date(base.getTime());
  // 夜场是跨天卡（结束小时 < 开始小时），结束时间落在次日
  if (Number(duration.end_hour) < Number(duration.start_hour)) {
    end_time.setUTCDate(end_time.getUTCDate() + 1);
  }
  end_time.setUTCHours(cstHourToUTC(duration.end_hour), 0, 0, 0);
  return { start_time: start_time.getTime(), end_time: end_time.getTime() };
}

/* ============================================================
 *  初始假数据
 * ============================================================
 *  【数据来源清单】—— 这张表决定了"哪些是真数据、哪些还是占位"：
 *
 *  已按原版截图 / 原版源码填好（可直接演示）：
 *    · me                 个人资料：昵称 oyyq、QQ 3296290695、Exp 1586、信用 S、未入店
 *    · machines           机台：舞萌·官机(可拼机) / 舞萌·MML / 舞萌·ADX / 中二节奏（各自独立排队）
 *    · cards              优惠卡：高级会员卡(已售罄) / 全天 69点 / 日间 45点 / 夜场 68点
 *    · meta.notice        首页公告「欢迎光临萌动喵~」、联系方式、常见问题 4 条
 *    · meta.reserve_*     预约：消耗 68 点、上限 15 人、需信用 ≥85（S）
 *
 *  仍为**占位数据**（原版没给截图，等你补）—— 需要时告诉我原值，我逐条替换：
 *    · mails              信箱消息（3 条）
 *    · points             充值档位（50 / 100 / 200 点）
 *    · orders             订单记录（3 条）
 *    · arcadeLog          出勤记录（3 条）
 *    · doorLog            开门记录（2 条）
 *    · reports            举报记录（1 条）
 *    · userUnauthorized   待授权用户（2 条）
 *    · faq 的「答复正文」  问题文案是原版源码里的，答复正文是过渡文案（截图里折叠看不到）
 *    · queues             排卡区：**刻意全空**，不做任何预设
 *
 *  注意：凡是云端集合里的业务数据（机台、优惠卡、公告、订单、用户…）都不要凭空编造，
 *        没有原值就留空或留占位，并在这里登记。
 * ============================================================ */
function seed() {
  const now = Date.now();

  const me = {
    _id: 'mock-user-me',
    openid: ME_OPENID,
    phone: '13800000001',
    qq_id: '3296290695', // 原版截图：QQ 号 3296290695
    exp: 1586, // 原版截图：Exp 1586 → Level 1（下一级 2000）
    role: MOCK_ROLE,
    display_title: null,
    // 信用分 → 等级（见 pages/user-center/index.js:248 calculateCreditLevel）：
    //   >=85 → S ； >=70 → A ； >=60 → B ； <60 → C
    credit: 92,
    nickname: 'oyyq', // 原版截图昵称
    avatar: AVATAR_ME,
    // 初始余额 0 点（用户指定，用来测欠费提醒）。
    // ⚠️ 注意：余额 0 且没有「当前时段的免单卡」时，enterArcade 会直接拒绝入店（原版规则，
    //    cloudMock 的 enterArcade 与原版一致）。所以测「入店后扣成负数」要先给点数：
    //    console 执行 wx.mockSetPoints(20) 或 wx.mockGrantPoints(20) 再入店。
    //    想恢复到 100 点：把这里改回 100 并把 DB_VERSION +1（或 console 执行 wx.mockSetPoints(100)）。
    real_point: 0,
    extra_point: 0,
    enter_state: 0, // 0 未入店 / 1 休息中 / 2 候机中 / 3 游玩中
    enter_time: null,
    machine_id: '',
    area: AREA_ARCADE, // 入店区域（音游区 / 桌游区），入店时写入
    cards: [],
  };

  // opt: { area, machine_id } —— 用来造「在某区、占着某台机」的假用户
  const makeUser = (openid, nickname, exp, credit, real, extra, state, opt = {}) => ({
    _id: 'mock-user-' + openid,
    openid,
    phone: '1380000' + openid.slice(-4),
    qq_id: '2000' + openid.slice(-4),
    exp,
    role: 'user',
    credit,
    nickname,
    avatar: AVATAR_OTHER,
    real_point: real,
    extra_point: extra,
    enter_state: state,
    enter_time: state > 0 ? now - (20 + Number(openid.slice(-2))) * MIN : null,
    machine_id: opt.machine_id || '',
    area: opt.area || AREA_ARCADE,
    cards: [],
  });

  // 默认只放 **2 人在店内休息**（与原版截图一致：正在游玩 0 人 / 正在休息 2 人），
  // 其余全部未入店。这样打开首页是干净的空店状态，方便自己一步步点着测。
  //
  // ⚠️ 想看「三区域各有几人」的效果时，把下面几行的 enter_state 改掉即可
  //    （0 未入店 / 1 休息中 / 2 候机中 / 3 游玩中），并**同步改 queues**、把 DB_VERSION +1：
  //      makeUser('mock-openid-04', '街机王',   ..., 3, { machine_id: 'M01' })  → 音游区
  //      makeUser('mock-openid-05', '夜场常客', ..., 3, { area: AREA_BOARD, machine_id: 'M05' }) → 桌游区
  //    之前为了测试铺过「每区 4 人」，现已改回默认；那段数据见改动清单第六节。
  const others = [
    // 管理员：未入店，可进管理页
    { _id: 'mock-user-admin', openid: 'mock-openid-admin', phone: '13800000000', qq_id: '10000', exp: 12000, role: 'master', credit: 100, nickname: '店长', avatar: AVATAR_OTHER, real_point: 999, extra_point: 0, enter_state: 0, enter_time: null, machine_id: '', cards: [] },

    // ── 店内 2 人：休息中（enter_state 1，没排队、没上机）──
    makeUser('mock-openid-02', '阿豪', 5600, 95, 120, 10, 1),
    makeUser('mock-openid-03', '小喵', 1200, 88, 60, 0, 1),

    // ── 其余未入店（enter_state 0）──
    makeUser('mock-openid-04', '街机王', 26000, 100, 800, 200, 0),
    makeUser('mock-openid-05', '夜场常客', 900, 78, 40, 5, 0),
    makeUser('mock-openid-06', '新来的', 100, 86, 30, 0, 0),
  ];

  // 机台列表：对应云端 machine 集合，排卡页顶部的机台下拉、首页入店的设备选择弹层都读这份数据。
  //
  // 舞萌细分为三个**各自独立排队**的版本：官机 / MML / ADX；
  // 中二节奏一台。桌游·日麻不是机台（不排队），由前端作为虚拟入店项处理，见 pages/home/home.js。
  //
  // max_player = 最大上机人数，它还控制右下角「拼机/单刷」按钮的显示：
  //   pages/queue-info/index.wxml:93 → wx:if="{{selectedMachine.maxPlayer >= 2}}"
  // 只有舞萌官机支持拼机（max_player = 2），MML / ADX / 中二节奏都是单刷。
  //
  // group_id / group_name / label 供入店时的设备选择弹层分组用：
  //   group_id   —— 同组的机台在弹层里合并成一张卡（舞萌有三个变体）
  //   group_name —— 卡片标题（舞萌 / 中二节奏）
  //   label      —— 组内的按钮文字（官机 / MML / ADX）
  // 缺这三个字段时会退化成「一台机 = 一张卡」，不会报错。
  const machines = [
    { _id: 'M01', machine_name: '舞萌·官机', max_player: 2,  area: 'arcade',  group_id: 'maimai',   group_name: '舞萌',     label: '官机', tag: '可拼机/单刷', is_disabled: false },
    { _id: 'M02', machine_name: '舞萌·MML',  max_player: 1,  area: 'arcade',  group_id: 'maimai',   group_name: '舞萌',     label: 'MML',  tag: '单刷',        is_disabled: false },
    { _id: 'M03', machine_name: '舞萌·ADX',  max_player: 1,  area: 'arcade',  group_id: 'maimai',   group_name: '舞萌',     label: 'ADX',  tag: '单刷',        is_disabled: false },
    { _id: 'M04', machine_name: '中二',      max_player: 1,  area: 'arcade',  group_id: 'chunithm', group_name: '中二',     label: '中二', tag: '单刷',        is_disabled: false },
    { _id: 'M05', machine_name: '麻将',      max_player: 4,  area: 'board', group_id: 'board',  group_name: '桌游/日麻', label: '麻将', tag: '可三麻/四麻', is_disabled: false },
    { _id: 'M06', machine_name: '桌游',      max_player: -1, area: 'board', group_id: 'board',  group_name: '桌游/日麻', label: '桌游', tag: '自由人数',    is_disabled: false },
  ];
  
  // 排卡区（机器队列）默认全空 —— 假用户只在店内休息，不占任何机位。
  //
  // ⚠️ 想让排卡板一打开就有人的话，往对应机台里加条目，字段与真实云函数
  //    Enqueue / Embark 写入的一致（改完记得 DB_VERSION +1）：
  //      { openid, timestamp, play_status, is_multi, play_position }
  //    · play_status true  = 已上机（占固定座位）
  //    · play_status false = 候机中（在等候区）
  //    · play_position     = 游玩区座位下标 0 ~ max_player-1，
  //                          见 pages/queue-info/index.js:38 buildPlayingList
  //    例（官机 2 人拼机）：
  //      M01: [
  //        { openid: 'mock-openid-04', timestamp: now - 26 * MIN, play_status: true,  is_multi: true, play_position: 0 },
  //        { openid: 'mock-openid-05', timestamp: now - 24 * MIN, play_status: true,  is_multi: true, play_position: 1 },
  //      ],
  const queues = {
    M01: [], // 舞萌·官机（max 2）
    M02: [], // 舞萌·MML（max 1）
    M03: [], // 舞萌·ADX（max 1）
    M04: [], // 中二（max 1）
    M05: [], // 日麻（max 4）
    M06: [], // 桌游（max -1）
  };

  const mails = [
    {
      _id: 'mock-mail-01',
      sender: 'mock-openid-admin',
      receiver: 'all',
      time: now - 6 * HOUR,
      title: '【公告】模拟环境已开启',
      content: '当前小程序运行在本地离线模拟模式下，数据均为演示用假数据，不会上传到云端。',
      read: false,
    },
    {
      _id: 'mock-mail-02',
      sender: 'mock-openid-admin',
      receiver: ME_OPENID,
      time: now - 2 * HOUR,
      title: '欢迎回来',
      content: '你有一张待使用的优惠卡，可在「我的 - 优惠卡」中查看。',
      read: false,
    },
    {
      _id: 'mock-mail-03',
      sender: 'mock-openid-admin',
      receiver: ME_OPENID,
      time: now - 3 * DAY,
      title: '历史消息示例',
      content: '这是一条已读消息，用于演示信箱列表的已读/未读样式。',
      read: true,
    },
  ];

  // 优惠卡：对应云端 card 集合，已按原版截图填写。
  // 排列顺序与原版一致（原版 getCardInfo 云函数是 orderBy('trial','desc').orderBy('cost','desc')，
  // 所以 高级会员卡(2) → 全天(1) → 夜场(0/68) → 日间(0/45)，其中「夜场」被 card.js 过滤、不展示）。
  // remain 语义（见 pages/user-center/other-page/card.wxml 与 cloudfunctions/baseFunctions/buyCard）：
  //   remain === 0            → 「剩余：已售罄」+ 按钮「已售罄」
  //   remain <= -100          → 「库存充足」（不限量，buyCard 不会拒绝）
  //   -100 < remain < 0       → 会被 buyCard 判为「已售罄」（不要用 -1 表示不限量）
  //   remain > 0              → 「剩余：N」
  // duration.type === 0 表示「每日时段卡」，过了当天 end_hour 会显示「今日已过时」。
  // （原版 duration.end_time 存的是 Date 对象；mock 里用 end_hour 等效表达，见 getCardInfo。）
  //
  // discount 语义（见 cloudfunctions/queueFunctions/getConsumePoint/index.js:80-84）：
  //   discount == 0 → 「免费时段卡」：把该时段的游玩时长从计费时长里剔除 = 该时段不扣点数
  //   discount != 0 → 折扣系数（如 0.5 = 5 折），仍然扣费
  // ⚠️ 「全天/日间畅玩套餐」按「畅玩」语义应为免单时段卡，故 discount 填 0。
  //    这个值来自我的推断（原版截图只给了卡名/价格/描述，看不到 discount），
  //    如果你云端 card 集合里实际不是 0，改这里 + 告诉我，免单入店逻辑才会正确生效。
  // ⚠️ 以下与云开发数据库 card 集合的真实数据保持一致（_id、卡名、价格、discount、时段）。
  //    「日间畅玩套餐」在云端已标记 is_deleted: true，这里不再列出。
  const cards = [
    {
      _id: 'e33be08d678e255a0189586d3b0d8a79',
      card_name: '夜场畅玩卡',
      trial: 0,
      discount: 1,
      duration: { type: 0, start_hour: 23, end_hour: 10, days: 1, start_time: null, end_time: null },
      remain: -100,
      cost: 68,
      desc: '68元/(23:00-次日10:00)，购买后可畅玩夜场。',
    },
    {
      _id: '9fc3269d672f10c0007c25e92548b234',
      card_name: '高级会员卡（试营，暂时别买）',
      trial: true,
      discount: 0.5,
      duration: { type: 1, start_hour: 0, end_hour: 24, days: 30, start_time: null, end_time: null },
      remain: 0,
      cost: 240,
      desc: '高级会员卡（试营）：240元/月；计时扣费5折；限3张',
    },
    {
      _id: 'cc3a4179678380c9049b4d3c331a34c6',
      card_name: '全天畅玩套餐',
      trial: false,
      discount: 0,
      duration: { type: 0, start_hour: 10, end_hour: 23, days: 1, start_time: null, end_time: null },
      remain: -100,
      cost: 69,
      desc: '全天畅玩套餐：69元/(10:00-23:00)',
    },
    {
      _id: 'ab52283f6783807201221ba02db6611e',
      card_name: '早八畅玩套餐',
      trial: false,
      discount: 0,
      duration: { type: 0, start_hour: 8, end_hour: 10, days: 1, start_time: null, end_time: null },
      remain: -100,
      cost: 12,
      desc: '早八畅玩套餐：12元/(08:00-10:00)',
    },
    {
      _id: 'df40db4d6ad4af17010238800070046a',
      card_name: '桌游麻将票·日场',
      trial: 0,
      discount: 0,
      area: 'board',
      duration: { type: 0, start_hour: 10, end_hour: 23, days: 1, start_time: null, end_time: null },
      remain: -100,
      cost: 30,
      desc: '桌游麻将票（日场）：30元/(10:00-23:00)，仅限桌游/麻将',
    },
    {
      _id: 'df40db4d6ad4af26010239057dae6a3c',
      card_name: '桌游麻将票·夜场',
      trial: 0,
      discount: 0,
      area: 'board',
      duration: { type: 0, start_hour: 23, end_hour: 10, days: 1, start_time: null, end_time: null },
      remain: -100,
      cost: 30,
      desc: '桌游麻将票（夜场）：30元/(23:00-次日10:00)，仅限桌游/麻将',
    },
  ];

  const points = [
    { _id: 'pt-1', point: 50, cost: 50, trial: 0, desc: '50 点' },
    { _id: 'pt-2', point: 100, cost: 100, trial: 1, desc: '100 点（推荐）' },
    { _id: 'pt-3', point: 200, cost: 200, trial: 2, desc: '200 点' },
  ];

  const orders = [
    { _id: 'order-1', openid: ME_OPENID, state: 1, time_order: now - 2 * DAY, time_expire: now + 28 * DAY, point: 100 },
    { _id: 'order-2', openid: ME_OPENID, state: 1, time_order: now - 12 * DAY, time_expire: now - 1 * DAY, point: 50 },
    { _id: 'order-3', openid: 'mock-openid-02', state: 1, time_order: now - 1 * DAY, time_expire: now + 29 * DAY, point: 200 },
  ];

  const arcadeLog = [
    { _id: 'al-1', openid: ME_OPENID, time: now - 1 * DAY, remain_point: 250, exp: 2300, op: 0 },
    { _id: 'al-2', openid: ME_OPENID, time: now - 1 * DAY + 2 * HOUR, remain_point: 200, exp: 2400, op: 1 },
    { _id: 'al-3', openid: 'mock-openid-04', time: now - 3 * HOUR, remain_point: 800, exp: 26000, op: 0 },
  ];

  const doorLog = [
    { _id: 'dl-1', openid: ME_OPENID, time: now - 1 * DAY },
    { _id: 'dl-2', openid: 'mock-openid-04', time: now - 3 * HOUR },
  ];

  const reports = [
    {
      _id: 'report-1',
      from_openid: 'mock-openid-02',
      to_openid: 'mock-openid-05',
      timestamp: now - 5 * HOUR,
      content: '该用户疑似插队',
      handled: false,
    },
  ];

  // 麻将对局战绩表 —— 对应云端 mahjong_game 集合。
  // 一局一条：4 名玩家（openid/昵称/头像/点数/顺位），顺位按点数降序、同分同名次。
  // 造 16 局演示数据：5 人轮换上阵，胜负模式固定循环（方便页面上四率/趋势图看出形状）。
  const MJ_PLAYERS = [
    { openid: ME_OPENID, nickname: 'oyyq' },
    { openid: 'mock-openid-02', nickname: '阿豪' },
    { openid: 'mock-openid-03', nickname: '小喵' },
    { openid: 'mock-openid-04', nickname: '街机王' },
    { openid: 'mock-openid-05', nickname: '夜场常客' },
  ];
  // 每局的点数模板（和为 0 的日麻 pt 风格），按下标循环
  const MJ_SCORE_PATTERNS = [
    [90, 30, -30, -90],
    [60, 20, -10, -70],
    [120, 40, -40, -120],
    [45, 15, 5, -65],
    [75, 25, -25, -75],
  ];
  const mahjongGames = (() => {
    const list = [];
    for (let gi = 0; gi < 16; gi++) {
      // 4 人组合：从 5 人里跳过 (gi % 5) 那个人，保持轮换
      const skip = gi % 5;
      const four = MJ_PLAYERS.filter((_, i) => i !== skip);
      const pat = MJ_SCORE_PATTERNS[gi % MJ_SCORE_PATTERNS.length];
      // 胜者轮换：把 pat 按 gi 旋转，模拟不同人赢
      const rotated = pat.map((_, i) => pat[(i + gi) % 4]);
      const players = four.map((p, i) => ({
        openid: p.openid,
        nickname: p.nickname,
        avatar: i === 0 ? AVATAR_OTHER : AVATAR_OTHER,
        points: rotated[i],
        rank: 0, // 下面统一算
      }));
      // 顺位：点数降序、同分同名次（与云端 mahjongStats 一致）
      const order = players.slice().sort((a, b) => b.points - a.points);
      order.forEach((p, idx) => {
        p.rank = idx > 0 && p.points === order[idx - 1].points
          ? order[idx - 1].rank
          : idx + 1;
      });
      list.push({
        _id: 'mj-game-' + (gi + 1),
        game_date: new Date(now - (16 - gi) * DAY).toISOString().slice(0, 10),
        players,
        recorder_openid: 'mock-admin',
        create_time: new Date(now - (16 - gi) * DAY),
      });
    }
    return list;
  })();

  return {
    version: DB_VERSION,
    me,
    mahjongGames,
    mahjongTitles: [
      { _id: 'mt-1', openid: ME_OPENID, title: 'kokushi', count: 3, grant_by: 'mock-admin', create_time: new Date(now - 5 * DAY) },
      { _id: 'mt-2', openid: ME_OPENID, title: 'daisangen', count: 1, grant_by: 'mock-admin', create_time: new Date(now - 2 * DAY) },
      { _id: 'mt-3', openid: 'mock-openid-04', title: 'suankou', count: 1, grant_by: 'mock-admin', create_time: new Date(now - 3 * DAY) },
    ],
    users: others,
    machines,
    queues,
    queueLogs: {},
    mails,
    cards,
    points,
    orders,
    arcadeLog,
    doorLog,
    reports,
    // 夜场预约表 —— 对应云端 reserve 集合。
    // 页面（pages/reserve/index.js）以「当前自然月」日历展示，这里生成整月（1 号~月末）数据；
    // 明天、后天各造了一条「别人」的预约用于测试日历红/橙/绿三色状态。
    reserve: monthReserve(),
    userUnauthorized: [
      { _id: 'ua-1', openid: 'mock-openid-07', phone: '13900000007', qq_id: '30007', nickname: '待授权用户A', avatar: AVATAR_OTHER },
      { _id: 'ua-2', openid: 'mock-openid-08', phone: '13900000008', qq_id: '30008', nickname: '待授权用户B', avatar: AVATAR_OTHER },
    ],
    meta: {
      business_status: true,
      // 首页公告栏 / 常见问题 / 联系方式 —— 对应云端 meta 集合，原版截图如下：
      //   顶部滚动条：「欢迎光临萌动喵~」
      //   联系方式：  群聊 →「舞萌机子中间有二维码」
      //               管理员联系方式 →「QQ: 3825778824」
      // 注意：faq 的 4 条**问题**取自本仓库 pages/home/home.js 里开发者自己留的默认文案，
      //       是真的；但**答复正文**在截图里是折叠状态看不到，下面是用可核实的信息（计费 0.2 点/分、
      //       夜场 23:00-10:00、预约扣 68 点且不可取消、入店流程、联系 QQ）写的过渡文案，
      //       等你把原版「常见问题」展开后把原文发我，我再逐条替换。
      notice: {
        broadcast: '欢迎光临萌动喵~',
        faq: [
          {
            q: '1.1如何前往HAO窝游玩？',
            a: '营业时间内在首页点击「入店」即可开始游玩，离店时点击「离店」结算。&hc入店后请到机台前排队等候，按排卡区顺序上机。',
          },
          {
            q: '1.2HAO窝的收费模式？',
            a: '按分钟计时扣费，基础费率 0.2 点/分钟，离店时统一结算。&hc不满一分钟不产生费用。&hc持有优惠卡可按卡面折扣计价。',
          },
          {
            q: '1.3在HAO窝游玩的一些注意事项？',
            a: '请按排卡区队列顺序上机，不要插队；&hc排队时请留意队列提醒，长时间不在可能导致被移出队列；&hc离开机台请及时退队，方便后面的玩家。',
          },
          {
            q: '1.4HAO窝夜场的一些注意事项？',
            a: '夜场时间为当日 23:00 至次日 10:00。&hc预约成功将立即自动扣除 68 点，且预约成功后不可取消。&hc10:00 前仍可预约当日凌晨场。',
          },
        ],
        contact: [
          { type: '群聊', detail: '舞萌机子中间有二维码' },
          { type: '管理员联系方式', detail: 'QQ: 3825778824' },
        ],
      },
      // 预约参数 —— 原版截图：说明栏「预约成功将立即自动扣除 68 点」，
      //             卡片右侧「信用：S」，已预约 0 人 / 剩余名额 15 → reserve_max = 15。
      reserve_limit: true, // true = 有名额上限（false 时页面显示「剩余名额：无限制」）
      reserve_max: 15,
      reserve_cost: 68,
      night_card_id: 'e33be08d678e255a0189586d3b0d8a79',
    },
    pendingRecharge: null,
    seq: 100,
    timeOffset: 0, // 虚拟时间偏移（毫秒），0 = 真实时间。见 wx.mockSetTime()
  };
}

/* ============================================================
 *  状态存取
 * ============================================================ */
function load() {
  let s = null;
  try {
    s = wx.getStorageSync(DB_KEY);
  } catch (e) {
    s = null;
  }
  if (!s || s.version !== DB_VERSION) {
    s = seed();
    save(s);
  }
  return s;
}

function save(s) {
  try {
    wx.setStorageSync(DB_KEY, s);
  } catch (e) {
    console.warn('[Mock] 保存假数据失败', e);
  }
}

export function resetMockData() {
  const prev = load();
  const s = seed();
  // 虚拟时间是调试开关，不属于业务数据：重置假数据时保留它，
  // 否则「设成 23:30 → 重置数据 → 又变回真实时间」会很困惑。
  s.timeOffset = (prev && prev.timeOffset) || 0;
  save(s);
  notifyAllQueueWatchers();   // 队列被重置成初始数据，推一次变更让页面跟上
  console.log(
    '[Mock] 假数据已重置（虚拟时间保持：',
    s.timeOffset ? new Date(REAL_NOW() + s.timeOffset).toLocaleString() : '真实时间',
    '，想恢复真实时间用 wx.mockResetTime()）',
  );
  return s;
}

export function getMockState() {
  return load();
}

/* ============================================================
 *  小工具
 * ============================================================ */
function allUsers(s) {
  return [s.me].concat(s.users);
}

function infoOf(s, openid) {
  const u = allUsers(s).find((x) => x.openid === openid);
  return { openid, avatar: u ? u.avatar : AVATAR_OTHER, nickname: u ? u.nickname : '未知用户' };
}

function totalPoints(u) {
  return (u.real_point || 0) + (u.extra_point || 0);
}

function buildQueue(s, machineId) {
  const list = s.queues[machineId] || [];
  return list.map((q, i) => ({
    openid: q.openid,
    timestamp: q.timestamp,
    play_status: !!q.play_status,
    is_multi: !!q.is_multi,
    play_position: q.play_position,
    next_id: i === list.length - 1 ? '-1' : list[i + 1].openid,
    user_info: infoOf(s, q.openid),
  }));
}

function pushQueueLog(s, machineId, openid, text) {
  if (!s.queueLogs[machineId]) s.queueLogs[machineId] = [];
  s.queueLogs[machineId].push({ timestamp: nowTs(), openid, log_info: text });
}

function logText(s, openid, action) {
  const name = infoOf(s, openid).nickname;
  return `${name}${action}`;
}

/**
 * 首页三区域人数。把在店的人**互斥地**分成三堆（三者相加 = 店内总人数）：
 *   休息区 = enter_state 1（休息中：没排队、没上机。两个区都算）
 *   桌游区 = area 'board' 且 enter_state > 1（排上日麻 2 / 上桌游玩 3）
 *   音游区 = area 非 board 且 enter_state > 1（候机 2 / 游玩 3）
 * 老数据没有 area 字段时按音游区计。
 *
 * 这样分区的用意：
 *   · 选「桌游/日麻」入店并排上队（state 2）→ 显示在**桌游区**
 *   · 在日麻队列里点「退队」（state 回到 1）→ 显示在**休息区**，但人还在桌游区、可随时再排
 * 即：三区域表示的是「当前在干什么」，不是「人在哪个房间」。
 */
function enterStats(s) {
  let relax = 0;
  let play = 0;
  let arcade = 0;
  let board = 0;
  allUsers(s).forEach((u) => {
    const st = u.enter_state || 0;
    if (!st) return;                       // 未入店
    if (st === 1) {                        // 休息中：只算休息区
      relax++;
      return;
    }
    play++;                                // play_num 沿用原版语义：候机 / 游玩
    if (normalizeArea(u.area) === AREA_BOARD) board++;
    else arcade++;
  });
  return { relax, play, arcade, board };
}

/**
 * 用户此刻是否持有「当前时段免单」的优惠卡。
 *
 * 与 cloudfunctions/queueFunctions/enterArcade/index.js 的 hasFreeTimeCard 完全同构，
 * 也和 getConsumePoint 的免单口径一致：
 *   · discount == 0 的卡 = 免费时段卡 → 覆盖时段内不扣点数
 *   · discount != 0 的卡 = 折扣卡   → 仍会扣费，不算免单
 *   · 需同时满足「在持有有效期内」+「当前时刻落在免单时段内」
 *
 * 口径差异（仅 mock 内部）：云端 duration.start_time/end_time 是 Date 对象取 getHours()；
 * mock 的卡片数据用 duration.start_hour/end_hour 直接存小时，等价。
 *
 * 跨天时段（如夜场 23:00 - 次日 10:00）表现为 startHour > endHour，需单独判断。
 */
// 某小时是否落在 [startHour, endHour) 区间内；跨天区间（如夜场 23:00-次日 10:00）单独处理
function hourInRange(hour, startHour, endHour) {
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

/**
 * 汇总用户持有的卡对计费的影响（对齐 getConsumePoint:63-86）。
 *
 *   discount != 0 → 折扣卡：zhekou *= discount（如高级会员卡 0.5 = 计时 5 折）
 *   discount == 0 → 免费时段卡：把 duration 的时段记入 freeRanges，用于抵扣计费时长
 *
 * 入店放行（hasFreeTimeCard）和计费抵扣（consumedPoints）都走这一个函数，
 * 保证两边口径一致 —— 不会出现「放行进店了但计费照扣」的矛盾。
 *
 * 注意：这里**区分区域**——card.area 存在且与用户当前区域不一致时，该卡不生效。
 *       缺省/null/undefined 则两区通用。
 */
function cardEffects(s, u, now = nowDate(), userArea) {
  const holds = (u && u.cards) || [];
  const ts = now.getTime();
  let zhekou = 1;
  const freeRanges = [];

  for (let i = 0; i < holds.length; i++) {
    const hold = holds[i];
    if (!hold || !hold.card_id) continue;

    // 仅在持有有效期内的卡才生效
    const start = new Date(hold.start_time).getTime();
    const end = new Date(hold.end_time).getTime();
    if (!(start <= ts && ts <= end)) continue;

    const card = s.cards.find((c) => c._id === hold.card_id);
    if (!card) continue;

    // 区域限制：card.area 存在且与用户当前区域不一致 → 该卡不生效
    if (card.area && userArea && card.area !== userArea) {
      console.log(`[mock] 卡 ${card._id} 仅限 ${card.area} 区，用户当前 ${userArea}，跳过`)
      continue
    }

    const discount = Number(card.discount);
    if (!Number.isNaN(discount) && discount !== 0) {
      zhekou *= discount;
    } else if (discount === 0 && card.duration) {
      const sh = Number(card.duration.start_hour);
      const eh = Number(card.duration.end_hour);
      if (!Number.isNaN(sh) && !Number.isNaN(eh)) freeRanges.push({ start: sh, end: eh });
    }
  }
  return { zhekou, freeRanges };
}

function hasFreeTimeCard(s, openid, now = nowDate()) {
  const u = allUsers(s).find((x) => x.openid === openid) || s.me;
  const userArea = normalizeArea(u.area);
  const { freeRanges } = cardEffects(s, u, now, userArea);
  const curHour = now.getHours();
  return freeRanges.some((r) => hourInRange(curHour, r.start, r.end));
}

function nextId(s, prefix) {
  s.seq = (s.seq || 100) + 1;
  return `${prefix}-${s.seq}`;
}

function addArcadeLog(s, openid, remain, exp, op) {
  s.arcadeLog.unshift({ _id: nextId(s, 'al'), openid, time: nowTs(), remain_point: remain, exp, op });
}

function inStoreUsers(s) {
  return allUsers(s).filter((u) => u.enter_state > 0);
}

/**
 * 计费：严格对齐 cloudfunctions/queueFunctions/getConsumePoint/index.js 的
 * calculateBillingTime()——入店/离店时间都先截断到「整分钟」再相减，
 * 总时长 <= 0 返回 0，也就是**不满一分钟不计费**，入店不会立刻产生费用。
 * 基础费率 0.2 点/分。
 * （原版还有优惠卡折扣、信用系数、Lv6 免单等逻辑，这里只做基础计费。）
 */
/**
 * 计费时长（对齐原版 calculateBillingTime，cloudfunctions/.../getConsumePoint/index.js:143-191）
 *   1. 时间截断到整分钟；总时长 <= 0 → 0（**不满一分钟不计费**，入店不立刻产生费用）
 *   2. 夜场：23:00-次日 10:00 之间入店且同样在夜场时段内 → 直接 0
 *   3. 免单时段抵扣：freeRanges 覆盖的时间从计费时长里剔除
 *      （⚠️ 原版对跨天时段如 23:00-10:00 的免单卡算不出交集、实际不生效，这里照原版实现）
 */
function billingMinutes(enter, now, freeRanges) {
  const enterH = enter.getHours();
  const nowH = now.getHours();
  let start = enter;

  // 用户在夜场进入
  if ((enterH >= 23 && enterH <= 24) || (enterH >= 0 && enterH < 10)) {
    // 夜场时间内结算 → 不消费
    if ((enter.getDate() === now.getDate() && nowH >= 23 && nowH <= 24) || (nowH >= 0 && nowH < 10)) {
      return 0;
    }
    // 结算在早上 10 点后 → 从 10 点开始算
    if (enter.getDate() !== nowDate().getDate() && nowH >= 10) {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
    }
  }

  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = now.getHours() * 60 + now.getMinutes();
  let totalPlayTime = endMin - startMin;
  if (enter.getSeconds() > now.getSeconds()) totalPlayTime -= 1;
  if (totalPlayTime <= 0) return 0;

  // 免单时段：按原版 mergeDiscountCards 合并区间后求交集
  const intervals = freeRanges
    .map((r) => ({ start: r.start * 60, end: r.end * 60 }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  intervals.forEach((iv) => {
    if (merged.length === 0 || merged[merged.length - 1].end < iv.start) merged.push(iv);
    else merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
  });

  let discountedTime = 0;
  merged.forEach((card) => {
    const overlapStart = Math.max(startMin, card.start);
    const overlapEnd = Math.min(endMin, card.end);
    if (overlapStart < overlapEnd) discountedTime += overlapEnd - overlapStart;
  });

  const billingTime = totalPlayTime - discountedTime;
  return billingTime > 0 ? billingTime : 0;
}

/**
 * 桌游区计费时长（分钟）—— 对齐 getConsumePoint 的 boardBillingMinutes：
 *   1. **支持跨天**：按天拆分累计真实时长（原版按当天分钟数相减，跨过 24:00 会变负数）
 *   2. **不走夜场免单**：23 点后继续按 0.1 点/分计费
 *   3. 免单卡按天分别抵扣（两个区都享受免单卡）
 */
function boardBillingMinutes(enter, now, freeRanges) {
  const intervals = freeRanges
    .map((r) => ({ start: r.start * 60, end: r.end * 60 }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  intervals.forEach((iv) => {
    if (merged.length === 0 || merged[merged.length - 1].end < iv.start) merged.push(iv);
    else merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
  });

  const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
  let total = 0;
  let discounted = 0;
  let cursor = new Date(enter.getTime());
  let guard = 0;
  // 最多算 7 天，防止异常数据死循环
  while (cursor < now && guard++ < 7 * 24) {
    const nextDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0);
    const segEnd = nextDay < now ? nextDay : now;
    const sMin = minutesOfDay(cursor);
    // segEnd 正好是次日 0 点时，当天结束按 1440 分钟计
    const eMin = segEnd.getTime() === nextDay.getTime() ? 1440 : minutesOfDay(segEnd);
    if (eMin > sMin) {
      total += eMin - sMin;
      merged.forEach((card) => {
        const os = Math.max(sMin, card.start);
        const oe = Math.min(eMin, card.end);
        if (os < oe) discounted += oe - os;
      });
    }
    cursor = segEnd;
  }
  if (enter.getSeconds() > now.getSeconds()) total -= 1;
  const billingTime = total - discounted;
  return billingTime > 0 ? billingTime : 0;
}

/**
 * 已消费点数。对齐原版 getConsumePoint：
 *   ori = 计费分钟 × 区域费率（音游区 0.2 点/分、桌游区 0.1 点/分）
 *   points = ori × 折扣系数（优惠卡的 discount 连乘）
 *   exp >= 114514（Lv6）→ 免单 0 点
 *
 * ⚠️ 两处与原版的差异，都已在注释里标明，按需调整：
 *   1. 信用系数：原版 switch(credit) 配 `case credit >= 85` 这类布尔表达式，
 *      case 永远匹配不上数字 credit，实际**完全不生效**。这里沿用「不生效」的实际行为。
 *   2. experience：原版返回 ori_consumePoint（点数金额），疑似笔误；
 *      这里仍返回「游玩分钟数」，更符合「经验按游玩时长累计」的直觉。
 */
function consumedPoints(s, u) {
  if (u.enter_state === 0) return { points: 0, experience: 0 };
  const enter = new Date(u.enter_time || nowTs());
  const now = nowDate();
  const area = normalizeArea(u.area);
  const { zhekou, freeRanges } = cardEffects(s, u, now, area);
  const rate = AREA_RATE[area];
  // 音游区走原版夜场逻辑；桌游区走跨天累计、不享受夜场免单
  const minutes = area === AREA_BOARD
    ? boardBillingMinutes(enter, now, freeRanges)
    : billingMinutes(enter, now, freeRanges);

  const ori = Number((minutes * rate).toFixed(2));
  let points = Number((ori * zhekou).toFixed(2));
  // Lv6 免单（与入店校验的 exp >= 114514 保持同一边界）
  if ((u.exp || 0) >= 114514) points = 0;

  return { points, experience: minutes };
}

/* ============================================================
 *  baseFunctions 模拟实现
 * ============================================================ */
const baseFunctions = {
  // 已注册用户直接返回用户文档 → app.js 视为登录成功
  getUsrInfo(p, s) {
    return { success: true, data: JSON.parse(JSON.stringify(s.me)) };
  },

  getUsrInfoByName(p, s) {
    const kw = String((p && p.nickname) || '').toLowerCase();
    if (!kw) return { success: true, data: [] };
    const list = allUsers(s).filter((u) => u.nickname.toLowerCase().indexOf(kw) >= 0);
    return {
      success: true,
      data: list.map((u) => ({
        openid: u.openid,
        nickname: u.nickname,
        avatar: u.avatar,
        credit: u.credit,
        exp: u.exp,
        real_point: u.real_point,
        extra_point: u.extra_point,
        role: u.role,
      })),
    };
  },

  getUsrNameByOpenids(p, s) {
    const ids = (p && p.openids) || [];
    if (!Array.isArray(ids) || !ids.length) return { success: true, data: [] };
    return { success: true, data: ids.map((id) => ({ openid: id, nickname: infoOf(s, id).nickname })) };
  },

  getUsrInfoForAuthorize(p, s) {
    const size = p && p.query_num > 0 ? p.query_num : 20;
    const skip = (p && p.skip_num) || 0;
    return { success: true, data: s.userUnauthorized.slice(skip, skip + size) };
  },

  /* ---------- 麻将对局战绩（对齐云端 mahjongStats） ---------- */

  // 录入一局：mock 不校验管理员身份（方便本地开发），云端会校验
  mahjongAddGame(p, s) {
    const { game_date, players } = p || {};
    if (!game_date) return { success: false, errMsg: '缺少对局日期' };
    if (!Array.isArray(players) || players.length !== 4) {
      return { success: false, errMsg: '一局需要恰好 4 名玩家' };
    }
    const seen = new Set();
    for (const pl of players) {
      if (!pl.openid) return { success: false, errMsg: '有玩家未选择' };
      if (seen.has(pl.openid)) return { success: false, errMsg: '同一玩家不能重复入局' };
      seen.add(pl.openid);
      if (!Number.isFinite(Number(pl.points))) return { success: false, errMsg: '点数必须为数字' };
    }
    const sorted = players.slice().sort((a, b) => Number(b.points) - Number(a.points));
    const rankMap = {};
    sorted.forEach((pl, idx) => {
      rankMap[pl.openid] = idx > 0 && Number(pl.points) === Number(sorted[idx - 1].points)
        ? rankMap[sorted[idx - 1].openid] : idx + 1;
    });
    const uinfo = (oid) => allUsers(s).find((u) => u.openid === oid) || {};
    s.mahjongGames.push({
      _id: 'mj-game-' + Date.now(),
      game_date,
      players: players.map((pl) => ({
        openid: pl.openid,
        nickname: uinfo(pl.openid).nickname || '未知用户',
        avatar: uinfo(pl.openid).avatar || AVATAR_OTHER,
        points: Number(pl.points),
        rank: rankMap[pl.openid],
      })),
      recorder_openid: s.me.openid,
      create_time: new Date(),
    });
    return { success: true, data: { game_id: 'ok' } };
  },

  mahjongGetMyStats(p, s) {
    const games = s.mahjongGames
      .slice()
      .sort((a, b) => (a.game_date < b.game_date ? 1 : -1));
    const mine = games.filter((g) => g.players.some((pl) => pl.openid === s.me.openid));
    const rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let pointsSum = 0, rankSum = 0, maxPoints = null;
    mine.forEach((g) => {
      const m = g.players.find((pl) => pl.openid === s.me.openid);
      if (rankCounts[m.rank] !== undefined) rankCounts[m.rank] += 1;
      pointsSum += m.points; rankSum += m.rank;
      if (maxPoints === null || m.points > maxPoints) maxPoints = m.points;
    });
    const total = mine.length;
    const rate = (n) => (total ? +(n * 100 / total).toFixed(2) : 0);
    return {
      success: true,
      data: {
        total,
        rankCounts,
        rankRates: { 1: rate(rankCounts[1]), 2: rate(rankCounts[2]), 3: rate(rankCounts[3]), 4: rate(rankCounts[4]) },
        flyRate: rate(rankCounts[4]),
        avgRank: total ? +(rankSum / total).toFixed(2) : null,
        avgPoints: total ? +(pointsSum / total).toFixed(1) : null,
        maxPoints: total ? maxPoints : null,
        recent: mine.slice(0, 20).reverse().map((g) => {
          const m = g.players.find((pl) => pl.openid === s.me.openid);
          return { game_id: g._id, game_date: g.game_date, rank: m.rank, points: m.points };
        }),
        titles: (s.mahjongTitles || []).filter((t) => t.openid === s.me.openid).map((t) => ({ title: t.title, count: t.count || 1 })),
        displayTitle: s.me.display_title || null,
      },
    };
  },

  mahjongGetRanking(p, s) {
    const agg = {};
    s.mahjongGames.forEach((g) => {
      g.players.forEach((pl) => {
        if (!agg[pl.openid]) agg[pl.openid] = { games: 0, rankSum: 0, pointsSum: 0, win: 0 };
        agg[pl.openid].games += 1;
        agg[pl.openid].rankSum += pl.rank;
        agg[pl.openid].pointsSum += pl.points;
        if (pl.rank === 1) agg[pl.openid].win += 1;
      });
    });
    const titleMap = {};
    (s.mahjongTitles || []).forEach((t) => {
      (titleMap[t.openid] = titleMap[t.openid] || []).push({ title: t.title, count: t.count || 1 });
    });
    const list = Object.keys(agg).map((oid) => {
      const a = agg[oid];
      const u = allUsers(s).find((x) => x.openid === oid) || {};
      return {
        openid: oid,
        nickname: u.nickname || '未知用户',
        avatar: u.avatar || AVATAR_OTHER,
        games: a.games,
        win: a.win,
        winRate: +(a.win * 100 / a.games).toFixed(2),
        avgRank: +(a.rankSum / a.games).toFixed(2),
        totalPoints: a.pointsSum,
        titles: titleMap[oid] || [],
        displayTitle: u.display_title || null,
      };
    }).sort((x, y) => x.avgRank - y.avgRank || y.games - x.games);
    return { success: true, data: list };
  },

  mahjongGrantTitle(p, s) {
    const { openid, title } = p || {};
    if (!openid) return { success: false, errMsg: '未指定玩家' };
    if (!title) return { success: false, errMsg: '未指定称号' };
    s.mahjongTitles = s.mahjongTitles || [];
    const exist = s.mahjongTitles.find((t) => t.openid === openid && t.title === title);
    if (exist) {
      exist.count = (exist.count || 1) + 1;
    } else {
      s.mahjongTitles.push({
        _id: 'mt-' + Date.now(),
        openid, title,
        count: 1,
        grant_by: s.me.openid,
        create_time: new Date(),
      });
    }
    return { success: true };
  },

  mahjongGetGames(p, s) {
    const page_no = Number(p && p.page_no) || 0;
    const page_size = Math.min(Math.max(Number(p && p.page_size) || 20, 1), 50);
    const sorted = s.mahjongGames.slice().sort((a, b) => (a.game_date < b.game_date ? 1 : -1));
    return { success: true, data: sorted.slice(page_no * page_size, (page_no + 1) * page_size) };
  },

  mahjongRevokeTitle(p, s) {
    const { openid, title, count } = p || {};
    if (!openid) return { success: false, errMsg: '未指定玩家' };
    if (!title) return { success: false, errMsg: '未指定称号' };
    const dec = Math.max(1, Number(count) || 1);
    s.mahjongTitles = s.mahjongTitles || [];
    const idx = s.mahjongTitles.findIndex((t) => t.openid === openid && t.title === title);
    if (idx < 0) return { success: false, errMsg: '该玩家没有此称号' };
    const cur = s.mahjongTitles[idx].count || 1;
    if (cur <= dec) {
      s.mahjongTitles.splice(idx, 1);
    } else {
      s.mahjongTitles[idx].count = cur - dec;
    }
    return { success: true };
  },

  mahjongGetPlayerTitles(p, s) {
    const { openid } = p || {};
    if (!openid) return { success: false, errMsg: '未指定玩家' };
    const list = (s.mahjongTitles || []).filter((t) => t.openid === openid).map((t) => ({ title: t.title, count: t.count || 1 }));
    return { success: true, data: list };
  },

  mahjongDeleteGame(p, s) {
    const { game_id } = p || {};
    if (!game_id) return { success: false, errMsg: '未指定对局' };
    const idx = s.mahjongGames.findIndex((g) => g._id === game_id);
    if (idx < 0) return { success: false, errMsg: '对局不存在' };
    s.mahjongGames.splice(idx, 1);
    return { success: true };
  },

  addUsrInfo(p, s) {
    s.me.nickname = (p && p.nickname) || s.me.nickname;
    s.me.phone = (p && p.phone) || s.me.phone;
    s.me.qq_id = (p && p.qq_id) || s.me.qq_id;
    if (p && p.avatar) s.me.avatar = p.avatar;
    return { success: true };
  },

  addUsrInfoUnauthorize(p, s) {
    s.userUnauthorized.push({
      _id: nextId(s, 'ua'),
      openid: (p && p.openid) || ME_OPENID,
      phone: p && p.phone,
      qq_id: p && p.qq_id,
      nickname: p && p.nickname,
      avatar: (p && p.avatar) || AVATAR_OTHER,
    });
    return { success: true };
  },

  authorizeUsrInfo(p, s) {
    return { success: true, data: { exp: s.me.exp, real_point: s.me.real_point, extra_point: s.me.extra_point, cards: s.me.cards, enter_state: s.me.enter_state, enter_time: s.me.enter_time, machine_id: s.me.machine_id } };
  },

  denyUsrInfo(p, s) {
    return { success: true, data: { openid: (p && p.openid) || '' } };
  },

  decryptPhone() {
    return { success: true, data: { phone: '13800000001' } };
  },

  modifyUsrInfo(p, s) {
    const target = allUsers(s).find((u) => u.openid === (p && p.openid)) || s.me;
    const updated = {};
    ['exp', 'role', 'credit', 'real_point', 'extra_point', 'display_title'].forEach((k) => {
      if (!p || typeof p[k] === 'undefined') return;
      if (k === 'role') {
        target[k] = p[k];
      } else {
        const n = Number(p[k]);
        target[k] = n === n ? n : p[k];
      }
      updated[k] = target[k];
    });
    return { success: true, data: updated };
  },

  /**
   * 对齐 cloudfunctions/baseFunctions/getCardInfo：
   *   orderBy('trial','desc').orderBy('cost','desc')
   *   own         = 用户是否持有该卡
   *   isExpired   = own ? (卡到期时间 > now) : null
   *   isTimeExpired = duration.type === 0 时，now 是否已过「当天 end_hour」；
   *                   原版比较的是 duration.end_time 这个 Date 对象的小时/分钟，
   *                   mock 里直接拿 end_hour 等效计算（跨天卡不处理，与原版注释一致）。
   */
  getCardInfo(p, s) {
    const mine = s.me.cards || [];
    const now = nowDate();
    const data = s.cards
      .slice()
      .sort((a, b) => (b.trial || 0) - (a.trial || 0) || (b.cost || 0) - (a.cost || 0))
      .map((c) => {
        const owned = mine.find((m) => m.card_id === c._id);
        const own = !!owned;

        let isTimeExpired = false;
        if (c.duration && c.duration.type === 0) {
          const endHour = Number(c.duration.end_hour);
          const today = new Date(now);
          today.setHours(endHour, 0, 0, 0);
          // 夜场这种 end < start 的跨天卡，结束时间落在次日
          if (Number(c.duration.end_hour) < Number(c.duration.start_hour)) {
            today.setDate(today.getDate() + 1);
          }
          isTimeExpired = now.getTime() >= today.getTime();
        }

        return Object.assign({}, c, {
          own,
          isExpired: own ? !(owned.end_time > now.getTime()) : null,
          isTimeExpired,
        });
      });
    return { success: true, data };
  },

  buyCard(p, s) {
    const card = s.cards.find((c) => c._id === (p && p.card_id) || c.card_name === (p && p.card_name));
    if (!card) return { success: false, errMsg: '该优惠卡不存在' };
    // 对齐原版 buyCard/index.js:152 —— remain 在 (-100, 0] 区间视为已售罄；
    // remain <= -100 表示不限量，不拦。
    if (card.remain !== undefined && card.remain <= 0 && card.remain > -100) {
      return { success: false, errMsg: '该优惠卡已售罄', data: { remain: card.remain } };
    }
    const cost = Number(card.cost) || 0;
    if (totalPoints(s.me) < cost) return { success: false, errMsg: `点数不足，需要 ${cost}, 当前 ${totalPoints(s.me)}` };

    let left = cost;
    const useExtra = Math.min(s.me.extra_point || 0, left);
    s.me.extra_point = Number(((s.me.extra_point || 0) - useExtra).toFixed(2));
    left -= useExtra;
    s.me.real_point = Number(((s.me.real_point || 0) - left).toFixed(2));

    // 对齐原版：只有「限量」(remain >= 0) 的卡购买后才 -1，不限量卡保持 remain 不变
    if (card.remain !== undefined && card.remain > -100 && card.remain >= 0) card.remain -= 1;
    const start = nowTs();
    const end = start + 30 * DAY;
    if (!s.me.cards.some((m) => m.card_id === card._id)) {
      s.me.cards.push({ card_id: card._id, start_time: start, end_time: end });
    } else {
      s.me.cards.forEach((m) => {
        if (m.card_id === card._id) {
          m.start_time = start;
          m.end_time = end;
        }
      });
    }
    return {
      success: true,
      data: {
        openid: s.me.openid,
        card_id: card._id,
        start_time: start,
        end_time: end,
        remain: card.remain,
        new_real_point: s.me.real_point,
        new_extra_point: s.me.extra_point,
      },
    };
  },

  removeCard(p, s) {
    const idx = (s.me.cards || []).findIndex((m) => m.card_id === (p && p.card_id));
    if (idx < 0) return { success: false, errMsg: '用户不存在或未拥有该荣誉卡' };
    s.me.cards.splice(idx, 1);
    const card = s.cards.find((c) => c._id === (p && p.card_id));
    if (card && card.remain > -100 && card.remain >= 0) card.remain += 1;
    return { success: true };
  },

  getPointInfo(p, s) {
    return { success: true, data: s.points };
  },

  buyPoint(p, s) {
    const add = Number((p && p.point) || 0);
    s.me.real_point = Number((s.me.real_point + add).toFixed(2));
    return { success: true, data: { openid: s.me.openid, real_point_add: add, extra_point_add: 0 } };
  },

  removePoint(p, s) {
    s.me.real_point = Number((s.me.real_point - Number((p && p.real_point_add) || 0)).toFixed(2));
    s.me.extra_point = Number((s.me.extra_point - Number((p && p.extra_point_add) || 0)).toFixed(2));
    return { success: true };
  },

  transferPoint(p, s) {
    const amount = Number((p && p.transfer_point) || 0);
    const dst = allUsers(s).find((u) => u.openid === (p && p.dst_openid));
    if (!dst) return { success: false, errMsg: '目标用户不存在或点数转移失败，请重试' };
    if (s.me.real_point < amount) return { success: false, errMsg: '用户可转移点数不足！' };
    s.me.real_point = Number((s.me.real_point - amount).toFixed(2));
    dst.real_point = Number((dst.real_point + amount).toFixed(2));
    return { success: true, data: { real_point: s.me.real_point, transfer_point: amount } };
  },

  getOrderInfo(p, s) {
    const rows = s.orders
      .filter((o) => o.state === 1)
      .filter((o) => !p || !p.openid || o.openid === p.openid)
      .sort((a, b) => b.time_order - a.time_order)
      .map((o) => Object.assign({}, o, { nickname: infoOf(s, o.openid).nickname, avatar: infoOf(s, o.openid).avatar }));
    return { success: true, data: rows };
  },

  getReserveInfo(p, s) {
    return {
      success: true,
      data: {
        reserve_qualification: (s.me.credit || 0) >= 85,
        reserve_data: s.reserve,
        reserve_limit: s.meta.reserve_limit,
        reserve_max: s.meta.reserve_max,
        reserve_cost: s.meta.reserve_cost,
      },
    };
  },

  buyReserve(p, s) {
    const day = p && p.reserve_date;
    if (!day) return { success: false, errMsg: '未传入预约时间信息' };
    const nightCard = s.cards.find((c) => c.card_name === '夜场');
    if (!nightCard) return { success: false, errMsg: '未搜到夜场卡信息' };
    let rec = s.reserve.find((r) => r.day === day);
    if (!rec) {
      rec = { _id: nextId(s, 'rsv'), day, openids: [] };
      s.reserve.push(rec);
    }
    if (rec.openids.indexOf(ME_OPENID) >= 0) return { success: false, errMsg: '已预约过该时段' };
    if (rec.openids.length >= s.meta.reserve_max) return { success: false, errMsg: '该时段已预约满员' };
    rec.openids.push(ME_OPENID);
    s.me.exp += 100;
    // 预约成功即把夜场卡发到 user.cards，对齐云端 buyReserve/index.js:547-551：
    //   cards: db_cmd.push({ card_id: night_card_id, start_time, end_time })
    // 夜场卡不在优惠卡列表展示，只能通过预约拿到。
    const period = nightCardPeriod(day, nightCard.duration);
    s.me.cards.push({ card_id: nightCard._id, start_time: period.start_time, end_time: period.end_time });
    return { success: true };
  },

  getNotice(p, s) {
    return { success: true, data: s.meta.notice };
  },

  sendMail(p, s) {
    const mail = {
      _id: nextId(s, 'mail'),
      sender: (p && p.sender) || s.me.openid,
      receiver: (p && p.receiver) || s.me.openid,
      time: nowTs(),
      title: (p && p.title) || '',
      content: (p && p.content) || '',
      read: false,
    };
    s.mails.unshift(mail);
    return { success: true, data: { sender: mail.sender, receiver: mail.receiver, time: mail.time, content: mail.content } };
  },

  getMail(p, s) {
    const rows = s.mails
      .filter((m) => m.receiver === ME_OPENID || m.receiver === 'all')
      .sort((a, b) => b.time - a.time);
    return { success: true, data: rows };
  },

  readMail(p, s) {
    const mail = s.mails.find((m) => m._id === (p && p.mail_id));
    if (mail) mail.read = true;
    return { success: true };
  },

  getUnreadMessageCount(p, s) {
    const unread = s.mails.filter((m) => m.receiver === ME_OPENID && !m.read);
    const announcements = s.mails.filter((m) => m.receiver === 'all' && !m.read).map((m) => m._id);
    return { success: true, data: { personalUnreadCount: unread.length, announcementIds: announcements } };
  },
};

/* ============================================================
 *  queueFunctions 模拟实现
 * ============================================================ */
const queueFunctions = {
  getEnterInfo(p, s) {
    const stats = enterStats(s);
    return {
      success: true,
      data: {
        openid: s.me.openid,
        real_point: s.me.real_point,
        extra_point: s.me.extra_point,
        enter_state: s.me.enter_state,
        enter_time: s.me.enter_time,
        machine_id: s.me.machine_id,
        area: normalizeArea(s.me.area),
        relax_num: stats.relax,
        play_num: stats.play,
        arcade_num: stats.arcade,
        board_num: stats.board,
        business_status: !!s.meta.business_status,
      },
    };
  },

  getAllEnterInfo(p, s) {
    return {
      success: true,
      data: inStoreUsers(s).map((u) => ({ openid: u.openid, nickname: u.nickname, avatar: u.avatar })),
    };
  },

  getCurrentInStoreInfo(p, s) {
    const rows = inStoreUsers(s)
      .sort((a, b) => new Date(a.enter_time || 0).getTime() - new Date(b.enter_time || 0).getTime())
      .map((u) => ({
        openid: u.openid,
        nickname: u.nickname,
        avatar: u.avatar,
        enter_state: u.enter_state,
        enter_time: u.enter_time,
      }));
    return { success: true, data: rows, total: rows.length };
  },

  getMachineInfo(p, s) {
    return { success: true, data: s.machines };
  },

  getQueueInfo(p, s) {
    const id = p && p.machine_id;
    const machine = s.machines.find((m) => m._id === id);
    if (!machine) return { success: false, errMsg: '机器不可用' };
    if (machine.is_disabled) return { success: false, errMsg: '机器不可用' };
    return { success: true, data: buildQueue(s, id) };
  },

  Enqueue(p, s) {
    const id = p && p.machine_id;
    const machine = s.machines.find((m) => m._id === id);
    if (!machine || machine.is_disabled) return { success: false, errMsg: '机器不可用' };
    if (s.me.enter_state === 0) return { success: false, errMsg: '用户未入店，请重试' };
    // 跨区排卡拉黑：机台所属区域必须和用户当前入店区域一致
    //   桌游区的人只能排日麻，音游区的人只能排音游机台（对齐 cloudfunctions/queueFunctions/Enqueue）
    const myArea = normalizeArea(s.me.area);
    const mArea = machineArea(machine);
    if (myArea !== mArea) {
      return {
        success: false,
        errMsg: myArea === AREA_BOARD
          ? '桌游区无法排音游机台，请先离店后重新选择音游区入店'
          : '日麻属于桌游区，请先离店后重新选择「桌游/日麻」入店',
      };
    }
    const inOther = Object.keys(s.queues).find((k) => k !== id && s.queues[k].some((q) => q.openid === ME_OPENID));
    if (inOther) return { success: false, errMsg: '用户正在其他机器上排队，请先退队后重试' };
    if ((s.queues[id] || []).some((q) => q.openid === ME_OPENID)) return { success: false, errMsg: '当前用户已在队列中，请刷新重试' };
    // 对齐原版 Enqueue：`应扣点数 > 余额` 才算余额不足（原版 Enqueue/index.js:119）
    // ⚠️ 之前写死 `totalPoints <= 0`，会导致「持有免单卡、本就不扣费、余额 0」的用户也排不了卡。
    if (consumedPoints(s, s.me).points > totalPoints(s.me)) return { success: false, errMsg: '余额不足' };

    if (!s.queues[id]) s.queues[id] = [];
    s.queues[id].push({ openid: ME_OPENID, timestamp: nowTs(), play_status: false, is_multi: !!(p && p.is_multi), next_id: '-1' });
    s.me.enter_state = 2;
    s.me.machine_id = id;
    if (!s.me.enter_time) s.me.enter_time = nowTs();
    pushQueueLog(s, id, ME_OPENID, logText(s, ME_OPENID, '加入排队'));
    return { success: true, data: buildQueue(s, id) };
  },

  Dequeue(p, s) {
    const id = p && p.machine_id;
    const list = s.queues[id] || [];
    const idx = list.findIndex((q) => q.openid === ME_OPENID);
    if (idx < 0) return { success: false, errMsg: '用户不在队列中，请重试' };
    list.splice(idx, 1);
    s.me.enter_state = 1;
    s.me.machine_id = '';
    pushQueueLog(s, id, ME_OPENID, logText(s, ME_OPENID, '退出排队'));
    return { success: true, data: buildQueue(s, id) };
  },

  Embark(p, s) {
    const id = p && p.machine_id;
    const machine = s.machines.find((m) => m._id === id);
    if (!machine || machine.is_disabled) return { success: false, errMsg: '机器不可用' };
    const list = s.queues[id] || [];
    const me = list.find((q) => q.openid === ME_OPENID);
    if (!me) return { success: false, errMsg: '当前用户排队状态有误，请刷新页面重试' };
    const playing = list.filter((q) => q.play_status).length;
    if (playing >= machine.max_player && !me.play_status) return { success: false, errMsg: '当前游玩人数已满请耐心等待' };
    if (consumedPoints(s, s.me).points > totalPoints(s.me)) return { success: false, errMsg: '余额不足' };

    me.play_status = true;
    me.is_multi = !!(p && p.is_multi);
    me.play_position = (p && typeof p.play_position !== 'undefined') ? Number(p.play_position) : undefined;   // ← 加这行
    s.me.enter_state = 3;
    s.me.machine_id = id;
    pushQueueLog(s, id, ME_OPENID, logText(s, ME_OPENID, '上机'));
    return { success: true, data: buildQueue(s, id) };
  },

  Deplain(p, s) {
    const id = p && p.machine_id;
    const list = s.queues[id] || [];
    const me = list.find((q) => q.openid === ME_OPENID);
    if (!me || !me.play_status) return { success: false, data: buildQueue(s, id), errMsg: '当前用户排队状态有误，请刷新页面重试' };
    me.play_status = false;
    me.play_position = undefined;
    me.is_multi = true;          // ← 下机重置为"拼机"
    list.splice(list.indexOf(me), 1);
    list.push(me);
    s.me.enter_state = 2;
    pushQueueLog(s, id, ME_OPENID, logText(s, ME_OPENID, '下机并回到队尾'));
    return { success: true, data: buildQueue(s, id) };
  },

  DeplainAll(p, s) {
    const id = p && p.machine_id;
    const list = s.queues[id] || [];
    let changed = false;
    list.forEach((q) => {
      if (q.play_status) {
        q.play_status = false;
        changed = true;
      }
    });
    if (!changed) return { success: false, errMsg: '当前用户排队状态有误，请刷新页面重试' };
    list.sort((a, b) => (a.play_status === b.play_status ? a.timestamp - b.timestamp : a.play_status ? -1 : 1));
    if (list.some((q) => q.openid === ME_OPENID)) s.me.enter_state = 2;
    ['mock-openid-02', 'mock-openid-04'].forEach((o) => {
      const u = allUsers(s).find((x) => x.openid === o);
      if (u && u.machine_id === id) u.enter_state = 2;
    });
    pushQueueLog(s, id, ME_OPENID, logText(s, ME_OPENID, '一键下机'));
    return { success: true, data: buildQueue(s, id), errMsg: '' };
  },

  /**
   * 入店。余额校验严格对齐（并修复）原版 enterArcade：
   *   remain_total < 0                                  → 余额不足（异常数据）
   *   remain_total == 0 && exp < 114514 && !免单卡       → 余额不足
   * 修复点：原版没考虑优惠卡，买了「畅玩套餐」这类免单卡后余额为 0 也进不了店。
   *         持有当前时段免单卡时不产生扣费，应放行。
   *
   * 入店状态（与「选设备」的入店流程配套）：
   *   · 两个区入店后都是 enter_state = 1（休息中），因为入店后都要排队：
   *     音游区排队 → 2（候机中）→ 上机 → 3（游玩中）
   *     桌游区排日麻 → 2（候机中）→ 上机 → 3（游玩中）
   *   · 日麻也是机台（M05，max_player 4 = 一桌 4 人），所以桌游区同样要排队。
   */
  enterArcade(p, s) {
    if (s.me.enter_state !== 0) return { success: false, errMsg: '用户已入店，请刷新重试' };
    const remain = totalPoints(s.me);
    const freeCard = hasFreeTimeCard(s, ME_OPENID);
    if (remain < 0 || (remain === 0 && (s.me.exp || 0) < 114514 && !freeCard)) {
      return { success: false, errMsg: '余额不足' };
    }
    if ((s.me.credit || 0) < 60) return { success: false, errMsg: '您的信用太差了，本店拒绝您访问' };
    const area = normalizeArea(p && p.area);
    // 两个区统一为「休息中」，随后由 Enqueue 置为「候机中」（日麻也要排队）
    s.me.enter_state = 1;
    s.me.enter_time = nowTs();
    s.me.machine_id = '';
    s.me.area = area;
    addArcadeLog(s, ME_OPENID, totalPoints(s.me), s.me.exp, 0);
    return { success: true, errMsg: '入店成功', data: { area } };
  },

  leaveArcade(p, s) {
    if (s.me.enter_state === 0) return { success: false, errMsg: '用户未入店，请刷新重试' };
    // 在队列里则先自动退队
    const queued = Object.keys(s.queues).find((k) => s.queues[k].some((q) => q.openid === ME_OPENID));
    if (queued) {
      s.queues[queued] = s.queues[queued].filter((q) => q.openid !== ME_OPENID);
    }
    const used = consumedPoints(s, s.me);
    let left = used.points;
    const fromExtra = Math.min(s.me.extra_point || 0, left);
    s.me.extra_point = Number(((s.me.extra_point || 0) - fromExtra).toFixed(2));
    left = Number((left - fromExtra).toFixed(2));
    s.me.real_point = Number(((s.me.real_point || 0) - left).toFixed(2));
    s.me.exp += used.experience;
    s.me.enter_state = 0;
    s.me.enter_time = null;
    s.me.machine_id = '';
    delete s.me.area; // 离店后不再保留入店区域（对齐云端 leaveArcade 的 area remove）
    addArcadeLog(s, ME_OPENID, totalPoints(s.me), s.me.exp, 1);
    return { success: true, errMsg: '退店成功' };
  },

  leaveArcadeForce(p, s) {
    const target = (p && p.targetOpenid) || '';
    const u = allUsers(s).find((x) => x.openid === target);
    if (!target) return { success: false, errMsg: '无效的目标用户ID' };
    if (!u) return { success: false, errMsg: '未找到该用户' };
    if (u.enter_state === 0) return { success: true, message: '用户已离店，无需操作' };
    Object.keys(s.queues).forEach((k) => {
      s.queues[k] = s.queues[k].filter((q) => q.openid !== target);
    });
    u.enter_state = 0;
    u.enter_time = null;
    u.machine_id = '';
    delete u.area; // 离店后不再保留入店区域
    addArcadeLog(s, target, totalPoints(u), u.exp, 1);
    return { success: true };
  },

  getArcadeInfo(p, s) {
    const rows = s.arcadeLog
      .slice()
      .sort((a, b) => b.time - a.time)
      .map((x) => Object.assign({}, x, { nickname: infoOf(s, x.openid).nickname, avatar: infoOf(s, x.openid).avatar }));
    return { success: true, data: rows };
  },

  getDoorInfo(p, s) {
    const rows = s.doorLog
      .slice()
      .sort((a, b) => b.time - a.time)
      .map((x) => Object.assign({}, x, { nickname: infoOf(s, x.openid).nickname, avatar: infoOf(s, x.openid).avatar }));
    return { success: true, data: rows };
  },

  getReport(p, s) {
    const rows = s.reports
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((r) =>
        Object.assign({}, r, {
          from_nickname: infoOf(s, r.from_openid).nickname,
          from_avatar: infoOf(s, r.from_openid).avatar,
          to_nickname: infoOf(s, r.to_openid).nickname,
          to_avatar: infoOf(s, r.to_openid).avatar,
        })
      );
    return { success: true, data: rows };
  },

  dealReport(p, s) {
    const r = s.reports.find((x) => x._id === (p && p.report_id));
    if (r) r.handled = true;
    return { success: true };
  },

  Report(p, s) {
    s.reports.unshift({
      _id: nextId(s, 'report'),
      from_openid: ME_OPENID,
      to_openid: (p && p.to_openid) || '',
      timestamp: nowTs(),
      content: (p && p.content) || '',
      handled: false,
    });
    return { success: true, errMsg: '举报成功' };
  },

  queueLog(p, s) {
    const id = p && p.machine_id;
    return { success: true, data: (s.queueLogs[id] || []).slice().reverse() };
  },

  modifyBusinessStatus(p, s) {
    if (!p || typeof p.business_status === 'undefined') return { success: false, errMsg: 'business status not in params' };
    s.meta.business_status = !!p.business_status;
    if (!p.business_status) {
      inStoreUsers(s).forEach((u) => {
        u.enter_state = 0;
        u.enter_time = null;
        u.machine_id = '';
      });
      s.queues = Object.keys(s.queues).reduce((acc, k) => {
        acc[k] = [];
        return acc;
      }, {});
    }
    return { success: true, data: { business_status: s.meta.business_status } };
  },

  getConsumePoint(p, s) {
    if (s.me.enter_state === 0) return { success: false, code: -3, errMsg: '用户未入店，请重试' };
    const used = consumedPoints(s, s.me);
    return { success: true, data: { points: used.points, experience: used.experience } };
  },

  /**
   * 对齐原版 checkAndChargeBalance：拿 getConsumePoint 算出的「应扣点数」和余额比较，
   *   remain_need > remain_total 才算不足。
   * ⚠️ 之前这里写死成 `totalPoints <= 0`，会导致「持免单卡、余额 0、本就不扣费」的用户
   *    也被判定余额不足强制退队 —— 与「买了优惠票不扣费」的诉求直接冲突，已修正。
   *
   * 【本次改动】费用扣成负数时**不再强制退队**，只把结果回报给前端做提醒。
   *   原版：余额不足 → 调 Dequeue 把人踢出队列（enter_state 不动），前端弹「余额不足」。
   *   现在：完全不碰队列，只返回 code: -2 + overdraft: true，
   *         前端显示常驻红字并只弹一次提示；排队位置保留，充值后照常上机。
   */
  checkAndChargeBalance(p, s) {
    if (s.me.enter_state === 0) return { success: false, errMsg: '用户未入店，无需判断' };
    const need = consumedPoints(s, s.me).points;
    const has = totalPoints(s.me);
    if (need > has) {
      return {
        success: false,
        code: -2,
        overdraft: true,
        data: { need, has, shortage: Number((need - has).toFixed(2)) },
        errMsg: '余额已透支，请及时充值',
      };
    }
    return { success: true, overdraft: false, errMsg: '余额充足' };
  },

  ifNight(p, s) {
    const h = nowDate().getHours();
    const night = h >= 23 || h <= 9;
    const now = nowTs();
    // 只认「夜场票」和「夜场桌游麻将票」两张卡（按 card_id 判断），
    // 且当前时间在有效期内。与云端 queueFunctions/ifNight 一致。
    // 其他卡（日间/全天畅玩、日场桌游麻将票等）不构成夜场入店资格。
    const hasCard = (s.me.cards || []).some((c) => {
      const start = new Date(c.start_time).getTime();
      const end = new Date(c.end_time).getTime();
      const isNightCard = c.card_id === NIGHT_CARD_ID || (BOARD_NIGHT_CARD_ID && c.card_id === BOARD_NIGHT_CARD_ID);
      return isNightCard && now >= start && now <= end;
    });
    return { success: true, data: { ifNight: night, hasCard } };
  },

  switchMulti(p, s) {
    const id = p && p.machine_id;
    const list = s.queues[id] || [];
    const me = list.find((q) => q.openid === ME_OPENID);
    const toMulti = !!(p && p.is_multi);
    if (me) me.is_multi = toMulti;
    const action = toMulti ? '切换为拼机' : '切换为单刷'
    pushQueueLog(s, id, ME_OPENID, logText(s, ME_OPENID, action));
    return { success: true, data: { machine_id: id, openid: ME_OPENID, is_multi: toMulti } };
  },

  checkUpdate(p, s) {
    const id = p && p.machine_id;
    if (s.me.enter_state === 0) return { success: false, errMsg: '用户不在排队状态，请重试' };
    return { success: true, data: buildQueue(s, id) };
  },

  // 拖动排序：把 from_openid 移动到 to_openid 之前（"-1" = 队尾）。
  // ⚠️ 与云端的已知差异：云端 delay 在改链表前会抢这台机台的分布式锁（machine_lock），
    //    抢不到就报错；离线模拟层没有锁，所以「并发抢锁失败」这类问题在离线测不出来 ——
    //    2.2.9 修的「拖动排序每次都失败」就是这种只在真机云端才暴露的 bug。
  Delay(p, s) {
    const id = p && p.machine_id;
    const list = s.queues[id] || [];
    const fromIdx = list.findIndex((q) => q.openid === (p && p.from_openid));
    const toOpenid = p && p.to_openid;
    if (fromIdx < 0) return { success: false, errMsg: '未找到要移动的用户' };
    const moved = list[fromIdx];
    const fromPos = fromIdx + 1; // 1-based position
    let toPos;
    if (toOpenid === '-1') {
      // 目标为队尾：排到最后
      list.splice(fromIdx, 1);
      list.push(moved);
      toPos = list.length;
    } else {
      // 目标为某位玩家：排到他前面。
      // 先确认目标还在队列中再摘除，否则「目标已不在」时用户会被摘掉却插不回去。
      // 云端 delay 也是这个顺序：校验全部做完才开始写库。
      if (!list.some((q) => q.openid === toOpenid && q !== moved)) {
        return { success: false, errMsg: '目标用户已不在队列中，请刷新重试' };
      }
      list.splice(fromIdx, 1);
      const at = list.findIndex((q) => q.openid === toOpenid);
      list.splice(at, 0, moved);
      toPos = at + 1;
    }
    const moverName = infoOf(s, moved.openid).nickname;
    const actionText = (p && p.from_openid === p.to_openid)
      ? `${moverName}将自身位置移至第${fromPos}位`
      : `${moverName}将${moverName}从第${fromPos}位移至第${toPos}位`;
    pushQueueLog(s, id, moved.openid, actionText);
    return { success: true, data: buildQueue(s, id) };
  },

  kickOut(p, s) {
    const id = p && p.machine_id;
    const target = (p && p.openid) || '';
    const list = s.queues[id] || [];
    const idx = list.findIndex((q) => q.openid === target);
    if (idx < 0) return { success: false, errMsg: '当前用户已不在队列中，请刷新重试' };
    list.splice(idx, 1);
    const u = allUsers(s).find((x) => x.openid === target);
    if (u) {
      u.enter_state = 1;
      u.machine_id = '';
    }
    pushQueueLog(s, id, target, logText(s, target, '被移出队列'));
    return { success: true, data: buildQueue(s, id) };
  },

  openDoor(p, s) {
    s.doorLog.unshift({ _id: nextId(s, 'dl'), openid: ME_OPENID, time: nowTs() });
    return { success: true };
  },
};

/* ============================================================
 *  统一分发
 * ============================================================ */
function dispatch(name, data) {
  const s = load();
  const type = data && data.type;
  const params = (data && data.params) || {};
  // 记下调用前的各机台队列，调用结束后按机台比对：
  // 只有真的变了才推给监听者，免得没动队列的调用（如 getQueueInfo）也触发刷新
  const queuesBefore = {};
  Object.keys(s.queues).forEach((machineId) => {
    queuesBefore[machineId] = JSON.stringify(s.queues[machineId]);
  });
  let result;

  if (name === 'baseFunctions') {
    const fn = baseFunctions[type];
    result = fn ? fn(params, s) : { success: true, data: null };
    if (!fn) console.warn('[Mock] baseFunctions 未实现的 type：', type);
  } else if (name === 'queueFunctions') {
    const fn = queueFunctions[type];
    result = fn ? fn(params, s) : { success: true, data: null };
    if (!fn) console.warn('[Mock] queueFunctions 未实现的 type：', type);
  } else if (name === 'cloudbase_module') {
    // 云开发工作流（此处用于生成支付参数）：伪造一笔支付单，并记录待充值的点数
    const payload = (data && data.data) || {};
    const amount = Number(payload.point) || 0;
    // 充值赠送倍率严格对齐 cloudfunctions/baseFunctions/buyPoint/index.js：
    //   仅当充值 >= 100 点才赠送；按 exp 等级分档，Lv6（exp >= 114514）直接拒绝充值。
    const exp = s.me.exp || 0;
    let bonus = 0;
    if (amount >= 100) {
      if (exp <= 2000) bonus = 0;
      else if (exp <= 8000) bonus = 0.05;
      else if (exp <= 18000) bonus = 0.1;
      else if (exp <= 30000) bonus = 0.2;
      else if (exp < 114514) bonus = 0.3;
      else return { success: false, errMsg: '最高等级用户无需充值！' };
    }
    s.pendingRecharge = { amount, extra: Number((amount * bonus).toFixed(2)) };
    result = {
      errMsg: 'ok',
      data: {
        timeStamp: String(Math.floor(nowTs() / 1000)),
        nonceStr: 'mocknonce' + s.seq,
        packageVal: 'prepay_id=wx_mock_' + nowTs(),
        signType: 'RSA',
        paySign: 'mock_pay_sign',
      },
    };
  } else {
    console.warn('[Mock] 未识别的云函数：', name);
    result = { success: true, data: null };
  }

  save(s);
  // 队列被改动的机台推一次变更，模拟真机数据库的实时推送
  Object.keys(s.queues).forEach((machineId) => {
    if (JSON.stringify(s.queues[machineId]) !== queuesBefore[machineId]) {
      notifyQueueWatchers('queue_' + machineId);
    }
  });
  return result;
}

function applyPendingRecharge() {
  const s = load();
  const pending = s.pendingRecharge;
  if (!pending) return null;
  s.me.real_point = Number(((s.me.real_point || 0) + pending.amount).toFixed(2));
  s.me.extra_point = Number(((s.me.extra_point || 0) + (pending.extra || 0)).toFixed(2));
  s.me.exp += Math.round(pending.amount);
  s.orders.unshift({
    _id: nextId(s, 'order'),
    openid: ME_OPENID,
    state: 1,
    time_order: nowTs(),
    time_expire: nowTs() + 30 * DAY,
    point: pending.amount,
  });
  s.pendingRecharge = null;
  save(s);
  console.log('[Mock] 模拟支付成功，已到账', pending.amount, '点（赠送', pending.extra || 0, '点）');
  return s;
}

/* ============================================================
 *  云能力桩
 * ============================================================ */

/* ---------- 云开发数据库实时监听（watch）桩 ----------
   真机上 watch 走客户端数据库权限、由数据库主动推变更；离线模拟层没有数据库，
   这里用一张「集合名 → 回调表」还原同样的语义，让离线也能看到实时刷新：
     · 建立监听后先推一次 type='init' 的首帧（真机也是这个行为）
     · 队列数据真的被改写时推一次 type='update'（见 dispatch / resetMockData）
     · 返回 close()，页面离开时调用
   ⚠️ 集合名按真机规则拼成 queue_<机台ID>，对应假数据里的 s.queues[机台ID]。 */
const queueWatchers = new Map();   // collectionName -> Set<handlers>

function notifyQueueWatchers(collectionName) {
  const handlers = queueWatchers.get(collectionName);
  if (!handlers) return;
  handlers.forEach((h) => {
    try {
      h.onChange({ type: 'update', docChanges: [] });
    } catch (e) {
      console.warn('[Mock] 队列监听回调出错', e);
    }
  });
}

function notifyAllQueueWatchers() {
  Array.from(queueWatchers.keys()).forEach(notifyQueueWatchers);
}

function makeDatabaseStub() {
  const empty = () => Promise.resolve({ data: [] });
  const chain = {
    where: () => chain,
    field: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    skip: () => chain,
    get: empty,
    count: () => Promise.resolve({ total: 0 }),
    add: () => Promise.resolve({ _id: 'mock-id' }),
    update: () => Promise.resolve({ stats: { updated: 1 } }),
    remove: () => Promise.resolve({ stats: { removed: 1 } }),
    aggregate: () => ({ match: () => chain, group: () => chain, count: () => chain, end: () => Promise.resolve({ list: [] }) }),
  };
  return {
    collection: (name) => ({
      ...chain,
      watch(handlers) {
        if (!queueWatchers.has(name)) queueWatchers.set(name, new Set());
        queueWatchers.get(name).add(handlers);
        // 真机的首帧是异步推下来的，这里也用异步对齐，
        // 免得页面在 onShow 里同步重入（onChange 会立刻拉一次队列）
        setTimeout(() => {
          const set = queueWatchers.get(name);
          if (set && set.has(handlers)) handlers.onChange({ type: 'init', docChanges: [] });
        }, 0);
        return {
          close() {
            const set = queueWatchers.get(name);
            if (set) set.delete(handlers);
          },
        };
      },
    }),
    command: {
      eq: (v) => v,
      neq: (v) => v,
      gt: (v) => v,
      gte: (v) => v,
      lt: (v) => v,
      lte: (v) => v,
      in: (v) => v,
      nin: (v) => v,
      and: (v) => v,
      or: (v) => v,
      inc: (v) => v,
      push: (v) => v,
      aggregate: {},
      RegExp: (o) => o,
    },
    serverDate: () => nowDate(),
  };
}

export function installCloudMock() {
  if (!MOCK_ENABLED) return false;

  const original = { cloud: wx.cloud, requestPayment: wx.requestPayment };
  wx.__mockOriginal = original;

  wx.cloud = {
    init() {
      console.log('[Mock] wx.cloud.init 已被本地模拟层接管，不会真实连接云环境');
    },
    callFunction(opt) {
      const name = opt && opt.name;
      try {
        return Promise.resolve(dispatch(name, opt && opt.data)).then((result) => ({ result }));
      } catch (e) {
        console.error('[Mock] 处理云调用出错', name, e);
        return Promise.resolve({ result: { success: false, errMsg: '模拟层内部错误：' + e.message } });
      }
    },
    uploadFile(opt) {
      // 直接把本地临时文件路径当作 fileID 返回，图片/头像仍能正常显示
      const fileID = (opt && opt.filePath) || AVATAR_ME;
      console.log('[Mock] 模拟上传文件：', fileID);
      return Promise.resolve({ fileID, statusCode: 200 });
    },
    downloadFile(opt) {
      return Promise.resolve({ tempFilePath: (opt && opt.fileID) || '', statusCode: 200 });
    },
    getTempFileURL(opt) {
      const list = ((opt && opt.fileList) || []).map((f) => ({ fileID: f, tempFileURL: typeof f === 'string' ? f : f.fileID }));
      return Promise.resolve({ fileList: list });
    },
    deleteFile() {
      return Promise.resolve({ fileList: [] });
    },
    database: makeDatabaseStub,
    Cloud: function MockCloud() {},
  };

  // 模拟微信支付：直接成功，并把待充值点数入账
  wx.requestPayment = function (opt = {}) {
    return new Promise((resolve) => {
      wx.showLoading({ title: '模拟支付中...', mask: true });
      setTimeout(() => {
        wx.hideLoading();
        applyPendingRecharge();
        const res = { errMsg: 'requestPayment:ok' };
        if (typeof opt.success === 'function') opt.success(res);
        if (typeof opt.complete === 'function') opt.complete(res);
        resolve(res);
      }, 600);
    });
  };

  // 调试辅助
  wx.resetMockData = resetMockData;
  wx.getMockState = getMockState;
  wx.mockGrantPoints = function (n = 100) {
    const s = load();
    s.me.real_point = Number((s.me.real_point + Number(n)).toFixed(2));
    save(s);
    console.log('[Mock] 已给当前用户增加', n, '点，当前余额', s.me.real_point + s.me.extra_point);
  };
  // 直接把余额设成某个数（初始余额是 0，测欠费前先给点钱时用这个最方便）
  //   wx.mockSetPoints(20)   余额设为 20 点
  //   wx.mockSetPoints(100)  恢复成 100 点
  wx.mockSetPoints = function (n = 0) {
    const s = load();
    s.me.real_point = Number(n) || 0;
    s.me.extra_point = 0;
    save(s);
    console.log('[Mock] 余额已设为', s.me.real_point, '点');
  };
  // ---------- 虚拟时间（测试夜场用） ----------
  // 把虚拟时间设为今天的 HH:MM（dayOffset 可指定偏移天数，如 1 = 明天）
  wx.mockSetTime = function (hhmm, dayOffset = 0) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
    if (!m) {
      console.warn('[Mock] 格式不对，示例：wx.mockSetTime("23:30") 或 wx.mockSetTime("01:15", 1)');
      return;
    }
    const target = new Date();
    target.setDate(target.getDate() + Number(dayOffset));
    target.setHours(Number(m[1]), Number(m[2]), 0, 0);
    const s = load();
    s.timeOffset = target.getTime() - REAL_NOW();
    save(s);
    console.log('[Mock] 虚拟时间已设为', nowDate().toLocaleString(), '（时间会继续正常流逝）');
  };
  // 在当前虚拟时间上再加 n 小时（可传负数）
  wx.mockAddHours = function (n) {
    const s = load();
    s.timeOffset = (s.timeOffset || 0) + Number(n) * 3600 * 1000;
    save(s);
    console.log('[Mock] 虚拟时间 +', n, '小时 →', nowDate().toLocaleString());
  };
  // 回到真实时间
  wx.mockResetTime = function () {
    const s = load();
    s.timeOffset = 0;
    save(s);
    console.log('[Mock] 已恢复真实时间 →', nowDate().toLocaleString());
  };
  // 查看当前虚拟时间
  wx.mockNow = function () {
    const d = nowDate();
    console.log('[Mock] 当前虚拟时间:', d.toLocaleString(), '（真实时间:', new Date().toLocaleString(), '）');
    return d;
  };

  // 动态改信用分（切换等级不用改代码重新编译）：
  //   wx.mockSetCredit(92) → S ；78 → A ；65 → B ；55 → C
  //   改完重新进入页面（或下拉刷新）即可看到新等级。
  wx.mockSetCredit = function (n) {
    const s = load();
    s.me.credit = Number(n);
    save(s);
    const grade = s.me.credit >= 85 ? 'S' : s.me.credit >= 70 ? 'A' : s.me.credit >= 60 ? 'B' : 'C';
    console.log(`[Mock] 信用分已设为 ${s.me.credit} → ${grade} 级（重新进入页面生效）`);
  };

  console.log('%c[Mock] 本地离线模拟层已启用：所有云调用都返回假数据', 'color:#07C160;font-weight:bold');
  return true;
}
