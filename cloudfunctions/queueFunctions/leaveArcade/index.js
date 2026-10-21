const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command
const db_user = "user"
const db_arcade_log = "arcade_log"

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