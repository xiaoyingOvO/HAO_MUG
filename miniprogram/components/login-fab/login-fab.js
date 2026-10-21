// components/login-fab/login-fab.js
const app = getApp();

Component({
  data: {
    isLoggedIn: true,
    showFab: false,
    disabled: true,
    x: 335, // 初始 x 坐标 (可以根据屏幕宽度动态计算)
    y: 500, // 初始 y 坐标 (可以根据屏幕高度动态计算)
    screenWidth: 375, // 屏幕宽度
    screenHeight: 667, // 屏幕高度
    viewWidth: 70,  // 球宽（px）
    lastX: 300, // 记录 x
    lastU: 500, // 记录 y
    isDragging: false,  // 是否正在被拖动
  },

  methods: {
    updateLoginStatus() {
      const isLoggedIn = app.globalData.isLoggedIn;
      this.setData({
        isLoggedIn: isLoggedIn,
      });
      if (!isLoggedIn) {
        setTimeout(() => {
          this.setData({
            showFab: true,
            disabled: false,
          });
        }, 200);
      } else {
        this.setData({
          showFab: false,
          disabled: true,
        });
      }
    },

    navigateToLogin() {
      if (this.data.isDragging || this.data.disabled) return;
      wx.navigateTo({
        url: '/pages/login/index',
      });
    },

    // 拖动过程中的事件，记录当前位置
    onDrag(e) {
      if (e.detail.source === 'touch') {
        this.setData({
          isDragging: true,
          lastX: e.detail.x,
          lastY: e.detail.y,
        });
      }
    },

    // 拖动结束时的事件，实现吸边效果
    onDragEnd(e) {
      if (!this.data.isDragging) {
        return;
      }
      const { screenWidth, viewWidth, lastX, lastY } = this.data;
      let targetX = 0;   // 目标 x 坐标

      // 判断小球的中心点在哪一侧
      if (lastX + viewWidth / 2 > screenWidth / 2) {
        // 在右侧，吸附到最右边
        targetX = screenWidth - viewWidth + 30;
      } else {
        // 在左侧，吸附到最左边
        targetX = 0;
      }

      // 使用 setData 更新位置，触发平滑的吸边动画
      // 这里需要 setData x 和 y，否则 y 坐标会跳回初始值
      this.setData({
        x: targetX,
        y: lastY,
      }, () => {
        setTimeout(() => {
          this.setData({
            x: targetX
          });
        }, 0);
      });
      setTimeout(() => {
        this.setData({ isDragging: false });
      }, 50);
    },

    // 初始化位置和屏幕尺寸
    initPosition() {
      wx.getWindowInfo({
        success: (res) => {
          const screenWidth = res.windowWidth;
          const screenHeight = res.windowHeight;

          const viewWidthRpx = 140;
          const viewWidth = viewWidthRpx / 750 * screenWidth;

          const initialX = screenWidth - viewWidth + 30;
          const initialY = screenHeight - viewWidth - (200 / 750 * screenWidth);
          
          this.setData({
            screenWidth,
            screenHeight,
            viewWidth,
            x: initialX,
            y: initialY,
            lastX: initialX, // 初始化 lastX 和 lastY
            lastY: initialY,
          });
        },
        fail: (err) => {
          console.error("获取窗口信息失败", err);
        }
      });
    },
  },

  lifetimes: {
    attached: function () {
      this.initPosition();
      app.globalData.updateLoginStatusCallback = () => {
        this.updateLoginStatus();
      };
      if (app.globalData.loginPromise) {
        app.globalData.loginPromise.then(() => {
          this.updateLoginStatus();
        }).catch(() => {
          this.updateLoginStatus();
        });
      }
    },
    detached: function () {
      if (app.globalData.updateLoginStatusCallback) {
        delete app.globalData.updateLoginStatusCallback;
      }
    },
  },

  pageLifetimes: {
    show: function () {
      if (app.globalData.loginPromise) {
        app.globalData.loginPromise.then(() => {
          this.updateLoginStatus();
        }).catch(() => {
          this.updateLoginStatus();
        })
      }
    }
  }
});