// components/card/card.js
// 等候区的玩家卡：只负责「长按 300ms 进入拖拽」并把触摸事件透给父页面，
// 排序 / 上机 / 下机等业务动作全部由 queue-info 页面处理。
// 「我」的标识由 player.isMe 决定（是不是当前用户），不依赖列表下标。
Component({

  properties: {
    player: {
      type: Object,
      value: {
        openid: '1111',
        order: 0,
        isMulti: true,
        nickname: '坤坤',
        avatar: 'https://s2.loli.net/2023/10/22/89oLHvfO2p3MIGB.jpg'
      }
    },
    playerIndex: {
      type: Number,
      value: 0
    },
  },

  data: {

  },

  methods: {
    // 按下：启动长按定时器（300ms）
    onTouchStart(e) {
      clearTimeout(this._longPressTimer);
      this._isDragging = false;              // ← 同步标志位
      this._longPressTimer = setTimeout(() => {
        this._isDragging = true;              // ← 同步设 true，不用 setData
        this.triggerEvent('dragstart', e);
      }, 300);
    },

    // 移动
    onTouchMove(e) {
      if (!this._isDragging) {
        clearTimeout(this._longPressTimer);
        return;
      }
      this.triggerEvent('dragmove', e);
    },

    // 松手 / 触摸被打断
    onTouchEnd(e) {
      clearTimeout(this._longPressTimer);
      if (this._isDragging) {
        this._isDragging = false;
        this.triggerEvent('dragend', e);
      }
    },

    onTouchCancel(e) {
      clearTimeout(this._longPressTimer);
      if (this._isDragging) {
        this._isDragging = false;
        this.triggerEvent('dragend', e);
      }
    },
  }
})