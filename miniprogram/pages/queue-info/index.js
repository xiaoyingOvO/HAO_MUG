// pages/queue-info/index.js
import cloudFcn from '../../cloudFcn.js'
const app = getApp()

// 支持「拼机 / 单刷」切换的机台 —— 目前只有「舞萌·官机」（M01）。
//   日麻是 4 人一桌开局，MML / ADX / 中二节奏都是单人机台，都没有拼机/单刷的概念，
//   所以游玩区那句「点击座位可切换 拼机 / 单刷」的提示也只给官机显示。
//   以后若新增可拼机的机台，把它的 machineId 加进来即可。
const MULTI_PLAY_MACHINE_IDS = ['M01'];
// 将后端传来的排队信息处理成前端显示的格式
const handleQueueInfo = function(queueInfo) {
  var myOpenid = wx.getStorageSync('userInfo')?.openid || app.globalData?.userInfo?.openid
  if (!myOpenid) {
    wx.showToast({
      title: '获取用户信息失败，可能出现问题，请检查登录状态',
      icon: 'none'
    })
  }
  var myIndex = -1
  var nowOrder = 0
  var playlist = Array.from(queueInfo, (p, index) => {
    // 正在游玩 → order 固定为 0；排队中 → order 从 1 开始递增
    let order = p.play_status ? 0 : ++nowOrder
    if (myOpenid == p.openid) myIndex = index
    return {
      openid: p.openid,
      order,
      isMulti: p.is_multi,
      playPosition: p.play_position,
      nickname: p.user_info ? p.user_info.nickname : undefined,
      avatar: p.user_info ? p.user_info.avatar : undefined
    }
  })

  return {playlist, myIndex}
}
// 把 playlist 拆成"游玩位"和"等候区"
function buildPlayingList(playlist, maxPlayer) {
  const playing = playlist.filter(p => p.order === 0)
  const waitingList = playlist.filter(p => p.order > 0).sort((a, b) => a.order - b.order)
  // 有人单刷（isMulti === false）→ 空位标红（locked）
  const hasSingle = playing.some(p => p.isMulti === false)
  const playingList = []
  for (let i = 0; i < maxPlayer; i++) {
    const player = playing.find(p => p.playPosition === i)
    if (player) {
      playingList.push({ type: 'player', player })
    } else {
      playingList.push({ type: hasSingle ? 'locked' : 'empty' })
    }
  }
  return { playingList, waitingList }
}

// 随手写的一重试函数
// promise参数必须为一个返回值为Promise的函数
const retryPromise = async function({ promise=async()=>{}, retries=0, fail=()=>{} }) {
  var attempts = 0 //已尝试次数
  var errors = []
  while (attempts < retries) {
    try {
      const result = await promise()
      return result
    } catch (err) {
      attempts++
      errors.push(err)
      fail(attempts, err)
    }
  }
  return Promise.reject(errors)
}

Page({
  // 空函数
  noop() {},
  /**
   * 页面的初始数据
   */
  data: {
    machines: [
      // ID, 机器名, 最大上机人数
      // {machineId: 't', machineName: '乌蒙1号', maxPlayer: 2},
    ],
    selectedMachine: {},
    enterInfo: {},  //存储用户排队状态
    playlist: [
      // {
      //   openid: '1111',
      //   order: 0,        // 0 正在游玩，1、2、3… 排队顺序
      //   isMulti: true,   // 是否拼机
      //   playPosition: 0, // 游玩位下标（0 ~ maxPlayer-1），仅游玩中有值
      //   nickname: '坤坤',
      //   avatar: 'https://xxx.net/xxx.jpg'
      // }
    ],
    playingList: [],   // 游玩位（固定 maxPlayer 个）
    waitingList: [],   // 等候区
    myIndex: 2,   // 当前用户在playlist中的位置，-1为未入队
    showDragClone: false, // 显示拖拽排序被移动的卡
    dragIndex: -1,        // 当前被拖拽的卡在 waitingList 中的下标
    clonePlayer: {},      // 结构和playlist中的元素一样，被拖拽的卡
    cloneRect: {          // 用于控制被拖拽的卡的位置
      top: 0,
      height: 0,
      width: 0
    },
    isMulti: true,
    // 当前机台是否支持「拼机 / 单刷」切换 —— 只有舞萌·官机为 true，
    // 决定游玩区那句提示要不要显示（见 MULTI_PLAY_MACHINE_IDS）
    canSwitchMulti: false,
    enqueueButtonText: '加载中...',
    isLoading: true,
    overdraft: false,        // 是否处于透支状态 → 页面常驻红字
    overdraftShortage: 0,    // 透支了多少点
    scrollEnabled: true,     // 等候区是否可滚动（拖拽时禁用）
  },

  // 切换机台（点击左侧列表里的某一项）
  async switchMachine(e) {
    return this.doSwitchMachine(Number(e.currentTarget.dataset.machineIndex))
  },
  /**
   * 实际切换机台。
   * ⚠️ 拆出来的原因：桌游区用户进页面时要自动切到「日麻」，不能只靠手动点击触发。
   * 原来 selectedMachine 初始是 {}，桌游区用户进来还是空/音游机台 →
   * 被「跨区排卡」校验拦下、整个排队列表被隐藏，看起来就像「日麻没加进排卡板」。
   */
  async doSwitchMachine(machineIndex) {
    let selectedMachine = this.data.machines[machineIndex]
    if (!selectedMachine) return
    // 机台不可用，无法切换至此机台
    if (selectedMachine.maxPlayer == -1) return wx.showToast({
      title: '机台不可用',
      icon: 'none'
    })
    this.setData({
      selectedMachine,
      // 只有可拼机的机台（舞萌·官机）才在游玩区显示「点击座位可切换 拼机 / 单刷」
      canSwitchMulti: MULTI_PLAY_MACHINE_IDS.indexOf(selectedMachine.machineId) !== -1
    })

    // 获取切换到机台的排队情况
    return this.getMachineQueueInfo(selectedMachine.machineId).then(playlist => {
      let enterState = this.data.enterInfo.enterState
      let myIndex = this.data.myIndex
      if (myIndex != -1 || enterState == 1) this.setData({
        checkQueueError: false,
      })
      else if (enterState == 2 || enterState == 3) {
        // 我在别的机台排队/游玩：切过来后，正常显示队列 + 入队按钮
        this.setData({
          checkQueueError: false,
        })
      }
      else if (enterState == 0) this.setData({
        checkQueueError: true,
        queueErrorText: '请先入店',
        enqueueButtonText: '请入店',
      })
    })
  },
  /**
   * 按当前入店区域自动选中机台：桌游区 → 日麻；音游区 → 第一台可用音游机台。
   * 已经手动选了同区域的机台就不覆盖（保留用户选择）。
   */
  async ensureMachineForArea(area) {
    const list = this.data.machines || []
    if (!list.length) return
    const want = area === 'board' ? 'board' : 'arcade'
    const areaOf = (m) => (m && m.area === 'board' ? 'board' : 'arcade')
    const cur = this.data.selectedMachine
    if (cur && cur.machineId && areaOf(cur) === want) return   // 用户已选了同区机台
    const idx = list.findIndex((m) => areaOf(m) === want && m.maxPlayer != -1)
    if (idx < 0) return
    if (cur && cur.machineId === list[idx].machineId) return
    try {
      await this.doSwitchMachine(idx)
    } catch (e) {
      console.error('按区域自动选择机台失败', e)
    }
  },
  // 获取机台列表
  async getMachineInfo() {
    return cloudFcn.getMachineInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)

      var machines = Array.from(
        res.result.data,
        m => {
          return {
            machineId: m._id,
            machineName: m.max_player != -1 ? m.machine_name : m.machine_name + '（不可用喵）',
            maxPlayer: m.max_player,
            // 机台所属区域：日麻 = 'board'（桌游区），其余 'arcade'。用于跨区排卡校验
            area: m.area === 'board' ? 'board' : 'arcade'
          }
        }
      )
      this.setData({
        machines
      })
      // 机台列表到位后，按当前入店区域自动选中一个（桌游区自动切到日麻）
      const area = this.data.enterInfo && this.data.enterInfo.area === 'board' ? 'board' : 'arcade'
      return this.ensureMachineForArea(area)
    })
  },

  // 获取某个机台排队信息
  async getMachineQueueInfo(machineId) {
    return cloudFcn.getQueueInfo(machineId).then(res => {
      if (!res.result.success) return Promise.reject(res)
      var {playlist, myIndex} = handleQueueInfo(res.result.data)
      var maxPlayer = this.data.selectedMachine.maxPlayer || 1
      var { playingList, waitingList } = buildPlayingList(playlist, maxPlayer)
      this.setData({
        playlist,
        myIndex,
        playingList,
        waitingList,
      })
      return playlist
    })
  },

  // 用户点击入队按钮
  async handleEnqueueBtn() {
    // 跨区排卡拉黑
    const myArea = this.data.enterInfo && this.data.enterInfo.area === 'board' ? 'board' : 'arcade'
    const mArea = this.data.selectedMachine && this.data.selectedMachine.area === 'board' ? 'board' : 'arcade'
    if (myArea !== mArea) {
      return wx.showToast({
        title: myArea === 'board'
          ? '桌游区只能排「日麻」，请先离店后重新选择音游设备入店'
          : '「日麻」属于桌游区，请先离店后重新选择「桌游/日麻」入店',
        icon: 'none',
        duration: 2500
      })
    }

    // 检查"我是否在别的机台排队/游玩"
    const enterState = this.data.enterInfo.enterState
    const myMachineId = this.data.enterInfo.machineId
    const curMachineId = this.data.selectedMachine.machineId
    const inOther = (enterState == 2 || enterState == 3) && myMachineId && myMachineId !== curMachineId

    if (inOther) {
      wx.showModal({
        title: '提示',
        content: '确定要切换到这个机台吗？',
        success: (res) => {
          if (res.confirm) {
            this.switchToMachine()
          }
        }
      })
      return
    }

    retryPromise({
      promise: this.enqueue.bind(this),
      retries: 3,
      fail: (attempts, err) => {
      }
    }).catch(errors => {
      wx.showToast({
        title: `入队失败，${errors.slice(-1)[0].result ? errors.slice(-1)[0].result.errMsg : '请重试'}`,
        icon: 'error'
      })
    })
  },

  // 切换到新机台：退出原机台 + 排新队
  async switchToMachine() {
    const enterState = this.data.enterInfo.enterState
    const machineId = this.data.selectedMachine.machineId
    try {
      if (enterState == 3) {
        await cloudFcn.deplain(this.data.enterInfo.machineId)
      } else if (enterState == 2) {
        await cloudFcn.dequeue(this.data.enterInfo.machineId)
      }
      await cloudFcn.enqueue(machineId, this.data.isMulti)
      await this.getMachineQueueInfo(machineId)
      await this.refreshEnterInfo()
      wx.showToast({ title: '已切换机台', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: err.errMsg || '切换失败', icon: 'none' })
      console.error('切换机台失败', err)
    }
  },

  // 入队
  async enqueue() {
    var machineId = this.data.selectedMachine.machineId
    var isMulti = this.data.isMulti
    return cloudFcn.enqueue(machineId, isMulti).then(res => {
      if (!res.result.success) return Promise.reject(res)
      return this.getMachineQueueInfo(machineId)
    }).then(res => {
      return this.refreshEnterInfo()
    })
  },

    // 点游玩区的空位：切换单刷
    async toggleSingle(e) {
      // 只有支持「拼机 / 单刷」的机台（舞萌·官机）才响应。
      //   日麻是 4 人一桌，切成单刷会把剩下 3 个座位全标红锁定；
      //   MML / ADX / 中二节奏都是单人机台，本来就没有拼机概念。
      //   ⚠️ 提示文字也用同一个 canSwitchMulti 控制，两处保持一致。
      if (!this.data.canSwitchMulti) return

      const position = Number(e.currentTarget.dataset.position)
      const seats = this.data.playingList
      const seat = seats[position]
      // 只有"空位"或"红位"能点，"玩家位"不响应
      if (!seat || seat.type === 'player') return
  
      // 只有"我"在游玩区才能切
      const myIndex = this.data.myIndex
      if (myIndex < 0 || this.data.playlist[myIndex].order !== 0) {
        return wx.showToast({ title: '只有上机后才能切换单刷', icon: 'none' })
      }
  
      const openid = this.data.enterInfo.openid
      const machineId = this.data.selectedMachine.machineId
      const isCurrentlySingle = this.data.playlist[myIndex].isMulti === false
      const newMulti = isCurrentlySingle   // 现在是单刷 → 切回拼机(true)；否则 → 单刷(false)
  
      try {
        await cloudFcn.switchMulti(openid, machineId, newMulti)
        await this.getMachineQueueInfo(machineId)
        wx.showToast({ title: newMulti ? '已切回拼机' : '已单刷', icon: 'none' })
      } catch (err) {
        wx.showToast({ title: '切换失败', icon: 'none' })
        console.error(err)
      }
    },

  // 用户点击退队按钮
  async handleDequeueBtn() {
    retryPromise({
      promise: this.dequeue.bind(this),
      retries: 3,
      fail: (attempts, err) => {
      }
    }).catch(errors => {
      wx.showToast({
        title: `退队失败，${errors.slice(-1)[0].result.errMsg}`,
        icon: 'error'
      })
    })
  },
  // 退队
  async dequeue() {
    return cloudFcn.getEnterInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)
      var enterInfo = res.result.data
      var machineId = enterInfo.machine_id
      return cloudFcn.dequeue(machineId)
    }).then(res => {
      if (!res.result.success) return Promise.reject(res)
      return this.getMachineQueueInfo(this.data.selectedMachine.machineId)
    }).then(res => {
      return this.refreshEnterInfo()
    })
  },

  // 用户点击下机按钮
  async deplain(e) {
    var both = e.detail.both
    var machineId = this.data.selectedMachine.machineId
    var result
    if (!both) result = cloudFcn.deplain(machineId)
    else result = cloudFcn.deplainAll(machineId)

    result.then(res => {
      if (!res.result.success) return Promise.reject(res)
      return this.getMachineQueueInfo(machineId)
    }).then(res => {
      return this.refreshEnterInfo()
    }).catch(console.error)
  },

  // 底部按钮：下机
  handleDeplainBtn() {
    this.deplain({ detail: { both: false } });
  },

  // 开始拖动（长按后触发）
  async dragStart(e) {
    if (this.data.showDragClone) return

    const detail = e.detail || {}
    const touch = detail.changedTouches && detail.changedTouches[0]
    if (!touch) return

    const i = e.currentTarget.dataset.index   // waitingList 的下标
    const player = this.data.waitingList[i]
    if (!player) return

    this._dragPlayer = player

    // 先切 DOM（scroll-view → view），再在 nextTick 拿 rect
    this.setData({
      scrollEnabled: false,
      dragIndex: i,
      clonePlayer: { ...player },
      showDragClone: true,
    })

    wx.nextTick(() => {
      this.createSelectorQuery()
        .select('.waiting-list > .real-card').boundingClientRect()
        .select('.waiting-list').boundingClientRect()
        .exec(([cardRect, listRect]) => {
          if (!listRect) return
          const height = cardRect ? cardRect.height : 140
          const top = touch.clientY - listRect.top - height / 2

          // 缓存 list 顶部，dragMove 直接用
          this._listTop = listRect.top

          this.setData({
            cloneRect: {
              top,
              height,
              width: listRect.width,
            },
          })

          wx.vibrateShort && wx.vibrateShort({ type: 'light' })
        })
    })
  },

  // 正在拖动
  dragMove(e) {
    if (!this.data.showDragClone) return
    const detail = e.detail || {}
    const touch = detail.touches && detail.touches[0]
    if (!touch) return
    if (this._listTop == null) return
    const { height } = this.data.cloneRect
    const top = touch.clientY - this._listTop - height / 2
    this.setData({ 'cloneRect.top': top })
  },

  // 拖动完成
  async dragEnd(e) {
    if (!this.data.showDragClone) return

    const detail = e.detail || {}
    const touch = detail.changedTouches && detail.changedTouches[0]
    if (!touch) {
      this.resetDragState()
      return
    }

    const touchY = touch.clientY
    const player = this._dragPlayer

    this.resetDragState()
    if (!player) return

    this.createSelectorQuery()
      .select('.playing-area').boundingClientRect()
      .selectAll('.playing-seat').boundingClientRect()
      .exec(([areaRect, seats]) => {
        if (!areaRect) return

        const inPlayingArea =
          touchY >= areaRect.top - 20 && touchY <= areaRect.bottom + 20

        if (inPlayingArea) {
          let position = -1
          ;(seats || []).forEach((seat, idx) => {
            if (touchY >= seat.top - 20 && touchY <= seat.bottom + 20) {
              position = idx
            }
          })
          if (position >= 0) this.embarkToSeat(player, position)
          return
        }

        this.requeueInWaiting(player, touchY)
      })
  },

  // 复位拖动状态
  resetDragState() {
    this._dragPlayer = null
    this._listTop = null
    this.setData({
      scrollEnabled: true,
      showDragClone: false,
      dragIndex: -1,
      clonePlayer: {},
      cloneRect: { top: 0, height: 0, width: 0 }
    })
  },

  // 把玩家上机到指定位子
  async embarkToSeat(player, position) {
    let machineId = this.data.selectedMachine.machineId
    let isMulti = player.isMulti
    let seats = this.data.playingList
    if (seats[position] && seats[position].type === 'player') {
      wx.showToast({ title: '该位置已有人', icon: 'none' })
      return
    }
    cloudFcn.embark(machineId, isMulti, position).then(res => {
      if (!res.result.success) return Promise.reject(res)
      wx.showToast({ title: '上机成功', icon: 'none' })
      return this.getMachineQueueInfo(machineId)
    }).then(() => {
      return this.refreshEnterInfo()
    }).catch(err => {
      wx.showToast({ title: err.errMsg || '上机失败', icon: 'none' })
      console.error(err)
    })
  },

  // 在等候区内调整顺序（拖到哪就排哪）
  async requeueInWaiting(player, touchY) {
    const machineId = this.data.selectedMachine.machineId
    const waitingList = this.data.waitingList
    if (!waitingList.length) return

    this.createSelectorQuery()
      .selectAll('.waiting-list > .real-card').boundingClientRect()
      .exec(([rects]) => {
        if (!rects || !rects.length) return

        // rects 和 waitingList 索引一致（原卡 visibility 占位）
        let insertIndex = rects.length   // 默认队尾
        for (let i = 0; i < rects.length; i++) {
          const center = rects[i].top + rects[i].height / 2
          if (touchY < center) {
            insertIndex = i
            break
          }
        }

        const selfIndex = waitingList.findIndex(p => p.openid === player.openid)
        if (selfIndex === -1) return

        let targetOpenid
        if (insertIndex >= rects.length) {
          targetOpenid = '-1'
        } else {
          const target = waitingList[insertIndex]
          if (!target || target.openid === player.openid) {
            return
          }
          targetOpenid = target.openid
        }

        cloudFcn.delay(machineId, targetOpenid, player.openid)
          .then(res => {
            if (!res.result.success) return Promise.reject(res)
            wx.showToast({ title: '已调整顺序', icon: 'none' })
            return this.getMachineQueueInfo(machineId)
          })
          .catch(err => {
            wx.showToast({ title: '排序失败', icon: 'none' })
            console.error('排序失败', err)
          })
      })
  },

  // 举报
  // ⚠️ 当前 card 组件已改成「长按拖拽」的纯净卡片，不再渲染「举报」按钮，
  //    所以这里暂时没有 UI 入口，保留备用。要恢复：在 card.wxml 加按钮并 triggerEvent('report')。
  report(e) {
    let index = e.currentTarget.dataset.index
    let toOpenid = this.data.playlist[index].openid
    wx.showModal({
      title: '举报',
      editable: true,
      placeholderText: '举报内容'
    }).then(res => {
      if (res.cancel) {
      }
  
      if (res.confirm) {
        return cloudFcn.report(toOpenid, res.content)
      }
    }).then(res => {
      if (!res.result.success) return Promise.reject(res)

      wx.showToast({
        title: '举报成功',
        icon: 'none'
      })
    }).catch(console.error)
  },

  // 踢出他人
  // ⚠️ 同 report：当前 card 组件没有「踢出」按钮入口，保留备用。
  kickOut(e) {
    let index = e.currentTarget.dataset.index
    let toOpenid = this.data.playlist[index].openid
    let machineId = this.data.selectedMachine.machineId
    let nickname = wx.getStorageSync('userInfo')?.nickname

    wx.showModal({
      title: '踢出他人',
      content: '你是否要踢出该用户？'
    }).then(res => {
      if (res.cancel) {
        return Promise.reject({canceled: true})
      }
  
      if (res.confirm) {
        return cloudFcn.kickOut(machineId, toOpenid, nickname)
      }
    }).then(res => {
      if (!res.result.success) return Promise.reject(res)

      wx.showToast({ title: '已踢出该用户', icon: 'none' })
    }).catch(err => {
      if (err.canceled) return
      console.error(err)
    })
  },

  // 点击日志按钮跳转到日志页面
  toLog() {
    wx.navigateTo({
      url: `/pages/play-log/log?selectedMachine=${JSON.stringify(this.data.selectedMachine)}`,
    })
  },

  // 进入页面时检查用户当前入队情况
  async checkQueueInfo() {
    this.setData({
      checkQueueError: true,
      queueErrorText: 'loading',
      enqueueButtonText: '加载中...',
    })
    this.refreshEnterInfo().then(async enterInfo => {
      // 先把机台切到「本区域」的（桌游区 → 日麻），再做下面的校验，
      // 否则桌游区用户会因为 selectedMachine 还是音游机台而被误判为跨区排卡
      await this.ensureMachineForArea(enterInfo.area)
      var enterState = enterInfo.enterState
      var point = enterInfo.realPoint + enterInfo.extraPoint
      var machineId = enterInfo.machineId

      // 报错信息
      if (enterState == 0) { // 未入店
        return this.setData({
          checkQueueError: true,
          queueErrorText: '请先入店',
          enqueueButtonText: '请入店',
        })
      }
      // 跨区排卡拉黑：机台所属区域必须和入店区域一致
      //   桌游区（board）的人只能排日麻，音游区的人只能排音游机台
      else if (
        (enterInfo.area === 'board' ? 'board' : 'arcade') !==
        (this.data.selectedMachine && this.data.selectedMachine.area === 'board' ? 'board' : 'arcade')
      ) {
        const inBoard = enterInfo.area === 'board'
        return this.setData({
          checkQueueError: true,
          queueErrorText: inBoard
            ? '您当前在桌游区，只能排「日麻」。如需游玩音游机台，请先离店后重新选择音游设备入店'
            : '「日麻」属于桌游区，请先离店后重新选择「桌游/日麻」入店',
          enqueueButtonText: inBoard ? '桌游区只能排日麻' : '音游区无法排日麻',
        })
      }

      // 余额判断：拿「当前应扣点数」和余额比较，而不是只看余额是否为 0。
      //   持有免单优惠卡时应扣点数为 0，所以余额为 0 也能正常排卡
      //   （对齐云函数 Enqueue / Embark 的 `remain_need > remain_total` 判定）。
      var needPoint = 0
      try {
        const cp = await cloudFcn.getConsumePoint()
        if (cp.result && cp.result.success) needPoint = cp.result.data.points || 0
      } catch (e) {
        console.warn('获取已消费点数失败，按 0 处理', e)
      }

      // 费用扣成负数：只提醒，不把人从队列里踢出去。
      //   已经在队列里（enterState 2 / 3）→ 保持「退队」按钮可用，只显示红字提醒；
      //   还没排队（enterState 1）        → 阻止新入队（入队本身仍有余额门槛）。
      const overdraft = needPoint > point
      this.setData({
        overdraft,
        overdraftShortage: overdraft ? Number((needPoint - point).toFixed(2)) : 0
      })
      if (overdraft && enterState == 1) {   // 尚未排队才阻止入队
        return this.setData({
          checkQueueError: true,
          queueErrorText: '余额不足，请充值',
          enqueueButtonText: '余额不足'
        })
      }

      if (enterState == 1) {  // 用户休息中
        return this.getMachineInfo().then(res => {
          // 显示默认机器
          var defaultMachineIndex = 0
          var e = {currentTarget: {dataset: {machineIndex: defaultMachineIndex}}}
          return this.switchMachine(e)
        })
      }
      else if (enterState == 2 || enterState == 3) {  // 候队中or游玩中
        return this.getMachineInfo().then(res => {
          // 显示用户排队所在机器的排队情况
          var machineIndex = this.data.machines.findIndex(m => m.machineId == machineId)
          var e = {currentTarget: {dataset: {machineIndex: machineIndex}}}
          return this.switchMachine(e).then(res => {
            var isMulti = this.data.playlist[this.data.myIndex].isMulti
            this.setData({isMulti})
          })
        })
      }
      else return Promise.reject(res)
    }).catch(console.error)
  },

  // 刷新用户排队状态
  async refreshEnterInfo() {
    return cloudFcn.getEnterInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)

      // 用户排队状态信息
      var enterInfo = res.result.data
      enterInfo = {
        openid: enterInfo.openid,
        realPoint: enterInfo.real_point,
        extraPoint: enterInfo.extra_point,
        enterState: enterInfo.enter_state,
        enterTime: enterInfo.enter_time,
        machineId: enterInfo.machine_id,
        // 入店区域：'arcade' 音游区 / 'board' 桌游区（老数据没有该字段时按音游区）
        area: enterInfo.area === 'board' ? 'board' : 'arcade'
      }
      this.setData({
        enterInfo
      })
      return enterInfo
    })
  },

// 检查登录状态
//  async checkLoginState() {
//     // wx.showLoading({
//     //   title: '正在验证登录...',
//     //   mask: true
//     // })
//     let userInfo = null;
//     let loginStatusIsValid = false;
    
//     try {
//         const cloudRes = await wx.cloud.callFunction({
//             name: 'baseFunctions',
//             data: {
//                 type: 'getUsrInfo'
//             }
//         });
//         if (cloudRes.result && cloudRes.result.success === true && cloudRes.result.data?.openid) {
//             userInfo = cloudRes.result.data;
//             wx.setStorageSync('userInfo', userInfo);
//             this.setData({ userInfo: userInfo });
//             wx.hideLoading();
//             return Promise.resolve(true); // 检查通过
//         } else {
//             wx.removeStorageSync('userInfo'); // 清除可能的无效缓存
//             loginStatusIsValid = false;
//              wx.hideLoading();
//           //   wx.showLoading({
//           //     title: '跳转至登录页',
//           //     icon: 'loading',
//           //     duration: 1500,
//           //     mask: true
//           //   });
//           //   await new Promise(resolve => setTimeout(resolve, 1500));
//           //   wx.reLaunch({
//           //     url: '/pages/login/index',
//           //     complete: () => {
//           //         wx.hideLoading();
//           //     }
//           //   });
//           //   return Promise.reject("重定向至登录页");
//         }
//     } catch (cloudError) {
//         console.error('云函数调用异常：', cloudError);
//         wx.removeStorageSync('userInfo');
//         loginStatusIsValid = false;
//         wx.hideLoading();
//       //   wx.showToast({
//       //     title: '验证失败, 请登录',
//       //     icon: 'none',
//       //     duration: 2000,
//       //     mask: true
//       // });
//         // 延迟跳转
//       //   await new Promise(resolve => setTimeout(resolve, 2000));
//       //   wx.reLaunch({
//       //     url: '/pages/login/index',
//       //   });
//       //   return Promise.reject("因异常重定向至登录页");
//     };

//     if (loginStatusIsValid) {
//         this.setData({
//             userInfo: userInfo,
//             showLoginOverlay: false,  // 已登录，隐藏遮罩层
//             isLoading: false,
//         });
//         // 加载页面其他数据
//     } else {
//         this.setData({
//             userInfo: null,
//             showLoginOverlay: true,   // 未登录
//             isLoading: false
//         });
//     }
// },

// 预览状态登录
  redirectToLogin() {
    wx.reLaunch({
        url: '/pages/login/index' 
      });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    // this.checkLoginState();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {
    //获取自定义组件中的'计算自定义导航栏高度'方法
    var calNavigationBarHeight = this.selectComponent('#custom-navi').calNavigationBarHeight
    this.calNavigationBarHeight = calNavigationBarHeight
    // 获取所有机器信息
    this.getMachineInfo().catch(console.error)
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this.checkQueueInfo()
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