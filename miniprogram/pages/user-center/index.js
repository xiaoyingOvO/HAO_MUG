// pages/user-center/index.js
import { checkBadge } from '../../messageBadge';
import { add, toCents, toYuan } from '../../decimal';
import cloudFcn from '../../cloudFcn.js';
import { MOCK_ENABLED } from '../../mock/cloudMock.js';
const app = getApp();

Page({
  data: {
    userInfo: {}, // 用户完整信息对象
    isLoading: true,  // 控制加载状态
    isLoggedIn: false,  // 登录状态
    creditLevel: '', // 信用等级 (S, A, B, C, -)
    expProgress: 0, // 经验条进度百分比 (0-100)
    totalBalance: 0, // 总余额 (real_point + extra_point)
    displayBalance: '0.00', // 界面显示余额，与动画相关
    isAnimatingBalance: false,  // 动画锁
    nextLevelExp: 0, // 下一级所需总经验
    stateText: '未入店', // 用于显示的状态文本
    stateClass: 'offline', // 用于控制状态文本样式的 class
    stateClassMap: { // 状态值到 CSS class 的映射
      0: 'offline', // 未入店
      1: 'online',  // 休息中
      2: 'waiting', // 候机中
      3: 'gaming'   // 游玩中
    },
    unreadCount: 0, // 未读消息数
    isMaxLevel: false,      // 是否满级（判断经验条动画）
    progressGradient: null, // 经验条渐变色
  },

  onLoad: function (options) {
    wx.showShareMenu({
      withShareTicket: true, 
      menus: ['shareAppMessage', 'shareTimeline'],
    });
  },

  // 进入页面自动刷新数据
  onShow: async function () {
    this.setData({ isLoading: true });
    const userInfo = app.globalData.userInfo;
    if (userInfo && userInfo.openid && app.globalData.isLoggedIn) {
      this.setData({
        userInfo: userInfo,
        isLoggedIn: true,
      });
      this.updatePageData();
    } else {
      try {
        const loggedInUserInfo = await app.ensureLoggedIn();
        if (loggedInUserInfo) {
          this.setData({ userInfo: loggedInUserInfo, isLoggedIn: true });
          this.updatePageData();
        } else {
          this.setData({ userInfo: null, isLoggedIn: false });
          this.clearProcessedData();
        }
      } catch (err) {
        console.error("onShow 登录检查失败：", err);
        this.setData({ userInfo: null, isLoggedIn: false });
        this.clearProcessedData();
      }
    }
    // this.initializePage();
  },

  // 下拉刷新
  onPullDownRefresh: async function() {
    if (!this.data.isLoggedIn) {
      wx.showToast({
        title: '请先去登录噢~',
        icon: 'none'
      });
      wx.stopPullDownRefresh();
      return;
    }

    wx.showNavigationBarLoading();
    try {
      app.globalData.loginPromise = null;
      await app.silentLogin();
      await this.initializePage();
    } catch (err) {
      console.error("[User-center] 下拉刷新失败：", err);
      wx.showToast({
        title: '刷新失败',
        icon: 'none'
      });
    } finally {
      wx.hideNavigationBarLoading();
      wx.stopPullDownRefresh();
    }
  },

  /**
   * 点击头像更换（button open-type="chooseAvatar" 的回调）
   *
   * 微信给过来的是本地临时文件路径，**必须**先传到云存储换成 fileID 再落库 ——
   * 临时路径在本次进程结束后就失效，直接存下来的话下次打开就是破图。
   *
   * 文件名带时间戳而不是用固定名：同名覆盖会让 CDN 继续命中旧缓存，
   * 表现出来就是「换了头像但界面没变」。
   */
  async onChooseAvatar(e) {
    const tempPath = e && e.detail && e.detail.avatarUrl;
    if (!tempPath) return;

    const userInfo = this.data.userInfo;
    if (!this.data.isLoggedIn || !userInfo || !userInfo.openid) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    // 用户连点会并发上传多张，只放行第一次
    if (this._uploadingAvatar) return;
    this._uploadingAvatar = true;
    wx.showLoading({ title: '正在上传', mask: true });

    const openid = userInfo.openid;
    const oldAvatar = userInfo.avatar;
    try {
      let newAvatar;
      if (MOCK_ENABLED) {
        // 模拟模式没有云存储，只把本地临时路径写进 mock 数据用于预览
        newAvatar = tempPath;
        await cloudFcn.modifyUsrInfo({ openid, avatar: newAvatar });
      } else {
        const suffix = (String(tempPath).match(/\.[a-zA-Z0-9]+$/) || ['.png'])[0];
        const cloudPath = `avatar/${openid}_${Date.now()}${suffix}`;
        const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
        if (!up || !up.fileID) throw new Error('头像上传失败');

        const res = await cloudFcn.modifyUsrInfo({ openid, avatar: up.fileID });
        if (!res || !res.result || !res.result.success) {
          throw new Error((res && res.result && res.result.errMsg) || '头像保存失败');
        }
        newAvatar = up.fileID;
      }

      this.setData({ 'userInfo.avatar': newAvatar });
      // 同步全局缓存，否则切到别的页面拿到的还是旧头像
      if (app.globalData.userInfo) app.globalData.userInfo.avatar = newAvatar;

      wx.hideLoading();
      wx.showToast({ title: MOCK_ENABLED ? '已更新（模拟）' : '头像已更新', icon: 'none' });

      // 清理旧图，避免云存储无限堆积。
      // 只删 cloud:// 开头的（自己上传的），外链头像和历史默认图一律不动；
      // 删除失败不影响已经成功的更换。
      if (!MOCK_ENABLED && typeof oldAvatar === 'string' && oldAvatar.indexOf('cloud://') === 0) {
        wx.cloud.deleteFile({ fileList: [oldAvatar] }).catch(function () {});
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[avatar] 更换失败:', err);
      const raw = (err && err.message) || '';
      // toast 会截断长文案，超过一行就换成统一提示
      const text = raw && raw.length <= 12 ? raw : '头像更换失败，请重试';
      wx.showToast({ title: text, icon: 'none', duration: 2500 });
    } finally {
      this._uploadingAvatar = false;
    }
  },

  async initializePage() {
    this.setData({ isLoading: true });
    try {
      const userInfo = await app.ensureLoggedIn();
      if (userInfo && !userInfo.isNewUser) {
        this.setData({
          userInfo: userInfo,
          isLoggedIn: true,
        });
        this.updatePageData();
      } else {
        this.setData({
          userInfo: null,
          isLoggedIn: false,
          isLoading: false,
        });
        this.clearProcessedData();
      }
    } catch (error) {
      console.error("[User-center] 初始化页面失败：", error);
      this.setData({
        userInfo: null,
        isLoggedIn: false,
        isLoading: false,
      });
      this.clearProcessedData();
      wx.showToast({
        title: '网络连接失败',
        icon: 'none'
      });
    }
  },

  // 页面数据更新函数 (迁移自processData)
  updatePageData: async function() {
    const userInfo = this.data.userInfo;
    if (!userInfo) return;

    const levelColorMap = {
      // 当前等级: { 进度条颜色, 当前经验颜色, 下一级颜色, 进度条渐变色 }
      1: { progressBar: '#43e97b', highlight: '#6ee7b7', nextLevel: '#002f69', gradient: 'linear-gradient(90deg, #d1fae5, #43e97b, #d1fae5)' },
      2: { progressBar: '#66a6ff', highlight: '#89f7fe', nextLevel: '#f9a8d4', gradient: 'linear-gradient(90deg, #dbeafe, #66a6ff, #dbeafe)' },
      3: { progressBar: '#ff9a9e', highlight: '#fecfef', nextLevel: '#e5e7eb', gradient: 'linear-gradient(90deg, #fee2e2, #ff9a9e, #fee2e2)' },
      4: { progressBar: '#bdc3c7', highlight: '#e5e7eb', nextLevel: '#fcd34d', gradient: 'linear-gradient(90deg, #f3f4f6, #bdc3c7, #f3f4f6)' },
      5: { progressBar: '#f6d365', highlight: '#fde047', nextLevel: '#c084fc', gradient: 'linear-gradient(90deg, #fef9c3, #f6d365, #fef9c3)' },
      6: { progressBar: '#a64dff', highlight: '#d8b4fe', nextLevel: '#fef08a', gradient: 'linear-gradient(120deg, #ff3cac, #a64dff, #2b86c5, #43e97b, #f6d365, #ff3cac)' },
};

  // 1. 计算信用等级
  const credit = userInfo.credit;
  const creditLevel = this.calculateCreditLevel(credit);

  // 2. 计算经验进度
  const exp = userInfo.exp || 0; // 用户当前经验值，默认为 0
  const displayExp = Math.floor(exp); // 取整
  // 定义每个等级所需的经验值上限
  const expMaxMap = [0, 2000, 8000, 18000, 30000, 114514, Infinity];
  let currentLevel = 1; // 当前等级
  let currentLevelMinExp = 0; // 当前等级起始经验
  let currentLevelMaxExp = expMaxMap[1]; // 当前等级上限经验

  // 循环查找用户当前所属的等级区间
  for (let i = 1; i < expMaxMap.length; i++) {
    if (exp >= expMaxMap[i - 1] && exp < expMaxMap[i]) {
      currentLevel = i;
      currentLevelMinExp = expMaxMap[i - 1];
      currentLevelMaxExp = expMaxMap[i];
      break;
    }
  }
  // 计算下一等级所需的总经验值 (如果是最高级则为 'MAX')
  const colors = levelColorMap[currentLevel] || levelColorMap[6];
  let progressGradient = colors.gradient;
  const nextLevelExp = currentLevelMaxExp === Infinity ? 'MAX' : currentLevelMaxExp;
  const isMaxLevel = exp >= expMaxMap[5];
  // 计算当前等级内的经验进度百分比
  const expInCurrentLevel = exp - currentLevelMinExp;
  const expNeededForLevel = currentLevelMaxExp - currentLevelMinExp;
  const expProgress = (expNeededForLevel > 0 && expNeededForLevel !== Infinity) ?
                      Math.min((expInCurrentLevel / expNeededForLevel) * 100, 100) :
                      (currentLevelMaxExp === Infinity ? 100 : 0); // 满级显示100%，0级显示0%

  // 3. 计算入店状态文本和样式类
  const stateMap = { 0: '未入店', 1: '休息中', 2: '候机中', 3: '游玩中' };
  const stateText = stateMap[userInfo.enter_state] || '未知';
  const stateClass = this.data.stateClassMap[userInfo.enter_state] || 'offline'; 

  // 4. 计算总余额
  const real_point = userInfo.real_point || 0;
  const extra_point = userInfo.extra_point || 0;
  const newTotalBalance = add(real_point, extra_point);
  // const totalBalance = ((real_point || 0) + (extra_point || 0)); // 计算总和
  if (!this.data.isAnimatingBalance && parseFloat(this.data.displayBalance) !== newTotalBalance ) {
    this.animateBalance(parseFloat(this.data.totalBalance) || 0, newTotalBalance);
  }
  // 5. 获取未读消息数
  let unreadCount = 0;
  try {
    const badgeResult = await checkBadge();
    unreadCount = badgeResult.totalUnreadCount;
  } catch (badgeError) {
    console.error("更新小红点失败：", badgeError);
  }

  this.setData({
    displayExp: displayExp,
    currentLevel: currentLevel,
    creditLevel: creditLevel,
    expProgress: expProgress,
    nextLevelExp: nextLevelExp,
    totalBalance: newTotalBalance,
    stateText: stateText,
    stateClass: stateClass,

    progressBarColor: colors.progressBar,
    highlightColor: colors.highlight,
    nextLevelColor: colors.nextLevel,
    isMaxLevel: isMaxLevel,
    progressGradient: progressGradient,
    unreadCount: unreadCount,
    isLoading: false,
  });
  this.animateBalance(this.data.totalBalance || 0, newTotalBalance);
  },

  clearProcessedData() {
    this.setData({
      creditLevel: '-',
      expProgress: 0,
      totalBalance: 0,
      displayBalance: '0.00',
      nextLevelExp: 'N/A',
      stateText: '未登录',
      stateClass: 'offline',
      unreadCount: 0,
      isMaxLevel: false,
      currentLevel: 1,
    });
  },

  // 预览状态登录
  redirectToLogin() {
      wx.navigateTo({
          url: '/pages/login/index' 
        });
  },

  // 辅助函数-计算信用等级
  calculateCreditLevel: function(credit) {
    if (credit === null || credit === undefined) return '-';
    if (credit >= 85) return 'S';
    if (credit >= 70) return 'A';
    if (credit >= 60) return 'B';
    return 'C';
  },

  // 动画更新余额数值
  animateBalance(startValue, endValue, duration = 1200) {
    if (this.data.isAnimatingBalance) return;
    this.setData({ isAnimatingBalance: true });
    if (typeof startValue !== 'number' || typeof endValue !== 'number') {
      console.error("animateBalance: startValue or endValue is not number.");
      return;
    }
    const startTime = Date.now();

    const startCents = toCents(startValue);
    const endCents = toCents(endValue);
    const diffCents = endCents - startCents;

    const frameFunc = () => {
      const elapsedTime = Date.now() - startTime;
      const progress = Math.min(elapsedTime / duration, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);

      const currentCents = startCents + Math.round(diffCents * easedProgress);
      const currentValue = toYuan(currentCents);

      this.setData({
        displayBalance: currentValue.toFixed(2)
      });

      if(progress < 1) {
        wx.nextTick(frameFunc);
      } else {
        this.setData({
          displayBalance: toYuan(endCents).toFixed(2),
          isAnimatingBalance: false,
        });
      }
    }
    wx.nextTick(frameFunc);
  },

  // 显示信用等级提示
  showCreditTip: function () {
    const level = this.data.creditLevel;
    let content = '';

    switch (level) {
      case 'S':
        content = '信用等级 S (85-100分):\n一切正常，可享受所有服务及优惠。';
        break;
      case 'A':
        content = '信用等级 A (70-84分):\n计时扣费上升20%，失去包夜预约资格。';
        break;
      case 'B':
        content = '信用等级 B (60-69分):\n计时扣费上升50%，失去包夜预约资格。';
        break;
      case 'C':
        content = '信用等级 C (<60分):\n无法入店使用服务。请联系管理员处理。';
        break;
      default:
        content = '未能获取信用等级信息。';
    }

    wx.showModal({
      title: '信用等级说明',
      content: content,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#4facfe'
    });
  },

  // -------------------- 页面跳转函数 --------------------
  // navigateTo: function (pagePath) {
  //   wx.navigateTo({ url: pagePath });
  // },

  // --- 具体页面跳转处理 ---

  // 统一登录提示弹窗
  promptLogin(actionName = '操作') {
    wx.showModal({
      title: '请先登录',
      content: `登录后才能进入${actionName}界面噢~`,
      confirmText: '去登录',
      cancelText: '再看看',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({
            url: '/pages/login/index'
          });
        } else if (res.cancel) {
        }
      }
    });
  },

  /**
   * 跳转到充值页面，并使用 eventChannel 传递 userInfo
   */
  toRecharge: function () {
    if (!app.globalData.isLoggedIn) {
      this.promptLogin('充值');
      return; 
    }
    if (!this.data.userInfo || !this.data.userInfo.openid) {
      wx.showToast({ title: '用户信息异常，请检查是否登录', icon: 'none' });
      return;
    }
    if (this.isNavigating) return;
    this.isNavigating = true;
    setTimeout(() => { this.isNavigating = false; }, 1000);
    wx.navigateTo({
      url: '/pages/user-center/other-page/recharge',
      success: (res) => {
        // 通过 eventChannel 向目标页面发送数据
        if (this.data.userInfo) {
           res.eventChannel.emit('acceptData', { userInfo: this.data.userInfo });
        } else {
           console.warn("无法发送 userInfo，因为当前 userInfo 为空");
        }
      },
      fail: (err) => {
         console.error("跳转到充值页失败:", err);
         wx.showToast({ title: '跳转失败', icon: 'none' });
      }
    });
  },

   /**
   * 跳转到点数转移页面
   */
  toTransferPoints: function () {
    // 检查登录状态
    if (!app.globalData.isLoggedIn) { // 或者 !this.data.userInfo
      this.promptLogin('点数转移'); // 调用统一的登录提示函数
      return;
    }
    if (!this.data.userInfo || !this.data.userInfo.openid) {
      wx.showToast({ title: '用户信息异常，请检查登录状态', icon: 'none' });
      return;
    }

    // 跳转并使用 eventChannel 传递数据
    wx.navigateTo({
      url: '/pages/user-center/other-page/transferPoint',
      success: (res) => {
        if (res.eventChannel) {
          // 将 userInfo 传递过去
          res.eventChannel.emit('acceptUserInfo', { userInfo: this.data.userInfo });
        }
      },
      fail: (err) => {
         console.error("跳转到点数转移页失败:", err);
         wx.showToast({ title: '跳转失败', icon: 'none' });
      }
    });
  },

  /**
   * 跳转到优惠卡页面，并使用 eventChannel 传递 userInfo
   */
  toCard: function () {
    wx.navigateTo({
      url: '/pages/user-center/other-page/card',
      success: (res) => {
        if (this.data.userInfo) {
          res.eventChannel.emit('acceptUserInfo', { userInfo: this.data.userInfo });
        } else {
          console.warn("无法发送 userInfo 到卡片页，因为当前 userInfo 为空");
        }
      },
      fail: (err) => {
        console.error("跳转到卡片页失败:", err);
        wx.showToast({ title: '跳转失败', icon: 'none' });
      }
    });
  },

  /**
   * 跳转到出勤记录页面
   */
  toAttendance: function () {
     wx.showToast({ title: '功能待开发', icon: 'none'}); // 暂时显示未开发
  },

  /**
   * 跳转到预约记录页面
   */
  toReserve: function () {
    wx.navigateTo({ url: '/pages/reserve/index' });
  },

  /**
   * 跳转到信箱页面
   */
  toMailbox: function () {
    if (!app.globalData.isLoggedIn) {
      this.promptLogin('信箱');
      return; 
    }
    wx.navigateTo({ url: '/pages/user-center/other-page/mailbox' });
    //wx.showToast({ title: '功能待开发', icon: 'none'}); // 暂时显示未开发
  },

  /**
   * 跳转到会员福利页面
   */
  toMembership: function () {
    wx.navigateTo({ url: '/pages/user-center/other-page/membership' });
  },

  /**
   * 跳转到意见反馈页面
   */
  toFeedback: function () {
    wx.showToast({ title: '功能待开发', icon: 'none'}); // 暂时显示未开发
  },

  /**
   * 跳转到登录/注册页面
   */
  navigateToLogin: function() {
    wx.reLaunch({
      url: '/pages/login/index',
    });
  },

  /**
   * 跳转到管理员后台页面
   */
  navigateToAdmin: function() {
    wx.navigateTo({
      url: '/pages/admin/index',
      success: (res) => {
        // 通过 eventChannel 向目标页面发送数据
        if (this.data.userInfo) {
           res.eventChannel.emit('acceptData', { userInfo: this.data.userInfo });
        } else {
           console.warn("无法发送 userInfo，因为当前 userInfo 为空");
        }
      },
      fail: (err) => {
         console.error("跳转到管理员界面失败:", err);
         wx.showToast({ title: '跳转失败', icon: 'none' });
      }
    });
  },
});