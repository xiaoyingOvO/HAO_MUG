// components/admin/door-query/door-query.js
import { queryCommonMethods, queryCommonObservers, queryCommonData } from '../common/query-utils.js'

Component({

  /**
   * 组件的属性列表
   */
  properties: {

  },

  /**
   * 组件的初始数据
   */
  data: {
    ...queryCommonData,
    doorInfo: []
  },

  observers: {
    ...queryCommonObservers
  },

  /**
   * 组件的方法列表
   */
  methods: {
    ...queryCommonMethods,

    // 获取页面数据更新
    updateData({list, total, hasMore}) {
      list.forEach(item => {
        item.nickname = item.nickname ?? '未知用户'
        item.time = this.formatTime(item.time)
      })
      this.setData({
        doorInfo: list,
      })
    }
  }
})