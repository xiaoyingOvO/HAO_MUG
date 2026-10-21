/**
 * baseFunctions
 */
// 获取用户信息
const getUsrInfo = async function() {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'getUsrInfo'
    }
  })
}

// 根据昵称查找用户
const getUsrInfoByName = async function(nickname) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'getUsrInfoByName',
      params: {
        nickname
      }
    }
  })
}

// 获取公告信息
const getNotice = async function() {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'getNotice'
    }
  })
}

/**
 * queueFunctions
 */
// 停业/开业
const modifyBusinessStatus = async function(business_status) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'modifyBusinessStatus',
      params: {
        business_status
      }
    }
  })
}

// 修改用户信息（设置展示称号等）
const modifyUsrInfo = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'modifyUsrInfo',
      params
    }
  })
}

// 获取所有机器信息
const getMachineInfo = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'getMachineInfo'
    }
  })
}
// 获取某机器排队信息
const getQueueInfo = async function(id) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'getQueueInfo',
      params: {
        machine_id: id,
      }
    }
  })
}

// 获取用户入店信息
const getEnterInfo = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'getEnterInfo'
    }
  })
}

// 用户入店
// area: 'arcade' 音游区（默认，12 点/小时）/ 'board' 桌游区（6 点/小时）
const enterArcade = async function(area) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'enterArcade',
      params: {
        area: area || 'arcade'
      }
    }
  })
}
// 用户离店
const leaveArcade = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'leaveArcade'
    }
  })
}

// 开门！
const openDoor = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'openDoor'
    }
  })
}

// 用户余额判断
const checkAndChargeBalance = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'checkAndChargeBalance'
    }
  })
}

// 获取消费点数
const getConsumePoint = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'getConsumePoint'
    }
  })
}

// 判断夜场
const ifNight = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'ifNight'
    }
  })
}

// 切换是否拼机
const switchMulti = async function(openid, machineId, multi) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'switchMulti',
      params: {
        openid,
        machine_id: machineId,
        is_multi: multi,
      }
    }
  })
}

// 用户进入排队
const enqueue = async function(id, multi) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'Enqueue',
      params: {
        machine_id: id,
        is_multi: multi,
      }
    }
  })
}
// 用户退出排队
const dequeue = async function(id) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'Dequeue',
      params: {
        machine_id: id,
      }
    }
  })
}

// 用户上机
const embark = async function(id, multi, playPosition) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'Embark',
      params: {
        machine_id: id,
        is_multi: multi,
        play_position: playPosition
      }
    }
  })
}

// 用户下机
const deplain = async function(id) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'Deplain',
      params: {
        machine_id: id,
      }
    }
  })
}
// 用户和拼机用户一起下机
const deplainAll = async function(id) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'DeplainAll',
      params: {
        machine_id: id,
      }
    }
  })
}

// 踢出、举报、移动前置准备
const checkUpdate = async function(id, openid) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'checkUpdate',
      params: {
        machine_id: id,
        openid
      }
    }
  })
}

// 踢出某用户
const kickOut = async function(machineId, openid, nickname) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'kickOut',
      params: {
        machine_id: machineId,
        openid,
        nickname
      }
    }
  })
}

// 举报某用户
const report = async function(id, content) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'Report',
      params: {
        to_openid: id,
        content
      }
    }
  })
}

// 获取举报信息（管理员）
const getReport = async function() {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'getReport',
      params: {

      }
    }
  })
}

// 排队用户的队列位置移动
const delay = async function(id, toOpenid, fromOpenid) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'Delay',
      params: {
        machine_id: id,
        to_openid: toOpenid,
        from_openid: fromOpenid
      }
    }
  })
}

const queueLog = async function(id) {
  return wx.cloud.callFunction({
    name: 'queueFunctions',
    data: {
      type: 'queueLog',
      params: {
        machine_id: id
      }
    }
  })
}

/**
 * 麻将对局战绩（baseFunctions / mahjongStats）
 */
// 录入一局对局（仅管理员）
const mahjongAddGame = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongAddGame',
      params
    }
  })
}

// 我的战绩聚合
const mahjongGetMyStats = async function() {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongGetMyStats'
    }
  })
}

// 排行榜
const mahjongGetRanking = async function() {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongGetRanking'
    }
  })
}

// 全部对局（分页）
const mahjongGetGames = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongGetGames',
      params
    }
  })
}

// 管理员发称号
const mahjongGrantTitle = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongGrantTitle',
      params
    }
  })
}

// 管理员撤销/减少称号次数
const mahjongRevokeTitle = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongRevokeTitle',
      params
    }
  })
}

// 管理员查询某玩家称号列表
const mahjongGetPlayerTitles = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongGetPlayerTitles',
      params
    }
  })
}

// 管理员删除对局记录
const mahjongDeleteGame = async function(params) {
  return wx.cloud.callFunction({
    name: 'baseFunctions',
    data: {
      type: 'mahjongDeleteGame',
      params
    }
  })
}

export default {
  modifyBusinessStatus,
  modifyUsrInfo,
  getUsrInfo,
  getUsrInfoByName,
  getEnterInfo,
  getNotice,
  enterArcade,
  leaveArcade,
  openDoor,
  checkAndChargeBalance,
  getConsumePoint,
  ifNight,
  getMachineInfo,
  getQueueInfo,
  switchMulti,
  enqueue,
  dequeue,
  embark,
  deplain,
  deplainAll,
  checkUpdate,
  kickOut,
  report,
  getReport,
  delay,
  queueLog,
  mahjongAddGame,
  mahjongGetMyStats,
  mahjongGetRanking,
  mahjongGetGames,
  mahjongGrantTitle,
  mahjongRevokeTitle,
  mahjongGetPlayerTitles,
  mahjongDeleteGame
}