const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"

// 检查余额云函数入口
exports.main = async (event, context) => {
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
  if (user_record.data[0].enter_state == 0){
    return {
      success: false,
      errMsg: "用户未入店，无需判断",
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
  // 【改动】费用扣成负数时不再强制退队，只回报给前端做提醒。
  //   原逻辑：余额不足 → 调 Dequeue 把用户踢出队列（enter_state 不动），
  //           前端收到 code -2 弹「余额不足，请充值」。
  //   现逻辑：完全不碰队列，只返回 code -2 + overdraft，前端显示常驻红字并首次弹一次提示。
  //           队列位置保留，充值后可以照常上机。
  //   ⚠️ 入队 / 上机（Enqueue、Embark）的余额门槛维持不变，那是「进场门槛」不是「踢人」。
  if(remain_need > remain_total){
    return {
      success: false,
      code: -2,
      overdraft: true,
      data: {
        need: remain_need,
        has: remain_total,
        shortage: Number((remain_need - remain_total).toFixed(2)),
      },
      errMsg: "余额已透支，请及时充值",
    }
  }
  return {
    success: true,
    overdraft: false,
    errMsg: "余额充足",
  }
}