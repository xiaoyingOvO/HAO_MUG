const cloud = require('wx-server-sdk');
const { toMs } = require('../timeUtil');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command
const db_user = "user"
const db_card = "card"
const db_arcade_log = "arcade_log"

// remain == -100 表示不限量，不参与库存回收
const UNLIMITED_REMAIN = -100

/**
 * 离店清卡：**本次消费已经结算**，所以所有 end_time <= 现在 的卡都已用完，
 * 可以立刻从 user.cards 删掉，并把库存（remain）还给 card 集合。
 *
 * 为什么离店时清是安全的：结算（getConsumePoint）刚刚跑完，卡的历史使命已经结束，
 * 不再有任何「等会儿还要用它抵扣」的可能。这与「按时刻清卡」的本质区别是——
 * 这里的触发条件是「消费已结束」这个事件，而不是「某个钟点到了」。
 *
 * 只删已过期的卡：未过期的卡（如 30 天会员卡、当天还没到点的全天卡）原样保留，
 * 它们的有效期覆盖的是以后的消费。
 *
 * 幂等：end_time 无法解析时保守保留，交给 scheduledTask 兜底；重复调用不会多还库存。
 *
 * @param {string} openid
 * @param {Array}  cards  用户持有的卡 [{card_id, start_time, end_time}]
 * @param {Date}   now
 */
async function recycleExpiredCards(openid, cards, now) {
  if (!Array.isArray(cards) || cards.length === 0) return
  const nowMs = now.getTime()
  const keep = []
  const removed = []
  cards.forEach((c) => {
    const endMs = toMs(c && c.end_time)
    if (endMs === null || endMs > nowMs) keep.push(c)
    else removed.push(c)
  })
  if (removed.length === 0) return

  await db.collection(db_user).where({
    openid: openid
  }).update({
    data: {
      cards: keep
    }
  })
  console.log('离店清卡:', openid, '删除', removed.length, '张，保留', keep.length, '张')

  // 归还库存：同一张卡可能持有多次，按次数累加（与 scheduledTask 的口径一致）
  const count = new Map()
  removed.forEach((c) => {
    const id = c && c.card_id
    if (!id) return
    count.set(id, (count.get(id) || 0) + 1)
  })
  for (const [id, n] of count) {
    const r = await db.collection(db_card).where({
      _id: id
    }).field({
      remain: true
    }).get()
    const remain = r && r.data && r.data.length ? r.data[0].remain : null
    if (remain === null || remain === undefined) continue
    if (Number(remain) === UNLIMITED_REMAIN) continue
    await db.collection(db_card).where({
      _id: id
    }).update({
      data: {
        remain: db_cmd.inc(n)
      }
    })
    console.log('库存归还:', id, '+' + n, '（原 remain', remain, '）')
  }
}

// 退店云函数入口
exports.main = async (event, context) => {
  console.log('---退店云函数---')
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
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
    exp: true
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  let exp = user_record.data[0].exp
  if (user_record.data[0].enter_state == 0){
    return {
      success: false,
      errMsg: "用户未入店，请刷新重试",
    }
  }else if(user_record.data[0].enter_state > 1){
    const waitQueueResult = await cloud.callFunction({
      name: 'queueFunctions', // 被调用云函数的名称
      data: {
        type: "Dequeue",
        params:{
          openid : openid,
          machine_id : user_record.data[0].machine_id
        }
      },
    });
    // return {
    //   success: false,
    //   errMsg: "请检查当前状态是否为候队中或游玩中，请在退队后离店",
    // }
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
  let remain_total = user_remain_record.data[0].real_point + user_remain_record.data[0].extra_point
  const result = await cloud.callFunction({
    name: 'queueFunctions', // 被调用云函数的名称
    data: {
      type : "getConsumePoint",
      params:{
        openid : openid
      }
    },
  });
  console.log(result,remain_total)
  let remain_need = result.result.data.points
  let experience = result.result.data.experience
  // 扣费逻辑
  let afterExtraPoint = user_remain_record.data[0].extra_point
  let afterRealPoint = user_remain_record.data[0].real_point
  if (afterExtraPoint >= remain_need){
    afterExtraPoint = afterExtraPoint - remain_need
  }else{
    afterRealPoint = afterRealPoint - (remain_need - afterExtraPoint)
    afterExtraPoint = 0
  }

  if (afterRealPoint < 0){
    // 余额不足
    experience *= (remain_need + afterRealPoint) / remain_need
  }
  exp += experience

  const time = new Date()
  await db.collection(db_user)
  .where({
    openid: openid,
  })
  .update({
    data: {
      enter_state: 0,
      enter_time: null,
      real_point: afterRealPoint,
      extra_point: afterExtraPoint,
      exp: exp,
      // 离店后不再保留入店区域：否则下次入店前的状态读取会拿到上次的区域
      area: db_cmd.remove()
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
      remain_point: afterRealPoint + afterExtraPoint,
      exp: exp,
      op: 1,
    }
  })
  .then(res => {
    console.log(res);
  })

  // 结算已完成 → 立即清掉本次消费用过的过期卡，库存零延迟归还。
  // 清卡失败不影响离店（钱已经扣了、状态已经改了），下次定时任务还会兜底。
  try {
    await recycleExpiredCards(openid, user_remain_record.data[0].cards, time)
  } catch (e) {
    console.error('离店清卡失败（不影响结算）:', e)
  }

  if (afterRealPoint < 0){
    // 余额不足
    return {
      success: false,
      errMsg: "余额不足，请充值",
    }
  }
  return {
    success: true,
    errMsg: "退店成功",
  }
}