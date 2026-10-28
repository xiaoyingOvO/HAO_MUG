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
    flyRate: 0,
    avgRank: null,
    avgPoints: null,
    maxPoints: null,
    power: null,
    recent: [],
  };
}

Page({
  data: {
    activeTab: 'stats',   // 'stats' 我的战绩 | 'rank' 排行榜 | 'games' 全部对局
    loading: true,
    isAdmin: false,       // 是否管理员（决定是否显示删除/撤销入口）

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
    trendRange: 10,       // 趋势图显示 10 / 20 局
    trendRows: [],        // [{rank:1, cells:[{filled, rank}]}]（行数随模式：四麻 4 行、三麻 3 行）

    /* ---------- 排行榜 ---------- */
    // 三个榜一次请求全拿到，切 tab 只做本地切换、零延迟
    rankTab: 'coin',      // 'coin' 麻币 | 'power4' 四麻雀力 | 'power3' 三麻雀力
    rankData: { coin: [], power3: [], power4: [] },
    rankList: [],         // 当前 tab 的列表（wxml 直接遍历这个，避免模板里动态取键）
    rankConfig: null,     // 云端下发的规则（门槛局数等），用于说明文案

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
    await Promise.all([this.loadMyStats(), this.loadRanking(), this.loadMyRole()]);
    // 正停在「全部对局」页时直接重拉，否则等下次切过去再拉
    if (this.data.activeTab === 'games') {
      await this.loadGames(false);
    }
    this.setData({ loading: false });
  },

  // 获取当前用户角色（判断管理员）
  async loadMyRole() {
    try {
      const res = await cloudFcn.getUsrInfo();
      const user = res.result && res.result.data;
      const role = user && user.role;
      this.setData({ isAdmin: role === 'admin' || role === 'master' });
    } catch (e) {
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
      // 统一加上名次/奖牌，并把展示称号 key 解析成图片对象
      const decorate = (list) => (list || []).map((item, i) => ({
        ...item,
        medal: i < 3 ? ['🥇', '🥈', '🥉'][i] : '',
        index: i + 1,
        displayTitle: item.displayTitle ? getTitle(item.displayTitle) : null,
      }));
      const rankData = {
        coin: decorate(d.coin),
        power3: decorate(d.power3),
        power4: decorate(d.power4),
      };
      this.setData({
        rankData,
        rankList: rankData[this.data.rankTab] || [],
        rankConfig: d.config || null,
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

  // 管理员手改玩家战绩（覆盖值与对局明细分开存，不会被重算洗掉）
  goAdjustPlayer() {
    this._needRefresh = true;
    wx.navigateTo({ url: '/pages/mahjong/adjustPlayer' });
  },

  // 用户设置主称号
  async setMainTitle(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    try {
      const userRes = await cloudFcn.getUsrInfo();
      const myOpenid = userRes.result?.data?.openid;
      if (!myOpenid) {
        wx.showToast({ title: '获取用户信息失败', icon: 'none' });
        return;
      }
      const res = await cloudFcn.modifyUsrInfo({ openid: myOpenid, display_title: key });
      const r = res.result || {};
      if (!r.success) {
        wx.showToast({ title: r.errMsg || '设置失败', icon: 'none' });
        return;
      }
      const found = this.data.myTitles.find(t => t.key === key);
      this.setData({ mainTitle: found || null });
      wx.showToast({ title: '已设为展示称号', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: '设置失败', icon: 'none' });
    }
  },

  formatPercent(v) {
    return (v === null || v === undefined) ? '--' : Number(v).toFixed(2) + '%';
  },
});
