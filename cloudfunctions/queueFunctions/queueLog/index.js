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
  // 云函数跑在 UTC 时区，必须按「北京时间当天 00:00 ~ 23:59:59」换算成 UTC 时间戳，
  // 否则直接 setHours(0) 得到的是 UTC 0 点（北京 8 点），会把凌晨 0~8 点的日志漏掉。
  const now = new Date()
  const bjNow = new Date(now.getTime() + 8 * 3600 * 1000)
  const bjMidnightUTC = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()) - 8 * 3600 * 1000
  const start = new Date(bjMidnightUTC)
  const end = new Date(bjMidnightUTC + 24 * 3600 * 1000 - 1)
  // ⚠️ 必须显式排序 + 限制条数：
  //   云函数里 get() 默认最多返回 100 条，且不排序时是「最早的那 100 条」，
  //   当天日志一旦超过 100 条，新写入的就永远查不出来 —— 表现就是「日志不更新」。
  //   这里按时间倒序取最新 100 条（前端再按时间正序翻转展示）。
  var queue_log_record = await db.collection(db_queueLog).where({
    timestamp: db.command.and(db.command.gte(start),db.command.lte(end)) 
  })
  .orderBy('timestamp', 'desc')
  .limit(100)
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