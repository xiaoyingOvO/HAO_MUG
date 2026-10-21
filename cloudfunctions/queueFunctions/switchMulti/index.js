const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';

// 获取用户信息云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  const machine_id = event.params.machine_id;
  const is_multi = event.params.is_multi;
  console.log('openid:', openid, 'machine_id:', machine_id, 'is_multi:', is_multi);
  // 修改用户单双刷状态
  var db_queue = 'queue_' + machine_id;
  await db.collection(db_queue)
    .where({
      openid: openid
    })
    .limit(1)
    .update({
      data: {
        is_multi: is_multi
      }
    })
    .then(res => {
      console.log(res);
    })

  return {
    success: true,
    data: {
      machine_id: machine_id,
      openid: openid,
      is_multi: is_multi
    }
  };
};
