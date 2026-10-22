// components/custom-navi/custom-navi.js
const app = getApp()
Component({

  /**
   * 组件的属性列表
   */
  properties: {
    title: {
      type: String,
      value: '默认标题'
    }
    
  },

  /**
   * 组件的初始数据
   */
  data: {
    navigationBarHeight: '0px'
  },

  lifetimes: {
    attached: function() {
      let {
        navigationBarHeight,
        menuButtonHeight,
        statusBarHeight
      } = this.calNavigationBarHeight()
      this.setData({
        navigationBarHeight: navigationBarHeight + 'px',
        menuButtonHeight: menuButtonHeight + 'px',
        statusBarHeight: statusBarHeight + 'px'
      })
    }
  },

  /**
   * 组件的方法列表
   */
  methods: {
    // 计算自定义导航栏高度
    calNavigationBarHeight() {
      const menuButtonInfo = wx.getMenuButtonBoundingClientRect()
      let bh = menuButtonInfo.height ?? 0
      let bt = menuButtonInfo.top ?? 0
      const windowInfo = wx.getWindowInfo()
      let sh = windowInfo.statusBarHeight ?? 0
      let navigationBarHeight = (bt - sh) * 2 + sh + bh
      return {
        statusBarHeight: sh,
        menuButtonHeight: bh,
        navigationBarHeight
      }
    },
  }
})