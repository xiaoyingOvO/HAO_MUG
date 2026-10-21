const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_point = 'point';
const db_user = 'user';

// 购买优惠卡云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  console.log('openid: ' + openid);

  // 查所有卡信息
  let point_record = await db.collection(db_point)
    .orderBy('trial', 'desc')
    .orderBy('cost', 'desc')
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(point_record);

  return {
    success: true,
    data: point_record.data
  };
};
