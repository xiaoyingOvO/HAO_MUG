const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_card = 'card'
const db_cmd = db.command;

const { toBJHour } = require('../timeUtil');

// 区域费率（点/分钟）
const AREA_ARCADE = 'arcade'
const AREA_BOARD = 'board'
const RATE_ARCADE = 0.2   // 音游区：0.2 点/分 = 12 点/小时（老版计费）
const RATE_BOARD = 0.1    // 桌游区：0.1 点/分 =  6 点/小时

// 获取入店情况云函数入口
async function getConsumePointMain(event, context) {
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
  // 查用户信息（入店时间，优惠卡持有）
  let user_record = await db.collection(db_user)
    .where({
      openid: openid
    })
    .field({
      openid: true,
      cards: true,
      credit: true,
      enter_state: true,
      enter_time: true,
      exp: true,
      area: true,
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  if (user_record.data.length != 1) {
    return {
      success: false,
      errMsg: '未查询到该用户',
    };
  }
  let enter_time = user_record.data[0].enter_time
  if (user_record.data[0].enter_state == 0){
    return {
      success: false,
      code : -3,
      errMsg: "用户未入店，请重试",
    }
  }
  // 以下正常扣费逻辑
  let current_time = new Date()
  let cards = user_record?.data?.[0]?.cards ?? [];
  let credit = user_record.data[0].credit
  // 入店区域：老数据没有 area 字段时按音游区处理
  const area = user_record.data[0].area === AREA_BOARD ? AREA_BOARD : AREA_ARCADE
  const rate = area === AREA_BOARD ? RATE_BOARD : RATE_ARCADE
  console.log('计费区域:', area, '费率:', rate, '点/分')
  let zhekou = 1
  // 处理所有优惠卡信息    
  var discountCards = []
  for(var i = 0 ; i < cards.length ; i++){
    var endtime = cards[i].end_time
    var starttime = cards[i].start_time
    // 入店至今包含优惠卡有效期
    if (enter_time <= endtime && current_time >= starttime) {
      var card_id = cards[i].card_id
      // 查询优惠卡具体信息（防呆：卡集合里查不到该卡时跳过，避免 data[0] undefined 抛错导致整个函数失败）
      let card_info = await db.collection(db_card).where({
        _id: card_id
      }).get({
        success: function (res) {
          console.log('success!!!')
          return res
        },
        fail: console.error
      })
      if (!card_info.data || card_info.data.length === 0) {
        console.warn('优惠卡不存在，跳过:', card_id)
        continue
      }
      // 分会员卡和免费时段卡
      if (card_info.data[0].discount != 0){
        zhekou *= card_info.data[0].discount
      }else{
        // 免单时段：统一用公共工具解析成「北京时间小时数」（兼容字符串/Date/$date/数字）
        const dur = card_info.data[0].duration || {}
        const sh = toBJHour(dur.start_time !== undefined ? dur.start_time : dur.start_hour)
        const eh = toBJHour(dur.end_time !== undefined ? dur.end_time : dur.end_hour)
        if (!Number.isNaN(sh) && sh !== null && !Number.isNaN(eh) && eh !== null) {
          discountCards.push({ start: sh, end: eh })
        } else {
          console.warn('免单卡时段格式无法识别，跳过:', card_id, JSON.stringify(dur))
        }
      }
    }
  }
  // 计费点数 = 计费分钟 × 区域费率（音游区 0.2 点/分，桌游区 0.1 点/分）
  //
  // 音游区：沿用原版 calculateBillingTime（含「夜场入店且夜场结算 → 计费 0」、10 点起算等规则）
  // 桌游区：用 boardBillingMinutes —— 桌游一把可能打很久、23 点不强制离店，
  //         原版那套按「小时×60+分钟」算时长的写法跨过 24:00 会变成负数，
  //         所以桌游区改为按天拆分累计真实时长，且**不走夜场免单**，23 点后继续计费。
  var billingTime = (area === AREA_BOARD)
    ? boardBillingMinutes(enter_time, current_time, discountCards)
    : calculateBillingTime(enter_time, current_time, discountCards)
  var ori_consumePoint = billingTime * rate
  // 信誉百分比叠加
  var consumePoint = ori_consumePoint * zhekou
  // 信用分惩罚：>=85 无惩罚；70~84 加 20%；60~69 加 50%；<60 记 -1（异常标记）
  // （原版误用 switch(credit) + 布尔 case 且缺 break，永远不会命中也不会 fall-through，这里改为 if/else）
  if (credit < 60) {
    consumePoint = -1
  } else if (credit >= 60 && credit < 70) {
    consumePoint = consumePoint * 1.5
  } else if (credit >= 70 && credit < 85) {
    consumePoint = consumePoint * 1.2
  }
  // Lv6等级不扣点数
  // 边界统一：enterArcade 的余额校验用的是 `exp < 114514` 才拦截（即 exp >= 114514 放行），
  // 这里原本写的是 `exp > 114514`，两者差一个等号，会导致 exp 恰好等于 114514 的用户
  // 「放行入店但仍被扣费、随即被 checkAndChargeBalance 强制退队」。统一为 >=。
  if (user_record.data[0].exp >= 114514){
    consumePoint = 0
  }
  let experience = ori_consumePoint
  return {
    success: true,
    data:{
      points: consumePoint,
      experience: experience
    }
  }
};

// 入口：兜底捕获所有异常，把错误信息明确返回给前端（而不是让函数静默失败、前端停留在 0.00）
exports.main = async (event, context) => {
  try {
    return await getConsumePointMain(event, context);
  } catch (e) {
    console.error('getConsumePoint 异常:', e);
    return { success: false, errMsg: 'getConsumePoint 异常: ' + e.message };
  }
};

// 时间转换
function timeToMinutes(timeStr) {
  return timeStr * 60;
}

// 某个时刻在当天经过的分钟数（0 ~ 1439）
function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 桌游/日麻区计费时长（分钟）—— 与原版 calculateBillingTime 的区别：
 *   1. **支持跨天**：原版用「当天分钟数相减」，跨过 24:00 会得到负数；
 *      这里按天拆分累计真实游玩时长，跨夜、跨多天都能算对。
 *   2. **不走夜场免单**：桌游区 23 点后不强制离店、继续计费。
 *   3. 免单时段（discount == 0 的卡）**按天分别抵扣**，两个区都享受免单卡。
 *
 * @param {Date} playStart 入店时间
 * @param {Date} playEnd   结算时间
 * @param {Array} discountCards 免单时段 [{start:小时, end:小时}]
 */
function boardBillingMinutes(playStart, playEnd, discountCards) {
  const merged = mergeDiscountCards(discountCards); // [{start,end}] 单位：当天分钟
  let total = 0;      // 真实游玩分钟
  let discounted = 0; // 被免单卡覆盖的分钟

  let cursor = new Date(playStart.getTime());
  let guard = 0;
  // 最多算 7 天（10080 分钟），防止异常数据导致死循环
  while (cursor < playEnd && guard++ < 7 * 24) {
    const nextDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0);
    const segEnd = nextDay < playEnd ? nextDay : playEnd;
    const sMin = minutesOfDay(cursor);
    // segEnd 正好是次日 0 点时，当天结束按 1440 分钟计
    const eMin = segEnd.getTime() === nextDay.getTime() ? 1440 : minutesOfDay(segEnd);

    if (eMin > sMin) {
      total += eMin - sMin;
      merged.forEach((card) => {
        const overlapStart = Math.max(sMin, card.start);
        const overlapEnd = Math.min(eMin, card.end);
        if (overlapStart < overlapEnd) discounted += overlapEnd - overlapStart;
      });
    }
    cursor = segEnd;
  }

  // 与原版一致：入店秒数大于结算秒数时扣掉 1 分钟（抵消截断误差）
  if (playStart.getSeconds() > playEnd.getSeconds()) total -= 1;

  const billingTime = total - discounted;
  return billingTime > 0 ? billingTime : 0;
}

// 合并优惠卡（并拆分跨天时段）
function mergeDiscountCards(discountCards) {
  // 先把每个时段转成「当天分钟」，跨天时段（start > end，如夜场 23:00→次日10:00）拆成两段：
  //   [start, 24:00] 落在当天  +  [00:00, end] 落在次日
  // 否则 start 分钟(1380) > end 分钟(600)，交集恒为 0，抵扣失效（桌游区夜场会正常扣费）。
  const intervals = [];
  discountCards.forEach(card => {
    const s = card.start;
    const e = card.end;
    if (s < e) {
      intervals.push({ start: timeToMinutes(s), end: timeToMinutes(e) });
    } else {
      // 跨天时段：拆成当天 [s, 24:00] 和次日 [00:00, e] 两段
      intervals.push({ start: timeToMinutes(s), end: 24 * 60 });
      intervals.push({ start: 0, end: timeToMinutes(e) });
    }
  });
  intervals.sort((a, b) => a.start - b.start);
  // 合并重叠区间
  const merged = [];
  intervals.forEach(interval => {
      if (merged.length === 0 || merged[merged.length - 1].end < interval.start) {
          // 没有重叠，直接添加
          merged.push(interval);
      } else {
          // 有重叠，合并时间段
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
      }
  });

  return merged;
}

// 计算有效计费时间（音游区，保持原版逻辑不变）
function calculateBillingTime(playStart, playEnd, discountCards) {
  // 夜场计时逻辑
  const enter_time_d = playStart.getDate()
  const leave_time_d = playEnd.getDate()
  const now_d = new Date().getDate()
  let enter_time_h = playStart.getHours()
  let leave_time_h = playEnd.getHours()
  // 用户在夜场进入
  if ((enter_time_h >= 23 && enter_time_h <= 24) || 
      (enter_time_h >= 0 && enter_time_h < 10)) {
    // 夜场时间内退店，直接不消费
    if ((enter_time_d == leave_time_d && leave_time_h >= 23 && leave_time_h <= 24) || 
        (leave_time_h >= 0 && leave_time_h < 10)) {
      return 0;
    }
    // 离店在早上10点后，计费时间从早上10点开始算
    if (enter_time_d != now_d && leave_time_h >= 10) {
      playStart = new Date(playEnd.getFullYear(), playEnd.getMonth(), playEnd.getDate(), 10, 0, 0);
    }
  }
  var playStartMin = playStart.getHours() * 60 + playStart.getMinutes();
  var playEndMin = playEnd.getHours() * 60 + playEnd.getMinutes();
  console.log("test2!",playStartMin,playEndMin)
  let totalPlayTime = playEndMin - playStartMin; // 总游玩时间（分钟）
  if (playStart.getSeconds() > playEnd.getSeconds()) {
    totalPlayTime -= 1;
  }
  if (totalPlayTime <= 0){
    return 0
  }
  let discountedTime = 0; // 被优惠卡覆盖的时间
  // 合并优惠卡时间段
  const mergedCards = mergeDiscountCards(discountCards);
  console.log(playStartMin,playEndMin,mergedCards)
  // 计算合并后的优惠时间与用户游玩时间的交集
  mergedCards.forEach(card => {
      const overlapStart = Math.max(playStartMin, card.start);
      const overlapEnd = Math.min(playEndMin, card.end);

      if (overlapStart < overlapEnd) {
          discountedTime += overlapEnd - overlapStart;
      }
  });
  if (playStart.getSeconds() > playEnd.getSeconds()){
    totalPlayTime -= 1
  }
  const billingTime = totalPlayTime - discountedTime;
  return billingTime > 0 ? billingTime : 0; // 确保计费时间非负
}