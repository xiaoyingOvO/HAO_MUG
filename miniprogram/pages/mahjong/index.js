// pages/mahjong/index.js
import cloudFcn from '../../cloudFcn.js';
import { decorateTitles, countUnknownTitles, getTitle } from '../../utils/mahjongTitles.js';

/**
 * 空模式数据。结构与云函数 getMyStatsMain 里 buildMode() 的返回保持一致。
 * 页面骨架始终渲染，没数据时靠这个占位 —— 否则新用户进来只能看到一句
 * 「还没有对局记录」，连有哪些指标都不知道，像个坏页面。
 */
function emptyModeStats(mode) {
  const three = mode === 'three';
  const topRank = three ? 3 : 4;
  const rankCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const rankRates = {};
  for (let r = 1; r <= topRank; r++) rankRates[r] = 0;
  return {
    mode: three ? 'three' : 'four',
    topRank,
    games: 0,
    rankCounts,
    rankRates,
    pointsSum: null,
    avgRank: null,
    avgPoints: null,
    maxPoints: null,
    power: null,
    recent: [],
  };
}

/* ---------- 排行榜规则文案 ----------
 * 麻币结算表和雀力系数都由云端 rankConfig 下发，文案必须跟着配置重算。
 * 早先这段字写在 wxml 里写死，四麻改成 +3/+1/0/-2 之后，榜上还在念 +2/+1/0/-1。
 */
const DEFAULT_COIN_BY_RANK = { four: { 1: 3, 2: 1, 3: 0, 4: -2 }, three: { 1: 2, 2: 0, 3: -1 } };
const DEFAULT_POWER = { base: 1000, coef: 300, baseRank: { four: 2.5, three: 2.0 }, minGames: 10 };

function buildCoinRule(config) {
  const table = (config && config.coinByRank) || DEFAULT_COIN_BY_RANK;
  const fmt = (t, top) => {
    const out = [];
    for (let r = 1; r <= top; r += 1) {
      const v = Number((t || {})[r]) || 0;
      out.push(r + '位' + (v > 0 ? '+' + v : String(v)));
    }
    return out.join(' / ');
  };
  return '每局按顺位结算　四麻 ' + fmt(table.four, 4) + '　三麻 ' + fmt(table.three, 3) + '　最低 0';
}

function buildPowerRule(config) {
  const c = config || {};
  return {
    base: Number(c.powerBase) || DEFAULT_POWER.base,
    coef: Number(c.powerCoef) || DEFAULT_POWER.coef,
    minGames: Number(c.powerMinGames) || DEFAULT_POWER.minGames,
    // baseRank 一定要带着默认值合并：wxml 里是 powerRule.baseRank.four，
    // 缺了字段会渲染成空白，看着像公式丢了
    baseRank: Object.assign({}, DEFAULT_POWER.baseRank, c.powerBaseRank || {}),
  };
}

Page({
  data: {
    activeTab: 'stats',   // 'stats' 我的战绩 | 'rank' 排行榜 | 'games' 全部对局
    loading: true,
    isAdmin: false,       // 是否管理员（决定是否显示删除/撤销入口）
    // 当前用户：雀力卡左上角的头像 + 昵称
    me: { avatar: '', nickname: '' },

    /* ---------- 我的战绩（三麻四麻分开） ---------- */
    statsTab: 'four',     // 'four' 四麻 | 'three' 三麻
    stats: null,          // 云端原始返回 { coin, modes, titles }
    // 当前模式的数据（stats.modes[statsTab]）。初值是空结构而非 null，
    // 保证首屏（云函数还没回来时）就能把整页骨架画出来，不会闪一下再长出来
    cur: emptyModeStats('four'),
    coin: 0,              // 麻币（三麻四麻合并结算的一个账户）
    myTitles: [],         // 我的称号（已装饰，含 img；不分模式）
    titleKinds: 0,        // 称号种类数（= myTitles.length，单独存一份供模板用）
    titleTotal: 0,        // 称号累计获得次数（各称号 count 求和）
    unknownTitleCount: 0, // 后台有记录但本版本字典不认识的称号数（多半是前端包没更新）
    titlesMissing: false, // 云端压根没返回 titles 字段（说明云函数还是旧版）
    mainTitle: null,      // 用户设置的展示称号（{key,name,img,count} 或 null）
    // 称号面板：卡片上只留一条摘要，全部称号收进弹窗里。
    // 称号越攒越多，原来平铺一行能占三四屏，现在点开看。
    // selKey 是弹窗里选中的那条（未选为 ''），selIsMain 表示它已经是展示称号
    // （是的话按钮变成「取消展示」—— 设错了要能撤回来）
    titleSheet: { show: false, selKey: '', selIsMain: false, submitting: false },
    trendRange: 10,       // 趋势图显示 10 / 20 局
    trendRows: [],        // [{rank:1, cells:[{filled, rank}]}]（行数随模式：四麻 4 行、三麻 3 行）

    /* ---------- 排行榜 ---------- */
    // 三个榜一次请求全拿到，切 tab 只做本地切换、零延迟
    rankTab: 'coin',      // 'coin' 麻币 | 'power4' 四麻雀力 | 'power3' 三麻雀力
    rankData: { coin: [], power3: [], power4: [] },
    rankList: [],         // 当前 tab 的列表（wxml 直接遍历这个，避免模板里动态取键）
    // 说明文案预先算成字符串，模板里只做插值：
    // wxml 里直接写 rankConfig.powerBaseRank.four 在配置回来之前会取空
    coinRule: buildCoinRule(null),
    powerRule: buildPowerRule(null),

    /* ---------- 全部对局 ---------- */
    games: [],
    gamesLoaded: false,
    gamesPage: 0,
    hasMoreGames: true,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从录入页返回时刷新（打完一局回来立刻看到新数据）
    if (this._needRefresh) {
      this._needRefresh = false;
      this.refresh();
    }
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    this.setData({ loading: true, gamesLoaded: false });
    await Promise.all([this.loadMyStats(), this.loadRanking(), this.loadMe()]);
    // 正停在「全部对局」页时直接重拉，否则等下次切过去再拉
    if (this.data.activeTab === 'games') {
      await this.loadGames(false);
    }
    this.setData({ loading: false });
  },

  // 取当前用户：角色（判断管理员）+ 头像 + 昵称，一次请求解决
  async loadMe() {
    try {
      const res = await cloudFcn.getUsrInfo();
      const user = (res.result && res.result.data) || {};
      this.setData({
        isAdmin: user.role === 'admin' || user.role === 'master',
        me: {
          avatar: user.avatar || '',
          nickname: user.nickname || '',
        },
      });
    } catch (e) {
      // 拿不到就退回默认头像、昵称位置显示占位，别让雀力卡空一块
      this.setData({ isAdmin: false });
    }
  },

  /* ================= 我的战绩 ================= */
  async loadMyStats() {
    try {
      const res = await cloudFcn.mahjongGetMyStats();
      const stats = res.result && res.result.data;
      if (!stats || !stats.modes) {
        this.setData({
          stats: null, cur: emptyModeStats(this.data.statsTab), coin: 0,
          myTitles: [], titleKinds: 0, titleTotal: 0, unknownTitleCount: 0,
          titlesMissing: false, mainTitle: null,
        });
        this.buildTrend();
        return;
      }

      // 称号不分三麻四麻，一次拿到即可
      const myTitles = decorateTitles(stats.titles);
      // 种类数 / 总获得次数：重复发放会累加 count，两个数含义不同，要分开算
      const titleKinds = myTitles.length;
      const titleTotal = myTitles.reduce((sum, t) => sum + (Number(t.count) || 1), 0);
      // 有多少条是字典里没有的（前端包没更新 / key 拼错 / 后台手填了中文名）
      const unknownTitleCount = countUnknownTitles(stats.titles);
      if (unknownTitleCount) {
        console.warn('[称号] 有 %d 个称号本版本无法识别，请更新小程序', unknownTitleCount, stats.titles);
      }
      // 新云函数必定返回 titles（空也是 []）。拿不到说明线上跑的还是旧版云函数
      const titlesMissing = !Array.isArray(stats.titles);
      if (titlesMissing) {
        console.warn('[称号] 云端未返回 titles 字段，请部署最新版 baseFunctions');
      }
      // 从 userInfo 拿 display_title，匹配到我的称号列表里
      const userRes = await cloudFcn.getUsrInfo();
      const displayTitleKey = userRes.result?.data?.display_title;
      let mainTitle = null;
      if (displayTitleKey) {
        const found = myTitles.find(t => t.key === displayTitleKey);
        if (found) mainTitle = found;
      }

      const tab = this.data.statsTab;
      const cur = stats.modes[tab] || emptyModeStats(tab);
      this.setData({
        stats,
        cur,
        coin: stats.coin || 0,
        myTitles,
        titleKinds,
        titleTotal,
        unknownTitleCount,
        titlesMissing,
        mainTitle,
      });
      this.buildTrend();
    } catch (e) {
      console.error('加载我的战绩失败', e);
    }
  },

  // 四麻 / 三麻 切换：数据已在内存里，只换展示，不发请求
  switchStatsTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.statsTab) return;
    const modes = this.data.stats && this.data.stats.modes;
    this.setData({
      statsTab: tab,
      cur: (modes && modes[tab]) || emptyModeStats(tab),
    });
    this.buildTrend();
  },

  // 生成顺位趋势格：每行一个名次，列 = 最近 N 局（最新在右）
  buildTrend() {
    const { cur, trendRange } = this.data;
    // 三麻只有 1~3 位，多画一行 4 位只会是一条永远空的线
    const topRank = (cur && cur.topRank) || 4;
    const ranks = [];
    for (let r = 1; r <= topRank; r++) ranks.push(r);

    const recent = ((cur && cur.recent) || []).slice(-trendRange);
    // 前面补空，让局数不足时格子从右侧开始（与雀魂一致）
    const pad = trendRange - recent.length;
    const rows = ranks.map((rank) => {
      const cells = [];
      for (let i = 0; i < pad; i++) cells.push({ filled: false, rank: 0 });
      recent.forEach((g) => {
        cells.push({ filled: g.rank === rank, rank: g.rank, date: g.game_date });
      });
      return { rank, cells };
    });
    this.setData({ trendRows: rows });
  },

  switchTrendRange(e) {
    const range = Number(e.currentTarget.dataset.range);
    if (range === this.data.trendRange) return;
    this.setData({ trendRange: range });
    this.buildTrend();
  },

  /* ================= 排行榜 ================= */
  async loadRanking() {
    try {
      const res = await cloudFcn.mahjongGetRanking();
      const d = (res.result && res.result.data) || {};
      // 统一加上名次/奖牌，并把展示称号 key 解析成图片对象 + 获得次数。
      // 云端返回的 displayTitle 只是 key 字符串，count 要从 titles 数组里查：
      // 排行榜上要在称号角标里显示「×N」，没有 count 就永远不显示
      const decorate = (list) => (list || []).map((item, i) => {
        const titleInfo = getTitle(item.displayTitle);
        let count = 1;
        if (titleInfo && Array.isArray(item.titles)) {
          const hit = item.titles.find(t => t.title === item.displayTitle);
          if (hit && hit.count) count = hit.count;
        }
        return {
          ...item,
          medal: i < 3 ? ['🥇', '🥈', '🥉'][i] : '',
          index: i + 1,
          displayTitle: titleInfo ? { ...titleInfo, count } : null,
        };
      });
      const rankData = {
        coin: decorate(d.coin),
        power3: decorate(d.power3),
        power4: decorate(d.power4),
      };
      this.setData({
        rankData,
        rankList: rankData[this.data.rankTab] || [],
        coinRule: buildCoinRule(d.config),
        powerRule: buildPowerRule(d.config),
      });
    } catch (e) {
      console.error('加载排行榜失败', e);
    }
  },

  // 麻币 / 三麻雀力 / 四麻雀力 三档切换（数据已在内存，不发请求）
  switchRankTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.rankTab) return;
    this.setData({
      rankTab: tab,
      rankList: this.data.rankData[tab] || [],
    });
  },

  /* ================= 全部对局 ================= */
  async loadGames(append) {
    if (this.data.gamesLoaded && !append) return;
    try {
      const res = await cloudFcn.mahjongGetGames({
        page_no: append ? this.data.gamesPage + 1 : 0,
        page_size: 20,
      });
      const list = (res.result && res.result.data) || [];
      this.setData({
        games: append ? this.data.games.concat(list) : list,
        gamesPage: append ? this.data.gamesPage + 1 : 0,
        hasMoreGames: list.length >= 20,
        gamesLoaded: true,
      });
    } catch (e) {
      console.error('加载对局列表失败', e);
    }
  },

  loadMoreGames() {
    if (!this.data.hasMoreGames) return;
    this.loadGames(true);
  },

  // 管理员删除一局对局
  deleteGame(e) {
    if (!this.data.isAdmin) return;
    const gameId = e.currentTarget.dataset.id;
    if (!gameId) return;
    wx.showModal({
      title: '删除对局',
      content: '确定删除这局对局记录吗？删除后相关玩家的战绩/排行榜会同步变化，且不可恢复。',
      confirmColor: '#ee0a24',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const r = (await cloudFcn.mahjongDeleteGame({ game_id: gameId })).result || {};
          if (r.success) {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ gamesLoaded: false, gamesPage: 0, hasMoreGames: true });
            await Promise.all([this.loadMyStats(), this.loadRanking(), this.loadGames(false)]);
          } else {
            wx.showModal({ title: '删除失败', content: r.errMsg || '未知错误', showCancel: false });
          }
        } catch (err) {
          wx.showModal({ title: '删除失败', content: '网络异常，请重试', showCancel: false });
        }
      },
    });
  },

  // 管理员修改一局（只能改日期和点数，不能换人）
  editGame(e) {
    if (!this.data.isAdmin) return;
    const gameId = e.currentTarget.dataset.id;
    if (!gameId) return;
    wx.navigateTo({ url: '/pages/mahjong/record?game_id=' + gameId });
    this._needRefresh = true;
  },

  /* ================= 交互 ================= */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    if (tab === 'stats') {
      this.buildTrend();
    } else if (tab === 'rank' && !this.data.rankData.coin.length) {
      this.loadRanking();
    }
  },

  showAllGames() {
    this.setData({ activeTab: 'games' });
    this.loadGames(false);
  },

  backToStats() {
    this.setData({ activeTab: 'stats' });
  },

  // 管理员录入入口
  goRecord() {
    wx.navigateTo({
      url: '/pages/mahjong/record',
      events: {
        // 录入成功后通知刷新
        gameAdded: () => { this._needRefresh = true; },
      },
    });
    this._needRefresh = true; // 简化：直接标记，返回即刷新
  },

  // 管理员发称号入口
  goGrantTitle() {
    this._needRefresh = true;
    wx.navigateTo({ url: '/pages/mahjong/grantTitle' });
  },

  // 管理员手改玩家战绩（直接读写 mahjong_player，改完回来自动刷新三处）
  goAdjustPlayer() {
    this._needRefresh = true;
    wx.navigateTo({ url: '/pages/mahjong/adjustPlayer' });
  },

  /* ---------- 称号面板 ---------- */
  // 称号只是一条入口条，点开才是全部称号。默认选中当前展示的那个，
  // 没设置过就选第一个 —— 打开面板时按钮总归是能点的，不用先点一次格子
  openTitleSheet(e) {
    if (!this.data.myTitles.length) return;
    const fromTap = e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.key : '';
    const main = this.data.mainTitle;
    const selKey = fromTap || (main ? main.key : this.data.myTitles[0].key);
    this.setData({
      titleSheet: {
        show: true,
        selKey,
        selIsMain: !!(main && main.key === selKey),
        submitting: false,
      },
    });
  },

  // 弹窗里点某个称号：只改选中态，不直接提交（误触一下就把展示换掉太随意）
  pickTitle(e) {
    if (this.data.titleSheet.submitting) return;
    const key = e.currentTarget.dataset.key;
    const main = this.data.mainTitle;
    this.setData({
      'titleSheet.selKey': key,
      'titleSheet.selIsMain': !!(main && main.key === key),
    });
  },

  closeTitleSheet() {
    // 请求在飞的时候不给关：关掉再点别处会把 submitting 状态搅乱
    if (this.data.titleSheet.submitting) return;
    this.setData({ titleSheet: { show: false, selKey: '', selIsMain: false, submitting: false } });
  },

  // 遮罩上的 touchmove 拦截，防止背后的页面跟着滚
  noop() {},

  async confirmTitleSheet() {
    const sheet = this.data.titleSheet;
    if (sheet.submitting) return;
    const item = this.data.myTitles.find(t => t.key === sheet.selKey);
    if (!item) {
      wx.showToast({ title: '请先选一个称号', icon: 'none' });
      return;
    }
    const key = item.key;
    const wantMain = !sheet.selIsMain;   // 已是展示 -> 取消；否则 -> 设为展示
    this.setData({ 'titleSheet.submitting': true });
    try {
      const userRes = await cloudFcn.getUsrInfo();
      const myOpenid = userRes.result?.data?.openid;
      if (!myOpenid) {
        wx.showToast({ title: '获取用户信息失败', icon: 'none' });
        return;
      }
      // 取消展示传 null（云函数会把 null 落成「无值」）。不要传 '' 或 0：
      // 归一化路径里 '' 会被当成「没填」，0 会被当成一个真值写进去
      const res = await cloudFcn.modifyUsrInfo({
        openid: myOpenid,
        display_title: wantMain ? key : null,
      });
      const r = res.result || {};
      if (!r.success) {
        wx.showToast({ title: r.errMsg || '设置失败', icon: 'none' });
        return;
      }
      this.setData({
        mainTitle: wantMain ? item : null,
        'titleSheet.show': false,
        'titleSheet.selKey': '',
        'titleSheet.selIsMain': false,
      });
      wx.showToast({ title: wantMain ? '已设为展示称号' : '已取消展示', icon: 'success' });
      // 排行榜是三档一次拉回来缓存的（switchTab 只在空的时候才请求），
      // 不刷的话切过去还是旧称号。没加载过就不必多发一次请求
      if (this.data.rankData.coin.length) this.loadRanking();
    } catch (err) {
      console.error('设置展示称号失败', err);
      wx.showToast({ title: '设置失败', icon: 'none' });
    } finally {
      this.setData({ 'titleSheet.submitting': false });
    }
  },

  formatPercent(v) {
    return (v === null || v === undefined) ? '--' : Number(v).toFixed(2) + '%';
  },
});
