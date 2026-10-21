// pages/user-center/other-page/transferPoint.js
let searchTimer = null; // 防抖定时器
const app = getApp();

Page({
  data: {
    userInfo: null,
    displayRealPoint: '0.00',

    // --- 搜索相关状态 ---
    searchValue: '',
    isSearching: false,
    searchedUsers: [],
    showSearchResults: false,
    searchAttempted: false,
    selectedUser: null,

    // --- 表单与提交状态 ---
    transferAmount: '', // 用户输入的原始字符串
    isSubmitting: false,
    canSubmit: false,
    transferSuccess: false, // 用于显示成功状态
  },

  onLoad: function (options) {
    const eventChannel = this.getOpenerEventChannel();
    if (eventChannel && eventChannel.on) {
      eventChannel.on('acceptUserInfo', (data) => {
        if (data && data.userInfo) {
          const userInfo = data.userInfo;
          const realPoint = Number(userInfo.real_point) || 0;
          const displayRealPoint = realPoint.toFixed(2);
          this.setData({ userInfo: userInfo, displayRealPoint: displayRealPoint });
        }
      });
    }
  },

  // --- 搜索逻辑 ---
  onSearchInput(e) {
    const keyword = e.detail.value;
    this.setData({ searchValue: keyword, isSearching: true, showSearchResults: true, searchAttempted: true });
    if (searchTimer) clearTimeout(searchTimer);
    if (!keyword.trim()) {
      this.setData({ isSearching: false, searchedUsers: [] });
      return;
    }
    searchTimer = setTimeout(() => { this.executeSearch(keyword); }, 500);
  },
  async executeSearch(keyword) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'baseFunctions',
        data: { type: 'getUsrInfoByName', params: { nickname: keyword } }
      });
      if (this.data.searchValue !== keyword) return;
      if (res.result?.success) {
        const filteredUsers = (res.result.data || []).filter(user => user.openid !== this.data.userInfo.openid);
        this.setData({ searchedUsers: filteredUsers });
      }
    } catch (err) { console.error('搜索用户失败', err) }
    finally {
      if (this.data.searchValue === keyword) this.setData({ isSearching: false });
    }
  },
  onSelectUser(e) {
    this.setData({
      selectedUser: e.currentTarget.dataset.user,
      showSearchResults: false,
      searchValue: '',
      searchAttempted: false,
    }, () => this.validateForm());
  },
  closeSearchResults() {
    this.setData({ showSearchResults: false });
  },
  changeUser() {
    this.setData({ selectedUser: null, searchAttempted: false }, () => this.validateForm());
  },

  // --- 金额输入和校验 ---
  onAmountInput(e) {
    let value = e.detail.value;

    if (value.startsWith('.')) {
      value = '0' + value;
    }

    const decimalCount = (value.match(/\./g) || []).length;
    if (decimalCount > 1) {
      const parts = value.split('.');
      value = parts[0] + '.' + parts.slice(1).join('');
    }

    if (value.includes('.')) {
      const parts = value.split('.');
      if (parts[1] && parts[1].length > 2) {
        parts[1] = parts[1].slice(0, 2);
        value = parts[0] + '.' + parts[1];
      }
    }

    value = value.replace(/[^\d.]/g, '');

    this.setData({ transferAmount: value }, () => {
      this.validateForm();
    });
  },

  validateForm() {
    const amount = parseFloat(this.data.transferAmount);
    const availablePoints = Number(this.data.userInfo?.real_point) || 0;
    const isValidAmount = !isNaN(amount) && amount > 0 && amount <= availablePoints;
    this.setData({
      canSubmit: !!this.data.selectedUser && isValidAmount
    });
  },

  // --- 提交转移  ---
  async submitTransfer() {
    if (!this.data.canSubmit || this.data.isSubmitting) return;

    const amount = parseFloat(this.data.transferAmount).toFixed(2);
    wx.showModal({
      title: '确认转移',
      content: `确定要向「${this.data.selectedUser.nickname}」转移 ${amount} 点数吗？\n此操作不可撤销！`,
      confirmText: "确认",
      cancelText: "取消",
      success: async (res) => {
        if (res.confirm) {
          this.setData({ isSubmitting: true });
          wx.showLoading({ title: '正在处理...', mask: true });

          try {
            const transferRes = await wx.cloud.callFunction({
              name: 'baseFunctions',
              data: {
                type: 'transferPoint',
                params: {
                  dst_openid: this.data.selectedUser.openid,
                  transfer_point: parseFloat(amount)
                }
              }
            });
            
            if (transferRes.result?.success) {
              // --- 获取和更新用户信息 ---
              const refreshRes = await wx.cloud.callFunction({
                  name: 'baseFunctions',
                  data: {
                      type: 'getUsrInfo'
                  }
              });

              if (refreshRes.result?.success && refreshRes.result.data) {
                  const latestUsrInfo = refreshRes.result.data;
                  app.globalData.userInfo = latestUsrInfo; // 更新全局 userInfo
                  wx.setStorageSync('userInfo', latestUsrInfo); // 同时更新缓存
              }
              // ---------------------------------------------------

              wx.hideLoading();
              this.setData({ transferSuccess: true });
              wx.showToast({ title: '转移成功', icon: 'success' });
              setTimeout(() => {
                wx.navigateBack(); // 1.5秒后自动返回
              }, 1500);

            } else {
              wx.hideLoading();
              wx.showToast({ title: transferRes.result?.errMsg || '转移失败', icon: 'none', duration: 3000 });
              this.setData({ isSubmitting: false });
            }
          } catch (err) {
            wx.hideLoading();
            console.error('转移流程捕获到错误:', err); 

            wx.showToast({ title: '操作异常，请重试', icon: 'none' });
            this.setData({ isSubmitting: false });
          }
        }
      }
    });
  }
});