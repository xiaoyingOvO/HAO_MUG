const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_machine = 'machine';

// 获取入店情况云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)

  // 查用户信息（入店情况、余额信息、排队机器）
  let machine_record = await db.collection(db_machine)
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  return {
    success: true,
    data: machine_record.data
  };
};
