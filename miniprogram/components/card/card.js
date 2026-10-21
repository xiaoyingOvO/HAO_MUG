// components/card/card.js
Component({

  properties: {
    player: {
      type: Object,
      value: {
        openid: '1111',
        order: 0,
        isMulti: true,
        multiPlaying: true,
        nickname: '坤坤',
        avatar: 'https://s2.loli.net/2023/10/22/89oLHvfO2p3MIGB.jpg'
      }
    },
    playerIndex: {
      type: Number,
      value: 0
    },
    myIndex: {
      type: Number,
      value: -1
    },
  },

  data: {
    
  },

  methods: {
    // 按下：启动长按定时器（300ms）
    onTouchStart(e) {
      console.log('card onTouchStart 触发')
      clearTimeout(this._longPressTimer);
      this._isDragging = false;              // ← 同步标志位
      this._longPressTimer = setTimeout(() => {
        console.log('card 长按 300ms 到，触发 dragstart')
        this._isDragging = true;              // ← 同步设 true，不用 setData
        this.triggerEvent('dragstart', e);
      }, 300);
    },

    // 移动
    onTouchMove(e) {
      console.log('card onTouchMove, _isDragging:', this._isDragging)
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