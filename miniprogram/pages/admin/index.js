// pages/admin/index.js
import cloudFcn from '../../cloudFcn';
import { getAvailableModules } from '../../config/adminConfig';
const ADMIN_INFO_CACHE_KEY = 'adminInfo'; // 缓存 key

Page({
  data: {
    adminInfo: null,  // 存储管理员信息
    isStoreOpen: true,  //  店铺营业状态
    availableModules: [],
    isLoading: true,
  },


  onLoad: function(options) {
    this.setData({ isLoading: true });
    this.initializeAdminInfo();
  },

  onShow: function() {
    this.refreshAdminInfo();
  },

  onPullDownRefresh: function() {
    console.log('下拉刷新管理员信息');
    this.loadStoreStatus();
    wx.stopPullDownRefresh();
  },

  initializeAdminInfo: function() {
    return new Promise((resolve, reject) => {
      const cachedAdminInfo = wx.getStorageSync(ADMIN_INFO_CACHE_KEY);
      if (cachedAdminInfo && cachedAdminInfo.role) {
        console.log('从缓存中恢复管理员信息：', cachedAdminInfo);
        this.setAdminInfo(cachedAdminInfo);
        resolve();
        return;
      }

      const eventChannel = this.getOpenerEventChannel();
      if (eventChannel && eventChannel.on) {
        const timer = setTimeout(() => {
          if (!this.data.adminInfo) {
            console.error('EventChannel 超时，未接收到 adminInfo');
            wx.showModal({
              title: '权限错误',
              content: '无法获取到管理员身份，请重新进入。',
              showCancel: false,
              success: () => { wx.navigateBack(); }
            });
            reject('EventChannel timeout');
          }
        }, 10000);

        eventChannel.on('acceptData', (data) => {
          clearTimeout(timer);
          console.log('管理员界面接收到 userInfo：', data.userInfo);
          if (data.userInfo && data.userInfo.role) {
            this.setAdminInfo(data.userInfo);
            resolve();
          } else {
            console.error('EventChannel 传递了无效的数据');
            wx.showModal({
              title: '权限错误',
              content: '管理员信息传递异常，请重试。',
              showCancel: false,
              success: () => { wx.navigateBack(); }
            });
            reject('Invalid data from EventChannel');
          }
        });
      } else {
        console.error('无法获取管理员信息：找不到缓存且 EventChannel 无响应');
        wx.showModal({
          title: '权限错误',
          content: '无法获取管理员身份，请重新进入。',
          showCancel: false,
          success: () => { wx.navigateBack(); }
        });
        reject('No cache and no EventChannel');
      }
    }).then(() => {
      this.loadStoreStatus();
    }).catch((error) => {
      console.error('初始化管理员信息失败：', error);
    }).finally(() => {
      this.setData({ isLoading: false });
    });
  },

  setAdminInfo: function(info, forceUpdate = false) {
    if (!forceUpdate && this.data.adminInfo) {
      return;
    }

    wx.setStorageSync(ADMIN_INFO_CACHE_KEY, info);
    const roleTextMap = { 'admin': '管理员', 'master': '主管' };
    this.setData({
      adminInfo: {
        ...info,
        roleText: roleTextMap[info.role] || '未知'
      }
    });
    this.loadModules();
  },

  async refreshAdminInfo() {
    const cachedAdminInfo = wx.getStorageSync(ADMIN_INFO_CACHE_KEY);
    if (cachedAdminInfo && cachedAdminInfo.role) {
      console.log('从缓存中恢复管理员信息:', cachedAdminInfo);
      this.setAdminInfo(cachedAdminInfo);
    }
    console.log('后台静默刷新管理员信息...');
    try {
      const res = await wx.cloud.callFunction({
        name: 'baseFunctions',
        data: {
          type: 'getUsrInfo'
        }
      });
      if (res.result && res.result.success && res.result.data) {
        const latestAdminInfo = res.result.data;
        if (!this.data.adminInfo || latestAdminInfo.role !== this.data.adminInfo.role) {
          console.log('管理员信息有变动，正在更新...');
          this.setAdminInfo(latestAdminInfo, true);
        } else {
          console.log('管理员信息无变动，无需更新。');
        }
      } else {
        console.warn('获取管理员最新信息失败或已无权限：', res.result?.errMsg);
        wx.removeStorageSync(ADMIN_INFO_CACHE_KEY);
        this.setData({ adminInfo: null, availableModules: [] });
        wx.showModal({
          title: '权限已变更',
          content: '您已不再是管理员，即将返回上一页',
          confirmText: '知道了',
          success: (modalRes) => {
            if (modalRes.confirm) {
              wx.navigateBack({
                delta: 1
              }).catch(err => {
                wx.reLaunch({
                  url: '/pages/home/home',
                });
              });
            }
          }
        });
      }
    } catch (err) {
      console.error('onShow: 静默刷新管理员信息异常:', err);
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 加载模块
  loadModules: function() {
    console.log(`当前管理员级别：${this.data.adminInfo.role}`);
    const modules = getAvailableModules(this.data.adminInfo.role);
    // console.log(`当前可用功能模块：${JSON.stringify(modules, null, 2)}`);
    this.setData({ availableModules: modules });
  },

  // 加载店铺营业状态
  loadStoreStatus: function() {
    cloudFcn.getEnterInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)
      
      var data = res.result.data
      var businessStatus = data.business_status ?? true
      console.log('店铺营业状态: ', businessStatus)
      this.setData({ isStoreOpen: businessStatus })
    }).catch(console.error)
  },

  // 切换店铺状态
  toggleStoreStatus: function() {
    let newStatus = !this.data.isStoreOpen

    wx.showModal({
      title: `更改营业状态`,
      content: `您是否要${newStatus ? '营业' : '打烊'}？`,
      complete: (res) => {
        if (res.confirm) {
          cloudFcn.modifyBusinessStatus(newStatus).then(res =>{
            if(!res.result.success) return Promise.reject(res)
      
            this.setData({ isStoreOpen: newStatus })
            wx.showToast({
              title: '切换成功',
              icon: 'none'
            })
            console.log(`营业状态切换至${newStatus}`)
          }).catch(err => {
            this.setData({ isStoreOpen: !newStatus })
            wx.showToast({
              title: '切换失败',
              icon: 'none'
            })
            console.error(err)
          })
        }
        else {
          this.setData({ isStoreOpen: !newStatus })
        }
      }
    })

    
  },

  navigateToModule: function(e) {
    const moduleKey = e.currentTarget.dataset.moduleKey;
    if (moduleKey) {
      wx.navigateTo({
        url: `/pages/admin/manage/manage?module=${moduleKey}`,
        success: (res) => {
          if (res.eventChannel) {
            res.eventChannel.emit('acceptAdminInfo', { adminInfo: this.data.adminInfo });
          }
        }
      });
    }
  },






})