// pages/user-center/other-page/mailbox.js

const READ_ANNOUNCEMENT_IDS_KEY = 'readAnnouncementIds';  // 本地缓存公告

Page({
  data: {
    messageList: [],
    filteredMessageList: [],
    userInfo: null,
    isLoading: true,
    // isLoadingMore: false,
    // pageNo: 0,
    // pageSize: 15,
    // hasMore: true,
    total: 0,

    filters: {
      type: 'all',    // 'all', 'announcement', 'personal'
      status: 'all',  // 'all', 'read', 'unread'
    },
    isFiltered: false,
    typeOptions: [
      { label: '所有类型', value: 'all' },
      { label: '公告', value: 'announcement' },
      { label: '私信', value: 'personal' },
    ],
    statusOptions: [
      { label: '所有状态', value: 'all' },
      { label: '未读', value: 'unread' },
      { label: '已读', value: 'read' },
    ],
    filterTypeIndex: 0,
    filterStatusIndex: 0,
    showTypeOptions: false, // 控制下拉菜单
    showStatusOptions: false,
    showDetailView: false, // 控制详情视图显示
    selectedMessage: null, // 存储当前查看的邮件详情
  },

  onLoad: function (options) {
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (cachedUserInfo && cachedUserInfo.openid) {
      this.setData({ userInfo: cachedUserInfo });
      this.loadMessages(true);
    }
  },

  onPullDownRefresh: function() {
    this.loadMessages(true).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // onReachBottom: function() {
  //   if (this.data.isLoading || this.data.isLoadingMore || !this.data.hasMore) {
  //     return;
  //   }
  //   // this.setData({ isLoadingMore: true });
  //   this.loadMessages();
  // },

  onUnload: function() {
  },

  async loadMessages(isRefresh = false) {
    if (!this.data.userInfo || !this.data.userInfo.openid) {
        console.warn("无法加载消息，因为用户信息不存在。");
        // this.setData({ isLoading: false, isLoadingMore: false });
        this.setData({ isLoading: false });
        return;
    }
    if (isRefresh) {
      // this.setData({ pageNo: 0, hasMore: true, messageList: [] });
      this.setData({ isLoading: true, messageList: [], filteredMessageList: [] });
    }
    if (!this.data.hasMore && !isRefresh) return;

    try {
      const userOpenid = this.data.userInfo.openid;
      // const currentPageNo = isRefresh ? 0 : this.data.pageNo;

      const res = await wx.cloud.callFunction({
        name: 'baseFunctions',
        data: {
          type: 'getMail',
          params: {
            receiver: userOpenid,
            // page_no: currentPageNo,
            page_size: 1000
          }
        }
      });

      if (res.result && res.result.success) {
        let fetchedMessages = res.result.data || [];
        
        const readAnnouncementIds = wx.getStorageSync('readAnnouncementIds') || [];
        const formattedList = this.formatMessageList(fetchedMessages);
        this.setData({
          messageList: formattedList,
        });
        this.applyFilters();
      } else {
        wx.showToast({ title: res.result?.errMsg || '加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error("加载消息异常:", err);
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      this.setData({ isLoading: false, isLoadingMore: false });
    }
},

  formatMessageList(messages) {
    const readAnnouncementIds = wx.getStorageSync(READ_ANNOUNCEMENT_IDS_KEY) || [];
    return (messages || []).map(msg => {
        const isAnnouncement = (msg.receiver === 'all');
        let isRead = msg.read;
        if (isAnnouncement) {
          isRead = readAnnouncementIds.includes(msg._id);
        }
        return {
          ...msg, isRead, isExpanded: false,
          type: isAnnouncement ? 'announcement' : 'personal',
          content_formatted: this.formatContent(msg.content, msg.title),
          formattedTime: this.formatTime(msg.time),
        };
      });
  },

  onFilterChange(e) {
    const { field, index } = e.currentTarget.dataset;
    // const index = e.detail.value;
    const value = (field === 'type' ? this.data.typeOptions : this.data.statusOptions)[index].value;
    const newFilters = { ...this.data.filters, [field]: value };
    const isFiltered = newFilters.type !== 'all' || newFilters.status !== 'all';

    this.setData({
      filters: newFilters,
      [`filter${field.charAt(0).toUpperCase() + field.slice(1)}Index`]: index,
      isFiltered: isFiltered,
      showTypeOptions: false,
      showStatusOptions: false,
    });
    this.applyFilters();
  },

  clearFilters() {
    this.setData({
      filters: { type: 'all', status: 'all' },
      isFiltered: false,
      filterTypeIndex: 0,
      filterStatusIndex: 0,
      showTypeOptions: false,
      showStatusOptions: false,
    });
    this.applyFilters();
  },

  applyFilters() {
    const { messageList, filters } = this.data;
    const { type, status } = filters;

    const filteredList = messageList.filter(item => {
        const typeMatch = (type === 'all') || (item.type === type);
        const statusMatch = (status === 'all') || (status === 'read' && item.isRead) || (status === 'unread' && !item.isRead);
        return typeMatch && statusMatch;
    });

    this.setData({
      filteredMessageList: filteredList
    });
  },

  showMessageDetail(e) {
    const index = e.currentTarget.dataset.index;
    const message = this.data.filteredMessageList[index];
    if (!message) return;

    if (!message.isRead) {
      const originalIndex = this.data.messageList.findIndex(item => item._id === message._id);
      if (originalIndex > -1) {
        if (message.type === 'announcement') this.markAnnouncementAsRead(message._id, originalIndex);
        else this.markAsRead(message._id, originalIndex);
      }
    }

    this.setData({
      selectedMessage: {
        ...message,
        formattedTimeDetail: this.formatTime(message.time, true)
      },
      showDetailView: true
    });
  },

  hideMessageDetail() {
    this.setData({
      showDetailView: false
    });
    
    setTimeout(() => {
        if (!this.data.showDetailView) { 
             this.setData({ selectedMessage: null });
        }
    }, 350);
  },

  markAsRead(messageId, index) {
    this.setData({
      [`messageList[${index}].isRead`]: true
    });
    this.applyFilters();

    wx.cloud.callFunction({
      name: 'baseFunctions',
      data: {
        type: 'readMail',
        params: {
          mail_id: messageId
        }
      }
    }).then(res => {
      if (res.result && res.result.success) {
      } else {
        console.error(`标记消息 ${messageId} 已读失败：`, res.result?.errMsg);
        wx.showToast({
          title: '标记已读失败',
          icon: 'none'
        });
        this.setData({
          [`messageList[${index}].isRead`]: false,
        });
      }
    }).catch(err => {
      console.error(`调用 readMail 云函数异常 for ${messageId}：`, err);
      wx.showToast({
        title: '网络错误',
        icon: 'none'
      });
      this.setData({
        [`messageList[${index}].isRead`]: false,
      });
    });
  },

  markAnnouncementAsRead(messageId, index) {
    this.setData({
      [`messageList[${index}].isRead`]: true,
    });
    this.applyFilters();

    try {
      const readIds = wx.getStorageSync(READ_ANNOUNCEMENT_IDS_KEY) || [];
      if (!readIds.includes(messageId)) {
          readIds.push(messageId);
          wx.setStorageSync(READ_ANNOUNCEMENT_IDS_KEY, readIds);
        }
      } catch (e) {
        console.error('更新已读公告缓存失败', e);
    }
  },

  formatTime(timeStr) {
    if (!timeStr) return '';
    try {
      const date = new Date(timeStr);
      const now = new Date();
      const diff = (now.getTime() - date.getTime()) / 1000;

      if (diff < 60) return '刚刚';
      if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
      if (diff < 3600 * 24) return `${Math.floor(diff / 3600)}小时前`;

      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      if (year === now.getFullYear()) {
        return `${month}-${day}`;
      }
      return `${year}-${month}-${day}`;
    } catch (e) {
      return '';
    }
  },

  formatContent(content, title) {
    let body = '';
    if (typeof content === 'string') {
      body = content;
    } else if (typeof content === 'object' && content !== null && content.body) {
      body = content.body;
    }
    return body.replace(/\\n/g, '\n');
  },

  toggleFilterOptions(e) {
    const { field } = e.currentTarget.dataset;
    if (field === 'type') {
      this.setData({
        showTypeOptions: !this.data.showTypeOptions,
        showStatusOptions: false
      });
    } else if(field === 'status') {
      this.setData({
        showStatusOptions: !this.data.showStatusOptions,
        showTypeOptions: false
      });
    }
  },

  closeAllDropdowns() {
    this.setData({
      showTypeOptions: false,
      showStatusOptions: false,
    });
  },
})