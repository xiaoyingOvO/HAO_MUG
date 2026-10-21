// pages/play-log/log.js
import cloudFcn from '../../cloudFcn.js'

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
        // console.log(log.log_info)
        const match = log.log_info.match(/用户(.+?)于/)
        return {
          time: Date.parse(new Date(log.timestamp).toString()),
          timeShow: new Date(log.timestamp).toLocaleString('zh-CN', {hour12: false}).replace(/\//g, "-"),
          action: log.log_info.replace(/^用户.+?于.*?Time\)/, ""),
          userName: match ? match[1] : '未知用户',
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