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

// 入店设备选择弹层：一级分组对应的配图
//   maimai / chunithm 来自云端 machine 集合的 group_id
//   board 是前端虚拟项（桌游·日麻不是机台，不排队，只负责把用户带进桌游区）
// ⚠️ 这三张图已压缩到 360px 宽（小程序主包上限 2MB，原图 613KB 会把包撑爆）。
//    弹层里只显示 128rpx 的缩略图，360px 足够；换高清图时记得重新压缩。
const GROUP_ICONS = {
  maimai: '/images/machines/maimai.jpg',
  chunithm: '/images/machines/chunithm.jpg',
  board: '/images/machines/mahjong.jpg',
};
/**
 * 桌游/日麻的兜底项：只有云端 machine 集合里**没有** area='board' 的机台（日麻 M05）时才用。
 * 内容与真机台保持一致（machineId 也指向 M05，4 人一桌），这样无论云端有没有数据，
 * 桌游/日麻走的都是同一条「入队」流程 —— 文案和行为统一。
 * ⚠️ 必须带 children：弹层的点击统一走 toggleDeviceGroup / selectDevice，
 *    少了这个数组会读 undefined.length 抛 TypeError，框架静默吞掉 → 表现就是「点了没反应」。
 */
const BOARD_DEVICE = {
  groupId: 'board',
  groupName: '桌游/日麻',
  icon: GROUP_ICONS.board,
  desc: '4 人一桌 · 独立排队',
  actionText: '入队',
  children: [{
    key: 'board',
    machineId: 'M05',
    label: '日麻',
    deviceName: '日麻',
    area: 'board',
    maxPlayer: 4,
  }],
};

/**
 * 把云端 machine 列表整理成入店弹层需要的两级结构。
 * 同 group_id 的机台合并成一张卡（如舞萌 → 官机 / MML / ADX 三个独立队列）；
 * 缺少 group_id 时退化成「一台机一张卡」，不会报错。
 * 最后追加虚拟的「桌游/日麻」项。
 */
function buildDeviceGroups(machines) {
  const groups = [];
  const byGroup = new Map();
  Array.from(machines || []).forEach((m) => {
    // max_player 为 0 / -1 表示机台不可用，不进选择列表
    if (m.max_player === 0 || m.max_player === -1) return;
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
    byGroup.get(gid).children.push({
      key: m._id,
      machineId: m._id,
      label: m.label || m.machine_name,
      deviceName: m.machine_name,
      // 机台自带 area（日麻 = 'board'），缺省按音游区；决定入店时进哪个区
      area: m.area === 'board' ? 'board' : 'arcade',
      maxPlayer: m.max_player,
    });
  });
  groups.forEach((g) => {
    const only = g.children[0];
    g.desc = g.children.length > 1
      ? `${g.children.length} 台独立排队`
      : (only.area === 'board'
        ? `${only.maxPlayer} 人一桌 · 独立排队`
        : (only.maxPlayer >= 2 ? '可拼机 / 单刷 · 独立排队' : '独立排队'));
    g.actionText = '入队';
  });
  // 云端 machine 集合还没有日麻（area='board'）时，退化成不可排队的「桌游/日麻」虚拟项，
  // 保证桌游区仍然可以入店。有了真机台就用真机台。
  if (!byGroup.has('board')) {
    groups.push({
      ...BOARD_DEVICE,
      children: BOARD_DEVICE.children.map((c) => ({ ...c })),
    });
  }
  return groups;
}

// 一定分钟一次的余额检查
function checkBalance(nowTime, enterTime, timeout) {
  let count = Math.ceil((nowTime - enterTime) / 1000 / 60 / timeout)  // timeout min查询一次
  // console.log(count)
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
 * 入店时间显示：改为**时间戳**（YYYY-MM-DD HH:mm:ss），不再做每秒正计时。
 * 时间戳只在 getEnterInfo 拉到入店时间时算一次，不必每秒重算。
 */
function formatTimestamp(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 余额恢复后清掉红字，并允许下次再透支时重新提醒一次
function clearOverdraft(page) {
  if (!page.data.overdraft && !page.data.overdraftNotified) return;
  page.setData({ overdraft: false, overdraftShortage: 0, overdraftNotified: false });
}

function checkAndChargeBalance() {
  cloudFcn.checkAndChargeBalance().then(res => {
    if (!res.result.success) return Promise.reject(res.result)
    console.log('轮询检查用户余额充足')
    clearOverdraft(this)
  }).catch(err => {
    if (err.code === undefined) return console.error(err)
    if (err.code == -2) {
      // 余额已透支：只提醒，不弹 modal、不踢出队列
      notifyOverdraft(this, err.data && err.data.shortage)
      console.log('轮询检查用户余额不足（仅提醒，不退队）', err)
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
      console.log(`轮询检查已消费点数: ${points}, 剩余点数${remainPoint}`)
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
      else if (err.code == -3) {
        
      }
    })
    checkConsumePointCount = count
  }
}

// 处理faq中的文字和图片
function faqFilter(faq) {
  faq.forEach((value) => {
    // console.log(1, v.a)
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
      businessStatus: false,   // 正在营业
      relaxNum: 0,
      playNum: 0,
      enterState: 0, // 用户是否已入店 0：未入店  1：休息中  2：候机中  3：游玩中
      // 入店区域：'arcade' 音游区（12 点/小时）/ 'board' 桌游区（6 点/小时）
      area: 'arcade',
      areaName: '音游区',
      arcadeNum: 0, // 音游区在店人数
      boardNum: 0,  // 桌游区在店人数
      enterTime: {  // 入店时间，以时间戳形式表示（毫秒）
        time: 0,
        show: ''  // 计算所得在店内的时间
      },
    },
    woClosed: false,  // 无法入店
    woClosedText: '', // 停止入店的按钮文字
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

  // 查询店内状态
  async getEnterInfo() {
    return cloudFcn.getEnterInfo().then(res => {
      if (!res.result.success) return Promise.reject(res)
      
      var data = res.result.data
      console.log('获取用户入店信息：', data)
      remainPoint = (data.real_point ?? 0) + (data.extra_point ?? 0)
      var businessStatus = data.business_status ?? true
      var relaxNum = data.relax_num ?? 0, playNum = data.play_num ?? 0
      var enterState = data.enter_state ?? 0
      // 入店区域：老数据没有 area 字段时按音游区处理
      var area = data.area === 'board' ? 'board' : 'arcade'
      var time = new Date(data.enter_time).getTime()
      this.setData({
        ['woStatus.businessStatus']: businessStatus,
        ['woStatus.enterState']: enterState,
        ['woStatus.relaxNum']: relaxNum,
        ['woStatus.playNum']: playNum,
        ['woStatus.arcadeNum']: data.arcade_num ?? 0,
        ['woStatus.boardNum']: data.board_num ?? 0,
        ['woStatus.area']: area,
        ['woStatus.areaName']: area === 'board' ? '桌游区' : '音游区',
        ['woStatus.enterTime.time']: time,
        ['woStatus.enterTime.show']: formatTimestamp(time) // 入店时间戳（不再每秒正计时）
      })
      this.setEnterTimer()
    }).catch(console.error)
  },
  // 判断是否可入店
  async checkAccess() {
    return cloudFcn.ifNight().then(res => {
      if (!res.result.success) return Promise.reject(res)

      let businessStatus = this.data.woStatus.businessStatus    // 店铺是否营业
      let {ifNight, hasCard} = res.result.data  //是否夜场以及是否持有夜场卡

      console.log(`店铺${businessStatus ? '正常营业' : '已打烊'}。\n当前${ifNight ? '为' : '非'}夜场，用户${hasCard ? '' : '未'}持有夜场卡。`)
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
    }).catch(err => {
      if (err.success === false) console.log(err)
      else console.error(err)
    })
  },

  // 获取公告等信息
  async getNotice() {
    return cloudFcn.getNotice().then(res => {
      if (!res.result.success) return Promise.reject(res)

      let { broadcast, faq, contact } = res.result.data

      faqFilter(faq)

      this.setData({
        broadcast,
        contact,
        faq
      })
      console.log('获取到最新公告: ', res.result.data)
    }).catch(console.error)
  },

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
          } else if (res.cancel) {
            console.log('用户取消前往登录');
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
      this.setData({ deviceGroups: groups });

      // 拉每个机台的"总人数"
      const tasks = [];
      groups.forEach((g) => {
        (g.children || []).forEach((c) => {
          tasks.push(
            cloudFcn.getQueueInfo(c.machineId).then(qres => {
              if (qres.result && qres.result.success) {
                c.totalCount = (qres.result.data || []).length;   // 游玩中 + 排队中
              } else {
                c.totalCount = 0;
              }
            }).catch(() => {
              c.totalCount = 0;
            })
          );
        });
      });
      return Promise.all(tasks).then(() => {
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

  // 点击卡片本体：选中该一级分组（卡片本体变绿）
  selectGroup(e) {
    const gi = Number(e.currentTarget.dataset.groupIndex);
    const group = this.data.deviceGroups[gi];
    if (!group) return;
    // 点已选中的组则取消（可选，看你要不要）
    // const selectedGroup = this.data.selectedGroup === group.groupId ? '' : group.groupId;
    this.setData({
      selectedGroup: group.groupId,
    });
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
        console.log('用户入店并进入队列', device.deviceName);
        setTimeout(() => wx.switchTab({ url: '/pages/queue-info/index' }), 800);
      } else {
        wx.showToast({ title: `已入店：${areaName}`, icon: 'none' });
        console.log('用户入店', areaName);
      }
    } catch (err) {
      if (err && err.success === false) {
        wx.showModal({
          title: '入店失败',
          content: err.errMsg || '余额不足，请充值',
        });
        console.log('用户入店失败', err);
      } else console.error(err);
    } finally {
      this.setData({ isEntering: false });
      // 刷新页面
      this.onShow();
    }
  },
  // 用户离店
  leaveArcade() {
    cloudFcn.leaveArcade().then(res => {
      if (!res.result.success) return Promise.reject(res.result)
      wx.showToast({
        title: '离店成功',
        icon: 'none'
      })
      console.log('用户离店')
    }).catch(err => {
      if (err.success === false) {
        var title = '离店失败'
        if (err.errMsg.includes('退队')) {
          title = '离店失败，请先退队'
        }
        else if (err.errMsg.includes('余额')) {
          title = '余额不足，自动离店'
        }
        wx.showToast({
          title,
          icon: 'none'
        })
        console.log('离店失败', err)
      }
      else console.error(err)
    }).finally(() => {
      // 刷新页面
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
          console.log(res)
          wx.showToast({
            icon: 'none',
            title: '门已开，欢迎游玩~',
          }),
          console.log('用户已打开门禁')
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

  //添加入店时间计时(查询余额也在这里)
  setEnterTimer() {
    clearInterval(enterTimer)
    let that = this
    enterTimer = setInterval((function i() {
      let enterState = that.data.woStatus.enterState
      // 未入店 || 未获取到信息
      if (enterState === 0 || !enterState) return i

      // 入店时间改为时间戳展示（getEnterInfo 里已算好），这里只负责轮询余额/消费
      let time = that.data.woStatus.enterTime.time
      let nowTime = new Date().getTime()

      checkBalance.call(that, nowTime, time, checkBalanceTimeout)

      checkConsumePoint.call(that, nowTime, time, checkConsumePointTimeout)

      return i
    })(), 1000)
  },
  // 计算入店时长（HH:mm:ss 正计时）
  // ⚠️ 已废弃：入店时间改为展示**时间戳**（见 formatTimestamp），这里不再被调用，保留备用。
  calcEnterTime(time, nowTime = new Date().getTime()) {
    let dec = parseInt((nowTime - time) / 1000)
    let HH = parseInt(dec / 3600) != 0 ? `${parseInt(dec / 3600)}:` : ''
    let mm = `${parseInt(dec % 3600 / 60)}:`.padStart(3, '0')
    let ss = `${parseInt(dec % 3600 % 60)}`.padStart(2, '0')
    let show = dec >= 0 ? HH + mm + ss : '00:00'
    return show
    
  },

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


  // 预览状态登录
  redirectToLogin() {
    wx.reLaunch({
        url: '/pages/login/index' 
      });
  },

  // 页面初始化
  async loadPageData() {
    this.setData({ isLoadingPage: true });
    try {
      await this.getEnterInfo();
      await Promise.all([
        this.checkAccess(),
        this.getNotice(),
      ]);
      this.setData({ isEnterBtnDisabled: true });
      console.log("Home: 页面数据加载完成。");
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

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
      console.log("Home page onLoad");
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: async function() {
      console.log("Home page onShow");
      app.ensureLoggedIn().then(userInfo => {
        console.log("Home onShow: 登录状态检查完成, userInfo:", userInfo);
        if (userInfo && !userInfo.isNewUser) {
          console.log("Home onShow: 用户已登录");
          this.setData({ userInfo: userInfo, isLoggedIn: true });
          this.loadPageData();
        } else {
          console.log("Home onShow: 用户未登录");
          this.setData({
            userInfo: null,
            isLoggedIn: false,
            ['woStatus.enterState']: 0,
            ['woStatus.enterTime.show']: '',
            consumptionAmount: 0,
          });
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