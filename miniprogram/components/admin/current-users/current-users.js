// components/admin/current-users/curren-users.js
Component({
  data: {
    userList: [],
    total: 0,
    hasMore: true
  },

  methods: {
    updateData({ list, total, hasMore }) {
      const stateMap = {
        1: '休息中',
        2: '候机中',
        3: '游玩中'
      };
      if (!Array.isArray(list)) {
        console.error("updateData received non-array list:", list);
        return; // 增加保护
      }
      const formattedList = (list || []).map(user => ({
        ...user,
        statusText: stateMap[user.enter_state] || '未知状态',
        isProcessing: false,
        formattedEnterTime: this.formatTime(user.enter_time),
      }));
      this.setData({
        userList: formattedList,
        total: total,
        hasMore: hasMore
      });
    },
    // 强制离店
    onActionClick(e) {
      const { openid, nickname } = e.currentTarget.dataset;
      const userIndex = this.data.userList.findIndex(u => u.openid === openid);
      if (userIndex === -1 || this.data.userList[userIndex].isProcessing) return;
      
      wx.showModal({
        title: '确认操作',
        content: `确定要使用户[${nickname}]强制离店吗？`,
        confirmColor: '#ee0a24',
        success: (res) => {
          if (res.confirm) {
            this.triggerEvent('action', {
              actionType: 'action',
              data: { targetOpenid: openid }
            });
          }
        }
      });
    },

    formatTime(timeStr) {
      if (!timeStr) return '未知';
      try {
        const date = new Date(timeStr);
        if (isNaN(date.getTime())) {
          return '时间无效';
        }
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
      } catch (e) {
        return '时间格式错误';
      }
    }

  }
});