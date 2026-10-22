// components/admin/recharge-query/recharge-query.js
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
    rechargeInfo: []
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
        item.orderTime = this.formatTime(item.time_order)
        item.expireTime = this.formatTime(item.time_expire)
        item.amount = item.point ? Math.round(item.point * 100) / 100 : 0
        // 格式化状态文本
        switch(item.state) {
          case 0:
            item.statusText = '支付中'
            item.statusClass = 'pending'
            break
          case 1:
            item.statusText = '支付成功'
            item.statusClass = 'success'
            break
          case 2:
            item.statusText = '支付失败'
            item.statusClass = 'failed'
            break
          default:
            item.statusText = '未知状态'
            item.statusClass = 'unknown'
        }
      })
      this.setData({
        rechargeInfo: list,
      })
    }
  }
})