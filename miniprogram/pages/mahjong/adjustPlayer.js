// pages/mahjong/adjustPlayer.js —— 管理员改玩家数据
//
// 读写的就是 mahjong_player 那条记录本身：进页面时填的是库里的真值，
// 改完写回去，记录里就是新数字。没有「自动值 / 手填值」两层语义。
//
// 可改：麻币 / 局数 / 各顺位次数 / 最高点数
// 不可改：顺位和（跟着次数自动算）、点数和（跟着对局自动累加）
//   —— 顺位和让人自己去凑 1×c1+2×c2+3×c3+4×c4，只会和次数互相矛盾
//   —— 点数和没有对应的分布字段可推，要纠正去「全部对局」改那一局
import cloudFcn from '../../cloudFcn.js';

const TOP_RANK = { four: 4, three: 3 };
const POWER_BASE = 1000;
const POWER_COEF = 300;
const POWER_BASE_RANK = { four: 2.5, three: 2.0 };
const POWER_MIN_GAMES = 10;     // 与后端上榜门槛一致

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 这一行是不是被改过（输入值和记录里的值不一样） */
function isDirty(r) {
  const raw = String(r.value == null ? '' : r.value).trim();
  if (raw === '') return false;              // 清空视为「不改」，不会把字段删掉
  const n = Number(raw);
  if (!Number.isFinite(n)) return true;      // 非法输入也要算进「有改动」，好在保存时报错
  return n !== r.original;
}

/** 行里当前该用的数：填了就用填的，没填沿用记录里的值 */
function rowNum(r) {
  const raw = String(r.value == null ? '' : r.value).trim();
  const n = raw === '' ? Number(r.original) : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 麻币这一行：三麻四麻共用一个账户，不属于任何一个模式 */
function buildCoin(stat) {
  const v = stat && stat.coin;
  const has = v !== null && v !== undefined;
  return {
    path: 'coin',
    label: '当前余额',
    value: has ? String(v) : '',
    original: has ? Number(v) : null,
    originalText: has ? String(v) : '—',
    missing: !has,
    dirty: false,
  };
}

/** 一个模式的表单 + 只读派生展示 */
function buildMode(stat, mode) {
  const top = TOP_RANK[mode];
  const box = (stat && stat[mode]) || {};

  const makeRow = (path, label) => {
    const v = getPath(stat, path);
    const missing = v === null || v === undefined;
    return {
      path: path,
      label: label,
      value: missing ? '' : String(v),
      original: missing ? null : Number(v),
      originalText: missing ? '—' : String(v),
      missing: missing,
      dirty: false,
    };
  };

  // 只放真正能改的：各顺位次数 + 最高点数。
  // 局数不在里面 —— 它就是这几个次数之和，由它自己算（见 decorate）。
  const rows = [];
  for (let r = 1; r <= top; r += 1) {
    rows.push(makeRow(mode + '.rankCounts.' + r, r + '位次数'));
  }
  rows.push(makeRow(mode + '.maxPoints', '最高点数'));

  return {
    mode: mode,
    title: mode === 'four' ? '四麻' : '三麻',
    rows: rows,
    // 局数 / 顺位和的基准：改次数时都在这上面按增量平移，
    // 与后端 applyStatEdits 同一套算法，所以预览不会和保存后的结果对不上
    gamesBase: Number(box.games) || 0,
    rankSumBase: Number(box.rankSum) || 0,
    pointsSumText: String(Number(box.pointsSum) || 0),
    dirty: 0,
    warn: '',
    warnSoft: '',
    stat: null,
  };
}

/** 用当前输入值算派生指标、局数与顺位和预览、一致性提示 */
function decorate(group) {
  const top = TOP_RANK[group.mode];
  const rows = group.rows.map(r => Object.assign({}, r, { dirty: isDirty(r) }));

  const countRows = rows.slice(0, top);           // 前 top 行是各顺位次数

  // 局数 = 基准 + Σ次数变化量；顺位和 = 基准 + Σ(名次 × 次数变化量)
  // 两个都走增量，不按 Σcounts 全量重算（base 快照里可能有历史差额）
  let games = group.gamesBase;
  let rankSum = group.rankSumBase;
  countRows.forEach((r, i) => {
    const d = rowNum(r) - (Number(r.original) || 0);
    games += d;
    rankSum += d * (i + 1);
  });

  let countSum = 0;
  countRows.forEach((r) => { countSum += rowNum(r); });

  const avgRank = games ? rankSum / games : null;
  const power = avgRank === null
    ? null
    : Math.round(POWER_BASE + (POWER_BASE_RANK[group.mode] - avgRank) * POWER_COEF);
  const winRate = games ? (rowNum(countRows[0]) * 100 / games) : null;

  // games ≡ countSum 是结构上的等式，唯一能破的是历史脏数据（次数当年没记全），
  // 所以这里只剩「次数合计≠局数」这一类提示。硬错误才拦保存，脏数据只提醒。
  let warn = '';
  let warnSoft = '';
  if (games > 0) {
    if (countSum > games) {
      warn = '顺位次数合计 ' + countSum + ' 超过局数 ' + games;
    } else if (countSum < games) {
      warnSoft = '还有 ' + (games - countSum) + ' 局没有名次归属，平均顺位会偏高';
    } else if (rankSum < games || rankSum > games * top) {
      warnSoft = '顺位和 ' + rankSum + ' 不在 ' + games + '~' + games * top + ' 的正常区间，记录本身可能有问题';
    }
  } else if (countSum > 0) {
    warn = '次数合计 ' + countSum + '，但局数是 0 —— 记录本身就不自洽，请先修明细';
  }

  return Object.assign({}, group, {
    rows: rows,
    dirty: rows.filter(r => r.dirty).length,
    warn: warn,
    warnSoft: warnSoft,
    gamesText: String(games),
    rankSumText: String(rankSum),
    stat: {
      games: games,
      avgRankText: avgRank === null ? '—' : avgRank.toFixed(2),
      powerText: power === null ? '—' : String(power),
      powerNote: games && games < POWER_MIN_GAMES ? '不足 ' + POWER_MIN_GAMES + ' 局，不上榜' : '',
      winRateText: winRate === null ? '—' : winRate.toFixed(1) + '%',
    },
  });
}

/**
 * tab 上要显示的信息：切走之后也得能看见「另一头有改动」，
 * 否则保存时冒出一条「三麻：次数合计超过局数」叫人摸不着头脑。
 */
function buildTabs(modes, activeMode) {
  return (modes || []).map((m) => ({
    mode: m.mode,
    title: m.title,
    dirty: m.dirty,
    games: (m.stat && m.stat.games) || 0,
    warn: !!m.warn,
    active: m.mode === activeMode,
  }));
}

/** 字段 path -> 中文名，给修改历史用 */
const LABELS = {
  coin: '麻币',
  'four.games': '四麻局数',
  'three.games': '三麻局数',
  'four.maxPoints': '四麻最高点数',
  'three.maxPoints': '三麻最高点数',
  'four.rankSum': '四麻顺位和',
  'three.rankSum': '三麻顺位和',
  'four.pointsSum': '四麻点数和',
  'three.pointsSum': '三麻点数和',
};
[1, 2, 3, 4].forEach((r) => {
  LABELS['four.rankCounts.' + r] = '四麻' + r + '位次数';
  LABELS['three.rankCounts.' + r] = '三麻' + r + '位次数';
});

Page({
  data: {
    checkDone: false,
    isAdmin: false,

    player: null,        // {openid, nickname, avatar}
    keyword: '',
    suggestions: [],
    searching: false,

    loaded: false,
    coin: { path: 'coin', label: '当前余额', value: '', original: null, originalText: '—', missing: true, dirty: false },
    gamesTotal: 0,
    modes: [],           // [四麻, 三麻]，两个模式都留着，只按 activeMode 渲染
    modeTabs: [],        // 顶部分段控件：标题 + 该模式改了几项 + 局数
    activeMode: 'four',
    logs: [],
    lastEdit: '',
    dirtyCount: 0,
    note: '',
    submitting: false,

    // 明细清理（保留期与云函数 ARCHIVE_DAYS 一致）
    retentionDays: 30,
    archiving: false,
    archiveResult: '',
  },

  /**
   * 手动清理超期对局。
   *
   * 云端会先折算再删，且只删「所有参与者都已折算到位」的那一局，
   * 所以重复点、并发点都不会丢数据。这里只是给管理员一个补跑入口。
   */
  async runArchive() {
    if (this.data.archiving) return;
    const confirmRes = await new Promise((resolve) => {
      wx.showModal({
        title: '清理超期对局',
        content: `超过 ${this.data.retentionDays} 天的对局会先把成绩折算进个人战绩，再删除明细。删掉之后不能再查看或修改这些对局。确定执行吗？`,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmRes) return;

    this.setData({ archiving: true, archiveResult: '' });
    try {
      const res = await cloudFcn.mahjongArchive({});
      const r = (res && res.result) || {};
      if (!r.success) {
        this.setData({ archiving: false, archiveResult: '清理失败：' + (r.errMsg || '未知错误') });
        return;
      }
      const d = r.data || {};
      if (d.mock) {
        this.setData({ archiving: false, archiveResult: '离线模拟模式不执行清理（数据在本地，删了会丢）' });
        return;
      }
      const msg = d.removed
        ? `已折算 ${d.rolled} 局、删除 ${d.removed} 条明细（归档线 ${d.cutoff}）`
        : `没有需要清理的对局（归档线 ${d.cutoff}）`;
      this.setData({
        archiving: false,
        archiveResult: d.failed ? msg + `，${d.failed} 名玩家折算失败，请再点一次` : msg,
      });
    } catch (e) {
      console.error('清理超期对局失败', e);
      this.setData({ archiving: false, archiveResult: '清理失败，请稍后重试' });
    }
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
    this._stat = {};
    this._rawLogs = [];
    this.setData({
      player: { openid: u.openid, nickname: u.nickname, avatar: u.avatar },
      suggestions: [],
      keyword: '',
      loaded: false,
      modes: [],
      modeTabs: [],
      logs: [],
      dirtyCount: 0,
      lastEdit: '',
    });
    this.loadDetail(u.openid);
  },

  clearPlayer() {
    this._stat = {};
    this._rawLogs = [];
    this.setData({
      player: null, loaded: false, modes: [], modeTabs: [],
      logs: [], note: '', dirtyCount: 0, lastEdit: '',
    });
  },

  /* ---------------- 读取记录 ---------------- */
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
    const stat = data.stat || {};
    this._stat = stat;
    this._rawLogs = data.logs || [];

    const modes = [buildMode(stat, 'four'), buildMode(stat, 'three')].map(decorate);

    const logs = this._rawLogs.map((l) => ({
      field: l.field,
      fieldText: LABELS[l.field] || l.field,
      beforeRaw: (l.before === null || l.before === undefined) ? '' : l.before,
      beforeText: (l.before === null || l.before === undefined) ? '—' : String(l.before),
      afterText: (l.after === null || l.after === undefined) ? '—' : String(l.after),
      atText: fmtTime(l.at),
      by: l.by || '',
      note: l.note || '',
    }));

    const latest = this._rawLogs[0];
    const lastEdit = latest ? fmtTime(latest.at) + ' 由 ' + (latest.by || '管理员') + ' 修改' : '';

    const activeMode = this.data.activeMode || 'four';

    this.setData({
      loaded: true,
      coin: buildCoin(stat),
      gamesTotal: Number(stat.gamesTotal) || 0,
      modes: modes,
      modeTabs: buildTabs(modes, activeMode),
      activeMode: activeMode,
      logs: logs,
      lastEdit: lastEdit,
      dirtyCount: modes.reduce((a, m) => a + m.dirty, 0),
    });
  },

  /* ---------------- 模式切换 ---------------- */
  onModeTab(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.activeMode) return;
    // 只换渲染目标，两个模式的数据都留在 modes 里，切回来改动还在
    this.setData({ activeMode: mode, modeTabs: buildTabs(this.data.modes, mode) });
  },

  /**
   * 模式数据统一落地：modes + tab 角标 + 总改动数。
   * 改动数在这里一次算完（含麻币），免得几处各算各的、把麻币漏掉。
   */
  applyModes(modes) {
    const activeMode = this.data.activeMode || 'four';
    const coinDirty = (this.data.coin && this.data.coin.dirty) ? 1 : 0;
    const modeDirty = (modes || []).reduce((a, m) => a + m.dirty, 0);
    this.setData({
      modes: modes,
      modeTabs: buildTabs(modes, activeMode),
      dirtyCount: modeDirty + coinDirty,
    });
  },

  /* ---------------- 输入 ---------------- */
  onCoinInput(e) {
    const value = e.detail.value;
    const raw = String(value == null ? '' : value).trim();
    const n = Number(raw);
    const dirty = raw !== '' && (!Number.isFinite(n) || n !== this.data.coin.original);
    this.setData({ 'coin.value': value, 'coin.dirty': dirty }, () => this.refreshDirty());
  },

  onRowInput(e) {
    const mi = Number(e.currentTarget.dataset.mi);
    const ri = Number(e.currentTarget.dataset.ri);
    const value = e.detail.value;
    const modes = this.data.modes.slice();
    modes[mi] = decorate(Object.assign({}, modes[mi], {
      rows: modes[mi].rows.map((r, i) => (i === ri ? Object.assign({}, r, { value: value }) : r)),
    }));
    this.applyModes(modes);
  },

  refreshDirty() {
    this.applyModes(this.data.modes);
  },

  /** 点修改历史里的一条，把旧值填回对应的框（还要点保存才生效） */
  fillFromLog(e) {
    const field = e.currentTarget.dataset.field;
    const before = e.currentTarget.dataset.before;
    if (before === '' || before === undefined) {
      wx.showToast({ title: '这一条没有可回填的值', icon: 'none' });
      return;
    }

    if (field === 'coin') {
      this.setData({ 'coin.value': String(before) }, () => this.onCoinInput({ detail: { value: String(before) } }));
      wx.showToast({ title: '已填入，记得保存', icon: 'none' });
      return;
    }

    // 局数 / 顺位和 / 点数和都没有输入框，不能回填
    const parts = String(field).split('.');
    if (parts.length === 2 && (parts[1] === 'games' || parts[1] === 'rankSum' || parts[1] === 'pointsSum')) {
      wx.showToast({
        title: parts[1] === 'pointsSum'
          ? '点数和随对局自动累加，不能直接改'
          : '局数和顺位和由各顺位次数算出，改次数就会跟着变',
        icon: 'none',
      });
      return;
    }

    const modes = this.data.modes.map((m, mi) => {
      const ri = m.rows.findIndex(r => r.path === field);
      if (ri < 0) return m;
      // 回填的字段不在当前 tab 上时自动切过去，否则填了却看不见
      if (m.mode !== this.data.activeMode) this.setData({ activeMode: m.mode });
      return decorate(Object.assign({}, m, {
        rows: m.rows.map((r, i) => (i === ri ? Object.assign({}, r, { value: String(before) }) : r)),
      }));
    });
    this.applyModes(modes);
    wx.showToast({ title: '已填入，记得保存', icon: 'none' });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  /* ---------------- 保存 ---------------- */
  async save() {
    if (this.data.submitting) return;
    const { player, coin, modes, note } = this.data;
    if (!player) { wx.showToast({ title: '请先选择玩家', icon: 'none' }); return; }

    // 只提交改动过的字段，值就是「改完之后应该是什么」
    const values = {};
    let bad = '';
    const push = (row) => {
      if (!isDirty(row)) return;
      const raw = String(row.value || '').trim();
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        bad = bad || (row.label + ' 必须是非负整数');
        return;
      }
      values[row.path] = n;
    };
    push(coin);
    modes.forEach((m) => { m.rows.forEach(push); });

    if (bad) { wx.showModal({ title: '数值不对', content: bad, showCancel: false }); return; }
    if (!Object.keys(values).length) {
      wx.showToast({ title: '还没有改动任何数字', icon: 'none' });
      return;
    }

    // 数据不自洽就别发出去，先在本地拦住并说清楚哪里不对
    const hard = modes.filter(m => m.warn);
    if (hard.length) {
      wx.showModal({
        title: '数据不自洽',
        content: hard.map(m => m.title + '：' + m.warn).join('；'),
        showCancel: false,
      });
      return;
    }

    this.setData({ submitting: true });
    try {
      const res = await cloudFcn.mahjongSetPlayerStat({ openid: player.openid, values, note });
      const r = res.result || {};
      if (r.success) {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.setData({ note: '' });
        // 直接拿服务端回传的记录重渲染：写进去什么就显示什么，
        // 不靠「再读一次」来间接验证
        this.render({ stat: r.data.stat, logs: this._rawLogs });
        // 历史是异步追加的，过一会儿再拉一次把新记录补上
        this.loadDetail(player.openid);
      } else {
        // result 为空 = 云端根本没执行到业务代码。最常见的原因是
        // 线上 baseFunctions 还是旧版本、没有这个接口，这时说「未知错误」
        // 等于什么都没说，必须给出可操作的原因。
        const msg = r.errMsg
          || (res && res.errMsg ? '云端调用失败：' + res.errMsg : '')
          || '云函数没有返回结果。请确认 baseFunctions 已重新上传部署（部署时记得单独上传触发器）。';
        wx.showModal({ title: '保存失败', content: msg, showCancel: false });
      }
    } catch (e) {
      wx.showModal({
        title: '保存失败',
        content: '调用云函数出错：' + ((e && (e.errMsg || e.message)) || '未知异常'),
        showCancel: false,
      });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
