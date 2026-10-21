// components/admin/send-mail/send-mail.js
let searchTimer = null;

Component({
  data: {
    sendType: 'single',     // 'single' or 'all'
    searchValue: '',
    isSearching: false,
    searchAttempted: false,
    showSearchResults: false,
    searchedUsers: [],
    selectedUser: null,
    messageTitle: '',
    messageContent: '',
    isSubmitting: false,
    canSend: false,
    isSearchInputFocused: false,
    isTitleInputFocused: false,
    isContentTextareaFocused: false,
  },

  methods: {
    // 切换发送类型
    onSendTypeChange(e) {
      const newType = e.detail.value;
      this.setData({
        sendType: newType,
        searchValue: '',
        searchedUsers: [],
        selectedUser: null,
        searchAttempted: false
      });
      this.validateForm();
    },

    // 用户搜索
    onSearchInput(e) {
      const keyword = e.detail.value;
      this.setData({
        searchValue: keyword,
        searchAttempted: true,
        isSearching: true,
        selectedUser: null
      });

      if (searchTimer) {
        clearTimeout(searchTimer);
      }

      if (!keyword.trim()) {
        this.setData({
          isSearching: false,
          searchedUsers: [],
          showSearchResults: false,
        });
        return;
      }
      this.setData({ showSearchResults: true });
      searchTimer = setTimeout(() => {
        console.log(`[防抖] 准备执行搜索： "${keyword}"`);
        this.executeSearch(keyword);
      }, 500);
    },

    async executeSearch(keyword) {
      console.log(`[executeSearch] 开始执行对 "${keyword}" 的搜索`);
      try {
        const res = await wx.cloud.callFunction({
          name: 'baseFunctions',
          data: {
            type: 'getUsrInfoByName',
            params: { nickname: keyword }
          }
        });
        console.log(`[executeSearch] 云函数返回 for "${keyword}":`, res.result); // <<< 打印完整返回结果


        if (this.data.searchValue !== keyword) {
          console.log(`[executeSearch] 结果已过时，丢弃 for "${keyword}"`);
          return;
        }
        if (res.result?.success && Array.isArray(res.result.data)) {
          console.log(`[executeSearch] 搜索成功，准备 setData for "${keyword}"`, res.result.data);
          this.setData({ searchedUsers: res.result.data });
        } else {
          wx.showToast({
            title: '搜索失败',
            icon: '',
          });
          this.setData({ searchedUsers: [] });
        }
      } catch (err) {
        if (this.data.searchValue === keyword) {
          wx.showToast({
            title: '搜索发生异常',
            icon: 'error'
          });
          this.setData({ searchedUsers: [] });
        }
      } finally {
        if (this.data.searchValue === keyword) {
          this.setData({ isSearching: false });
        }
      }
    },



    onSelectUser(e) {
      this.setData({
        selectedUser: e.currentTarget.dataset.user,
        showSearchResults: false,
        searchedUsers: [], // 选中后清空列表
        searchValue: '',   // 清空搜索框
        searchAttempted: false,
      });
      this.validateForm();
    },
    clearSelectedUser() {
      this.setData({
        selectedUser: null,
        searchAttempted: false,
      });
      this.validateForm();
    },

    // 内容输入
    onMessageTitleInput(e) {
      this.setData({
        messageTitle: e.detail.value
      });
      this.validateForm();
    },
    onMessageContentInput(e) {
        this.setData({
          messageContent: e.detail.value
        });
        this.validateForm();
    },

    // 表单校验
    validateForm() {
      let isValid = false;
      const { sendType, selectedUser, messageContent, messageTitle } = this.data;
      if (sendType === 'single') {
        isValid = !!selectedUser && messageContent.trim().length > 0;
      } else {
        isValid = messageContent.trim().length > 0 && messageTitle.trim().length > 0;
      }
      this.setData({ canSend: isValid });
    },

    // 发送操作
    onSend() {
      if (this.data.isSubmitting || !this.data.canSend) return;
      const { sendType, selectedUser, messageTitle, messageContent } = this.data;

      const receiver = ( sendType === 'single' && selectedUser) ? selectedUser.openid : 'all';

      const title = messageTitle.trim();
      const content = messageContent.trim();

      wx.showModal({
        title: '确认发送',
        content: `确定要向 ${sendType === 'single' ? `用户「${selectedUser.nickname}」` : '所有用户'} 发送消息吗？`,
        success: (res) => {
          if (res.confirm) {
            this.setData({ isSubmitting: true });
            this.triggerEvent('action', {
              actionType: 'submit',
              data: {
                receiver: receiver,
                title: title,
                content: content,
              },
              callback: (success) => {
                if (success) {
                  wx.showToast({
                    title: '发送成功',
                    icon: 'success'
                  });
                  this.setData({
                    messageTitle: '',
                    messageContent: '',
                    searchValue: '',
                    searchedUsers: [],
                    selectedUser: null,
                    searchAttempted: false
                  });
                  this.validateForm();
                } else {
                  console.log('父页面通知：发送失败');
                }
                this.setData({ isSubmitting: false });
              }
            })
          }
        }
      })

    },

    // 关闭下拉框
    closeSearchResults() {
      this.setData({
        showSearchResults: false,
      });
    },

    onInputFocus(e) {
      const field = e.currentTarget.dataset.field;
      this.setData({ [field]: true });
      },
    
    onInputBlur(e) {
      const field = e.currentTarget.dataset.field;
      this.setData({ [field]: false });
    },


  },
});