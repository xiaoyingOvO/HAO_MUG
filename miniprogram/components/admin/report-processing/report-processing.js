// components/admin/report-processing/report-processing.js
import cloudFcn from '../../../cloudFcn.js'
import { queryCommonMethods } from '../common/query-utils.js'

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
    reportList: [],
    showReportPage: false,
    currentReport: null,
    sendToReporter: true,
    sendToReported: false,
    messageTitle: '',
    messageContent: ''
  },

  /**
   * 组件的方法列表
   */
  methods: {
    formatTime: queryCommonMethods.formatTime,

    // 初始化组件属性
    setInitialParams(options) {
      
    },

    // 获取页面数据更新
    updateData({list, total, hasMore}) {
      list.reverse().forEach(item => {
        item.time = this.formatTime(item.timestamp)
      })
      this.setData({
        reportList: list,
      })
    },

    // 点击处理举报按钮
    handleProcessBtn(e) {
      const reportId = e.currentTarget.dataset.id
      const report = this.data.reportList.find(item => item._id === reportId)
      
      this.setData({
        showReportPage: true,
        currentReport: report,
        sendToReporter: true,
        sendToReported: false,
        messageTitle: '举报反馈',
        messageContent: ''
      })
    },

    // 切换发送给举报人
    toggleReporter() {
      this.setData({
        sendToReporter: !this.data.sendToReporter
      })
    },

    // 切换发送给被举报人
    toggleReported() {
      this.setData({
        sendToReported: !this.data.sendToReported
      })
    },

    // 输入标题
    onTitleInput(e) {
      this.setData({
        messageTitle: e.detail.value
      })
    },

    // 输入内容
    onContentInput(e) {
      this.setData({
        messageContent: e.detail.text.trim()
      })
    },

    // 发送反馈消息
    sendFeedback() {
      const { currentReport, sendToReporter, sendToReported, messageTitle, messageContent } = this.data
      
      // 验证输入
      if (!sendToReporter && !sendToReported) {
        wx.showToast({
          title: '请选择发送对象',
          icon: 'none'
        })
        return
      }
      
      if (!messageTitle.trim()) {
        wx.showToast({
          title: '请输入消息标题',
          icon: 'none'
        })
        return
      }
      
      if (!messageContent.trim()) {
        wx.showToast({
          title: '请输入消息内容',
          icon: 'none'
        })
        return
      }

      this.doSendFeedback()
    },

    // 执行发送反馈
    async doSendFeedback() {
      const { currentReport, sendToReporter, sendToReported, messageTitle, messageContent } = this.data
      
      let detail = {
        actionType: 'process',
        data: {
          receiver: null,
          title: messageTitle,
          content: messageContent
        },
        callback: (success) => {
          if (success) {
            this.setData({
              showReportPage: false,
              currentReport: null,
              sendToReporter: true,
              sendToReported: false,
              messageTitle: '',
              messageContent: ''
            })
          }
        }
      }

      if (sendToReporter) {
        detail.data.receiver = currentReport.from_openid
        this.triggerEvent('action', detail)
        console.log('发送给举报人:', currentReport.from_openid)
      }
      // 发送给被举报人
      if (sendToReported) {
        detail.data.receiver = currentReport.to_openid
        this.triggerEvent('action', detail)
        console.log('发送给被举报人:', currentReport.to_openid)
      }

      /* try {
        wx.showLoading({ title: '发送中...' })
        
        // actionType, data, callback
        // 发送给举报人
        if (sendToReporter) {
          console.log('发送给举报人:', currentReport.from_openid)
        }
        
        // 发送给被举报人
        if (sendToReported) {
          console.log('发送给被举报人:', currentReport.to_openid)
        }
        
        wx.hideLoading()
        wx.showToast({
          title: '发送成功',
          icon: 'success'
        })
        this.setData({
          showReportPage: false,
          currentReport: null,
          sendToReporter: true,
          sendToReported: false,
          messageTitle: '',
          messageContent: ''
        })
      } catch (err) {
        wx.hideLoading()
        wx.showToast({
          title: '发送失败'
        })
        console.error('发送反馈消息失败:', err)
      } */
    },

    onPageLeave() {
      this.setData({
        showReportPage: false,
        currentReport: null,
        sendToReporter: true,
        sendToReported: false,
        messageTitle: '',
        messageContent: ''
      })
    }
  }
})