// components/admin/common/query-utils.js
import cloudFcn from '../../../cloudFcn.js'

let timer // 用于输入框防抖

export const queryCommonMethods = {
  // 获取输入
  onInput(e) {
    let nicknameInput = e.detail.value
    this.setData({nicknameInput})
    if (!nicknameInput) {
      this.setData({
        userList: [],
        nicknameInput: ''
      })
      return
    }
    const search = () => {
      cloudFcn.getUsrInfoByName(nicknameInput).then(res => {
        if (!res.result.success) return Promise.reject(res)

        let userList = res.result.data
        this.setData({ userList })
      }).catch(console.error)
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(search, 500)
  },

  // 选择用户
  selectUser(e) {
    const user = e.currentTarget.dataset.user
    this.setData({
      userList: [], // 隐藏搜索结果
      nicknameInput: user.nickname,
      'filter.openid': user.openid
    })
  },

  // 时间筛选 - 始
  changeStartTime(e) {
    let time = e.detail.value
    this.setData({
      userList: [], // 隐藏搜索结果
      'filter.startTime': time
    })
  },

  // 时间筛选 - 终
  changeEndTime(e) {
    let time = e.detail.value
    this.setData({
      userList: [], // 隐藏搜索结果
      'filter.endTime': time
    })
  },

  // 清空筛选
  clearFilter() {
    this.setData({
      filter: {},
      userList: [],
      nicknameInput: ''
    })
  },

  // 格式化时间为 yyyy-MM-dd hh:mm:ss 格式
  formatTime(time) {
    if (!time) return ''
    
    try {
      const date = new Date(time)
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hours = String(date.getHours()).padStart(2, '0')
      const minutes = String(date.getMinutes()).padStart(2, '0')
      const seconds = String(date.getSeconds()).padStart(2, '0')
      
      return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
    }
    catch(err) {
      console.error(`传递时间${time}不合法`)
      return ''
    }
  },

  // 初始化组件属性
  setInitialParams(options) {
    if (!options) return

    let startTime = options.startTime, endTime = options.endTime, openid = options.openid
    let filter = {
      startTime,
      endTime,
      openid
    }
    this.setData({
      filter
    })
  },
}

// 公共observers
export const queryCommonObservers = {
  'filter.**': function(filter) {
    let formattedFilter = {
      start_time: filter.startTime ? filter.startTime + ' 00:00:00' : undefined,
      end_time: filter.endTime ? filter.endTime + ' 23:59:59' : undefined,
      openid: filter.openid
    }
    this.triggerEvent('filter', formattedFilter)
  }
}

// 公共的数据结构
export const queryCommonData = {
  filter: {},
  userList: [],
  nicknameInput: ''
}
