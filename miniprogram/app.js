// app.js
import { checkBadge } from './messageBadge.js';
// ↓↓↓ 本地离线模拟层：使用「测试号」或无云环境时启用。
//     要恢复真实云开发，把这两行 import 和下面 installCloudMock() 的调用删掉即可。
import { installCloudMock, MOCK_ENABLED } from './mock/cloudMock.js';

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
    }

    this.globalData.loginPromise = this.silentLogin();    
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

    console.log('[App] silentLogin begins');
    this.globalData.loginPromise = new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'baseFunctions',
        data: {
          type: 'getUsrInfo'
        }
      }).then(res => {
        if (res.result?.success && res.result.data?.openid) {
          // 登录成功
          console.log('[App] silentLogin success:', res.result.data);
          this.globalData.userInfo = res.result.data;
          this.globalData.isLoggedIn = true;
          wx.setStorageSync('userInfo', res.result.data);
          // 检查未读消息
          this.checkUnreadMessage();
          this.triggerUpdateLoginStatus();
          resolve(this.globalData.userInfo);
        } else if (res.result && res.result.data?.register === false && res.result.data?.openid) {
          console.log('[App] silentLogin get openid:', res.result.data.openid);
          this.clearLoginState();
          this.globalData.userInfo = {
            openid: res.result.data.openid,
            isNewUser: true,
          };
          this.triggerUpdateLoginStatus();
          resolve(this.globalData.userInfo);
        } else {
          console.log('[App] silentLogin: 获取信息失败');
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
      if (this.globalData.loginPromise) {
        this.updateUnreadCount(0);
        return;
      }
      console.log('[App] check unread Messages...');
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
