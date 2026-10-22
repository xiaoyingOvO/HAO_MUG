const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
const db_card = "card"
const db_arcade_log = "arcade_log"

const { toBJHour, nowBJMinutes } = require('../timeUtil');

// 区域：音游区（老版计费）/ 桌游区（一把时间可能很长，23 点不强制离店）
const AREA_ARCADE = 'arcade'   // 音游区：0.2 点/分 = 12 点/小时
const AREA_BOARD = 'board'     // 桌游区：0.1 点/分 =  6 点/小时

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
    const startHour = toBJHour(duration.start_time !== undefined ? duration.start_time : duration.start_hour)
    const endHour = toBJHour(duration.end_time !== undefined ? duration.end_time : duration.end_hour)
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