const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';


// 购买点数云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  console.log('openid: ' + openid);
  
  // 统计充值点数
  const real_point = event.params.point;

  user_record = await db.collection(db_user)
  .where({
    openid: openid
  })
  .field({
    exp: true
  })
  .get({
    success: function (res) {
      console.log('success!!!');
      return res;
    },
    fail: console.error
  });
  console.log(user_record);

  if (user_record == null || user_record.data.length == 0) {
    console.log("该用户不存在");
    return {
      success: false,
      errMsg: "该用户不存在"
    };
  }

  const exp = user_record.data[0].exp;
  let bonus = 0;    // 赠送点数倍数
  if (exp <= 2000) {
      // 1级
      bonus = 0;
  } else if (exp <= 8000) {
      // 2级
      bonus = 0.05;
  } else if (exp <= 18000) {
      // 3级
      bonus = 0.10;
  } else if (exp <= 30000) {
      // 4级
      bonus = 0.20;
  } else if (exp < 114514) {
      // 5级
      bonus = 0.30;
  } else {
      // 6级
      return {
          success: false,
          errMsg: "最高等级用户无需充值！"
      };
  }
  // 使用 Math.round 避免浮点数精度问题（如 123.000000001）
  let extra_point = Math.round(real_point * bonus * 100) / 100;
  extra_point = parseFloat(extra_point.toFixed(2)); // 保留两位小数
  
  

  // 更新user表点数
  await db.collection(db_user)
    .where({
      openid: openid
    })
    .update({
      data: {
        real_point: db_cmd.inc(real_point),
        extra_point: db_cmd.inc(extra_point)
      }
    })
    .then(res => {
      console.log(res);
    })
  
  console.log("购买完成！");
  return {
    success: true,
    data: {
      openid: openid,
      real_point_add: real_point,
      extra_point_add: extra_point
    }
  }
};