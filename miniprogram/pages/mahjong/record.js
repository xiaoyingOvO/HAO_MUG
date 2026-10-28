// pages/mahjong/record.js —— 管理员录入一局麻将对局
import cloudFcn from '../../cloudFcn.js';

// 一局的点数总量（原点 × 人数），与云函数 mahjongStats 里的 POINTS_TOTAL 一致。
// 云端是最终裁判，这里只是为了在点「录入」之前就把差额指出来。
const POINTS_TOTAL = {
  three: 105000,   // 三麻 35000 × 3
  four: 100000     // 四麻 25000 × 4
};

// 对局明细只保留最近 30 天（与云函数 ARCHIVE_DAYS 一致）。
// 保留的是「今天 + 前 29 天」，所以可选的最早日期是 today-29。
// 更早的日期云端会拒绝 —— 那一段已经折算成累计值，没法再插一局进去。
const ARCHIVE_DAYS = 30;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    // 权限
    isAdmin: false,
    checkDone: false,

    // 对局日期（默认今天）
    today: '',
    minDate: '',
    game_date: '',
    retentionDays: ARCHIVE_DAYS,

    // 4 个玩家位：null 表示未选
    // { openid, nickname, avatar, points }
    slots: [null, null, null, null],

    // 合计行：人数到 3 人才有意义（3 人即三麻、4 人即四麻）
    // { count, sum, expected, ok, hint }
    totalInfo: null,

    // 玩家搜索
    searchIndex: -1,      // 正在为第几个位置搜索（-1 无）
    keyword: '',
    suggestions: [],      // 搜索结果
    searching: false,

    submitting: false,

    // 编辑模式：从「对局记录」里点「修改」带 game_id 进来
    // 只允许改日期和点数，不允许换人（换人 = 删了重建，且原/新玩家统计都要动）
    editMode: false,
    gameId: '',
    loading: false,
  },

  onLoad(options) {
    const now = new Date();
    const today = ymd(now);
    // 最早可选 = 今天往前 29 天，正好是「保留 30 天」的第一天
    const min = new Date(now.getTime() - (ARCHIVE_DAYS - 1) * 86400000);
    const minDate = ymd(min);
    const gameId = (options && options.game_id) || '';
    this.setData({ today, minDate, game_date: today, editMode: !!gameId, gameId });
    if (gameId) {
      wx.setNavigationBarTitle({ title: '修改对局' });
      this.loadGameDetail(gameId);
    }
    this.checkAdmin();
  },

  /** 编辑模式：按 _id 取回这一局，回填日期与四个点数 */
  async loadGameDetail(gameId) {
    this.setData({ loading: true });
    try {
      const res = await cloudFcn.mahjongGetGameDetail({ game_id: gameId });
      const r = res.result || {};
      if (!r.success || !r.data) {
        wx.showModal({
          title: '打不开这局',
          content: r.errMsg || '对局不存在或已被删除',
          showCancel: false,
          success: () => wx.navigateBack(),
        });
        return;
      }
      const g = r.data;
      const slots = [null, null, null, null];
      (g.players || []).forEach((p, i) => {
        if (i > 3) return;
        slots[i] = {
          openid: p.openid,
          nickname: p.nickname,
          avatar: p.avatar,
          points: String(p.points),
        };
      });
      // 编辑模式可能碰到刚好卡在保留期边缘的局（今天还没跑归档时它还在），
      // 这时把可选下限放宽到它自己的日期，否则 picker 会显示一个越界的值
      const patch = { game_date: g.game_date || this.data.game_date, slots };
      if (g.game_date && this.data.minDate && g.game_date < this.data.minDate) {
        patch.minDate = g.game_date;
      }
      this.setData(patch);
      this.updateTotal();
    } catch (e) {
      console.error('加载对局详情失败', e);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
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
    if (this.data.editMode) {
      wx.showToast({ title: '修改对局不能换人', icon: 'none' });
      return;
    }
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
    this.updateTotal();
  },

  removePlayer(e) {
    if (this.data.editMode) {
      wx.showToast({ title: '修改对局不能换人', icon: 'none' });
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const slots = this.data.slots.slice();
    slots[index] = null;
    this.setData({ slots });
    this.updateTotal();
  },

  onPointsInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const slots = this.data.slots.slice();
    slots[index] = { ...slots[index], points: e.detail.value };
    this.setData({ slots });
    this.updateTotal();
  },

  /**
   * 实时合计：边填边看到「合计多少 / 应该是多少」，
   * 比等到点「录入」才报错好 —— 差 1000 这种错，当场就能发现。
   * 人数不足 3 人时不显示（这时还算不出一局的期望值）。
   */
  updateTotal() {
    const filled = this.data.slots.filter(Boolean);
    if (filled.length < 3) {
      this.setData({ totalInfo: null });
      return;
    }
    const expected = filled.length === 3 ? POINTS_TOTAL.three : POINTS_TOTAL.four;
    let sum = 0;
    let valid = true;
    filled.forEach((s) => {
      const v = Number(s.points);
      if (s.points === '' || !Number.isFinite(v)) valid = false;
      else sum += v;
    });
    const diff = sum - expected;
    const ok = valid && Math.abs(diff) < 0.5;
    this.setData({
      totalInfo: {
        count: filled.length,
        sum: valid ? sum : null,
        expected,
        ok,
        hint: !valid ? '点数未填完' : (ok ? '' : (diff > 0 ? `多 ${diff}` : `少 ${-diff}`)),
      },
    });
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

    // 点数总和守恒：三麻 105000（每人 35000）、四麻 100000（每人 25000）。
    // 云端也会拦，这里先拦是为了把差额直接讲清楚 —— 少打一位数字是最常见的
    // 录入错误，而它不会让任何单条数据看起来「不对劲」，只会让所有人的成绩
    // 慢慢失真，事后几乎查不出来。
    const totalPoints = filled.reduce((sum, s) => sum + Number(s.points), 0);
    const expectedTotal = filled.length === 3 ? POINTS_TOTAL.three : POINTS_TOTAL.four;
    const totalDiff = totalPoints - expectedTotal;
    if (Math.abs(totalDiff) > 0.5) {
      wx.showModal({
        title: '点数合计不对',
        content: `${filled.length === 3 ? '三麻' : '四麻'} ${filled.length} 人的点数合计应为 ${expectedTotal}，` +
          `当前 ${totalPoints}，${totalDiff > 0 ? '多' : '少'} ${Math.abs(totalDiff)}。\n\n请核对是否少填或多打了一位数字。`,
        showCancel: false,
      });
      return;
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
    // 合计也放进确认框：这是最后一次能发现「少打一位数字」的机会
    preview += `\n合计 ${totalPoints} / ${expectedTotal}`;

    const isEdit = this.data.editMode;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: isEdit
          ? `改为【${modeLabel}】${filled.length} 人`
          : `将记为【${modeLabel}】${filled.length} 人`,
        content: preview.trim() + (isEdit ? '\n\n保存后这几位玩家的战绩与麻币会按新结果重算。' : ''),
        confirmText: isEdit ? '确认修改' : '确认录入',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    const payload = {
      game_date,
      players: filled.map(s => ({ openid: s.openid, points: Number(s.points) })),
    };

    this.setData({ submitting: true });
    try {
      const res = isEdit
        ? await cloudFcn.mahjongUpdateGame({ game_id: this.data.gameId, ...payload })
        : await cloudFcn.mahjongAddGame(payload);
      const r = res.result || {};
      if (r.success) {
        if (r.warn) {
          // 主体改成功了，只是统计没同步干净，必须让管理员看到
          wx.showModal({
            title: isEdit ? '已修改' : '已录入',
            content: r.warn,
            showCancel: false,
            success: () => wx.navigateBack(),
          });
        } else {
          wx.showToast({ title: isEdit ? '已修改' : '录入成功', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 800);
        }
      } else {
        wx.showModal({
          title: isEdit ? '修改失败' : '录入失败',
          content: r.errMsg || '未知错误',
          showCancel: false,
        });
        // 权限失败时同步更新本地状态
        if (r.errMsg && r.errMsg.indexOf('权限') >= 0) this.setData({ isAdmin: false });
      }
    } catch (e) {
      console.error('提交对局异常', e);
      wx.showModal({
        title: isEdit ? '修改失败' : '录入失败',
        content: '网络异常，请重试',
        showCancel: false,
      });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
