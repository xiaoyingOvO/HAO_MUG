const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const db_cmd = db.command
const db_mail = 'mail'

// 添加用户云函数入口函数
exports.main = async (event, context) => {
  console.log('---readMail---')
  // 获取基本信息
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  const mail_id = event.params.mail_id;
  console.log('openid:', openid, 'mail_id:', mail_id);

  // 修改邮件阅读状态
  await db.collection(db_mail)
    .where({
      _id: mail_id,
      receiver: openid,
    })
    .limit(1)
    .update({
      data: {
        read: true,
      }
    })
    .then(res => {
      console.log(res);
    })
  
  return {
    success: true
  }
};