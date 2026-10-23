// pages/queue-info/index.js
import cloudFcn from '../../cloudFcn.js'
const app = getApp()

// 支持「拼机 / 单刷」切换的机台 —— 目前只有「舞萌·官机」（M01）。
//   日麻是 4 人一桌开局，MML / ADX / 中二节奏都是单人机台，都没有拼机/单刷的概念，
//   所以游玩区那句「点击座位可切换 拼机 / 单刷」的提示也只给官机显示。
//   以后若新增可拼机的机台，把它的 machineId 加进来即可。
const MULTI_PLAY_MACHINE_IDS = ['M01'];
// 排队信息自动刷新间隔（毫秒）。
//   排卡板是店里多人共看的场景，别人入队、退队、上机都该马上看到，
//   所以页面停留期间按固定间隔轮询；5 秒足够用，也不会把云函数调用量堆得太高。
const QUEUE_POLL_INTERVAL_MS = 5000;
// 排队数据本地缓存时间（毫秒），轮询模式下减少重复云函数请求。
//   比轮询间隔短，确保缓存失效时下一轮能拿到最新数据。
const QUEUE_DATA_CACHE_MS = 2000;
// 按机台分别缓存：Map<machineId, { data, ts }>
//   原来只有一个变量、只记最后看的那台 —— 从「我正在排的机台」切到别的机台再切回来，
//   缓存早被覆盖了，又得等一次网络。改成按机台存之后，来回切都是先出旧内容再静默刷新。
const _queueCacheMap = new Map()
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
      avatar: p.user_info ? p.user_info.avatar : undefined,
      // isMe = 是不是当前用户。卡片上的「我」只认这个人，不认列表下标：
      // playlist（游玩区+等候区混排）和 waitingList（只含等候区）两套下标本来就不一样，
      // 拿它们互相比较会随机撞上，把别人的卡标成「我」。
      isMe: myOpenid === p.openid
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

// 把列表压成字符串用于比对：顺序、人物、头像、昵称、拼机状态任何一项变了都算「变了」
const queueSnapshot = (list) => JSON.stringify(list || [])

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
  /**
   * 页面的初始数据
   */
  data: {
    machines: [
      // ID, 机器名, 最大上机人数
      // {machineId: 't', machineName: '乌蒙1号', maxPlayer: 2},
    ],
    // 首屏默认就按「加载中」渲染骨架，避免先闪一帧空列表再跳成文字。
    // 机台列表一到（machines.length > 0）就切到真正的排卡板，不再等入店状态校验完成。
    checkQueueError: true,
    queueErrorText: 'loading',
    enqueueButtonText: '加载中...',
    selectedMachine: {},
    // 左侧机台列表滚动定位：选中机台变化时滚到它（id 见 wxml 的 machine-{{item.machineId}}）
    machineScrollIntoView: '',
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
  },

  /* ============================================================
   * 【一】机台切换与数据获取
   *   switchMachine / doSwitchMachine / ensureMachineForArea —— 机台选择
   *   getMachineInfo / getMachineQueueInfo —— 拉取机台列表与队列
   * ============================================================ */

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
    if (selectedMachine.is_disabled) return wx.showToast({
      title: '机台不可用',
      icon: 'none'
    })
    this.setData({
      selectedMachine,
      // 只有可拼机的机台（舞萌·官机）才在游玩区显示「点击座位可切换 拼机 / 单刷」
      canSwitchMulti: MULTI_PLAY_MACHINE_IDS.indexOf(selectedMachine.machineId) !== -1,
      // 左侧机台多起来之后，正在排的那台可能在可视区外看不到 —— 选中就滚过去
      machineScrollIntoView: 'machine-' + selectedMachine.machineId,
    })

    const machineId = selectedMachine.machineId
    // 这台机台之前看过 → 先把旧队列铺上，点击立刻有反馈（不用干等网络）。
    // 紧接着的 forceRefresh 会拿最新数据盖掉它；失败时用户至少还看得到上一次的内容。
    const cached = _queueCacheMap.get(machineId)
    if (cached) {
      try {
        this.applyQueueData(cached.data)
      } catch (e) {
        console.warn('套用缓存的队列数据失败，忽略', e)
      }
    }

    // 获取切换到机台的排队情况
    return this.getMachineQueueInfo(machineId, true).then(playlist => {
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
   * 决定「进页面该打开哪一台机台的队列」。
   *   ① 用户正在排队 / 游玩（enter_state 2 / 3）→ 就是他所在的那台。
   *      这是排卡页最重要的信息，必须第一个加载、直接选中。
   *   ② 没在排队 → 按入店区域挑第一台可用机台（桌游区 → 日麻，音游区 → 第一台音游机台）。
   * 返回机台下标，-1 表示没找到可用的。
   */
  pickTargetMachineIndex(enterInfo) {
    const list = this.data.machines || []
    if (!list.length) return -1
    const state = enterInfo && enterInfo.enterState
    const myMachineId = enterInfo && enterInfo.machineId
    // ① 在排队/在游玩：优先定位到自己那一队
    if ((state == 2 || state == 3) && myMachineId) {
      const i = list.findIndex(m => m.machineId === myMachineId)
      // 机台被删/被停用时退回第 ② 步，否则会卡在「机台不可用」上
      if (i >= 0 && !list[i].is_disabled) return i
    }
    // ② 按区域兜底
    const want = (enterInfo && enterInfo.area === 'board') ? 'board' : 'arcade'
    return list.findIndex(m => (m.area === 'board' ? 'board' : 'arcade') === want && !m.is_disabled)
  },

  /**
   * 按当前入店区域自动选中机台：桌游区 → 日麻；音游区 → 第一台可用音游机台。
   * 已经手动选了同区域的机台就不覆盖（保留用户选择）。
   * ⚠️ 首屏不走这里 —— 首屏要用 pickTargetMachineIndex 优先认「正在排的队伍」，
   *    这个函数只作为「没在排队时的默认选择」和手动切换的补充。
   */
  async ensureMachineForArea(area) {
    const list = this.data.machines || []
    if (!list.length) return
    const want = area === 'board' ? 'board' : 'arcade'
    const areaOf = (m) => (m && m.area === 'board' ? 'board' : 'arcade')
    const cur = this.data.selectedMachine
    if (cur && cur.machineId && areaOf(cur) === want) return   // 用户已选了同区机台
    const idx = list.findIndex((m) => areaOf(m) === want && !m.is_disabled)
    if (idx < 0) return
    if (cur && cur.machineId === list[idx].machineId) return
    try {
      await this.doSwitchMachine(idx)
    } catch (e) {
      console.error('按区域自动选择机台失败', e)
    }
  },
  // 获取机台列表
  //   options.skipAutoSelect = true：只把机台列表铺到页面上，不自动选机台。
  //     首屏走这条 —— 「该打开哪一台的队列」要由「用户在排哪一队」来定
  //     （见 pickTargetMachineIndex），先按区域选一台再切过去会白打一次 getQueueInfo。
  async getMachineInfo(options) {
    const skipAutoSelect = !!(options && options.skipAutoSelect)
    // 优先读全局预取缓存：app 启动时已预取，命中则秒出机台框架，不用等网络
    const cached = app.globalData && app.globalData.pageCache && app.globalData.pageCache.machines
    const applyAndReturn = (rawData) => {
      var machines = Array.from(
        rawData,
        m => {
          return {
            machineId: m._id,
            machineName: m.is_disabled ? m.machine_name + '（不可用喵）' : m.machine_name,
            maxPlayer: m.max_player,
            // 机台所属区域：日麻 = 'board'（桌游区），其余 'arcade'。用于跨区排卡校验
            area: m.area === 'board' ? 'board' : 'arcade',
            is_disabled: !!m.is_disabled,
          }
        }
      )
      this.setData({ machines })
      if (skipAutoSelect) return machines
      // 机台列表到位后，按当前入店区域自动选中一个（桌游区自动切到日麻）
      const area = this.data.enterInfo && this.data.enterInfo.area === 'board' ? 'board' : 'arcade'
      return this.ensureMachineForArea(area)
    }

    if (cached && cached.length) {
      return applyAndReturn(cached)
    }

    // 复用 App 那一次在途请求。App 启动时已经在拉了，这里再发一次的话，
    // 冷启动下两个请求会互相排队，首屏反而更慢。
    if (app && typeof app.fetchMachines === 'function') {
      const data = await app.fetchMachines()
      if (data && data.length) return applyAndReturn(data)
    }

    return cloudFcn.getMachineInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)
      // 顺便写回全局缓存，供下次使用
      if (app.globalData && app.globalData.pageCache) {
        app.globalData.pageCache.machines = res.result.data
      }
      return applyAndReturn(res.result.data)
    })
  },

  // 获取某个机台排队信息
  //   forceRefresh=true 跳过本地缓存（用户主动操作后需要立刻看到真实结果）
  async getMachineQueueInfo(machineId, forceRefresh) {
    this.syncQueueRealtime(machineId)   // 机台变了就换实时监听的集合

    const cached = _queueCacheMap.get(machineId)
    const fresh = cached && Date.now() - cached.ts < QUEUE_DATA_CACHE_MS

    // 新鲜缓存 → 直接用，不再打云函数
    if (!forceRefresh && fresh) {
      return Promise.resolve(this.applyQueueData(cached.data))
    }

    return cloudFcn.getQueueInfo(machineId).then(res => {
      if (!res.result.success) return Promise.reject(res)
      _queueCacheMap.set(machineId, { data: res.result.data, ts: Date.now() })
      return this.applyQueueData(res.result.data)
    })
  },

  // 把云函数返回的原始队列数据套用到页面（缓存命中/网络返回共用）
  applyQueueData(rawData) {
    var {playlist, myIndex} = handleQueueInfo(rawData)
    var maxPlayer = this.data.selectedMachine.maxPlayer || 1
    var { playingList, waitingList } = buildPlayingList(playlist, maxPlayer)
    // 队列和页面上当前的一模一样就不 setData。
    // 自动刷新每 5 秒来一次，无脑重渲染会让卡片反复重建、看起来一闪一闪。
    const unchanged =
      this.data.myIndex === myIndex &&
      queueSnapshot(this.data.waitingList) === queueSnapshot(waitingList) &&
      queueSnapshot(this.data.playingList) === queueSnapshot(playingList)
    if (!unchanged) {
      this.setData({
        playlist,
        myIndex,
        playingList,
        waitingList,
      })
    }
    return playlist
  },

  /* ============================================================
   * 【二】入队 / 退队 / 上下机
   *   handleEnqueueBtn / switchToMachine / enqueue —— 入队、切换机台
   *   handleDequeueBtn / dequeue —— 退队
   *   deplain / handleDeplainBtn —— 下机
   * ============================================================ */

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
      await this.getMachineQueueInfo(machineId, true)
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
      return this.getMachineQueueInfo(machineId, true)
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
    return cloudFcn.getEnterInfo({ lite: true }).then(res => {
      if (!res.result.success) return Promise.reject(res)
      var enterInfo = res.result.data
      var machineId = enterInfo.machine_id
      return cloudFcn.dequeue(machineId)
    }).then(res => {
      if (!res.result.success) return Promise.reject(res)
      return this.getMachineQueueInfo(this.data.selectedMachine.machineId, true)
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
      return this.getMachineQueueInfo(machineId, true)
    }).then(res => {
      return this.refreshEnterInfo()
    }).catch(console.error)
  },

  // 底部按钮：下机
  handleDeplainBtn() {
    this.deplain({ detail: { both: false } });
  },

  /* ============================================================
   * 【三】拖拽排序（等候区调整顺序 / 拖到游玩位直接上机）
   *   dragStart / dragMove / dragEnd / resetDragState —— 拖拽手势
   *   embarkToSeat / requeueInWaiting —— 上机与重排
   * ============================================================ */

  // 开始拖动（长按后触发）
  async dragStart(e) {
    if (this.data.showDragClone) return

    const detail = e.detail || {}
    const touch = detail.changedTouches && detail.changedTouches[0]
    if (!touch) return

    // ⚠️ dataset 取出来可能是字符串。不转成数字的话模板里的
    //    `dragIndex === index` 恒为 false → 原卡不会被隐藏，
    //    屏幕上就会同时出现「原卡 + 跟手的克隆卡」两张一样的卡。
    const i = Number(e.currentTarget.dataset.index)
    const player = this.data.waitingList[i]
    if (!player) return

    this._dragPlayer = player

    // 拖拽会话号：resetDragState 会让它 +1，用来作废上一次拖拽遗留的异步回调
    const seq = ++this._dragSeq
    this._lastMoveTs = 0

    // 先把 showDragClone 打开（模板里 scroll-y 会跟着关掉、原卡也会隐藏），
    // 等这轮渲染落地后再量尺寸，否则量到的是滚动中的旧位置
    this.setData({
      dragIndex: i,
      clonePlayer: { ...player },
      showDragClone: true,
    })

    wx.nextTick(() => {
      if (seq !== this._dragSeq) return
      this.createSelectorQuery()
        .select('.waiting-list > .real-card').boundingClientRect()
        .select('.waiting-list').boundingClientRect()
        .exec(([cardRect, listRect]) => {
          if (seq !== this._dragSeq) return
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
    // touchmove 一帧内可能来好几次，而每次 setData 都是「逻辑层 → 渲染层」的跨线程通信。
    // 不节流的话实机上每帧要发好几次，直接掉帧，手指和卡片就会脱节。这里每帧最多发一次。
    const now = Date.now()
    if (now - this._lastMoveTs < 16) return
    this._lastMoveTs = now
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
    this._lastMoveTs = 0
    this._dragSeq++          // 让上一次拖拽还在途的回调作废
    this.setData({
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
    cloudFcn.embark(machineId, isMulti, position, player.openid).then(res => {
      if (!res.result.success) return Promise.reject(res)
      wx.showToast({ title: '上机成功', icon: 'none' })
      return this.getMachineQueueInfo(machineId, true)
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
            return this.getMachineQueueInfo(machineId, true)
          })
          .catch(err => {
            // 把云函数给的原因显示出来。
            // 原来这里写死一句「排序失败」，把真实原因盖掉了 —— 看不到原因就没法查。
            const reason = (err && err.result && err.result.errMsg) || '排序失败'
            wx.showToast({ title: reason, icon: 'none' })
            console.error('排序失败', err)
            // 失败时也要按后端的真实顺序校准一次：
            // 这次拖动没成功，本地这份列表不一定和后端链表一致，
            // 不校准的话界面和后端就会分叉，之后照着界面拖也拖不对。
            return this.getMachineQueueInfo(machineId, true)
          })
      })
  },

  /* ============================================================
   * 【四】举报 / 踢出 / 跳转日志
   *   report / kickOut —— 目前无 UI 入口，保留备用
   *   toLog —— 跳转日志页
   * ============================================================ */

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

  /* ============================================================
   * 【五】入店校验与用户状态
   *   checkQueueInfo —— 进页面时校验入店/跨区/余额
   *   refreshEnterInfo —— 拉取用户入店状态
   * ============================================================ */

  // 进入页面时检查用户当前入队情况
  //
  // 首屏的加载顺序（本轮优化的重点）：
  //   1. 机台列表 与 入店状态 并行发出 —— 两个都要，谁先回都行
  //   2. 拿到入店状态后先看「我在哪一队」（user.machine_id），直接打开那一队
  //      → 只打一次 getQueueInfo，而且选中的就是正在排的队伍
  //   3. 其余机台的队列按需加载（点哪台拉哪台，内存里按机台缓存，切回来秒出）
  //
  // 旧实现的两处浪费：
  //   · getMachineInfo 内部先按区域选一台（音游区 = 第一台）并拉一次队列，
  //     紧接着又切到真正在排的那台再拉一次 —— 串行两次 getQueueInfo，首屏多等一个来回
  //   · 期间左侧高亮从第一台跳到自己那台，看起来像「自动点错了」
  async checkQueueInfo() {
    this.setData({
      checkQueueError: true,
      queueErrorText: 'loading',
      enqueueButtonText: '加载中...',
    })

    // ① 并行：机台列表（不自动选机台）+ 入店状态
    const machineInfoPromise = this.getMachineInfo({ skipAutoSelect: true }).catch((e) => {
      console.warn('预热机台列表失败', e)
    })

    let enterInfo
    try {
      enterInfo = await this.refreshEnterInfo()
    } catch (e) {
      console.error('读取入店状态失败', e)
      await machineInfoPromise
      return this.setData({
        checkQueueError: true,
        queueErrorText: (this.data.machines || []).length ? '读取入店状态失败，请下拉重试' : '加载失败，请稍后重试',
        enqueueButtonText: '请重试',
      })
    }
    await machineInfoPromise   // 两个请求本来就同时发出，这一步几乎不增加等待

    const machines = this.data.machines || []
    if (!machines.length) {
      return this.setData({
        checkQueueError: true,
        queueErrorText: '机台列表加载失败，请稍后重试',
        enqueueButtonText: '加载失败',
      })
    }

    const enterState = enterInfo.enterState

    // ② 定目标机台：在排队/游玩 → 自己那一队；否则按区域选第一台
    const targetIndex = this.pickTargetMachineIndex(enterInfo)

    // 未入店：机台列表照常展示（让用户看到店里有哪几台），只把底部按钮禁掉
    if (enterState == 0) {
      this.setData({
        checkQueueError: true,
        queueErrorText: '请先入店',
        enqueueButtonText: '请入店',
      })
      if (targetIndex >= 0) await this.doSwitchMachine(targetIndex).catch(console.error)
      return
    }

    if (targetIndex < 0) {
      return this.setData({
        checkQueueError: true,
        queueErrorText: enterInfo.area === 'board'
          ? '桌游区暂无可排的机台，请联系店员'
          : '音游区暂无可排的机台，请联系店员',
        enqueueButtonText: '暂无可排机台',
      })
    }

    // ③ 一次到位：选中目标机台 + 拉它的队列（首屏只有这一次 getQueueInfo）
    try {
      await this.doSwitchMachine(targetIndex)
    } catch (e) {
      console.error('打开目标机台队列失败', e)
      return this.setData({
        checkQueueError: true,
        queueErrorText: '队列加载失败，请下拉重试',
        enqueueButtonText: '请重试',
      })
    }

    // ④ 跨区排卡拉黑：机台所属区域必须和入店区域一致
    //    （必须在选定机台之后判断，否则 selectedMachine 还是空/别的区，会误判）
    const inBoard = enterInfo.area === 'board'
    const mBoard = this.data.selectedMachine && this.data.selectedMachine.area === 'board'
    if (inBoard !== mBoard) {
      return this.setData({
        checkQueueError: true,
        queueErrorText: inBoard
          ? '您当前在桌游区，只能排「日麻」。如需游玩音游机台，请先离店后重新选择音游设备入店'
          : '「日麻」属于桌游区，请先离店后重新选择「桌游/日麻」入店',
        enqueueButtonText: inBoard ? '桌游区只能排日麻' : '音游区无法排日麻',
      })
    }

    // ⑤ 队列和入店状态都到位，放行底部按钮
    this.setData({ checkQueueError: false })

    // 余额透支判断：异步做，不阻塞排卡板主体内容
    this.updateOverdraft(enterInfo)

    // 排队中/游玩中：把「拼机 / 单刷」状态同步过来
    if (enterState == 2 || enterState == 3) {
      const me = this.data.playlist[this.data.myIndex]
      // myIndex 为 -1 说明云端说我在排队、但这个队列里没我（数据刚变），交给轮询去追
      if (me) this.setData({ isMulti: me.isMulti })
    }
  },

  // 异步计算透支状态（余额 vs 当前应扣点数），不阻塞主流程
  async updateOverdraft(enterInfo) {
    const point = enterInfo.realPoint + enterInfo.extraPoint
    let needPoint = 0
    try {
      const cp = await cloudFcn.getConsumePoint()
      if (cp.result && cp.result.success) needPoint = cp.result.data.points || 0
    } catch (e) {
      console.warn('获取已消费点数失败，按 0 处理', e)
    }
    // 费用扣成负数：只提醒，不把人从队列里踢出去。
    const overdraft = needPoint > point
    this.setData({
      overdraft,
      overdraftShortage: overdraft ? Number((needPoint - point).toFixed(2)) : 0
    })
    // 余额不足且尚未排队（enterState 1）时阻止新入队
    if (overdraft && enterInfo.enterState == 1) {
      this.setData({
        checkQueueError: true,
        queueErrorText: '余额不足，请充值',
        enqueueButtonText: '余额不足'
      })
    }
  },

  // 刷新用户排队状态
  async refreshEnterInfo() {
    return cloudFcn.getEnterInfo({ lite: true }).then(res => {
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

  /* ============================================================
   * 【六】页面生命周期
   *   onLoad / onReady / onShow / onHide / onUnload / onShareAppMessage
   * ============================================================ */

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    // this.checkLoginState();
    this._dragSeq = 0      // 拖拽会话号，见 dragStart / resetDragState
    this._lastMoveTs = 0   // dragMove 的节流时间戳
    this._queuePollTimer = null   // 排队信息轮询的定时器（实时监听不可用时用）
    this._pollInFlight = false    // 上一轮自动刷新是否还没返回
    this._queueWatcher = null     // 云开发数据库实时监听句柄
    this._queueWatchMachineId = null      // 当前监听的是哪个机台
    this._queueWatchFailedMachineId = null // 哪台机台确认建立不起监听（退回轮询）
    this._queueWatchClosed = false  // 是否已主动关闭监听（防止异步 onError 踩状态）
    this._queueWatchIniting = false // 是否正在建立监听（防重入）
    this._queueWatchReady = false   // 首帧是否已到达（= 监听真正建立成功）
    this._queueWatchSeq = 0         // 监听世代号，作废在途回调
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {
    // 获取所有机器信息。
    // ⚠️ skipAutoSelect：这里只做预热，不能顺手「按区域选一台并拉一次队列」——
    //    checkQueueInfo 紧接着会按「我在排哪一队」选目标机台，
    //    两边各选一次的话，首屏会多打一次 getQueueInfo，还会看到高亮先跳一下。
    this.getMachineInfo({ skipAutoSelect: true }).catch(console.error)
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this.checkQueueInfo()
    // 进页面就打开刷新通道（离开页面时在 onHide / onUnload 里关掉）
    this.ensureQueueRefresh()
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {
    this.stopQueueRefresh()
    // 拖到一半切后台 / 息屏时 touchend 可能不触发，克隆卡和「被隐藏的原卡」会留在页面上，
    // 看起来就像卡片变成了两张。这里补一次收尾。
    if (this.data.showDragClone) this.resetDragState()
  },

  /* ===== 排队信息实时刷新 =====
     主通道：用云开发数据库实时监听 queue_<机台> 集合 —— 队列一变（入队/退队/
             上机/位置调整）立刻拉一次全量。
             拉全量是因为昵称和头像不在队列集合里，得由云函数拼。
     备用：监听不可用（离线模拟层 / 没配集合读权限 / 连接断了）时退回 5 秒轮询。
     ⚠️ 实时监听需要在云开发控制台给 queue_* 集合配「所有用户可读」的权限，
        否则前端读不到这个集合，会自动落到轮询。 */

  /* ============================================================
   * 【七】排队信息实时刷新（数据库监听 + 轮询兜底）
   *   ensureQueueRefresh / syncQueueRealtime / startQueueRealtime —— 建立监听
   *   stopQueueRefresh —— 关闭监听
   *   startQueuePolling / stopQueuePolling / pollQueueInfo —— 轮询兜底
   * ============================================================ */

  ensureQueueRefresh() {
    const machineId = this.data.selectedMachine && this.data.selectedMachine.machineId
    if (machineId) {
      this.startQueueRealtime(machineId)
      return
    }
    // 还没选出机台：先用轮询兜着，等 getMachineQueueInfo 拿到机台再切到实时监听
    this.startQueuePolling()
  },

  // 机台换了就换监听目标（在每次拿到队列前调用）
  syncQueueRealtime(machineId) {
    if (this._queueWatchMachineId === machineId) return
    // 这台机台已经确认建立不起监听（没配权限等），就留在轮询上，
    // 不要在每一轮轮询里反复重试、刷日志
    if (this._queueWatchFailedMachineId === machineId) return
    this.startQueueRealtime(machineId)
  },

  startQueueRealtime(machineId) {
    this.stopQueueRefresh()
    this._queueWatchMachineId = machineId
    this._queueWatchFailedMachineId = null   // 每次进页面都重新试一次实时监听
    // 先起轮询兜底：建立监听是异步的，万一失败或很慢，队列也不会卡着不刷新；
    // 监听真正生效后再把轮询停掉
    this.startQueuePolling()

    const cloudDb = wx.cloud && wx.cloud.database ? wx.cloud.database() : null
    if (!cloudDb || !cloudDb.collection) return   // 离线模拟层没有数据库，就用轮询

    // watch() 失败时 onError 可能在它返回之前就同步回调（比如集合没配读权限）。
    // 用这个标志判断监听到底建起来没有 —— 否则会把上面刚起的兜底轮询又停掉
    let watchEstablished = true
    // 已在监听中，或正在建立中，直接跳过（防止重复建立）
    if (this._queueWatcher || this._queueWatchIniting) return;
    const mySeq = (this._queueWatchSeq || 0) + 1
    this._queueWatchSeq = mySeq
    this._queueWatchIniting = true;
    this._queueWatchClosed = false;
    this._queueWatchReady = false;
    try {
      const watcher = cloudDb.collection('queue_' + machineId).watch({
        // 首帧（init）也会回调，正好当作进页面后的第一次刷新
        onChange: (snapshot) => {
          // 这一代已作废（切了机台或已离开页面）→ 不再处理，收尾交给 stopQueueRefresh
          if (this._queueWatchSeq !== mySeq) return
          this._queueWatchIniting = false;
          this._queueWatchReady = true   // 收到首帧 = 监听真正建立成功，此后才能安全 close
          console.log('队列变动触发刷新：', snapshot && snapshot.type,
            snapshot && snapshot.docChanges ? snapshot.docChanges.length : 0)
          this.pollQueueInfo()
        },
        onError: (err) => {
          if (this._queueWatchSeq !== mySeq) return
          this._queueWatchIniting = false;
          this._queueWatchReady = false;
          // 已主动关闭/切换页面，忽略后续异步错误
          if (this._queueWatchClosed) return;
          this._queueWatchClosed = true;
          // 监听建立不起来或中途断了（没配集合读权限、网络异常、连接被回收）
          // → 退回轮询，保证队列还能刷新
          watchEstablished = false
          console.warn('队列实时监听不可用，改用 5 秒轮询：', err)
          this._queueWatcher = null
          this._queueWatchMachineId = null
          this._queueWatchFailedMachineId = machineId
          this.startQueuePolling()
        }
      })
      if (!watchEstablished) {
        this._queueWatchIniting = false;
        return;   // 同步报错：监听没建起来，轮询继续兜着
      }
      this._queueWatcher = watcher
      this._queueWatchIniting = false;
      this.stopQueuePolling()   // 监听已生效，不用再轮询
    } catch (e) {
      this._queueWatchIniting = false;
      console.warn('队列实时监听建立失败，改用 5 秒轮询：', e)
      this._queueWatchMachineId = null
      this._queueWatchFailedMachineId = machineId
    }
  },

  stopQueueRefresh() {
    // 先标记已关闭，防止异步回调再触发逻辑
    this._queueWatchClosed = true;
    this._queueWatchIniting = false;
    this._queueWatchSeq = (this._queueWatchSeq || 0) + 1   // 作废所有在途回调
    this._queueWatchMachineId = null
    const watcher = this._queueWatcher
    const ready = this._queueWatchReady
    this._queueWatcher = null
    this._queueWatchReady = false
    if (watcher) {
      if (ready) {
        try {
          watcher.close()
        } catch (e) {
          // close() 时 watcher 还没完全建立，SDK 会抛异常，安全忽略
        }
      } else {
        // 监听还在建立中：此刻 close 会把 SDK 内部状态置成 CLOSED，
        // 等会儿 initWatch 的失败回调迟到，SDK 试图 transition('initWatchFail') 就会抛
        //   "current state (CLOSED) does not accept initWatchFail"
        // （堆栈在 Fa.initWatch → Wo.transition，是 SDK 内部抛的，外层的 try/catch 抓不到）
        // 所以先不动它，等它自己落定（成功→onChange 首帧 / 失败→onError）再关。
        setTimeout(() => {
          try { watcher.close() } catch (e) { /* 同上，忽略 */ }
        }, 2000)
      }
    }
    this.stopQueuePolling()
  },

  /* ===== 排队信息自动刷新 =====
     checkQueueInfo 会先把页面打成 loading 态，只适合进页面时用一次；
     这里改用只读的 getMachineQueueInfo 静默轮询。 */
  startQueuePolling() {
    if (this._queuePollTimer) return   // 已经在轮询了，不要重复起定时器
    this._queuePollTimer = setInterval(() => {
      this.pollQueueInfo()
    }, QUEUE_POLL_INTERVAL_MS)
  },

  stopQueuePolling() {
    if (this._queuePollTimer) {
      clearInterval(this._queuePollTimer)
      this._queuePollTimer = null
    }
  },

  async pollQueueInfo() {
    // 正在拖卡时不刷新：列表被重建会把拖到一半的卡弹回原位
    if (this.data.showDragClone) return
    // 上一轮还没回来就跳过这一轮，网络慢时不让请求堆积
    if (this._pollInFlight) return
    // 未登录不轮询（handleQueueInfo 取不到 openid 会弹提示，轮询起来就是刷屏）
    const myOpenid = wx.getStorageSync('userInfo')?.openid || app.globalData?.userInfo?.openid
    if (!myOpenid) return
    const machine = this.data.selectedMachine
    if (!machine || !machine.machineId) return

    this._pollInFlight = true
    try {
      // ⚠️ 必须绕过本地缓存：这里是「云端告诉我队列变了」之后的刷新。
      //   而 2 秒缓存只服务「同一台机台来回切换」这种场景 —— 如果这次刷新命中缓存，
      //   相当于把这条变更通知丢掉。监听生效后轮询已停，丢掉的这一条就再也没人补，
      //   页面会一直停在旧队列上（直到用户手动切机台或退出重进）。
      await this.getMachineQueueInfo(machine.machineId, true)
    } catch (e) {
      // 自动刷新失败不弹提示：网络抖一下不该打断用户，下一轮会自己重试
      // （用户主动操作触发的刷新仍然走原来的报错逻辑）
      console.error('排队信息自动刷新失败', e)
    } finally {
      this._pollInFlight = false
    }
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {
    this.stopQueueRefresh()
    if (this.data.showDragClone) this.resetDragState()
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})