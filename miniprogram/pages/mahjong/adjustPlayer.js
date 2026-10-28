// pages/mahjong/adjustPlayer.js —— 管理员手改玩家战绩数据
//
// 页面上每个输入框对应统计里的一个「原始量」。派生值（平均顺位、雀力、
// 一位率）不单独存，改原始量就跟着变 —— 否则页面上会出现「平均顺位 2.30
// 但雀力按 2.10 算」这种自相矛盾的数据。
import cloudFcn from '../../cloudFcn.js';

const TOP_RANK = { four: 4, three: 3 };
const POWER_BASE_RANK = { four: 2.5, three: 2.0 };

// 每个模式下可直接覆盖的原始量（顺序即页面显示顺序）
const MODE_ROWS = [
  { path: 'games', label: '局数', integral: true },
  { path: 'rankSum', label: '顺位和', integral: true },
  { path: 'pointsSum', label: '点数和', integral: false },
  { path: 'maxPoints', label: '最高点数', integral: false },
];

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, val) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = val;
}

function fmtNum(v, digits) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return digits ? n.toFixed(digits) : String(n);
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 把 auto + fields 组装成页面要渲染的分组结构 */
function buildGroups(auto, fields) {
  const groups = [];

  const makeRow = (path, label, integral) => {
    const ov = getPath(fields, path);
    const av = getPath(auto, path);
    return {
      path: path,
      label: label,
      integral: !!integral,
      auto: av === undefined ? null : av,
      autoText: fmtNum(av),
      value: ov === undefined ? '' : String(ov),
      overridden: ov !== undefined,
    };
  };

  // 总览：麻币是跨模式的一个账户，总对局数也只是合计
  groups.push({
    title: '总览',
    mode: '',
    rows: [
      makeRow('coin', '麻币', true),
      makeRow('gamesTotal', '总对局数', true),
    ],
    warn: '',
  });

  ['four', 'three'].forEach((mode) => {
    const top = TOP_RANK[mode];
    const rows = MODE_ROWS.map(r => makeRow(mode + '.' + r.path, r.label, r.integral));
    for (let r = 1; r <= top; r += 1) {
      rows.push(makeRow(mode + '.rankCounts.' + r, r + '位次数', true));
    }
    groups.push({
      title: mode === 'four' ? '四麻' : '三麻',
      mode: mode,
      rows: rows,
      warn: '',
    });
  });

  return groups;
}

/** 用当前输入值算派生指标与一致性提示 */
function decorateGroups(groups) {
  return groups.map((g) => {
    if (!g.mode) return Object.assign({}, g, { stat: null });

    const top = TOP_RANK[g.mode];
    const eff = {};
    g.rows.forEach((r) => {
      const key = r.path.substring(g.mode.length + 1);   // 去掉 'four.' / 'three.' 前缀
      eff[key] = r.value === '' ? r.auto : Number(r.value);
    });

    const games = Number(eff.games) || 0;
    const rankSum = Number(eff.rankSum) || 0;
    let countSum = 0;
    for (let r = 1; r <= top; r += 1) countSum += Number(eff['rankCounts.' + r]) || 0;

    const avgRank = games ? rankSum / games : null;
    const power = avgRank === null ? null : Math.round(1000 + (POWER_BASE_RANK[g.mode] - avgRank) * 300);
    const winRate = games ? (Number(eff['rankCounts.1']) || 0) * 100 / games : 0;

    let warn = '';
    if (games > 0) {
      if (rankSum < games || rankSum > games * top) {
        warn = '顺位和应在 ' + games + '~' + games * top + ' 之间，当前 ' + rankSum;
      } else if (countSum > games) {
        warn = '顺位次数合计 ' + countSum + ' 超过局数 ' + games;
      }
    } else if (rankSum > 0 || countSum > 0) {
      warn = '局数为 0 时，顺位和与顺位次数都必须是 0';
    }

    return Object.assign({}, g, {
      warn: warn,
      stat: {
        games: games,
        avgRankText: fmtNum(avgRank, 2),
        powerText: power === null ? '—' : String(power),
        winRateText: fmtNum(winRate, 1) + '%',
      },
    });
  });
}

/** 字段 path -> 中文名，给修改历史用 */
function labelMap() {
  const map = { coin: '麻币', gamesTotal: '总对局数' };
  ['four', 'three'].forEach((mode) => {
    const prefix = mode === 'four' ? '四麻' : '三麻';
    MODE_ROWS.forEach((r) => { map[mode + '.' + r.path] = prefix + r.label; });
    for (let r = 1; r <= TOP_RANK[mode]; r += 1) map[mode + '.rankCounts.' + r] = prefix + r + '位次数';
  });
  return map;
}

const LABELS = labelMap();

Page({
  data: {
    checkDone: false,
    isAdmin: false,

    player: null,        // {openid, nickname, avatar}
    keyword: '',
    suggestions: [],
    searching: false,

    loaded: false,
    groups: [],
    logs: [],
    note: '',
    submitting: false,
  },

  onLoad(options) {
    this.checkAdmin(options || {});
  },

  async checkAdmin(options) {
    try {
      const res = await cloudFcn.getUsrInfo();
      const user = res.result && res.result.data;
      const role = user && user.role;
      const isAdmin = role === 'admin' || role === 'master';
      this.setData({ isAdmin, checkDone: true });
      if (isAdmin && options.openid) {
        this.setData({
          player: {
            openid: options.openid,
            nickname: options.nickname ? decodeURIComponent(options.nickname) : options.openid,
            avatar: options.avatar ? decodeURIComponent(options.avatar) : '',
          },
        });
        this.loadDetail(options.openid);
      }
    } catch (e) {
      this.setData({ isAdmin: false, checkDone: true });
    }
  },

  /* ---------------- 选玩家 ---------------- */
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
    this.setData({
      player: { openid: u.openid, nickname: u.nickname, avatar: u.avatar },
      suggestions: [],
      keyword: '',
      loaded: false,
      groups: [],
      logs: [],
    });
    this.loadDetail(u.openid);
  },

  clearPlayer() {
    this.setData({ player: null, loaded: false, groups: [], logs: [], note: '' });
  },

  /* ---------------- 读取数据 ---------------- */
  async loadDetail(openid) {
    wx.showLoading({ title: '读取中', mask: true });
    try {
      const res = await cloudFcn.mahjongGetPlayerStatDetail({ openid });
      const r = res.result || {};
      if (!r.success) {
        wx.showModal({ title: '读取失败', content: r.errMsg || '未知错误', showCancel: false });
        return;
      }
      this.render(r.data);
    } catch (e) {
      wx.showModal({ title: '读取失败', content: '网络异常，请重试', showCancel: false });
    } finally {
      wx.hideLoading();
    }
  },

  render(data) {
    const auto = data.auto || {};
    const fields = data.fields || {};
    const groups = decorateGroups(buildGroups(auto, fields));
    const logs = (data.logs || []).map((l) => ({
      fieldText: LABELS[l.field] || l.field,
      beforeText: l.before === null || l.before === undefined ? '自动' : String(l.before),
      afterText: l.after === null || l.after === undefined ? '还原为自动' : String(l.after),
      atText: fmtTime(l.at),
      by: l.by || '',
      note: l.note || '',
    }));
    this.setData({ loaded: true, groups, logs });
  },

  /* ---------------- 输入 ---------------- */
  onInput(e) {
    const gi = Number(e.currentTarget.dataset.gi);
    const ri = Number(e.currentTarget.dataset.ri);
    const value = e.detail.value;
    this.setData({ ['groups[' + gi + '].rows[' + ri + '].value']: value }, () => {
      this.setData({ groups: decorateGroups(this.data.groups) });
    });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  /* ---------------- 保存 ---------------- */
  async save() {
    if (this.data.submitting) return;
    const { player, groups, note } = this.data;
    if (!player) { wx.showToast({ title: '请先选择玩家', icon: 'none' }); return; }

    const fields = {};
    const same = [];      // 与自动值相同，存了反而会把这一项冻住
    let badLabel = '';
    groups.forEach((g) => {
      g.rows.forEach((r) => {
        if (r.value === '') return;
        const n = Number(r.value);
        if (!Number.isFinite(n)) { badLabel = r.label; return; }
        if (r.auto !== null && n === Number(r.auto)) { same.push(r.label); return; }
        setPath(fields, r.path, n);
      });
    });

    if (badLabel) { wx.showModal({ title: '数值不对', content: badLabel + ' 不是有效数字', showCancel: false }); return; }
    if (!Object.keys(fields).length) {
      wx.showToast({ title: same.length ? '改动的值都与自动值相同' : '还没有填写任何修改', icon: 'none' });
      return;
    }

    const dirty = groups.some(g => g.warn);
    if (dirty) {
      wx.showModal({ title: '数据不自洽', content: groups.filter(g => g.warn).map(g => g.warn).join('；'), showCancel: false });
      return;
    }

    this.setData({ submitting: true });
    try {
      const res = await cloudFcn.mahjongSetPlayerOverride({ openid: player.openid, fields, note });
      const r = res.result || {};
      if (r.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.setData({ note: '' });
        // 覆盖值变了，自动值也要重取（可能刚好有人录了新局）
        this.loadDetail(player.openid);
      } else {
        wx.showModal({ title: '保存失败', content: r.errMsg || '未知错误', showCancel: false });
      }
    } catch (e) {
      wx.showModal({ title: '保存失败', content: '网络异常，请重试', showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /* ---------------- 还原 ---------------- */
  clearOne(e) {
    const path = e.currentTarget.dataset.path;
    const openid = this.data.player && this.data.player.openid;
    if (!openid || !path) return;
    wx.showModal({
      title: '还原该项',
      content: '「' + (LABELS[path] || path) + '」将恢复为按对局记录自动计算的值，手动设置值会被删除。',
      success: (res) => { if (res.confirm) this.doClear(openid, [path]); },
    });
  },

  clearAll() {
    const openid = this.data.player && this.data.player.openid;
    if (!openid) return;
    wx.showModal({
      title: '还原全部',
      content: '该玩家所有手动设置的数值都会被删除，恢复为按对局记录自动计算。修改历史会保留。',
      confirmColor: '#ee0a24',
      success: (res) => { if (res.confirm) this.doClear(openid, []); },
    });
  },

  async doClear(openid, paths) {
    wx.showLoading({ title: '处理中', mask: true });
    try {
      const res = await cloudFcn.mahjongClearPlayerOverride({ openid, paths });
      const r = res.result || {};
      if (r.success) {
        wx.showToast({ title: '已还原', icon: 'success' });
        this.loadDetail(openid);
      } else {
        wx.showModal({ title: '还原失败', content: r.errMsg || '未知错误', showCancel: false });
      }
    } catch (e) {
      wx.showModal({ title: '还原失败', content: '网络异常，请重试', showCancel: false });
    } finally {
      wx.hideLoading();
    }
  },
});
