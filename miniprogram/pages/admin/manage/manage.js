// pages/admin/manage/manage.js
import { adminConfig } from '../../../config/adminConfig';

Page({
  data: {
    currentModuleKey: null,
    moduleConfig: null,
    adminRole: null,

    // 通用列表与分页数据
    listData: [],
    pageNo: 0,
    pageSize: 15,
    hasMore: true,
    totalCount: 0,

    // 状态控制
    isLoading:false,        // 用于控制加载更多和下拉刷新
    initialLoaded: false,   // 标记是否已完成首次加载
    loadError: false,       // 标记加载是否出错

    // 筛选参数
    filterParams: {},
  },

  onLoad: function (options) {
    const moduleKey = options.module;
    const eventChannel = this.getOpenerEventChannel();
    if (eventChannel && eventChannel.on) {
      eventChannel.on('acceptAdminInfo', (data) => {
        if (data && data.adminInfo) {
          this.setData({
            adminRole: data.adminInfo.role
          });
        }
      });
    }
    
    if (moduleKey && adminConfig[moduleKey]) {
      options = {...options, ...adminConfig[moduleKey].defaultOptions};

      this.setData({
        currentModuleKey: moduleKey,
        moduleConfig: adminConfig[moduleKey],
      });
       // <<< 确认值

      wx.setNavigationBarTitle({
        title: adminConfig[moduleKey].name,
      });

      const component = this.selectComponent('#moduleComponent');
      // 如果组件需要传递初始参数 （例如，从其他页面带来的用户id）
      if (component && typeof component.setInitialParams === 'function') {
        component.setInitialParams(options);
      }
      
      if (options.instLoad && JSON.parse(options.instLoad)) this.loadListData(true);  // 首次加载
    } else {
      wx.showToast({
        title: '模块加载失败',
        icon: 'error'
      });
    }
  },

  onPullDownRefresh: function() {
    this.loadListData(true).finally(() => {
      this.setData({ isRefreshing:false });
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    this.loadListData();
  },

  // 通用列表加载函数
  async loadListData(isRefresh = false) {
    if (this.data.isLoading || (!isRefresh && !this.data.hasMore)) return;

    const loadFuncConfig = this.data.moduleConfig?.cloudFunctions?.load;
    if (!loadFuncConfig) {
      this.setData({ initialLoaded: true, hasMore: false });  // 没有加载函数，直接标记完成
      return;
    }

    this.setData({ isLoading: true, loadError: false });
    const pageNo = isRefresh ? 0 : this.data.pageNo;

    try {
      const res = await wx.cloud.callFunction({
        name: loadFuncConfig.name,
        data: {
          type: loadFuncConfig.type,
          params: { 
            ...this.data.filterParams, 
            page_no: pageNo, 
            page_size: this.data.pageSize 
          }
        }
      });

      if (res.result && res.result.success) {
        const fetchedData = res.result.data || [];
        const total = res.result.total || 0;

        this.setData({
          listData: isRefresh ? fetchedData : [...this.data.listData, ...fetchedData],
          totalCount: total,
          pageNo: pageNo + 1,
          hasMore: fetchedData.length === this.data.pageSize,
        });

        const component = this.selectComponent('#moduleComponent');
        if (component && typeof component.updateData === 'function') {
          component.updateData({
            list: this.data.listData, 
            total: this.data.totalCount,
            hasMore: this.data.hasMore
          });
        }

      } else {
        throw new Error(res.result?.errMsg || '加载失败');
      }
    } catch (err) {
      console.error("加载列表数据异常：", err);
      this.setData({ loadError: true });
      if (!isRefresh) {
        wx.showToast({
          title: '加载更多失败',
          icon: 'none'
        });
      }
    } finally {
      this.setData({
        isLoading: false, 
        initialLoaded: true
      });
    }
  },

  // 处理来自组件的筛选条件变化
  onFilterChange(e) {
    this.setData({
      filterParams: e.detail,
      listData: [],   // 清空旧数据
    });
    this.loadListData(true);  // 重置并按新条件加载
  },

  // 处理来自组件的操作事件
  async onModuleAction(e) {
    const { actionType, data, callback = () => {} } = e.detail;  // e.g., actionType: 'forceLeave', data: { targetOpenid: 'xxx' }
    const actionFuncConfig = this.data.moduleConfig?.cloudFunctions?.[actionType];

    if (!actionFuncConfig) {
      wx.showToast({
        title: `操作[${actionType}]未配置`,
        icon: 'none'
      });
      if (typeof callback === 'function') {
        callback(false);
      }
      return;
    }

    const component = this.selectComponent('#moduleComponent');
    if (actionType === 'search') {
      if (component) component.setData({ isSearching: true });
      try {
        const res = await wx.cloud.callFunction({
          name: actionFuncConfig.name,
          data: { type: actionFuncConfig.type, params: data }
        });
        if (res.result?.success) {
          if (component && typeof component.updateSearchResults === 'function') {
            component.updateSearchResults(res.result.data);
          }
        } else {
          wx.showToast({
            title: res.result?.errMsg || '搜索失败',
            icon: 'none'
          });
        }
      } catch (err) {
        wx.showToast({
          title: '搜索发生异常',
          icon: 'none'
        });
      } finally {
        if (component) component.setData({ isSearching: false });
      }
    }  else {
      wx.showLoading({
        title: '正在处理',
        mask: true
      });
      try {
        const res = await wx.cloud.callFunction({
          name: actionFuncConfig.name,
          data: {
            type: actionFuncConfig.type,
            params: data
          }
        });
  
        if (res.result && res.result.success) {
          wx.showToast({
            title: '操作成功',
            icon: 'success'
          });
          this.loadListData(true);
          if (typeof callback === 'function') {
            callback(true);
          }
        } else {
          wx.showToast({
            title: res.result?.errMsg || '操作失败',
            icon: 'none',
            duration: 3000
          });
          if (typeof callback === 'function') {
            callback(false);
          }
        }
      } catch (err) {
        console.error(`调用[${actionType}]云函数异常：`, err)  ;
        wx.showToast({
          title: '操作异常',
          icon: 'none'
        });
        if (typeof callback === 'function') {
          callback(false);
        }
      } finally {
        wx.hideLoading();
      }
    }

  }
 
});