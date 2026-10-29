// pages/queue-info/settings.js
// 排卡页底部「设置」进来的页面：和「当前这台机台」相关的杂项操作都放这里。
//   现有：日志 / 切换拼机状态 / 强制下机
//   以后再加的按钮，按 group 里的 cell 样式往下排即可（见 settings.wxml 注释）
import cloudFcn from '../../cloudFcn.js'
// 只有可拼机的机台（舞萌·官机）才显示「切换拼机状态」，
// 和排卡页点座位切换用的是同一份名单。
const { isMultiPlayMachine } = require('../../config/machineConfig.js')
// 切成单刷的确认文案（按「谁先上机」决定谁让位）、游玩列表的排序，和排卡页共用同一份
const { buildSwitchToSingleText, sortByEmbarkOrder } = require('../../utils/multiSwitch.js')

// 机台参数是 JSON 串在 url 里传的。
// 微信在大部分场景会帮我们把 query 解码，但不同基础库版本行为不完全一致，
// 所以这里「先按原样解析，失败再解码一次」，两种都能吃。
function parseMachineParam(raw) {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch (e) {}
  try {
    return JSON.parse(decodeURIComponent(raw)) || {}
  } catch (e) {}
  return {}
}

// 当前登录用户的 openid，用来在队列里标出「我」。
//   取法和排卡页一致：先看本地缓存，再退到全局的 userInfo。
function getMyOpenid() {
  let openid = ''
  try {
    const cached = wx.getStorageSync('userInfo')
    openid = (cached && cached.openid) || ''
  } catch (e) {}
  if (!openid) {
    try {
      const app = getApp()
      openid = (app && app.globalData && app.globalData.userInfo && app.globalData.userInfo.openid) || ''
    } catch (e) {}
  }
  return openid
}

Page({
  data: {
    selectedMachine: {},   // { machineId, machineName, maxPlayer, area }
    machineSubText: '',    // 「舞萌官机 · 2 座」
    myQueueItem: null,     // 队列里的「我」—— 切换拼机只对自己生效，所以只展示这一条
    playingList: [],       // 正在游玩的人（强制下机的候选）
    inQueue: false,        // 我在不在本机台的队列里（不在就不给点强制下机）
    queueLoaded: false,    // 队列读成功过没有（读失败时不要把功能误判成「你没资格」）
    canSwitchMulti: false, // 这台机台是否支持拼机 / 单刷
    forceOpen: false,      // 「强制下机」是否展开
    multiOpen: false,      // 「切换拼机状态」是否展开
    loading: false,        // 正在读取机台状态
    acting: false,         // 正在执行强制下机（防连点）
    multiActing: '',       // 正在切换拼机的 openid（防连点，空串 = 空闲）
  },

  onLoad(options) {
    const selectedMachine = parseMachineParam(options && options.selectedMachine)
    const maxPlayer = Number(selectedMachine.maxPlayer)
    // 副标题只放「几座 + 哪个区」，机台名上面已经大字显示了
    const parts = []
    if (maxPlayer > 0) parts.push(maxPlayer + ' 座')
    parts.push(selectedMachine.area === 'board' ? '桌游区' : '音游区')

    this.setData({
      selectedMachine,
      machineSubText: parts.join(' · '),
      canSwitchMulti: isMultiPlayMachine(selectedMachine.machineId),
    })
  },

  onShow() {
    // 从日志页返回、或者别人刚动过队列：回到这里都重新拉一次
    if (this.data.selectedMachine && this.data.selectedMachine.machineId) {
      this.loadQueue()
    }
  },

  /* ============================================================
   * 日志
   * ============================================================ */

  toLog() {
    const machine = this.data.selectedMachine || {}
    if (!machine.machineId) {
      wx.showToast({ title: '未选择机台', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `/pages/play-log/log?selectedMachine=${encodeURIComponent(JSON.stringify(machine))}`,
    })
  },

  /* ============================================================
   * 队列状态（强制下机 / 切换拼机共用一次读取）
   * ============================================================ */

  // 读本机台的整条队列：游玩中 + 等候中，顺带算出等候位次
  loadQueue() {
    const machineId = this.data.selectedMachine && this.data.selectedMachine.machineId
    if (!machineId) return Promise.resolve()
    // onShow 和「刷新」可能同时触发，同一时刻只发一次请求
    if (this._loading) return this._loading

    this.setData({ loading: true })
    this._loading = cloudFcn.getQueueInfo(machineId).then(res => {
      const raw = (res && res.result && res.result.data) || []
      const myOpenid = getMyOpenid()

      // getQueueInfo 返回的是链序：游玩中的人在链表前段，等候的人在后段。
      //   位次只数等候区（游玩的人已经在座位上，不占排队号），
      //   和排卡页 handleQueueInfo 的口径保持一致。
      let waitingSeq = 0
      const queueList = raw.map(p => {
        const info = p.user_info || {}
        // 云端 play_status 是布尔值；历史脏数据可能是 1/"true"，统一按真值判断
        const isPlaying = !!p.play_status
        // 游玩中不写座位号：游玩区已经按上机顺序从上往下排、不分格子了，
        // 座位号只是数据库里「哪个位置被占」的记录，显示出来只会让人以为界面和实际对不上。
        let posText = ''
        if (!isPlaying) {
          waitingSeq += 1
          posText = '第 ' + waitingSeq + ' 位'
        }
        return {
          openid: p.openid,
          nickname: info.nickname || '未知用户',
          avatar: info.avatar || '',
          isMulti: p.is_multi !== false,
          isPlaying,
          posText,
          // 座位号 / 上机标签：切成单刷时判断「谁让位」要用（和云端 switchMulti 同口径）
          playPosition: p.play_position,
          // 两个字段都往下传，由 multiSwitch 的 seqInfo 挑（新字段优先，清 0 时用老字段）
          embarkSeq: p.embark_seq,
          boardSeq: p.board_seq,
          isMe: !!myOpenid && myOpenid === p.openid,
        }
      })

      // 「正在游玩」列表按上机先后排（先上机的在上面），和排卡页的游玩区一致：
      //   店员从上往下点强制下机时，看到的就是「谁先上的、谁是刚上来的」。
      const playingItems = sortByEmbarkOrder(queueList.filter(q => q.isPlaying))
      // 切换拼机只能切自己，所以面板里只留「我」这一条
      const myItem = queueList.filter(q => q.isMe)[0] || null
      const inQueue = !!myItem

      this.setData({
        myQueueItem: myItem,
        // 强制下机只认正在游玩的人（「正在游玩」列表已按上机先后排序，见上面的 playingItems）
        playingList: playingItems,
        // 「我」在这台机台的队列里（游玩 / 等候都算）才有资格强制下机
        inQueue: inQueue,
        queueLoaded: true,
        // 已经展开的面板：我不在队列里了就自动收起（自己退队了 / 被别人弄出去了）
        forceOpen: this.data.forceOpen && inQueue,
        loading: false,
      })
    }).catch(err => {
      console.error('[设置页] 读取机台状态失败', err)
      // 读失败不能当成「你不在队列里」——把 queueLoaded 留在 false，
      // 界面上就不会灰掉按钮、也不会给一句「没有资格」的错判
      this.setData({ loading: false })
      wx.showToast({ title: '读取机台状态失败，请重试', icon: 'none' })
    }).then(() => {
      this._loading = null
    })
    return this._loading
  },

  /* ============================================================
   * 切换拼机状态
   * ============================================================ */

  // 展开 / 收起面板
  //   手风琴：同时只展开一个面板，点开这个就把别的收起来，
  //   否则两个列表叠在一起，页面上两屏都是人头，找按钮容易点错。
  toggleMulti() {
    const multiOpen = !this.data.multiOpen
    this.setData({ multiOpen, forceOpen: false })
    if (multiOpen) this.loadQueue()
  },

  // 切换自己的拼机状态（只能切自己，云端也会拦）
  async handleSwitchMulti(e) {
    if (this.data.multiActing) return
    const dataset = e.currentTarget.dataset || {}
    const targetOpenid = dataset.openid
    // dataset 里只有字符串，'single' = 改成单刷，'multi' = 改回拼机
    const nextIsMulti = dataset.next === 'multi'
    const machineId = this.data.selectedMachine && this.data.selectedMachine.machineId
    if (!targetOpenid || !machineId) return

    // 兜底：只能操作自己（正常情况下面板里也只有自己这一行）
    const myOpenid = getMyOpenid()
    if (!myOpenid || targetOpenid !== myOpenid) {
      wx.showToast({ title: '只能切换自己的拼机状态', icon: 'none' })
      return
    }

    // 切成单刷会改变机台上谁能坐（先上机的留下、后上机的让位），影响别人，先确认一次；
    //   切回拼机只是放开限制，不打扰。
    if (!nextIsMulti) {
      const me = this.data.myQueueItem || {}
      const playingOthers = (this.data.playingList || []).filter(p => !p.isMe)
      const modal = await wx.showModal({
        title: '切换为单刷',
        content: buildSwitchToSingleText({
          me,
          playingOthers,
          isPlaying: !!me.isPlaying,
        }),
        confirmText: '切成单刷',
        confirmColor: '#1677ff',
      })
      if (!modal || !modal.confirm) return
    }

    this.setData({ multiActing: targetOpenid })
    wx.showLoading({ title: '处理中...', mask: true })
    try {
      const res = await cloudFcn.switchMulti(machineId, nextIsMulti)
      wx.hideLoading()

      const result = (res && res.result) || {}
      if (!result.success) {
        // 云端会拒绝「机上还有别人时切单刷」，把真实原因弹出来
        wx.showToast({
          title: result.errMsg || '切换失败，请重试',
          icon: 'none',
          duration: 2500,
        })
      } else {
        const data = result.data || {}
        let toast = nextIsMulti ? '已切回拼机' : '已切成单刷'
        if (!nextIsMulti && data.self_moved) toast = '已切成单刷，你被移到队首'
        else if (!nextIsMulti && (data.displaced || []).length) toast = '已切成单刷，同台的人退回等候区'
        wx.showToast({ title: toast, icon: 'none' })
      }
      // 成功要刷新（状态变了）；失败也刷新（很可能是队列已被别人改动）
      this.loadQueue()
    } catch (err) {
      wx.hideLoading()
      console.error('[设置页] 切换拼机状态失败', err)
      wx.showToast({
        title: (err && err.errMsg) || '切换失败，请重试',
        icon: 'none',
      })
      this.loadQueue()
    } finally {
      this.setData({ multiActing: '' })
    }
  },

  /* ============================================================
   * 强制下机
   * ============================================================ */

  // 展开 / 收起面板（同上：同时只展开一个）
  //   打开前先确认「我在这台机台的队列里」—— 不在队伍里的人不能把别人请下去。
  //   每次打开都重新读一次队列，别用几分钟前的状态做判断。
  async toggleForce() {
    if (this.data.forceOpen) {
      this.setData({ forceOpen: false })
      return
    }
    await this.loadQueue()
    if (!this.data.queueLoaded) {
      // 读不到队列（断网 / 云函数报错）就不放行，也不冤枉人
      wx.showToast({ title: '读取机台状态失败，请重试', icon: 'none' })
      return
    }
    if (!this.data.inQueue) {
      wx.showToast({ title: '你不在本机台的队列中，不能强制下机', icon: 'none', duration: 2500 })
      return
    }
    this.setData({ forceOpen: true, multiOpen: false })
  },

  // 「我还在不在队列里」的统一拦截（除了云端的最后一道，这里也拦，免得白点）
  requireInQueue() {
    if (!this.data.queueLoaded) {
      wx.showToast({ title: '读取机台状态失败，请重试', icon: 'none' })
      return false
    }
    if (!this.data.inQueue) {
      wx.showToast({ title: '你不在本机台的队列中，不能强制下机', icon: 'none', duration: 2500 })
      return false
    }
    return true
  },

  // 点某个人后面的「下机」
  async handleForceDeplain(e) {
    if (this.data.acting) return
    if (!this.requireInQueue()) return
    const dataset = e.currentTarget.dataset || {}
    const targetOpenid = dataset.openid
    const targetName = dataset.name || '该用户'
    const machineId = this.data.selectedMachine && this.data.selectedMachine.machineId
    if (!targetOpenid || !machineId) return

    const modal = await wx.showModal({
      title: '强制下机',
      // 名单里也包括「我」（自己占着座位也能点自己下来），文案要说人话：
      //   「让『我』下来」看着别扭，直接说「你自己」。
      content: targetOpenid === getMyOpenid()
        ? '确定让自己从座位上下来吗？\n不会结算费用，你会排到等候区末尾。'
        : `确定让「${targetName}」从座位上下来吗？\n不会结算费用，他会排到等候区末尾。`,
      confirmText: '强制下机',
      confirmColor: '#e53935',
    })
    if (!modal || !modal.confirm) return

    this.setData({ acting: true })
    wx.showLoading({ title: '处理中...', mask: true })
    try {
      // 不结算费用，只把人放回等候区队尾（ForceDeplain）
      const res = await cloudFcn.forceDeplain(machineId, targetOpenid)
      wx.hideLoading()

      const result = (res && res.result) || {}
      if (!result.success) {
        wx.showToast({
          title: result.errMsg || '强制下机失败，请重试',
          icon: 'none',
          duration: 2500,
        })
      } else {
        wx.showToast({
          title: targetOpenid === getMyOpenid() ? '你已回到等候区末尾' : `已让「${targetName}」回到队尾`,
          icon: 'none'
        })
      }
      // 成功要刷新列表（人走了）；失败也刷新（很可能是对方自己已经下机了）
      this.loadQueue()
    } catch (err) {
      wx.hideLoading()
      console.error('[设置页] 强制下机失败', err)
      wx.showToast({
        title: (err && err.errMsg) || '强制下机失败，请重试',
        icon: 'none',
      })
      this.loadQueue()
    } finally {
      this.setData({ acting: false })
    }
  },

  // 全部下机：游玩区的人一次性全部回队尾（同样不结算）
  //   和上面单人版的区别只有一个：云端一次拿锁、一次补位、写一条日志。
  //   台下还有别人排队时会自动补位（否则机和人都僵在那儿），一个人都没有就让机台空着。
  async handleForceDeplainAll() {
    if (this.data.acting) return
    if (!this.requireInQueue()) return
    const machineId = this.data.selectedMachine && this.data.selectedMachine.machineId
    const playing = this.data.playingList || []
    if (!machineId) return
    if (!playing.length) {
      // 面板里的按钮只在有人游玩时出现，这里是兜底（比如列表刚好过期）
      wx.showToast({ title: '这台机台当前没有人在游玩', icon: 'none' })
      return
    }

    const modal = await wx.showModal({
      title: '全部下机',
      content: `确定让游玩区的 ${playing.length} 人全部下机吗？\n不会结算费用，他们会按上机先后排到等候区末尾。`,
      confirmText: '全部下机',
      confirmColor: '#e53935',
    })
    if (!modal || !modal.confirm) return

    this.setData({ acting: true })
    wx.showLoading({ title: '处理中...', mask: true })
    try {
      const res = await cloudFcn.forceDeplainAll(machineId)
      wx.hideLoading()

      const result = (res && res.result) || {}
      if (!result.success) {
        wx.showToast({
          title: result.errMsg || '全部下机失败，请重试',
          icon: 'none',
          duration: 2500,
        })
      } else {
        const downCount = (result.downed || []).length
        const upCount = (result.embarked || []).length
        // 有人被自动排上机就说一声，不然店员会疑惑「怎么台上还有人」
        wx.showToast({
          title: upCount ? `已下机 ${downCount} 人，${upCount} 人自动上机` : `已下机 ${downCount} 人`,
          icon: 'none',
        })
      }
      this.loadQueue()
    } catch (err) {
      wx.hideLoading()
      console.error('[设置页] 全部下机失败', err)
      wx.showToast({
        title: (err && err.errMsg) || '全部下机失败，请重试',
        icon: 'none',
      })
      this.loadQueue()
    } finally {
      this.setData({ acting: false })
    }
  },

  onShareAppMessage() {},
})
