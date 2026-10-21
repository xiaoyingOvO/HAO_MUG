// pages/mahjong/grantTitle.js —— 管理员发称号
import cloudFcn from '../../cloudFcn.js';
import { getAllTitles, decorateTitles } from '../../utils/mahjongTitles.js';

Page({
  data: {
    checkDone: false,
    isAdmin: false,

    // 目标玩家
    player: null,        // {openid, nickname, avatar}
    keyword: '',
    suggestions: [],
    searching: false,

    // 该玩家已拥有的称号（[{key,name,img,count}]）
    playerTitles: [],

    // 称号列表
    titles: getAllTitles(),
    selectedTitle: null, // key
    submitting: false,
  },

  onLoad() {
    this.checkAdmin();
  },

  async checkAdmin() {
    try {
      const res = await cloudFcn.getUsrInfo();
      const user = res.result && res.result.data;
      const role = user && user.role;
      this.setData({ isAdmin: role === 'admin' || role === 'master', checkDone: true });
    } catch (e) {
      this.setData({ isAdmin: false, checkDone: true });
    }
  },

  onKeywordInput(e) {
    const keyword = e.detail.value.trim();
    this.setData({ keyword });
    if (!keyword) { this.setData({ suggestions: [] }); return; }
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => this.doSearch(keyword), 300);
  },

  async doSearch(keyword) {
    this.setData({ searching: true });
    try {
      const res = await cloudFcn.getUsrInfoByName(keyword);
      const list = (res.result && res.result.data) || [];
      this.setData({ suggestions: list.slice(0, 8), searching: false });
    } catch (e) {
      this.setData({ suggestions: [], searching: false });
    }
  },

  pickPlayer(e) {
    const u = e.currentTarget.dataset.user;
    this.setData({ player: { openid: u.openid, nickname: u.nickname, avatar: u.avatar }, suggestions: [], keyword: '' });
    this.loadPlayerTitles(u.openid);
  },

  clearPlayer() {
    this.setData({ player: null, playerTitles: [] });
  },

  // 查询该玩家已有称号（供撤销用）
  async loadPlayerTitles(openid) {
    try {
      const res = await cloudFcn.mahjongGetPlayerTitles({ openid });
      const list = (res.result && res.result.data) || [];
      this.setData({ playerTitles: decorateTitles(list) });
    } catch (e) {
      this.setData({ playerTitles: [] });
    }
  },

  pickTitle(e) {
    this.setData({ selectedTitle: e.currentTarget.dataset.key });
  },

  // 撤销/减少一次称号
  revokeTitle(e) {
    const { key, name, count } = e.currentTarget.dataset;
    const openid = this.data.player.openid;
    wx.showModal({
      title: '撤销称号',
      content: `将「${name}」减少 1 次（当前 ×${count}）？`,
      confirmColor: '#ee0a24',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const r = (await cloudFcn.mahjongRevokeTitle({ openid, title: key, count: 1 })).result || {};
          if (r.success) {
            wx.showToast({ title: '已撤销', icon: 'success' });
            this.loadPlayerTitles(openid);
          } else {
            wx.showModal({ title: '撤销失败', content: r.errMsg || '未知错误', showCancel: false });
          }
        } catch (err) {
          wx.showModal({ title: '撤销失败', content: '网络异常，请重试', showCancel: false });
        }
      },
    });
  },

  async submit() {
    if (this.data.submitting) return;
    const { player, selectedTitle } = this.data;
    if (!player) { wx.showToast({ title: '请先选择玩家', icon: 'none' }); return; }
    if (!selectedTitle) { wx.showToast({ title: '请选择要发放的称号', icon: 'none' }); return; }

    this.setData({ submitting: true });
    try {
      const res = await cloudFcn.mahjongGrantTitle({ openid: player.openid, title: selectedTitle });
      const r = res.result || {};
      if (r.success) {
        wx.showToast({ title: '已发放', icon: 'success' });
        // 刷新该玩家已有称号，并保持选择
        this.loadPlayerTitles(player.openid);
        this.setData({ selectedTitle: null });
      } else {
        wx.showModal({ title: '发放失败', content: r.errMsg || '未知错误', showCancel: false });
      }
    } catch (e) {
      wx.showModal({ title: '发放失败', content: '网络异常，请重试', showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
