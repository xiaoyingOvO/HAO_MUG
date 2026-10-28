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

    // 已选的坑位必须从 1 号位起连续：「三麻」就是前 3 位填满、4 号位留空，
    // 不允许 1、2、4 有值而 3 空着这种歧义状态
    const firstEmpty = slots.findIndex(s => !s);
    if (firstEmpty >= 0 && slots.slice(firstEmpty).some(Boolean)) {
      wx.showToast({ title: '请从 1 号位开始依次填写', icon: 'none' });
      return;
    }

    const filled = slots.filter(Boolean);
    if (filled.length !== 3 && filled.length !== 4) {
      wx.showToast({ title: '需要 3 名（三麻）或 4 名（四麻）玩家', icon: 'none' });
      return;
    }
    for (let i = 0; i < filled.length; i++) {
      const v = Number(filled[i].points);
      if (filled[i].points === '' || !Number.isFinite(v)) {
        wx.showToast({ title: `${i + 1} 号位点数未填或不是数字`, icon: 'none' });
        return;
      }
    }

    // 三麻 / 四麻由人数自动判定，这里把判定结果连同顺位一起亮出来，
    // 避免「本想录四麻、少填一人，被静默记成三麻」这种事后极难发现的问题
    const mode = filled.length === 3 ? 'three' : 'four';
    const modeLabel = mode === 'three' ? '三麻' : '四麻';
    const ranked = filled
      .map(s => ({ nickname: s.nickname, points: Number(s.points) }))
      .sort((a, b) => b.points - a.points);

    let preview = '';
    let prevPoints = null, prevRank = 0;
    ranked.forEach((p, idx) => {
      // 同分同名次，与云端顺位算法保持一致
      const rank = (prevPoints !== null && p.points === prevPoints) ? prevRank : idx + 1;
      prevPoints = p.points;
      prevRank = rank;
      preview += `${rank}位  ${p.nickname}  ${p.points}\n`;
    });

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: `将记为【${modeLabel}】${filled.length} 人`,
        content: preview.trim(),
        confirmText: '确认录入',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ submitting: true });
    try {
      const res = await cloudFcn.mahjongAddGame({
        game_date,
        players: filled.map(s => ({ openid: s.openid, points: Number(s.points) })),
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
