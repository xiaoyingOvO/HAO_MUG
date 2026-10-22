// pages/notice/index.js
import cloudFcn from '../../cloudFcn.js'

Page({
  data: {
    faq: [],
    showFaq: [],
    contact: []
  },

  onLoad() {
    this.loadNotice()
  },

  async loadNotice() {
    try {
      const res = await cloudFcn.getNotice()
      if (!res.result.success) return
      const { faq, contact } = res.result.data
      faqFilter(faq)
      const showFaq = Array.from({ length: faq.length }, () => false)
      this.setData({ faq, contact, showFaq })
    } catch (e) {
      console.error('加载入店须知失败', e)
    }
  },

  extendFaq(e) {
    const idx = e.currentTarget.dataset.index
    const key = `showFaq[${idx}]`
    this.setData({ [key]: !this.data.showFaq[idx] })
  },

  copyContact(e) {
    let text = e.currentTarget.dataset.text
    if (!text) return
    // QQ 只复制数字号码
    if (e.currentTarget.dataset.type === 'QQ' || /^QQ/i.test(text)) {
      const digits = String(text).replace(/\D/g, '')
      if (digits) text = digits
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'none' })
    })
  }
})

// 处理 faq 中的换行和图片
function faqFilter(faq) {
  if (!Array.isArray(faq)) return
  faq.forEach(item => {
    if (item.a) item.a = String(item.a).replace(/&hc/g, '\n')
  })
}
