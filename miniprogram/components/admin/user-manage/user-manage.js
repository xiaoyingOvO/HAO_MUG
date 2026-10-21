// components/admin/user-manage/user-manage.js
Component({
    properties: {
      adminRole: {    // 接收管理员角色
        tyoe: String,
        value: '',
        observer: function(newRole) {
          this.setData({
            isAdminMaster: newRole === 'master'
          })
        }
      },
    },

    data: {
      searchValue: '',
      isSearching: false,
      isSubmitting: false,
      searchedUsers: [],  // 存储搜索到的用户列表
      selectedUser: null, // 存储管理员选择的要编辑的用户
      editForm: {
        credit: '',
        exp: '',
        real_point: '',
        extra_point: '',
        role: 'user',
      },   
      viewState: 'list',      // 视图状态 'list' 或 'detail'
      animationClass: '',     // 动画控制类
      searchAttempted: false, // 标记是否已执行过搜索
      editableUser: {},       // 即将编辑的用户
      isAdminMaster: false,
      roleOptions: [
        { value: 'user', name: '普通用户' },
        { value: 'admin', name: '管理员' }
      ],
    },
    methods: {
      onSearchInput(e) { this.setData({ searchValue: e.detail.value }); },
  
      async onSearchClick() {
        if (!this.data.searchValue || this.data.isSearching) return;
        this.setData({
          isSearching: true,
          searchAttempted: true,
          searchedUsers: [],  // 清空上次结果
          selectedUser: null,
          editableUser: {},
          viewState: 'list',
        });

        try {
          const res = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: {
              type: 'getUsrInfoByName', // 对应 config 中的 'search'
              params: { nickname: this.data.searchValue }
            }
          });

          if (res.result && res.result.success && res.result.data) {
            const users = res.result.data;

            this.setData({
              searchedUsers: users
            });
            if (users.length === 0) {
              wx.showToast({
                title: '未找到匹配的用户',
                icon: 'none'
              });
            }

          } else {
            wx.showToast({ title: '搜索失败', icon: 'none' });
            this.setData({ searchedUsers: [] });
          }
        } catch (err) {
          console.error('--- 调用云函数时捕获到异常 (err) ---', err);
          wx.showToast({ title: '搜索异常', icon: 'none' });
          this.setData({ searchedUsers: [] });
        } finally {
          this.setData({ isSearching: false });
        }
      },

      onSelectUser(e) {
        const selectedUser = e.currentTarget.dataset.user;
        this.setData({ animationClass: 'fadeOut' });
        setTimeout(() => {
          this.setData({
            viewState: 'detail',
            // selectedUser: selectedUser,
            // editableUser: JSON.parse(JSON.stringify(selectedUser)),
            animationClass: 'fadeIn',
          });
          this.processSelectedUser(selectedUser);
        }, 300);
      },

      processSelectedUser(user) {
        const roleIndex = this.data.roleOptions.findIndex(option => option.value === user.role);
        this.setData({
          selectedUser: user,
          editableUser: JSON.parse(JSON.stringify(user)),
        });
      },
  
      onInputChange(e) {
        const field = e.currentTarget.dataset.field;
        let value = e.detail.value;
        this.setData({ [`editableUser.${field}`]: value });
      },

      onRoleChange(e) {
        if (!this.data.isAdminMaster) {
          wx.showToast({
            title: '没有权限修改角色',
            icon: 'none'
          });
          return;
        }
        const newRole = e.detail.value;
        this.setData({
          'editableUser.role': newRole,
        });
      },
  
      onActionClick(e) {
        if (this.data.isSubmitting || !this.data.selectedUser) return;
        
        const action = e.currentTarget.dataset.action; // 'submit'
        
        let changedFields = {};
        for (const key in this.data.editableUser) {
          if (this.data.editableUser.hasOwnProperty(key)) {
            // 对数字字段进行转换和比较
            let editableValue = this.data.editableUser[key];
            let originalValue = this.data.selectedUser[key];

            if (['credit', 'exp', 'real_point', 'extra_point'].includes(key)) {
              const numEditable = editableValue === '' ? null : Number(editableValue);
              const numOriginal = originalValue === '' || originalValue === null ? null : Number(originalValue);

              if (numEditable !== numOriginal) {
                if (isNaN(numEditable))  {
                  wx.showToast({
                    title: `字段 [${key}] 必须是有效数字`,
                    icon: 'none'
                  });
                  return;
                }
                changedFields[key] = numEditable;
              }
            } else {
              if (editableValue !== originalValue) {
                changedFields[key] = editableValue;
              }
            }
          }          
        }
  
        if (Object.keys(changedFields).length === 0) {
          wx.showToast({ title: '未作任何修改', icon: 'none' });
          return;
        }

        wx.showModal({
          title: '确认保存',
          content: `确定要保存对用户 「${this.data.selectedUser.nickname}」的修改吗？`,
          confirmColor: '#ee0a24',
          success: (res) => {
            if (res.confirm) {
              this.executeSubmit(changedFields);
            } else if (res.cancel) {
            }
          }
        });
      },

        executeSubmit(changedFields) {
          this.setData({ isSubmitting: true });

          this.triggerEvent('action', {
            actionType: 'submit',
            data: {
              openid: this.data.selectedUser.openid,
              ...changedFields // 只传递有修改的字段
            },
            callback: (success) => {
              if (success) {
                wx.showToast({
                  title: '修改成功',
                  icon: 'success'
                });
                this.onSearchClick();
              }
              this.setData({ isSubmitting: false });
            }
          });
          setTimeout(() => { this.setData({ isSubmitting: false }); }, 3000);
        },

        backToSearchList() {
          this.setData({ animationClass: 'fadeOut' });

          setTimeout(() => {
            this.setData({
              viewState: 'list',
              selectedUser: null,
              editableUser: {},
              animationClass: 'fadeIn',
            });
          }, 300);
        },

    }
})