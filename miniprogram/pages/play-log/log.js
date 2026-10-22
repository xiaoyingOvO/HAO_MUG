// pages/play-log/log.js
import cloudFcn from '../../cloudFcn.js'

/**
 * 把操作日志的 action 拆成三段，前端三段式渲染（避免被操作者名字重复出现）：
 *   渲染顺序：operatorName + (targetName) + action
 *   故 action 里不再含被操作者名，只保留前缀动词 + 后缀
 *
 *   e.g. "将OVH从第2位移至第1位" → pre='将', target='OVH', post='从第2位移至第1位'
 */
function splitAction(action) {
  const moveMatch = action.match(/^将(.+?)从第(\d+)位移至第(\d+)位$/)
  if (moveMatch) {
    return {
      pre: '将',
      target: moveMatch[1],
      post: '从第' + moveMatch[2] + '位移至第' + moveMatch[3] + '位',
    }
  }
  const letMatch = action.match(/^让(.+?)(上机|下机)了$/)
  if (letMatch) {
    return {
      pre: '让',
      target: letMatch[1],
      post: letMatch[2] + '了',
    }
  }
  const kickMatch = action.match(/^将(.+?)踢出队列$/)
  if (kickMatch) {
    return {
      pre: '将',
      target: kickMatch[1],
      post: '踢出队列',
    }
  }
  // 云函数改版前的旧格式：将自身位置移至第1位（不含从/至）
  const oldSelf = action.match(/^将自身位置移至第(\d+)位$/)
  if (oldSelf) {
    return {
      pre: '将',
      target: '自身',
      post: '从原位置移至第' + oldSelf[1] + '位',
    }
  }
  // 无被操作者的普通动作（加入了队列/离开了队列等）
  return { pre: '', target: '', post: action }
}

Page({

  /**
   * 页面的初始数据
   */
  data: {
    logLists: {
      machineLogs: [
        // {
        //   time: new Date('2025-03-01T17:00:00'), // 和timeStart一致，用作唯一key
        //   timeShow: '2025-03-01 17:00:00',
        //   action: 1,  // 操作类型
        //   user1: null,  // 操作人openid
        //   user2: null,  // 被操作人openid
        //   actionShow: 'xx对xx [+xx] 进行yy操作'
        // },
      ],
      wmLogs: [
        {
          time: new Date('2025-03-01T17:00:00'), // 和timeStart一致，用作唯一key
          dateShow: '2025-03-01',
          timeStartShow: '17:00',
          timeStart: new Date('2025-03-01T17:00:00'),
          timeEndShow: '19:30',
          timeEnd: new Date('2025-03-01T19:30:00'),
          isMulti: true,
          machineName: '乌蒙1号',
          time_duration: '2h30min',
          pointConsumed: 30,
          cardUsed: '会员（2折）',
          companion: '好椰'
        }, 
        {
          time: new Date('2025-03-01T20:00:00'), // 和timeStart一致，用作唯一key
          dateShow: '2025-03-01',
          timeStartShow: '20:00',
          timeStart: new Date('2025-03-01T20:00:00'),
          timeEndShow: '20:30',
          timeEnd: new Date('2025-03-01T20:30:00'),
          isMulti: false,
          machineName: '乌蒙1号',
          time_duration: '30min',
          pointConsumed: 30,
          cardUsed: '会员（2折）',
          同桌好友: ''
        }, 
      ],
      pointLogs: [
        {
          time: new Date('2025-03-01T19:30:00'),
          timeShow: '2025-03-01 19:31:00',
          points: 30,
          reason: '充值到账'
        },
        {
          time: new Date('2025-03-01T19:30:00'),
          timeShow: '2025-03-01 19:30:00',
          points: 30,
          reason: '出勤消费'
        }
      ],
    },
    activeLogList: 'machineLogs',
    selectedMachine: null/* {machineId: 't', machineName: '乌蒙1号', maxPlayer: 2} */
  },

  // 获取机器操作日志
  getQueueLog() {
    let machineId = this.data.selectedMachine?.machineId
    if (!machineId) return

    cloudFcn.queueLog(machineId).then(res => {
      if(!res.result.success) return Promise.reject(res)
      
      let machineLogs = Array.from(res.result.data.reverse(), log => {
        // 兼容三种历史格式：
        //   新格式：[HH:MM:SS] 用户名动作
        //   旧格式：用户名于<Date>动作
        //   更旧格式：用户用户名于<Date>动作
        const logInfo = String(log.log_info || '')
        let operatorName = '未知用户'
        let action = logInfo

        // 动作关键词（用于切分名称和动作）
        const markers = ['加入了队列', '离开了队列', '切换为拼机', '切换为单刷', '将', '上机', '下机']

        if (logInfo.startsWith('[')) {
          // 新格式：[HH:MM:SS] 用户名动作
          const body = logInfo.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/^用户/, '')
          let cut = -1
          for (const m of markers) {
            const i = body.indexOf(m)
            if (i >= 0 && (cut < 0 || i < cut)) cut = i
          }
          if (cut > 0) {
            operatorName = body.slice(0, cut).trim()
            action = body.slice(cut).trim()
          } else {
            action = body.trim()
          }
        } else {
          // 旧格式：用户名于<Date>动作
          const body = logInfo.replace(/^用户/, '')
          const yiIdx = body.indexOf('于')
          if (yiIdx > 0) {
            operatorName = body.slice(0, yiIdx).trim()
            let rest = body.slice(yiIdx + 1)
            // 去掉 JS Date 字符串
            rest = rest.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}[^)]*\)?/, '')
            rest = rest.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '')
            action = rest.trim()
          } else {
            action = body.trim()
          }
        }

        // 把 action 拆成三段式（pre + target + post）
        const { pre, target, post } = splitAction(action)

        return {
          time: Date.parse(new Date(log.timestamp).toString()),
          timeShow: new Date(log.timestamp).toLocaleString('zh-CN', {hour12: false}).replace(/\//g, "-"),
          operatorName,
          pre,
          target,
          post,
        }
      })
      this.setData({
        ['logLists.machineLogs']: machineLogs
      })
    })
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    let selectedMachine = JSON.parse(options.selectedMachine)
    if (Object.keys(selectedMachine).length != 0) this.setData({
      selectedMachine
    })
    this.getQueueLog()
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // this.getQueueLog()
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})