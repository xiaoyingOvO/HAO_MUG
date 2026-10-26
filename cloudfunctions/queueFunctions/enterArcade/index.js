const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
const db_card = "card"
const db_arcade_log = "arcade_log"

const { durationHour, nowBJMinutes } = require('../timeUtil');

// 区域：音游区（老版计费）/ 桌游区（一把时间可能很长，23 点不强制离店）
const AREA_ARCADE = 'arcade'   // 音游区：0.2 点/分 = 12 点/小时
const AREA_BOARD = 'board'     // 桌游区：0.1 点/分 =  6 点/小时

// 夜场音游区通行证（与 queueFunctions/ifNight 的常量保持一致）
//   注意：「桌游麻将票·夜场」(df40db4d6ad4af26010239057dae6a3c) 不在白名单内 —— 它只覆盖桌游区。
const NIGHT_CARD_ID = 'e33be08d678e255a0189586d3b0d8a79';       // 夜场畅玩卡（预约包夜）
const MORNING_CARD_ID = 'ab52283f6783807201221ba02db6611e';      // 早八畅玩套餐（08:00-10:00）

// 入店云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
  // 入店区域：不传或传非法值时按音游区处理（兼容老版本调用）
  const params = ('params' in event) ? (event.params || {}) : {};
  const area = params.area === AREA_BOARD ? AREA_BOARD : AREA_ARCADE;
  console.log('入店区域:', area)
  // 用户状态判断
  let user_record = await db.collection(db_user)
  .where({
    openid: openid
  })
  .field({
    openid: true,
    real_point: true,
    extra_point: true,
    enter_state: true,
    machine_id: true,
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  if (user_record.data[0].enter_state != 0){
    return {
      success: false,
      errMsg: "用户已入店，请刷新重试",
    }
  }
  // 余额判断
  let cur_openID = openid
  let user_remain_record = await db.collection(db_user).where({
    openid: cur_openID
  }).get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  let credit = user_remain_record.data[0].credit
  let remain_total = user_remain_record.data[0].real_point + user_remain_record.data[0].extra_point
  let exp = user_remain_record.data[0].exp
  // 用户此刻是否持有「当前时段免单」的优惠卡（区域敏感，见 hasFreeTimeCard 说明）
  let freeCard = await hasFreeTimeCard(user_remain_record.data[0].cards, new Date(), area)
  console.log('是否持有当前时段免单卡:', freeCard)
  // 余额不足
  // 修复：原逻辑只看了余额和等级，没考虑优惠卡。持有「当前时段免单」的卡时入店不产生扣费，
  //       此时余额为 0 也应允许入店（否则买了畅玩套餐却进不了店）。
  //       折扣卡（discount != 0）仍会扣费，不在此列；负数余额一律拒绝（异常数据）。
  if (remain_total < 0 || (remain_total == 0 && exp < 114514 && !freeCard)) {
    return {
      success: false,
      errMsg: "余额不足",
    }
  }
  if (credit < 60){
    return {
      success: false,
      errMsg: "您的信用太差了，本店拒绝您访问",
    }
  }
  // 夜场音游区只对「预约包夜」开放。
  //   夜间（23:00-次日09:59）能进音游区的只有：夜场畅玩卡（预约包夜）、早八畅玩套餐（08:00-10:00）。
  //   桌游麻将票·夜场虽然能让用户夜间进店，但只覆盖桌游区 —— 拿它进音游区要拦下来。
  //   白天（10:00-22:59）不做此限制：持桌游日场票可以进音游区，按音游区费率正常计费。
  if (area === AREA_ARCADE) {
    const arcadePass = await hasNightArcadePass(user_remain_record.data[0].cards, new Date())
    console.log('夜场音游区通行证:', arcadePass)
    if (!arcadePass) {
      return {
        success: false,
        errMsg: "夜场音游区仅限预约包夜（或早八票），请先预约",
      }
    }
  }
  // 余额充足
  const time = new Date()

  // 入店状态：两个区统一为 1（休息中）。
  //   前端紧接着调 Enqueue 排选中的机台，Enqueue 内部会把它改成 2（候机中），上机后再变 3。
  //   桌游区也一样 —— 日麻（M05）是机台，一桌 4 人，同样要排队。
  const enter_state = 1

  await db.collection(db_user)
  .where({
    openid: openid,
  })
  .update({
    data: {
      enter_state: enter_state,
      enter_time: new Date(),
      machine_id: "",
      area: area
    }
  })
  .then(res => {
    updated = res.stats.updated;
    console.log(res);
  })

  await db.collection(db_arcade_log).add({
    data: {
      openid: openid,
      time: time,
      remain_point: remain_total,
      exp: exp,
      op: 0,
      area: area
    }
  })
  .then(res => {
    console.log(res);
  })

  return {
    success: true,
    errMsg: "入店成功",
    data: { area: area },
  }
}

/**
 * 判断用户此刻是否持有「当前时段免单」的优惠卡（区域敏感）。
 *
 * 与 getConsumePoint 的免单逻辑严格对齐（读同一份数据、用同一套时段口径）：
 *   · discount == 0 的卡 = 「免费时段卡」：getConsumePoint 会把卡覆盖时段内的游玩时长
 *     从计费时长中剔除，也就是这段时间内不扣点数。
 *     discount != 0 的卡 = 折扣卡（如 5 折高级会员卡），仍然会扣费，不计入免单。
 *   · 持有有效期：user.cards[i].start_time ~ end_time（与 getConsumePoint 一致）
 *   · 免单时段：card.duration.start_time / end_time 的北京时间小时
 *   · 区域限制：card.area === 'board' 仅限桌游区，'arcade' 仅限音游区，
 *              缺省/null/undefined 则两区通用
 *
 * @param {Array} userCards   用户的 cards 字段，形如 [{card_id, start_time, end_time}]
 * @param {Date}  currentTime 当前时间
 * @param {string} userArea   用户当前区域：'arcade' 或 'board'
 * @returns {Promise<boolean>} true = 此刻游玩不产生扣费
 */
async function hasFreeTimeCard(userCards, currentTime, userArea) {
  const cards = userCards ?? []
  if (!Array.isArray(cards) || cards.length == 0) return false

  const now = currentTime.getTime()
  for (let i = 0; i < cards.length; i++) {
    const hold = cards[i]
    if (!hold || !hold.card_id) continue

    // 只处理仍在持有有效期内的卡
    const start = new Date(hold.start_time).getTime()
    const end = new Date(hold.end_time).getTime()
    if (!(start <= now && now <= end)) continue

    let card_info = null
    try {
      card_info = await db.collection(db_card).where({ _id: hold.card_id }).get()
    } catch (e) {
      console.error('查询优惠卡失败：', hold.card_id, e)
      continue
    }
    if (!card_info.data || card_info.data.length == 0) continue

    const card = card_info.data[0]
    // 折扣卡仍会扣费，不算免单
    if (Number(card.discount) != 0) continue

    // 区域限制：card.area 存在且不等于用户当前区域 → 该卡不适用
    const cardArea = card.area
    if (cardArea && cardArea !== userArea) {
      console.log(`卡 ${card._id} 仅限 ${cardArea} 区，用户当前 ${userArea}，跳过`)
      continue
    }

    const duration = card.duration
    if (!duration) continue

    // 免单时段：统一用公共工具解析成「北京时间小时」（兼容字符串/Date/$date/数字），
    // 与 getConsumePoint 的口径严格一致，避免 new Date("23:00").getHours() 得到 NaN。
    // 用 durationHour 做「按可解析性回落」：真实数据是 { start_time: null, start_hour: 8 }，
    // 写成 `start_time !== undefined ? ...` 会把 null 当成有值，start_hour 永远读不到。
    const startHour = durationHour(duration, 'start')
    const endHour = durationHour(duration, 'end')
    if (startHour === null || endHour === null) continue

    // 当前北京时间小时（云函数跑 UTC，需 +8）
    const curHour = Math.floor(nowBJMinutes(currentTime) / 60)
    // 跨天时段（如夜场 23:00 - 次日 10:00）表现为 startHour > endHour
    const inRange = startHour < endHour
      ? (curHour >= startHour && curHour < endHour)
      : (curHour >= startHour || curHour < endHour)

    if (inRange) return true
  }
  return false
}

/**
 * 判断用户此刻能否进入「音游区」，只针对夜场时段做限制。
 *
 * 规则（来自店主）：
 *   · 夜场（北京时间 23:00 ~ 次日 09:59）音游区是包夜预约场，只有
 *       ① 夜场畅玩卡（预约包夜，NIGHT_CARD_ID）
 *       ② 早八畅玩套餐（08:00-10:00，MORNING_CARD_ID）
 *     可以打。「桌游麻将票·夜场」只覆盖桌游区，拿它进音游区要被拦。
 *   · 白天（10:00 ~ 22:59）不限制：持桌游日场票可以正常进音游区，按音游区费率计费。
 *
 * @param {Array} userCards   用户 cards 字段，形如 [{card_id, start_time, end_time}]
 * @param {Date}  currentTime 当前时间
 * @returns {boolean} true = 允许进音游区
 */
function hasNightArcadePass(userCards, currentTime) {
  const now = currentTime.getTime()
  const curHour = Math.floor(nowBJMinutes(currentTime) / 60)
  const isNight = curHour >= 23 || curHour < 10
  // 白天不限区域，直接放行
  if (!isNight) return true

  const cards = userCards ?? []
  if (!Array.isArray(cards) || cards.length == 0) return false

  // 早八票只在 08:00-09:59 这个窗口内算作音游通行证
  const isMorning = curHour >= 8 && curHour < 10

  for (let i = 0; i < cards.length; i++) {
    const hold = cards[i]
    if (!hold || !hold.card_id) continue
    const start = new Date(hold.start_time).getTime()
    const end = new Date(hold.end_time).getTime()
    if (!(start <= now && now <= end)) continue

    if (hold.card_id === NIGHT_CARD_ID) return true
    if (hold.card_id === MORNING_CARD_ID && isMorning) return true
  }
  return false
}