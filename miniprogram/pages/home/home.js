// pages/home/home.js
import cloudFcn from '../../cloudFcn.js';
import { MOCK_ENABLED } from '../../mock/cloudMock.js';
const app = getApp();
var enterTimer = null
const checkBalanceTimeout = 20 // 查询余额轮询时间(单位min)
var checkBalanceCount = 0
const checkConsumePointTimeout = 1  // 已消费金额轮询时间
var checkConsumePointCount = 0
var remainPoint = 114514    // 用户余额

const ENTER_INFO_CACHE_MS = 3000 // getEnterInfo 本地缓存时间（毫秒），避免 onShow 频繁请求
let _enterInfoCache = null // { data, ts }

/* ============================================================
 * 模块级工具函数（不依赖 Page 实例）
 *   buildDeviceGroups —— 云端 machine 列表 → 入店弹层两级结构
 *   checkBalance / checkAndChargeBalance —— 余额轮询与扣费
 *   checkConsumePoint —— 已消费点数轮询
 *   notifyOverdraft / clearOverdraft —— 透支提醒
 *   calcEnterTime —— 在店时长正计时
 *   faqFilter —— FAQ 文案处理
 * ============================================================ */

// 入店设备选择弹层：一级分组对应的配图
//   maimai / chunithm / board 来自云端 machine 集合的 group_id
// ⚠️ 这三张图已压缩到 360px 宽（小程序主包上限 2MB，原图 613KB 会把包撑爆）。
//    弹层里只显示 128rpx 的缩略图，360px 足够；换高清图时记得重新压缩。
const GROUP_ICONS = {
  maimai: '/images/machines/maimai.jpg',
  chunithm: '/images/machines/chunithm.jpg',
  board: '/images/machines/board.jpg',
};

/**
 * 把云端 machine 列表整理成入店弹层需要的两级结构。
 * 同 group_id 的机台合并成一张卡（如舞萌 → 官机 / MML / ADX 三个独立队列）；
 * 缺少 group_id 时退化成「一台机一张卡」，不会报错。
 */
function buildDeviceGroups(machines) {
  const groups = [];
  const byGroup = new Map();
  Array.from(machines || []).forEach((m) => {
    const gid = m.group_id || m._id;
    if (!byGroup.has(gid)) {
      const g = {
        groupId: gid,
        groupName: m.group_name || m.machine_name,
        icon: GROUP_ICONS[gid] || GROUP_ICONS.maimai,
        desc: '',
        children: [],
      };
      byGroup.set(gid, g);
      groups.push(g);
    }
    const childIndex = byGroup.get(gid).children.length;
    byGroup.get(gid).children.push({
      key: `${gid}__${m._id}__${childIndex}`,
      machineId: m._id,
      label: m.label || m.machine_name,
      deviceName: m.machine_name,
      area: m.area === 'board' ? 'board' : 'arcade',
      maxPlayer: m.max_player,
      tag: m.tag || '',
      is_disabled: !!m.is_disabled,
    });
  });
  groups.forEach((g) => {
    const only = g.children[0];
    g.desc = g.children.length > 1
      ? `${g.children.length} 台独立排队`
      : (only.area === 'board'
        ? `独立排队`
        : (only.maxPlayer >= 2 ? '可拼机 / 单刷 · 独立排队' : '独立排队'));
    g.actionText = '入队';
  });

  return groups;
}

// 一定分钟一次的余额检查
function checkBalance(nowTime, enterTime, timeout) {
  let count = Math.ceil((nowTime - enterTime) / 1000 / 60 / timeout)  // timeout min查询一次
  if (count != checkBalanceCount) { // 已过了一定分钟
    checkAndChargeBalance.call(this)
    checkBalanceCount = count
  }
}
/**
 * 欠费提醒：只提醒、不打断。
 *   · 页面常驻红字（data.overdraft + data.overdraftShortage）
 *   · 只在「从正常变成透支」的第一次弹一次 toast，之后不再反复打扰
 *   · 队列位置保留 —— 服务端已不再强制退队（checkAndChargeBalance 去掉了 Dequeue）
 */
function notifyOverdraft(page, shortage) {
  const s = Number(shortage || 0);
  page.setData({ overdraft: true, overdraftShortage: s });
  if (page.data.overdraftNotified) return;
  page.setData({ overdraftNotified: true });
  wx.showToast({
    title: s > 0 ? `余额已透支 ${s} 点，请及时充值` : '余额已透支，请及时充值',
    icon: 'none',
    duration: 3000,
  });
}
/**
 * 在店时长：HH:mm:ss **正计时**（显示的是「已经待了多久」，不是入店时刻）。
 * 由 setEnterTimer 每秒调一次：`calcEnterTime(入店时间戳, 当前时间戳)`。
 * getEnterInfo 里也会先算一次，避免刚进页面时那一秒是空白。
 */
function calcEnterTime(time, nowTime = new Date().getTime()) {
  if (!time) return '00:00'
  let dec = parseInt((nowTime - time) / 1000)
  let HH = parseInt(dec / 3600) != 0 ? `${parseInt(dec / 3600)}:` : ''
  let mm = `${parseInt(dec % 3600 / 60)}:`.padStart(3, '0')
  let ss = `${parseInt(dec % 3600 % 60)}`.padStart(2, '0')
  let show = dec >= 0 ? HH + mm + ss : '00:00'
  return show
}

// 余额恢复后清掉红字，并允许下次再透支时重新提醒一次
function clearOverdraft(page) {
  if (!page.data.overdraft && !page.data.overdraftNotified) return;
  page.setData({ overdraft: false, overdraftShortage: 0, overdraftNotified: false });
}

function checkAndChargeBalance() {
  cloudFcn.checkAndChargeBalance().then(res => {
    if (!res.result.success) return Promise.reject(res.result)
    clearOverdraft(this)
  }).catch(err => {
    if (err.code === undefined) return console.error(err)
    if (err.code == -2) {
      // 余额已透支：只提醒，不弹 modal、不踢出队列
      notifyOverdraft(this, err.data && err.data.shortage)
    }
  })
}

// 一定分钟一次的已消费点数检查
function checkConsumePoint(nowTime, enterTime, timeout) {
  let count = Math.ceil((nowTime - enterTime) / 1000 / 60 / timeout)  // timeout min查询一次

  if (count != checkConsumePointCount) { // 已过了一定分钟
    cloudFcn.getConsumePoint().then(res => {
      if (!res.result.success) return Promise.reject(res.result)

      let points = res.result.data.points
      this.setData({
        consumptionAmount: points.toFixed(2)
      })
      
      if (remainPoint < points) {
        // 余额已透支：只提醒，不踢出队列（队列由用户自己决定何时退）
        notifyOverdraft(this, Number((points - remainPoint).toFixed(2)))
        checkAndChargeBalance.call(this)
      } else {
        clearOverdraft(this)
      }
    }).catch(err => {
      if (err.code === undefined) console.error(err)
    })
    checkConsumePointCount = count
  }
}

// 处理faq中的文字和图片
function faqFilter(faq) {
  faq.forEach((value) => {
    value.a = value.a.replace(/\&hc/g, '\n')
  })
}

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 首页 logo：正式环境读云存储；离线模拟模式下云存储不可用，改用本地图片
    // 本地图放在 images/logo.svg（已去掉「LOGO 占位图」字样）。
    // 想把真图换成原版的云存储 logo.jpg：下载后另存为 images/logo.jpg，并把下面改成 '/images/logo.jpg'。
    logoImg: MOCK_ENABLED
      ? '/images/logo.svg'
      : "cloud://hao-2gz8w8z212e63bcf.6861-hao-2gz8w8z212e63bcf-1347707526/logo.jpg",
    woStatus: {
      businessStatus: true,   // 是否营业中（默认 true，避免首屏误闪「已打烊」，真实值由 getEnterInfo 拉取）
      relaxNum: 0,             // 休息区在店人数
      enterState: 0, // 用户是否已入店 0：未入店  1：休息中  2：候机中  3：游玩中
      // 入店区域：'arcade' 音游区（12 点/小时）/ 'board' 桌游区（6 点/小时）
      area: 'arcade',
      areaName: '音游区',
      arcadeNum: 0, // 音游区在店人数
      boardNum: 0,  // 桌游区在店人数
      enterTime: {  // 入店时间
        time: 0,   // 入店时刻（毫秒时间戳），计时的基准
        show: ''   // 在店时长正计时文案（HH:mm:ss），每秒刷新
      },
    },
    woClosed: false,  // 无法入店
    woClosedText: '', // 停止入店的按钮文字
    // 夜场音游区锁：夜场时段 + 只持桌游夜场票（无夜场票/早八票）时为 true，
    // 入店弹层里音游区机台置灰，桌游区照常可选。由 checkAccess 刷新。
    nightArcadeLock: false,
    consumptionAmount: 0, // 消费金额

    // 入店设备选择弹层（点「入店」后弹出，选中设备即入店并直接排队）
    showDevicePicker: false,   // 是否显示设备选择弹层
    expandedGroup: '',         // 当前展开的一级设备（如舞萌，有三个变体）
    deviceGroups: [],          // 由云端机器列表构建，见 buildDeviceGroups()
    isEntering: false,         // 入店 + 入队请求进行中，防连点
    selectedDevice: null,      // 弹层里当前选中的设备（确认前不执行入店，防误触）
    selectedKey: '',           // 选中项的 key，用于高亮
    selectedGroup: '',         // 选中一级分组的 groupId，用于卡片本体高亮
    confirmText: '取消',       // 弹层底部按钮：未选中 = 取消 / 已选中 = 入队（统一文案）
    closing: false,            // 弹层关闭动画中

    // 欠费提醒：费用扣成负数时只提醒、不踢出队列
    overdraft: false,          // 是否处于透支状态 → 页面常驻红字
    overdraftShortage: 0,      // 透支了多少点
    overdraftNotified: false,  // 本次透支是否已经弹过提示（只弹一次）
    
    broadcast: '',
    contact: [
      // {type: '企鹅', detail: '114514'},
      // {type: '店长微信', detail: '1919810'}
    ],
    faq: [
      // {q: "1.1如何前往HAO窝游玩？", a: "玩玩玩"},
      // {q: "1.2HAO窝的收费模式？", a: "玩玩玩"},
      // {q: "1.3在HAO窝游玩的一些注意事项？", a: "玩玩玩"},
      // {q: "1.4HAO窝夜场的一些注意事项？", a: "玩玩玩"},
    ],
    showFaq: [],
    userInfo: null,     // 存储用户数据
    isLoggedIn: false,  // 登录状态
    unreadCount: 0, // 未读消息数
    isLoadingPage: true,  // 页面加载状态
    isEnterBtnDisabled: true, //  控制入店按钮禁用
  },

  /* ============================================================
   * 【一】店内状态与公告数据
   *   getEnterInfo —— 店内状态（人数/营业/入店时长）
   *   checkAccess —— 是否可入店（营业/夜场）
   *   getNotice —— 公告/FAQ/联系方式
   * ============================================================ */

  // 查询店内状态
  //   forceRefresh=true 时跳过本地缓存（下拉刷新、入店/离店等需要最新数据的场景用）
  async getEnterInfo(forceRefresh) {
    // 命中缓存（3 秒内）→ 直接套用，不再打云函数
    if (!forceRefresh && _enterInfoCache &&
        Date.now() - _enterInfoCache.ts < ENTER_INFO_CACHE_MS) {
      this.applyEnterInfo(_enterInfoCache.data)
      return Promise.resolve()
    }
    return cloudFcn.getEnterInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)

      var data = res.result.data
      _enterInfoCache = { data, ts: Date.now() }   // 写缓存
      this.applyEnterInfo(data)
    }).catch(console.error)
  },

  // 把入店状态数据套用到页面（getEnterInfo 缓存命中/网络返回都走这里）
  applyEnterInfo(data) {
    remainPoint = (data.real_point ?? 0) + (data.extra_point ?? 0)
    var businessStatus = data.business_status ?? true
    var relaxNum = data.relax_num ?? 0
    var enterState = data.enter_state ?? 0
    // 入店区域：老数据没有 area 字段时按音游区处理
    var area = data.area === 'board' ? 'board' : 'arcade'
    // enter_time 为 null / 非法时置 0，下面据此判断要不要起计时器
    var time = data.enter_time ? new Date(data.enter_time).getTime() : 0
    if (isNaN(time)) time = 0
    this.setData({
      ['woStatus.businessStatus']: businessStatus,
      ['woStatus.enterState']: enterState,
      ['woStatus.relaxNum']: relaxNum,
      ['woStatus.arcadeNum']: data.arcade_num ?? 0,
      ['woStatus.boardNum']: data.board_num ?? 0,
      ['woStatus.area']: area,
      ['woStatus.areaName']: area === 'board' ? '桌游区' : '音游区',
      ['woStatus.enterTime.time']: time,
      ['woStatus.enterTime.show']: calcEnterTime(time) // 在店时长（首次渲染，避免空白）
    })
    // 先清旧定时器，再起新的（避免重复计时）
    this.stopEnterTimer()
    // 只有在店 + 基准时间有效才起表；否则会和残留的旧基准打架，出现两个时钟
    if (enterState !== 0 && time > 0) {
      this.startEnterTimer()
    }
  },

  // 启用在店计时器
  //   ⚠️ 这里不再用「已在运行就 return」的标记来防重。
  //   那个标记一旦和实际状态不同步（比如离店时没走到 stop、或 applyEnterInfo 被并发调用），
  //   就会留下一个没人管的旧定时器，界面上表现为「两个时钟交替跳」（旧基准 + 新基准）。
  //   改成：每次启动前先把所有可能的旧定时器清干净，保证同一时刻最多只有一个在跑。
  startEnterTimer() {
    this.stopEnterTimer()
    let that = this
    // 世代号（generation）：每次起表都 +1，旧的那一代在下一拍发现号对不上就自杀。
    // 这是对「clearInterval 清不掉」的最后兜底 —— 句柄丢失（模块被重新执行、
    // 开发者工具热重载、页面实例复用）时，光靠句柄是永远清不掉的，
    // 但世代号存在页面实例上，旧闭包读的就是当前值，一比就知道自己过期了。
    let gen = (this._enterGen || 0) + 1
    this._enterGen = gen
    let id = setInterval(function i() {
      // 不是最新一代 → 立刻停掉自己，绝不和现存的那个抢着写同一个字段
      if (that._enterGen !== gen) {
        clearInterval(id)
        console.warn('[enterTimer] 已自动清理一个过期的在店计时器（世代号不匹配），通常来自热重载残留')
        return
      }
      let enterState = that.data.woStatus.enterState
      // 未入店 / 未获取到信息 → 自己停下来，避免变成一个「空转但随时会被唤醒」的僵尸定时器
      if (enterState === 0 || !enterState) {
        that.stopEnterTimer()
        return
      }

      let time = that.data.woStatus.enterTime.time
      let nowTime = new Date().getTime()
      // 基准时间无效（0 / NaN）说明数据还没到，跳过这一拍，别显示成 00:00 或乱码
      if (!time || isNaN(time)) return

      // 在店时长正计时（每秒 +1 秒）
      let show = calcEnterTime(time, nowTime)
      that.setData({
        ['woStatus.enterTime.show']: show
      })

      checkBalance.call(that, nowTime, time, checkBalanceTimeout)
      checkConsumePoint.call(that, nowTime, time, checkConsumePointTimeout)
    }, 1000)
    this._enterTimer = id
    enterTimer = id
  },

  // 停止在店计时器（页面实例上的 + 模块级的都清一遍，防止漏掉任何一个）
  //   ① 世代号 +1：即使某个 interval 的句柄已经丢了（清不掉），它在下一拍也会因号不匹配自杀
  //   ② 句柄判断用 != null：setInterval 的返回值理论上可以是 0，`if (id)` 会把 0 当没句柄而漏清
  stopEnterTimer() {
    this._enterGen = (this._enterGen || 0) + 1
    if (this._enterTimer != null) {
      clearInterval(this._enterTimer)
      this._enterTimer = null
    }
    if (enterTimer != null) {
      clearInterval(enterTimer)
      enterTimer = null
    }
  },
  // 判断是否可入店
  //   forceRefresh=true 时跳过 getEnterInfo 的 3 秒缓存（入店/离店后必须拿真实状态）
  async checkAccess(forceRefresh) {
    // ⚠️ 必须先用 getEnterInfo 拿到真实的 businessStatus 再判断，
    //    否则这里会读到初始值 true/false，把「营业中」误判成「已打烊」。
    //    getEnterInfo 内部已 catch，不会因失败中断本函数。
    await this.getEnterInfo(forceRefresh);

    return cloudFcn.ifNight().then(res => {
      if (!res.result.success) return Promise.reject(res)

      let businessStatus = this.data.woStatus.businessStatus    // 店铺是否营业
      // ifNight：是否夜场；hasCard：是否持任意夜间入店凭证（含桌游夜场票）；
      // hasArcadePass：是否持「夜场票（预约包夜）」或早八票 —— 只有这两个能打夜场音游
      let {ifNight, hasCard, hasArcadePass} = res.result.data

      if (!businessStatus) {
        this.setData({
          woClosed: true,
          woClosedText: '本店已打烊'
        })
      }
      else if (ifNight && !hasCard) {
        this.setData({
          woClosed: true,
          woClosedText: '夜场请预约'
        })
      }
      else {
        this.setData({
          woClosed: false
        })
      }

      // 夜场音游区锁：能进店但只有桌游夜场票的，音游区不给进（桌游区照常）
      this.setData({
        nightArcadeLock: !!(ifNight && hasCard && !hasArcadePass)
      })
    }).catch(err => {
      console.error(err)
    })
  },

  // 获取公告等信息
  async getNotice(forceRefresh) {
    // 公告/FAQ/联系方式属于低频变更数据，首次加载后缓存，避免每次 onShow 重复请求
    if (!forceRefresh && this._noticeCache) {
      this.setData({
        broadcast: this._noticeCache.broadcast,
        contact: this._noticeCache.contact,
        faq: this._noticeCache.faq,
      });
      return Promise.resolve();
    }
    return cloudFcn.getNotice().then(res => {
      if (!res.result.success) return Promise.reject(res)

      let { broadcast, faq, contact } = res.result.data

      faqFilter(faq)

      this._noticeCache = { broadcast, contact, faq };

      this.setData({
        broadcast,
        contact,
        faq
      })
    }).catch(console.error)
  },

  /* ============================================================
   * 【二】入店 / 离店 / 开门
   *   enterArcade / loadDeviceGroups —— 入店 + 设备选择弹层
   *   toggleDeviceGroup / pickDevice / selectDevice / onPickerConfirm —— 弹层交互
   *   doEnterArcade —— 确认入店
   *   leaveArcade / openDoor —— 离店 / 开门
   * ============================================================ */

  // 用户进店：点「入店」后弹出设备选择弹层，选中的设备即入店并**直接进入该机台队列**。
  //   舞萌·官机 / 舞萌·MML / 舞萌·ADX —— 三个各自独立的队列
  //                                       （只有官机 max_player >= 2，才显示「拼机/单刷」）
  //   中二节奏                        —— 独立队列
  //   桌游/日麻                       —— 不是机台、不排队，只把用户带进「桌游区」
  // 计费：音游区 12 点/小时、23 点后强制离店；桌游区 6 点/小时、23 点后不强制离店、继续计费。
  async enterArcade() {
    // 检查登录状态
    if (!this.data.isLoggedIn) {
      wx.showModal({
        title: '',
        content: '入店需要登录账号噢~',
        confirmText: '去登录',
        cancelText: '再看看',
        success: (res) => {
          if (res.confirm) {
            wx.navigateTo({
              url: '/pages/login/index',
            });
          }
        }
      });
      return;
    }

    // 每次打开都重新拉一次机台列表，避免机台增减后显示过期数据
    try {
      await this.loadDeviceGroups();
    } catch (e) {
      return;
    }
    this.setData({ showDevicePicker: true, expandedGroup: '', selectedDevice: null, selectedKey: '', selectedGroup: '', confirmText: '取消' });
  },

  // 拉取机台列表并构建弹层的两级结构
  async loadDeviceGroups() {
    return cloudFcn.getMachineInfo().then(res => {
      if (!res.result.success) return Promise.reject(res.result);
      const machines = res.result.data || [];
      const groups = buildDeviceGroups(machines);
      // 夜场音游区锁：只持桌游夜场票的人，音游区机台一律置灰（桌游区照常可选）。
      // 真正的拦截在云端 enterArcade，这里只是不让用户白点。
      if (this.data.nightArcadeLock) {
        groups.forEach((g) => {
          (g.children || []).forEach((c) => {
            if (c.area !== 'board') {
              c.is_disabled = true;
              c.disabledText = '夜场需预约包夜';
            }
          });
        });
      }
      this.setData({ deviceGroups: groups });

      // 逐台拉「游玩中 + 排队中」的人数：
      //   二级项（官机 / MML / ADX…）各自记一份 → 展开后显示在各自名称下方
      //   一级卡片（舞萌）显示该组所有机台的**合计**
      const tasks = [];
      groups.forEach((g) => {
        (g.children || []).forEach((c) => {
          tasks.push(
            cloudFcn.getQueueInfo(c.machineId).then(qres => {
              c.totalCount = (qres.result && qres.result.success)
                ? (qres.result.data || []).length
                : 0;
            }).catch(() => {
              c.totalCount = 0;
            })
          );
        });
      });
      return Promise.all(tasks).then(() => {
        // 一级卡片人数 = 组内所有机台人数之和（舞萌 = 官机 + MML + ADX）
        groups.forEach((g) => {
          g.totalCount = (g.children || []).reduce((n, c) => n + (c.totalCount || 0), 0);
        });
        this.setData({ deviceGroups: groups });
      });
    }).catch(err => {
      console.error('获取机台列表失败', err);
      wx.showToast({ title: '获取机台列表失败，请重试', icon: 'none' });
      return Promise.reject(err);
    });
  },
  
  // 关闭设备选择弹层（同时清掉选中态，下次打开是干净的）
  closeDevicePicker() {
    if (this.data.closing) return;   // 防重复
    this.setData({ closing: true });
    setTimeout(() => {
      this.setData({
        closing: false,
        showDevicePicker: false,
        expandedGroup: '',
        selectedDevice: null,
        selectedKey: '',
        selectedGroup: '',
        confirmText: '取消',
      });
    }, 260);
  },

  // 空函数：阻止弹层内部的点击冒泡到遮罩把弹层关掉
  noop() {},

  // 点击一级设备：有多个变体（如舞萌）就展开，只有一个就直接选中
  toggleDeviceGroup(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex);
    const group = this.data.deviceGroups[groupIndex];
    if (!group) return;
    const children = group.children || [];
    // 单子项：直接选中（selectDevice 里已设 selectedGroup）
    if (children.length <= 1) {
      const device = children[0];
      if (device && device.is_disabled) {
        wx.showToast({ title: device.disabledText || '机台不可用', icon: 'none' });
        return;
      }
      // 再点同一个 = 取消选中
      if (device && this.data.selectedKey === device.key) {
        this.setData({
          expandedGroup: '',
          selectedDevice: null,
          selectedKey: '',
          selectedGroup: '',
          confirmText: '取消',
        });
        return;
      }
      this.setData({ expandedGroup: '' });
      return this.selectDevice(groupIndex, 0);
    }
    // 多子项：展开 = 变绿；收起 = 取消绿（并清空该组选中的子项）
    const willExpand = this.data.expandedGroup !== group.groupId;
    if (!willExpand) {
      // 收起：清掉该组选中的子项
      const selectedChild = children.find(c => c.key === this.data.selectedKey);
      this.setData({
        selectedGroup: '',
        expandedGroup: '',
        selectedKey: selectedChild ? '' : this.data.selectedKey,
        selectedDevice: selectedChild ? null : this.data.selectedDevice,
        confirmText: selectedChild ? '取消' : this.data.confirmText,
      });
    } else {
      this.setData({
        selectedGroup: group.groupId,
        expandedGroup: group.groupId,
        selectedDevice: null,
        selectedKey: '',
        confirmText: '取消',
      });
    }
  },

  // 点击展开后的具体变体（官机 / MML / ADX）
  pickDevice(e) {
    const ds = e.currentTarget.dataset;
    const gi = Number(ds.groupIndex);
    const ci = Number(ds.childIndex) || 0;
    const group = this.data.deviceGroups[gi];
    const children = (group && group.children) || [];
    const device = children[ci] || children[0];
    if (!device) return;
  
    // 再点同一个 = 取消选中
    if (this.data.selectedKey === device.key) {
      this.setData({
        selectedDevice: null,
        selectedKey: '',
        confirmText: '取消',
      });
      return;
    }
    // 否则选中
    this.selectDevice(gi, ci);
  },

  /**
   * 选中具体设备 —— **只选中，不立即入店**。
   * 真正的入店/入队由弹层底部的确认按钮触发（onPickerConfirm），
   * 这样点错一下不会直接把人塞进队列（防误触）。
   */
  selectDevice(groupIndex, childIndex) {
    const group = this.data.deviceGroups[groupIndex];
    const children = (group && group.children) || [];
    const device = children[childIndex] || children[0];
    if (!device) {
      console.error('设备选择失败：分组数据异常', groupIndex, group);
      wx.showToast({ title: '设备数据异常，请重试', icon: 'none' });
      return;
    }
    // 不可用机台不能被选中
    if (device.is_disabled) {
      wx.showToast({ title: device.disabledText || '机台不可用', icon: 'none' });
      return;
    }
    if (this.data.isEntering) return;
    this.setData({
      selectedDevice: device,
      selectedKey: device.key || '',
      // 统一叫「入队」：所有设备（含日麻）都是入店后排到该机台的队里
      selectedGroup: group.groupId,
      confirmText: '入队',
    });
  },

  // 弹层底部按钮：未选中 = 取消（关闭弹层）；已选中 = 入队/入店（真正执行）
  onPickerConfirm() {
    const device = this.data.selectedDevice;
    if (!device) {
      if (this.data.expandedGroup) {
        wx.showToast({ title: '请先选择机台', icon: 'none' });
        return;
      }
      return this.closeDevicePicker();
    }
    if (this.data.closing) return;
    this.setData({ closing: true });
    setTimeout(() => {
      this.setData({
        closing: false,
        showDevicePicker: false,
        expandedGroup: '',
      });
      this.doEnterArcade(device);
    }, 260);
  },

  // 实际执行入店（音游设备紧接着直接进队列）
  async doEnterArcade(device) {
    const area = device.area === 'board' ? 'board' : 'arcade';
    const areaName = area === 'board' ? '桌游区' : '音游区';
    this.setData({ isEntering: true });
    try {
      const res = await cloudFcn.enterArcade(area);
      if (!res.result.success) throw res.result;
      // 入店成功：作废旧缓存，保证 finally 里的 onShow 拿到**这次**的 enter_time，
      // 而不是入店前缓存里的旧值（否则计时基准和实际入店时刻对不上）
      _enterInfoCache = null

      // 音游设备：入店后紧接着排进该机台的队尾
      //（Enqueue 内部会把 enter_state 从 1「休息中」置为 2「候机中」）
      // 桌游/日麻没有队列，入店即开始游玩
      if (device.machineId) {
        const q = await cloudFcn.enqueue(device.machineId, true);
        if (!q.result.success) {
          // 入店成功但排队失败（如余额不足）：此时已在店内休息，提示后可在排卡页手动排队
          wx.showToast({
            title: `已入店，但排队失败：${q.result.errMsg}`,
            icon: 'none',
            duration: 3000,
          });
          console.warn('入店成功但排队失败', q.result);
          return;
        }
        wx.showToast({
          title: `已入店，正在排「${device.deviceName}」`,
          icon: 'none',
          duration: 2500,
        });
        // 不自动跳转排卡页，用户可手动切 Tab 或留在首页
      } else {
        wx.showToast({ title: `已入店：${areaName}`, icon: 'none' });
      }
    } catch (err) {
      if (err && err.success === false) {
        wx.showModal({
          title: '入店失败',
          content: err.errMsg || '余额不足，请充值',
        });
      } else console.error(err);
    } finally {
      this.setData({ isEntering: false });
      // 刷新页面
      this.onShow();
    }
  },
  // 清空本地「在店」状态：停表 + 状态归零 + 作废 getEnterInfo 缓存。
  //   ⚠️ 凡是「云端已确认用户不在店内」的分支都必须调用它，不能只靠 finally 里的 onShow 兜底：
  //   getEnterInfo 有 3 秒缓存，一旦命中「离店前」的旧数据（enter_state>0 + 旧的 enter_time），
  //   applyEnterInfo 就会按旧基准把计时器重新起回来 —— 这就是「离店后两个时钟交替跳」的根因。
  _clearLocalEnterState() {
    _enterInfoCache = null
    this.stopEnterTimer()
    this.setData({
      ['woStatus.enterState']: 0,
      ['woStatus.enterTime.time']: 0,
      ['woStatus.enterTime.show']: '',
      consumptionAmount: 0,
    })
  },

  // 用户离店
  leaveArcade() {
    cloudFcn.leaveArcade().then(res => {
      if (!res.result.success) return Promise.reject(res.result)
      // 离店成功：云端已把 enter_state 置 0
      this._clearLocalEnterState()
      wx.showToast({
        title: '离店成功',
        icon: 'none'
      })
    }).catch(err => {
      if (err && err.success === false) {
        var title = '离店失败'
        if (err.errMsg && err.errMsg.includes('退队')) {
          title = '离店失败，请先退队'
        }
        else if (err.errMsg && err.errMsg.includes('余额')) {
          // 「余额不足」并不是离店失败：云函数在返回失败之前**已经**把 enter_state 置 0、
          // enter_time 清空、余额扣成负数（见 leaveArcade 末尾那段 if）。
          // 也就是人已经离店了，只是钱包欠费。本地必须同步归零，否则时钟会继续按旧基准走。
          title = '余额不足，自动离店'
          this._clearLocalEnterState()
        }
        else if (err.errMsg && err.errMsg.includes('未入店')) {
          // 云端认为用户本来就不在店里（例如已被定时任务清出），本地同样归零
          title = '已不在店内'
          this._clearLocalEnterState()
        }
        wx.showToast({
          title,
          icon: 'none'
        })
      }
      else console.error(err)
    }).finally(() => {
      // 刷新页面（缓存已在上面清空，这里必然拉真实数据）
      this.onShow()
    })

  },

  // FBI open the door!
  openDoor() {
    wx.showModal({
      title: '提示',
      content: '开门动作将被记录，请勿随意借用，违者后果自负'
    }).then(res => {
      if (res.cancel) { // 用户取消
        return
      }
      if (res.confirm) {
        return cloudFcn.openDoor().then(res => {
          wx.showToast({
            icon: 'none',
            title: '门已开，欢迎游玩~',
          })
        })
      }
    }).catch(err => {
      wx.showToast({
        icon: 'none',
        title: '开门失败',
      })
      console.error(err)
    })
  },

  // 查看预约：跳转到预约页（已从 tabBar 移除，改为普通页面，用 navigateTo）
  viewReserve() {
    wx.navigateTo({
      url: '/pages/reserve/index'
    })
  },

  // 查看入店须知：跳转到须知页
  viewNotice() {
    wx.navigateTo({
      url: '/pages/notice/index'
    })
  },

  // 查看预约记录：跳转到预约页（与用户中心预约记录相同）
  toReserveRecord() {
    wx.navigateTo({
      url: '/pages/reserve/index'
    })
  },

  /* ============================================================
   * 【三】FAQ 交互 / 页面加载
   *   extendFaq / copyContact —— FAQ 展开 / 复制联系方式
   *   loadPageData —— 页面数据聚合加载
   *   （在店计时器见上方 applyEnterInfo 旁的 startEnterTimer / stopEnterTimer）
   * ============================================================ */

  // 展开常见问题
  extendFaq(e) {
    let extendIndex = e.currentTarget.dataset.index
    // 点击哪个问题，将对应问题的showFaq设置为true
    let showFaq = Array.from(
      this.data.faq,
      (value, index) => {
        // 已经展开的问题再次点击会收起
        return !this.data.showFaq[index] && extendIndex == index ? true : false
      }
    )
    this.setData({
      showFaq
    })
  },

  // 复制QQ号
  copyContact: function(e) {
    const textToCopy = e.currentTarget.dataset.text;
    if (textToCopy) {
      wx.setClipboardData({
        data: textToCopy,
        success: (res) => {
          wx.showToast({
            title: '已复制到剪贴板',
            icon: 'success',
            duration: 1500
          });
        },
        fail:(err) =>{
          wx.showToast({
            title: '复制失败',
            icon: 'none'
          });
          console.error('复制失败：', err);
        }
      });
    }
  },

  // 页面初始化
  async loadPageData() {
    this.setData({ isLoadingPage: true });
    try {
      // checkAccess 内部会先 getEnterInfo（拉店内状态），与 getNotice 并行；
      // 避免把 getEnterInfo 再并列一次造成重复请求 + 竞态
      await Promise.all([
        this.checkAccess(),
        this.getNotice(),
      ]);
      this.setData({ isEnterBtnDisabled: true });
    } catch (error) {
      console.error("Home: 加载页面数据时出错：", error);
      wx.showToast({
        title: '加载页面数据失败',
        icon: 'none'
      });
    } finally {
      this.setData({isLoadingPage: false, isEnterBtnDisabled: false });
    }
  },

  /* ============================================================
   * 【四】页面生命周期
   *   onLoad / onShow / onHide / onUnload / onPullDownRefresh
   *   onReachBottom / onShareAppMessage
   * ============================================================ */

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: async function() {
      app.ensureLoggedIn().then(userInfo => {
        if (userInfo && !userInfo.isNewUser) {
          this.setData({ userInfo: userInfo, isLoggedIn: true });
          this.loadPageData();
        } else {
          this.setData({
            userInfo: null,
            isLoggedIn: false,
          });
          // 未登录状态下不该有「在店时钟」：统一走收口方法（停表 + 归零 + 作废缓存）
          this._clearLocalEnterState();
          this.loadPageData();
        } 
      }).catch(err => {
        console.error("Home onShow: 登录检查时发生异常", err);
        this.setData({ userInfo: null, isLoggedIn: false, isLoadingPage: false });
        this.loadPageData();
      });
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {
    this.stopEnterTimer()
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {
    // 页面销毁时必须停表：定时器句柄挂在模块级变量 enterTimer 上，
    // 页面没了它还会每秒 setData 一次（控制台报「setData 不能在页面已销毁时调用」），
    // 下一次进入首页又会新起一个，句柄互相覆盖 → 旧的那个再也停不掉。
    this.stopEnterTimer()
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