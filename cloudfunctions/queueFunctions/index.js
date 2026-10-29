const getEnterInfo = require("./getEnterInfo/index")
const getAllEnterInfo = require("./getAllEnterInfo/index")
const getQueueInfo = require("./getQueueInfo/index")
const Enqueue = require("./Enqueue/index")
const Dequeue = require("./Dequeue/index")
const Embark = require("./Embark/index")
const DeplainAll = require("./DeplainAll/index")
const Deplain = require("./Deplain/index")
const ForceDeplain = require("./ForceDeplain/index")
const enterArcade = require("./enterArcade/index")
const leaveArcade = require("./leaveArcade/index")
const leaveArcadeForce = require("./leaveArcadeForce/index")
const getArcadeInfo = require("./getArcadeInfo")
const getCurrentInStoreInfo = require("./getCurrentInStoreInfo")
const checkAndChargeBalance = require("./checkAndChargeBalance/index")
const getMachineInfo = require("./getMachineInfo/index")
const getConsumePoint = require("./getConsumePoint/index")
const ifNight = require("./ifNight/index")
const delay = require("./delay/index")
const checkUpdate = require("./checkUpdate/index")
const Report = require("./Report/index")
const queueLog = require("./queueLog/index")
const openDoor = require("./openDoor/index")
const getDoorInfo = require("./getDoorInfo/index")
const switchMulti = require("./switchMulti/index")
const kickOut = require("./kickOut/index")
const getReport = require("./getReport/index")
const dealReport = require("./dealReport/index")
const modifyBusinessStatus = require("./modifyBusinessStatus/index")
const fixQueueChains = require("./fixQueueChains/index")

exports.main = async (event, context, callback) => {
  // 定时预热触发（config.json 里的 keepWarm，每 5 分钟一次）：
  //   只为了让这个云函数的实例保持温热，不做任何业务逻辑。
  //   没有它的话，审核员/用户第一次打开排卡页会撞上 1~3 秒的冷启动，
  //   而排卡页首屏是两次串行调用，冷启动会被放大到 3~6 秒。
  if (event && (event.Type === 'Timer' || event.Type === 'timer')) {
    return { success: true, warmup: true, ts: Date.now() }
  }
  switch (event.type) {
    case "getEnterInfo":
      return await getEnterInfo.main(event,context)
    case "getAllEnterInfo":
      return await getAllEnterInfo.main(event,context)
    case "getQueueInfo":
      return await getQueueInfo.main(event,context)
    case "Enqueue":
      return await Enqueue.main(event,context)  
    case "Dequeue":
      return await Dequeue.main(event,context)
    case "Embark":
      return await Embark.main(event,context)
    case "DeplainAll":
      return await DeplainAll.main(event,context)
    case "Deplain":
      return await Deplain.main(event,context)
    case "ForceDeplain":
      return await ForceDeplain.main(event,context)
    case "enterArcade":
      return await enterArcade.main(event,context)
    case "leaveArcade":
      return await leaveArcade.main(event,context)
    case "leaveArcadeForce":
      return await leaveArcadeForce.main(event,context)
    case "getArcadeInfo":
      return await getArcadeInfo.main(event,context)
    case "getCurrentInStoreInfo":
      return await getCurrentInStoreInfo.main(event,context)
    case "checkAndChargeBalance":
      return await checkAndChargeBalance.main(event,context)
    case "getMachineInfo":
      return await getMachineInfo.main(event,context)
    case "getConsumePoint":
      return await getConsumePoint.main(event,context)
    case "ifNight":
      return await ifNight.main(event,context)
    case "Delay":
      return await delay.main(event,context)
    case "checkUpdate":
      return await checkUpdate.main(event,context)
    case "Report":
      return await Report.main(event,context)
    case "queueLog":
      return await queueLog.main(event,context) 
    case "openDoor":
      return await openDoor.main(event, context)
    case "getDoorInfo":
      return await getDoorInfo.main(event, context)
    case "switchMulti":
      return await switchMulti.main(event, context)
    case "kickOut":
      return await kickOut.main(event, context)
    case "getReport":
      return await getReport.main(event, context)  
    case "dealReport":
      return await dealReport.main(event, context)  
    case "modifyBusinessStatus":
      return await modifyBusinessStatus.main(event, context)
    case "fixQueueChains":
      return await fixQueueChains.main(event, context)
  }
};
