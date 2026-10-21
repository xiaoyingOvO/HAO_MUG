// pages/mahjong/index.js
import cloudFcn from '../../cloudFcn.js';
import { computeRank } from '../../utils/mahjongRank.js';
import { decorateTitles, getTitle } from '../../utils/mahjongTitles.js';

Page({
  data: {
    activeTab: 'stats',   // 'stats' 我的战绩 | 'rank' 排行榜 | 'games' 全部对局
    loading: true,
    isAdmin: false,       // 是否管理员（决定是否显示删除/撤销入口）

    /* ---------- 我的战绩 ---------- */
    hasStats: false,      // 是否打过局
    stats: null,
    rankInfo: null,       // computeRank 结果（段位框架）
    myTitles: [],         // 我的称号（已装饰，含 img）
    mainTitle: null,      // 用户设置的展示称号（{key,name,img,count} 或 null）
    trendRange: 10,       // 趋势图显示 10 / 20 局
    trendRows: [],        // [{rank:1, cells:[{filled, rank}]}]

    /* ---------- 排行榜 ---------- */
    ranking: [],

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
    this.setData({ loading: true });
    await Promise.all([this.loadMyStats(), this.loadRanking(), this.loadMyRole()]);
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
      if (!stats || !stats.total) {
        this.setData({ hasStats: false, stats: null, rankInfo: computeRank(null), myTitles: [], mainTitle: null });
        return;
      }
      const myTitles = decorateTitles(stats.titles);
      // 从 userInfo 拿 display_title，匹配到我的称号列表里
      const userRes = await cloudFcn.getUsrInfo();
      const displayTitleKey = userRes.result?.data?.display_title;
      let mainTitle = null;
      if (displayTitleKey) {
        const found = myTitles.find(t => t.key === displayTitleKey);
        if (found) mainTitle = found;
      }
      this.setData({
        hasStats: true,
        stats,
        rankInfo: computeRank(stats),
        myTitles,
        mainTitle,
      });
      this.buildTrend();
    } catch (e) {
      console.error('加载我的战绩失败', e);
    }
  },

  // 生成顺位趋势格：4 行（1~4 位），列 = 最近 N 局（最新在右）
  buildTrend() {
    const { stats, trendRange } = this.data;
    const recent = (stats.recent || []).slice(-trendRange);
    // 前面补空，让局数不足时格子从右侧开始（与雀魂一致）
    const pad = trendRange - recent.length;
    const rows = [1, 2, 3, 4].map((rank) => {
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
      const list = (res.result && res.result.data) || [];
      this.setData({
        ranking: list.map((item, i) => ({
          ...item,
          medal: i < 3 ? ['🥇', '🥈', '🥉'][i] : '',
          index: i + 1,
          // 只显示用户设置的展示称号，没有设置则不显示
          displayTitle: item.displayTitle ? getTitle(item.displayTitle) : null,
        })),
      });
    } catch (e) {
      console.error('加载排行榜失败', e);
    }
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

  /* ================= 交互 ================= */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    if (tab === 'stats') {
      if (this.data.hasStats) this.buildTrend();
    } else if (tab === 'rank' && !this.data.ranking.length) {
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
