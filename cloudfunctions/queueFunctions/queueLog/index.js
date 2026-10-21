const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
    // 获取openid
  const wxContext = cloud.getWXContext();
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid);
  var db_queueLog = "queue_log_"
  var machine_id = event.params.machine_id
  db_queueLog += machine_id
  console.log(new Date().getTime().toString())
  // 创建当天0点的时间对象
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  // 创建当天23:59:59的时间对象
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  var queue_log_record = await db.collection(db_queueLog).where({
    timestamp: db.command.and(db.command.gte(start),db.command.lte(end)) 
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  return {
    success: true,
    data: queue_log_record.data
  };
}