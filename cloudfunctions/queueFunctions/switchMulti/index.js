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

  // 查询用户昵称（用于日志）
  let nickname = openid.substring(0, 8)
  try {
    const userRecord = await db.collection(db_user).where({ openid }).field({ nickname: true }).get()
    if (userRecord.data && userRecord.data.length > 0 && userRecord.data[0].nickname) {
      nickname = userRecord.data[0].nickname
    }
  } catch (e) {
    console.warn('查询用户昵称失败，使用 openid 前缀:', e)
  }

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

  // 写队列日志：切换单双刷
  var db_log = "queue_log_" + machine_id
  var now = new Date();
  var timeStr = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
  var content = "[" + timeStr + "] " + nickname + (is_multi ? "切换为拼机" : "切换为单刷")
  await db.collection(db_log).add({
    data: {
      timestamp: new Date(),
      openid: openid,
      log_info: content
    }
  }).catch(console.error)

  return {
    success: true,
    data: {
      machine_id: machine_id,
      openid: openid,
      is_multi: is_multi
    }
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
