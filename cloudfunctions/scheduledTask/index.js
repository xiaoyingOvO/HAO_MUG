// cloudfunctions/scheduledTask/index.js
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database()
const db_user = "user"
const db_card = "card"
const page_size = 50

// 区域
const AREA_ARCADE = 'arcade'   // 音游区：23 点强制离店（老版行为）
const AREA_BOARD = 'board'     // 桌游区：23 点**不**强制离店，继续计费（一把时间可能过长）

exports.main = async (event, context) => {
  console.log('---schedule_task---')
  console.log('定时任务触发时间:', new Date());
  // 获取强制退店参数
  const leave_arcade_force = "leave_arcade_force" in event ? 
    Boolean(event.leave_arcade_force) : false;
  // 获取有存量的卡表
  var card_result = await db.collection(db_card).where({
    remain: db.command.neq(-100)
  }).get({
    success: function (res) {
      return res
    },
    fail: console.error
  })
  // 遍历卡表，设置map
  var card_map = new Map()
  for (let i = 0 ; i < card_result.data.length ; i++){
    card_map.set(card_result.data[i]._id,0)
  }
  console.log("卡表",card_map)
  // 分页获取全用户
  var total = await getTotalCount(db_user, {})
  console.log('user count:', total)

  var user_datas = []
  const page_times = Math.ceil(total / page_size);
  for (let page_no = 0; page_no < page_times; page_no++) {
    const user_result = await paginationQuery(db_user, page_no, page_size, {})
    user_datas.push(...user_result.data)
    console.log('query user page:', page_no)
  }
  console.log('user data count:', user_datas.length)
  
  // 遍历用户
  for(var i = 0 ; i < user_datas.length ; i++) {
    var cards = user_datas[i].cards || []
    var updateCards = []

    var current_time = new Date()
    const time_23 = await customTime(23, 0, 0, 0)

    if (user_datas[i].enter_state >= 1) {
      console.log('店内用户:', user_datas[i])
      var cardFlag = false

      // 入店区域：老数据没有 area 字段时按音游区处理
      var area = user_datas[i].area === AREA_BOARD ? AREA_BOARD : AREA_ARCADE
      var isBoard = area === AREA_BOARD
      // 23 点强制离店：只对音游区生效。
      //   桌游区一把时间可能过长，23 点后不离店、继续计费，等用户自己离店时结算。
      //   （管理员手动强制离店 leave_arcade_force 仍然对所有区域生效）
      if (leave_arcade_force || (current_time >= time_23 && !isBoard)) {
        // --定时任务2--：23 点强制离店或自定义强制离店
        // 用户正在排队,退队
        if (user_datas[i].enter_state == 3 || user_datas[i].enter_state == 2){
          const waitQueueResult = await cloud.callFunction({
            name: 'queueFunctions', // 被调用云函数的名称
            data: {
              type: "Dequeue",
              params:{
                openid : user_datas[i].openid,
                machine_id : user_datas[i].machine_id
              }
            },
          })
          console.log('退队:', user_datas[i].openid)
        }
        // 退店
        const leaveArcadeResult = await cloud.callFunction({
          name: 'queueFunctions', // 被调用云函数的名称
          data: {
            type : "leaveArcade",
            params:{
              openid : user_datas[i].openid
            }
          },
        })
        console.log('退店:', user_datas[i].openid)
        // 同步内存快照：leaveArcade 无论扣费成功与否都会把 enter_state 置 0（余额不足也一样），
        // 但 user_datas[i] 还是本轮循环开始时的旧值。不同步的话，下面的清卡逻辑
        // 会因为 cardStillInUse 看到 enter_state=1 而把刚用完的卡多留一轮（余量延迟回收）。
        user_datas[i].enter_state = 0
        user_datas[i].enter_time = null
        // 重读卡片：leaveArcade 现在会在离店结算后立刻清掉过期卡并归还 remain。
        // 必须换成最新快照，否则下面会拿本轮循环开始时的旧 cards 再清一遍，
        // 同一张限量卡的 remain 被归还两次 → 库存凭空变多。
        // 重读失败则退回旧快照：leaveArcade 没清成功的情况下，下面的逻辑仍能自己兜住。
        try {
          const fresh = await db.collection(db_user).where({
            openid: user_datas[i].openid
          }).field({
            cards: true
          }).get()
          if (fresh && fresh.data && fresh.data.length) {
            user_datas[i].cards = fresh.data[0].cards || []
          }
        } catch (e) {
          console.error('重读用户卡片失败:', e)
        }
      }
      // 用（可能已被 leaveArcade 更新的）最新快照做后面的清卡判断
      cards = user_datas[i].cards || []
      // 备注：原「10 点把音游区 enter_time 重置成当天 10:00」的分支已移除。
      //   那是旧计费「夜场一律免单」的实现手段；现在 getConsumePoint 按免单卡覆盖时段
      //   逐天累计计费，夜场畅玩卡/早八套餐自己就能抵扣 23:00-10:00，不需要改 enter_time。
      //   保留它会连「没有夜场卡的人」（如持桌游夜场票进音游区）的整夜时长一起抹掉 → 夜场白玩。
    }

    // --定时任务3--：过期卡清除
    //
    // ⚠️ 这段不能因为「leaveArcade 已经离店清卡」就删掉，两者是快路径 + 兜底的关系：
    //   1. leaveArcade 只有前端「离店」按钮会调用。桌游区 23 点不强制离店，
    //      用户直接退回/杀掉小程序就永远走不到那条路径 → 卡和 remain 会一直挂着。
    //      特别是高级会员卡只有 3 个库存，挂住一张就少卖一张。
    //   2. 存量脏数据：本次上线之前就已过期的卡，没有任何一次离店事件能清到它们。
    //   3. leaveArcade 的清卡在 try/catch 里（不能让清卡失败把离店搞失败），
    //      万一失败一次，只能靠这里补。
    // 两边决策规则必须一致：end_time <= now 且本次消费不再使用它（cardStillInUse）。
    for(var j = 0 ; j < cards.length ; j++){
      current_time = new Date()
      var cardsID = cards[j].card_id
      // 卡未过期 → 保留；卡已过期但「仍被本次消费使用中」→ 也保留（见 cardStillInUse 注释）
      if (current_time <= cards[j].end_time || cardStillInUse(user_datas[i], cards[j], current_time)) {
        updateCards.push(cards[j])
        console.log("有效的卡",updateCards)
      } else {
        cardFlag = true
        // 卡不在有效期内且卡有余量限制
        if(card_map.has(cardsID)){
          card_map.set(cardsID,card_map.get(cardsID) + 1)
        }
      }
    }
    
    if (cardFlag) {
      await db.collection(db_user).where({
        openid: user_datas[i].openid
      }).update({
        data: {
          cards: updateCards
        }
      }).then(res => {
        // console.log(res);
      })
      console.log('用户卡信息更新成功:', user_datas[i].openid)
    }
  }

  console.log("更新后卡表",card_map)
  // 卡余量加回
  for (const [k, v] of card_map) {
    await db.collection(db_card).where({
      _id: k
    }).update({
      data: {
        remain: db.command.inc(v)
      }
    }).then(res => {
      updated = res.stats.updated;
      console.log(res);
    })
  }
  
  return {
    success: true,
    errMsg: "定时任务触发成功",
  }
};

async function getTotalCount(db_name, condition) {
  const countResult = await db.collection(db_name)
    .where(condition)
    .count()
  return countResult.total
}

// page_no 从 0 开始
async function paginationQuery(db_name, page_no, page_size, condition) {
  return await db.collection(db_name)
    .where(condition)
    .skip(page_no * page_size)
    .limit(page_size)
    .get({
      success: function (res) {
        return res
      },
      fail: console.error
    })
}

// 返回「今天北京时间 hours:minutes:seconds 对应的 UTC Date」。
// 云函数运行在 UTC 时区，直接 setHours(hours) 会得到 UTC hours 点（比北京早 8 小时），
// 导致 23 点强制离店等定时逻辑整体偏移 8 小时。
// 正确换算分两步：
//   1) 先求「北京当前日期」= (now + 8h) 的年月日（北京凌晨 0~7 点时，UTC 日期比北京早一天）
//   2) 北京当天 H 点对应的 UTC 时刻 = UTC(北京日期 00:00) - 8h + H 小时
function customTime(hours, minutes, seconds, milliseconds) {
  const now = new Date()
  // 北京当前时刻 = now + 8h，取其年月日即「北京今天」
  const bjNow = new Date(now.getTime() + 8 * 3600 * 1000)
  const bjMidnightUTC = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()) - 8 * 3600 * 1000
  return new Date(bjMidnightUTC + hours * 3600 * 1000 + minutes * 60 * 1000 + seconds * 1000 + milliseconds)
}

// 已过期的卡最多再保留多久（毫秒）。超过这个跨度还没结算就不再留着，避免限量卡余量被永久占用。
// 取值理由：getConsumePoint 的 billingMinutes 最多按 7 天跨度累计，更早的时段本来就不参与抵扣。
const STALE_HOLD_MS = 7 * 24 * 3600 * 1000

// 把库里各种时间存法统一成毫秒时间戳（Date / 字符串 / 数字 / {$date}）
function toMs(v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    const t = v.getTime()
    return Number.isNaN(t) ? null : t
  }
  if (typeof v === 'object') {
    if (v.$date !== undefined) return toMs(v.$date)
    return null
  }
  if (typeof v === 'number') return Number.isNaN(v) ? null : v
  if (typeof v === 'string') {
    const t = new Date(v).getTime()
    return Number.isNaN(t) ? null : t
  }
  return null
}

/**
 * 这张「已过期」的卡是否还必须留着 —— 因为用户本次消费还在用它。
 *
 * 背景（这是一个真实的计费事故）：
 *   各时段卡的 end_time 恰好落在定时任务的触发点上（早八 10:00、全天/桌游日场 23:00、
 *   夜场次日 10:00），而定时任务 cron 是「每天 10:00 与 23:00」。
 *   一旦用户「打超」（本来就超出卡内时段、还在玩），定时任务会把这张卡从 user.cards 里删掉，
 *   等用户 10:30 / 23:30 去结算时，getConsumePoint 已经查不到这张卡 →
 *   免单时段丢失 → 卡内那两小时被全额计费（早八 08:00-10:30 收 30 点而不是 6 点）。
 *
 * 判定口径与 getConsumePoint 保持一致：「本次入场时刻是否落在卡的有效期内」，
 * 而不是「结算时刻是否还在有效期内」。只要入店发生在卡失效之前，这张卡就属于本次消费，
 * 结算时要用它抵扣，必须先留着；等用户离店后的下一次定时任务再回收余量。
 *
 * @param {object} user 用户记录（需 enter_state / enter_time）
 * @param {object} card 用户持有的卡 {card_id, start_time, end_time}
 * @param {Date}   now  本次定时任务的当前时间
 * @returns {boolean}
 */
function cardStillInUse(user, card, now) {
  // 不在店内 → 没有正在进行的消费，照常清理
  if (!(Number(user.enter_state) >= 1)) return false
  const enterMs = toMs(user.enter_time)
  const endMs = toMs(card && card.end_time)
  if (enterMs === null || endMs === null) return false
  // 本次入场发生在卡失效之前 → 这次消费买过这张卡，结算还要用它
  if (enterMs > endMs) return false

  // 兜底：卡失效已超过 7 天仍未结算（用户长期不离店 / 脏数据），不再保留，
  // 否则限量卡的 remain 会被永久占用、库存只减不增。
  // 7 天是 billingMinutes 的计费跨度上限，超过这个跨度的时段本来就不参与抵扣，回收不会造成误扣。
  const nowMs = toMs(now)
  if (nowMs !== null && nowMs - endMs > STALE_HOLD_MS) {
    console.log('卡过期超过 7 天仍未结算，强制回收:', card && card.card_id, user.openid)
    return false
  }
  return true
}
