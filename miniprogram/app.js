// app.js
import { checkBadge } from './messageBadge.js';
// ↓↓↓ 本地离线模拟层：使用「测试号」或无云环境时启用。
//     要恢复真实云开发，把这两行 import 和下面 installCloudMock() 的调用删掉即可。
import { installCloudMock, MOCK_ENABLED } from './mock/cloudMock.js';
import cloudFcn from './cloudFcn.js';

App({
  onLaunch: function () {
    // 必须在任何云调用之前接管 wx.cloud
    if (MOCK_ENABLED) {
      installCloudMock();
    }

    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else if (MOCK_ENABLED) {
      // 已被本地模拟层接管，无需真实初始化云环境
      this.cloud = wx.cloud;
    } else {
      wx.cloud.init({
        // env 参数说明：
        //   env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会默认请求到哪个云环境的资源
        //   此处请填入环境 ID, 环境 ID 可打开云控制台查看
        //   如不填则使用默认环境（第一个创建的环境）
        env: "hao-2gz8w8z212e63bcf",
        traceUser: true,
      });
      this.cloud = wx.cloud;
    }

    this.globalData = {
      userInfo: null, // 存储用户信息
      isLoggedIn: false,  // 登录状态
      unreadMessageCount: 0, // 未读消息数
      loginPromise: null,   // 防止重复登录
      updateLoginStatusCallback: null,  // 存储回调函数
      // ↓↓↓ 页面数据预取缓存：登录后并行预取 4 个 tab 的重数据，
      //     各页面 onShow 时优先读缓存秒开，再后台静默刷新
      pageCache: {
        machines: null,   // 机台列表（排卡页）
        reserve: null,    // 预约数据（预约页）
      },
      prefetchPromise: null,  // 预取任务（防止重复触发）
    }

    this.globalData.loginPromise = this.silentLogin();

    // 登录完成后，后台预取「排卡」「预约」两个 tab 的重数据，
    // 这样用户切换页面时不用再干等网络请求
    this.prefetchTabData();

    // 强制更新：检测到新版本立即重启，无取消选项
    this.checkUpdate();
  },

  /**
   * 后台预取 tab 页数据（机台列表 + 预约数据）。
   * 失败静默忽略 —— 页面本身 onShow 时会兜底重新拉取，不影响可用性。
   */
  prefetchTabData() {
    if (this.globalData.prefetchPromise) return this.globalData.prefetchPromise

    this.globalData.prefetchPromise = this.ensureLoggedIn()
      .then(userInfo => {
        // 未注册新用户没有完整数据，跳过预取（页面会引导登录）
        if (!userInfo || userInfo.isNewUser) return
        return Promise.allSettled([
          // 机台列表：排卡页框架数据
          cloudFcn.getMachineInfo().then(res => {
            if (res && res.result && res.result.success) {
              this.globalData.pageCache.machines = res.result.data
            }
          }),
          // 预约数据：预约页列表（整月日历）
          wx.cloud.callFunction({
            name: 'baseFunctions',
            data: { type: 'getReserveInfo', params: { days: 31 } }
          }).then(res => {
            if (res && res.result && res.result.success) {
              this.globalData.pageCache.reserve = res.result.data
            }
          }),
        ])
      })
      .catch(err => {
        console.warn('[App] 预取 tab 数据失败（页面会兜底加载）：', err)
      })

    return this.globalData.prefetchPromise
  },

  onShow: function() {
    this.checkUnreadMessage();
  },

  /**
   * 触发全局组件状态更新
   */
  triggerUpdateLoginStatus() {
    if (this.globalData.updateLoginStatusCallback) {
      this.globalData.updateLoginStatusCallback();
    }
  },

  /**
   * 静默登录
   * @returns {Promis<Objec/null>}
   * - 已注册用户：resolve(userInfo)
   * - 未注册用户：resolve({ openid: '', isNewUser: true })
   * - 失败：reject(error)
   */
  silentLogin: function() {
    if (this.globalData.loginPromise) {
      return this.globalData.loginPromise;
    }

    this.globalData.loginPromise = new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'baseFunctions',
        data: {
          type: 'getUsrInfo'
        }
      }).then(res => {
        if (res.result?.success && res.result.data?.openid) {
          // 登录成功
          this.globalData.userInfo = res.result.data;
          this.globalData.isLoggedIn = true;
          wx.setStorageSync('userInfo', res.result.data);
          // 检查未读消息
          this.checkUnreadMessage();
          this.triggerUpdateLoginStatus();
          resolve(this.globalData.userInfo);
        } else if (res.result && res.result.data?.register === false && res.result.data?.openid) {
          this.clearLoginState();
          this.globalData.userInfo = {
            openid: res.result.data.openid,
            isNewUser: true,
          };
          this.triggerUpdateLoginStatus();
          resolve(this.globalData.userInfo);
        } else {
          this.clearLoginState();
          reject(new Error(res.result?.errMsg || '获取用户信息失败'));
        }
      }).catch(err => {
        console.error('[App] silentLogin 调用云函数异常：', err);
        this.clearLoginState();
        reject(err);
      });
    });
    return this.globalData.loginPromise;
  },

  /**
   * 清理登录状态
   */
  clearLoginState: function() {
    wx.removeStorageSync('userInfo');
    this.globalData.userInfo = null;
    this.globalData.isLoggedIn = false;
    this.updateUnreadCount(0);
    this.triggerUpdateLoginStatus();
  },

  /**
   * 检查并更新未读消息数
   */
  async checkUnreadMessage() {
    try {
      await this.ensureLoggedIn();
      if (!this.globalData.isLoggedIn) {
        // 未登录或新用户：没有未读消息
        this.updateUnreadCount(0);
        return;
      }
      await checkBadge();
    } catch (error) {
      console.error("[App] Failed to check unread messages:", error);
      this.updateUnreadCount(0);
    }
  },

  /**
   *   更新
   */ 
  updateUnreadCount(count) {
    const newCount = Math.max(0, count);
    this.globalData.unreadMessageCount = newCount;

    const tabPageIndex = 3;
    if (newCount > 0) {
      wx.setTabBarBadge({
        index: tabPageIndex,
        text: String(newCount > 99 ? '99+' : newCount),
      });
    } else {
      wx.removeTabBarBadge({
        index: tabPageIndex,
      });
    }
  },

  /**
   * 强制更新：检测到新版本立即重启，无取消选项。
   * 微信机制：onUpdateReady 说明新版本已下载完成，applyUpdate() 会立即重启小程序。
   */
  checkUpdate() {
    if (!wx.getUpdateManager) return

    const updateManager = wx.getUpdateManager()

    updateManager.onUpdateReady(() => {
      console.log('[App] 新版本已就绪，强制重启')
      updateManager.applyUpdate()
    })

    updateManager.onUpdateFailed(() => {
      console.warn('[App] 新版本下载失败')
    })
  },

  /**
   * 登录接口
   * @returns {Promise<Object>}
   */
  ensureLoggedIn: function() {
    if (!this.globalData.loginPromise) {
      this.globalData.loginPromise = this.silentLogin();
    }
    return this.globalData.loginPromise;
  }
  
});
