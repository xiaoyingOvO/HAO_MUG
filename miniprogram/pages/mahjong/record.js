// pages/mahjong/record.js —— 管理员录入一局麻将对局
import cloudFcn from '../../cloudFcn.js';

Page({
  data: {
    // 权限
    isAdmin: false,
    checkDone: false,

    // 对局日期（默认今天）
    today: '',
    game_date: '',

    // 4 个玩家位：null 表示未选
    // { openid, nickname, avatar, points }
    slots: [null, null, null, null],

    // 玩家搜索
    searchIndex: -1,      // 正在为第几个位置搜索（-1 无）
    keyword: '',
    suggestions: [],      // 搜索结果
    searching: false,

    submitting: false,
  },

  onLoad() {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.setData({ today, game_date: today });
    this.checkAdmin();
  },

  // 校验管理员身份（与 admin 页一致的 role 字段）
  async checkAdmin() {
    try {
      const res = await cloudFcn.getUsrInfo();
      const user = res.result && res.result.data;
      const role = user && user.role;
      this.setData({
        isAdmin: role === 'admin' || role === 'master',
        checkDone: true,
      });
    } catch (e) {
      console.error('校验身份失败', e);
      this.setData({ isAdmin: false, checkDone: true });
    }
  },

  /* ---------- 日期 ---------- */
  onDateChange(e) {
    this.setData({ game_date: e.detail.value });
  },

  /* ---------- 玩家搜索与选择 ---------- */
  startSearch(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ searchIndex: index, keyword: '', suggestions: [] });
  },

  cancelSearch() {
    this.setData({ searchIndex: -1, keyword: '', suggestions: [] });
  },

  onKeywordInput(e) {
    const keyword = e.detail.value.trim();
    this.setData({ keyword });
    if (!keyword) {
      this.setData({ suggestions: [] });
      return;
    }
    // 300ms 防抖搜索
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.doSearch(keyword), 300);
  },

  async doSearch(keyword) {
    this.setData({ searching: true });
    try {
      const res = await cloudFcn.getUsrInfoByName(keyword);
      const list = (res.result && res.result.data) || [];
      // 排除已选过的玩家
      const chosen = new Set(this.data.slots.filter(Boolean).map(s => s.openid));
      this.setData({
        suggestions: list.filter(u => !chosen.has(u.openid)).slice(0, 8),
        searching: false,
      });
    } catch (e) {
      console.error('搜索用户失败', e);
      this.setData({ suggestions: [], searching: false });
    }
  },

  pickPlayer(e) {
    const u = e.currentTarget.dataset.user;
    const index = this.data.searchIndex;
    if (index < 0) return;
    const slots = this.data.slots.slice();
    slots[index] = { openid: u.openid, nickname: u.nickname, avatar: u.avatar, points: '' };
    this.setData({ slots, searchIndex: -1, keyword: '', suggestions: [] });
  },

  removePlayer(e) {
    const index = Number(e.currentTarget.dataset.index);
    const slots = this.data.slots.slice();
    slots[index] = null;
    this.setData({ slots });
  },

  onPointsInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const slots = this.data.slots.slice();
    slots[index] = { ...slots[index], points: e.detail.value };
    this.setData({ slots });
  },

  /* ---------- 提交 ---------- */
  async submit() {
    if (this.data.submitting) return;
    const { slots, game_date } = this.data;

    // 校验
    for (let i = 0; i < 4; i++) {
      if (!slots[i]) {
        wx.showToast({ title: `第 ${i + 1} 位玩家未选择`, icon: 'none' });
        return;
      }
      const v = Number(slots[i].points);
      if (slots[i].points === '' || !Number.isFinite(v)) {
        wx.showToast({ title: `第 ${i + 1} 位玩家点数未填或不是数字`, icon: 'none' });
        return;
      }
    }

    this.setData({ submitting: true });
    try {
      const res = await cloudFcn.mahjongAddGame({
        game_date,
        players: slots.map(s => ({ openid: s.openid, points: Number(s.points) })),
      });
      const r = res.result || {};
      if (r.success) {
        wx.showToast({ title: '录入成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      } else {
        wx.showModal({ title: '录入失败', content: r.errMsg || '未知错误', showCancel: false });
        // 权限失败时同步更新本地状态
        if (r.errMsg && r.errMsg.indexOf('权限') >= 0) this.setData({ isAdmin: false });
      }
    } catch (e) {
      console.error('录入对局异常', e);
      wx.showModal({ title: '录入失败', content: '网络异常，请重试', showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
