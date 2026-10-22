const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const db_cmd = db.command
const db_report = "report"

// 举报云函数入口
exports.main = async (event, context) => {
  console.log('---dealReport---')
  // 获取基础信息
  let openids = event.params.openids
  const report_id = event.params.report_id
  const content = event.params.content
  console.log('openid:', openid, 'report_id:', report_id, 'content:', content)
  if (!openids instanceof Array) {
    openids = [openids]
  }

  // 修改为已处理状态
  await db.collection(db_meta)
    .where({
      _id: report_id,
    })
    .limit(1)
    .update({
      data: {
        handled: true,
      }
    })
    .then(res => {
      console.log(res);
    })

  // 发信给管理
  const time = new Date()
  for (openid in openids) {
    const result = await cloud.callFunction({
      name: 'baseFunctions', // 被调用云函数的名称
      data: {
        type : "sendMail",
        params:{
          sender : "admin",
          receiver: openid,
          time: time,
          title: "回复: 举报处理",
          content: content,
        }
      },
    });
  } 

  return {
    success: true,
  }
}