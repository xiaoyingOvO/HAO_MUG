const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_point = 'point';
const db_user = 'user';

// 删除优惠卡云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  const real_point = event.params.real_point_add;
  const extra_point = event.params.extra_point_add;
  console.log('openid: ' + openid +
    '; real_point_add: ' + real_point +
    '; extra_point_add: ' + extra_point);

  // 回滚user表点数
  let updated = 0;
  await db.collection(db_user)
    .where({
      openid: openid
    })
    .update({
      data: {
        real_point: db_cmd.inc(-real_point),
        extra_point: db_cmd.inc(-extra_point)
      }
    })
    .then(res => {
      updated = res.stats.updated;
      console.log(res);
    })

  if (updated == 0) {
    return {
      success: false,
      errMsg: "用户不存在"
    };
  }

  return {
    success: true
  };
};
