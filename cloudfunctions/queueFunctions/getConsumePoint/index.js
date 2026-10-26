const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_card = 'card'
const db_cmd = db.command;

const { durationHour } = require('../timeUtil');

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
  // 处理所有优惠卡信息（批量查询，避免 N+1）
  // 1. 先筛选出时间范围有效的卡，收集 card_id
  //    口径：入店时刻落在卡的持有有效期内，且结算时刻不早于有效期起点。
  //    ⚠️ 这里**故意不校验 current_time <= c.end_time** —— 早八票 08:00-10:00 打超到 11:00 时，
  //    卡的持有有效期已过，但 08:00-10:00 这段已经买断的免单权益必须照常抵扣。
  //    用「入店时刻是否在有效期内」来判定「这次消费是否买了这张卡」，比「结算时刻是否还在有效期内」正确。
  const activeCardRefs = []
  cards.forEach(c => {
    if (!c || !c.card_id) return
    if (c.start_time == null || c.end_time == null) return
    const holdStart = new Date(c.start_time).getTime()
    const holdEnd = new Date(c.end_time).getTime()
    if (Number.isNaN(holdStart) || Number.isNaN(holdEnd)) return
    const enterMs = new Date(enter_time).getTime()
    const nowMs = current_time.getTime()
    if (enterMs <= holdEnd && nowMs >= holdStart) {
      // 带上持有有效期，供 billingMinutes 把免单时段夹在有效期内（防跨天多免）
      activeCardRefs.push({ ref: c, holdStart, holdEnd })
    }
  })
  // 2. 批量查询卡详情
  const cardDetails = {}
  if (activeCardRefs.length > 0) {
    const cardIds = activeCardRefs.map(c => c.ref.card_id).filter(Boolean)
    const chunks = []
    for (let i = 0; i < cardIds.length; i += 100) chunks.push(cardIds.slice(i, i + 100))
    for (const chunk of chunks) {
      const cr = await db.collection(db_card).where({ _id: db.command.in(chunk) }).get()
      cr.data.forEach(cd => { cardDetails[cd._id] = cd })
    }
  }
  // 3. 处理每张卡的折扣和免单时段
  let zhekou = 1
  const discountCards = []
  for (const { ref: c, holdStart, holdEnd } of activeCardRefs) {
    const cardInfo = cardDetails[c.card_id]
    if (!cardInfo) {
      console.warn('优惠卡不存在，跳过:', c.card_id)
      continue
    }
    // discount 语义：
    //   0        → 免单卡，按其 duration 时段抵扣计费时长（早八/全天/桌游日场/桌游夜场/夜场畅玩卡）
    //   0<d<1    → 折扣卡，zhekou *= d（高级会员卡 0.5）
    //   d>1      → 加价卡，zhekou *= d（当前无此卡）
    //   ⚠️ 夜场畅玩卡的 discount 必须是 0。填 1 会走「折扣卡」分支，zhekou *= 1 等于不打折，
    //      也拿不到免单时段，持卡人整晚被全额计费 —— 云开发控制台 card 集合里已改为 0。
    const discountNum = Number(cardInfo.discount)
    if (!Number.isNaN(discountNum) && discountNum !== 0) {
      zhekou *= discountNum
    } else {
      // 区域限制：card.area 存在且不等于用户当前区域 → 该卡不享受免单
      const cardArea = cardInfo.area
      if (cardArea && cardArea !== area) {
        console.log(`卡 ${cardInfo._id} 仅限 ${cardArea} 区，用户当前 ${area}，不计免单`)
        continue
      }
      const dur = cardInfo.duration || {}
      // 早八畅玩套餐 / 全天畅玩套餐 / 夜场畅玩卡的真实存法是：
      //   { type: 0, start_hour: 8, end_hour: 10, start_time: null, end_time: null }
      // 必须用 durationHour 做「按可解析性回落」，不能写成 `start_time !== undefined ? ... : start_hour`
      // ——那样 null 会被当成有值，start_hour 永远读不到，免单时段丢失，整段时长全额计费。
      const sh = durationHour(dur, 'start')
      const eh = durationHour(dur, 'end')
      if (!Number.isNaN(sh) && sh !== null && !Number.isNaN(eh) && eh !== null) {
        // 带上持有有效期：billingMinutes 会把「每天重复的免单时段」夹在这段绝对时间之内，
        // 否则入店后一直不离店时，第二天、第三天的同一时段会继续免单。
        discountCards.push({ start: sh, end: eh, fromMs: holdStart, toMs: holdEnd })
      } else {
        console.warn('免单卡时段格式无法识别，跳过:', c.card_id, JSON.stringify(dur))
      }
    }
  }
  // 计费点数 = 计费分钟 × 区域费率（音游区 0.2 点/分，桌游区 0.1 点/分）
  //
  // 两个区统一用 billingMinutes：按北京时间「逐天累计真实时长」，再用免单卡的时段抵扣。
  //   · 不再有「音游区 23:00-次日10:00 一律 0 点」的兜底规则 —— 夜场之所以免费，
  //     是因为持有覆盖该时段的免单卡（夜场畅玩卡 / 早八套餐 / 预约发的夜场票），
  //     而不是「谁在这个点进来都免」。否则桌游夜场票（area=board）的持有人
  //     也能在音游区白玩一整晚，夜场畅玩卡就失去意义了。
  //   · 时长按天拆分累计，跨过 24:00 不会出现负数（原版按「当天分钟数相减」，跨天即翻负）。
  var billingTime = billingMinutes(enter_time, current_time, discountCards)
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

// 北京时间偏移。计费的一切「几点、哪一天」判断都必须基于北京时间，
// 而云函数运行时时区不保证 —— 这里用「绝对时间戳 +8h 后按分钟取整」得到
// 一个与运行时区无关的北京时间分钟序号，避免 UTC/Asia-Shanghai 切换导致整体差 8 小时。
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

// 北京时间分钟序号（同一时刻在任何时区跑都得到同一个数）
function bjMinuteStamp(d) {
  return Math.floor((d.getTime() + BJ_OFFSET_MS) / 60000);
}

// 北京时间分钟序号 → 绝对毫秒时间戳（bjMinuteStamp 的逆运算）
function bjStampToMs(stamp) {
  return stamp * 60000 - BJ_OFFSET_MS;
}

/**
 * 计费时长（分钟）—— 音游区 / 桌游区共用。
 *
 *   1. **按北京时间逐天累计**真实游玩时长，跨过 24:00、跨多天都能算对
 *      （原版用「当天分钟数相减」，跨天直接翻成负数 → 白玩）。
 *   2. **没有「夜场一律免单」的兜底**：夜场免费只来自免单卡（discount == 0）覆盖的时段，
 *      卡的区域不符时在调用方已被剔除（card.area === 'board' 的票在音游区不生效）。
 *   3. 免单时段按天分别抵扣，跨天时段（23:00→次日10:00）拆成 [23:00,24:00] + [00:00,10:00]。
 *   4. 抵扣范围还要与「卡的持有有效期」求交：免单时段本身是「每天重复」的，
 *      若不做这一步，用户入店后一直不点离店，第 2 天、第 3 天的同一时段会继续免单
 *      （例：全天畅玩套餐只买了 26 号 10:00-23:00，27 号 10:00-23:00 不该再免）。
 *
 * @param {Date}   playStart     入店时间
 * @param {Date}   playEnd       结算时间
 * @param {Array}  discountCards 免单时段，支持两种形态：
 *                               ① {start, end}                 —— 不限持有有效期（历史调用/单测）
 *                               ② {start, end, fromMs, toMs}   —— 只在 [fromMs, toMs] 内抵扣（真实卡）
 * @returns {number} 计费分钟数（>= 0）
 */
function billingMinutes(playStart, playEnd, discountCards) {
  if (!playStart || !playEnd) return 0;

  const windows = normalizeFreeWindows(discountCards);
  const startStamp = bjMinuteStamp(playStart);
  const endStamp = bjMinuteStamp(playEnd);
  if (endStamp <= startStamp) return 0;

  let total = 0;      // 真实游玩分钟
  let discounted = 0; // 被免单卡覆盖的分钟

  let cursor = startStamp;
  let guard = 0;
  // 最多算 7 天（防止异常数据死循环）
  while (cursor < endStamp && guard++ < 7) {
    const dayStart = Math.floor(cursor / 1440) * 1440;   // 当天 00:00 的分钟序号
    const segEnd = Math.min(dayStart + 1440, endStamp);  // 当天 24:00 或结算时刻

    total += segEnd - cursor;

    // 本段（当天这一段）的绝对毫秒区间，用来和时段、有效期求交
    const segFromMs = bjStampToMs(cursor);
    const segToMs = bjStampToMs(segEnd);

    windows.forEach((w) => {
      w.ranges.forEach((r) => {
        // 把「当天分钟」还原成绝对毫秒，再依次夹到持有有效期、本段区间内
        let fromMs = bjStampToMs(dayStart + r.start);
        let toMs = bjStampToMs(dayStart + r.end);
        if (w.fromMs !== null) fromMs = Math.max(fromMs, w.fromMs);
        if (w.toMs !== null) toMs = Math.min(toMs, w.toMs);
        fromMs = Math.max(fromMs, segFromMs);
        toMs = Math.min(toMs, segToMs);
        if (fromMs < toMs) discounted += Math.round((toMs - fromMs) / 60000);
      });
    });
    cursor = segEnd;
  }

  // 与原版一致：入店秒数大于结算秒数时扣掉 1 分钟（抵消截断误差，不满一分钟不计费）
  if (playStart.getSeconds() > playEnd.getSeconds()) total -= 1;

  // 多张免单卡时段重叠时可能重复抵扣，兜底不能超过真实时长
  const discountedSafe = Math.min(discounted, total);
  const billingTime = total - discountedSafe;
  return billingTime > 0 ? billingTime : 0;
}

/**
 * 把免单时段按「持有有效期」分组，组内合并重叠区间。
 * 不分组直接合并的话，两张有效期不同的卡会被并成一个不限期的时段，跨天就会多免。
 */
function normalizeFreeWindows(discountCards) {
  const groups = new Map();
  (discountCards || []).forEach((c) => {
    if (!c) return;
    const fromMs = (c.fromMs === undefined || c.fromMs === null) ? null : Number(c.fromMs);
    const toMs = (c.toMs === undefined || c.toMs === null) ? null : Number(c.toMs);
    const key = `${fromMs === null ? '-' : fromMs}|${toMs === null ? '-' : toMs}`;
    if (!groups.has(key)) groups.set(key, { fromMs, toMs, list: [] });
    groups.get(key).list.push({ start: c.start, end: c.end });
  });
  const out = [];
  groups.forEach((g) => {
    out.push({ fromMs: g.fromMs, toMs: g.toMs, ranges: mergeDiscountCards(g.list) });
  });
  return out;
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
