const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_mail = 'mail';

// 添加用户云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const wxContext = cloud.getWXContext()
  const sender = "sender" in event.params ? event.params.sender : wxContext.OPENID
  let receiver = event.params.receiver
  const time = new Date()
  const title = event.params.title
  const content = event.params.content
  console.log('sender:', sender, 'receiver:', receiver,
    'time:', time, 'content:', content)

  // 添加信息至数据库
  if (!receiver instanceof Array) {
    receiver = [receiver]
  }
  for (r in receiver) {
    await db.collection(db_mail).add({
      data: {
        sender: sender,
        receiver: r,
        time: time,
        title: title,
        content: content,
        read: false,
      }
    })
    .then(res => {
      console.log(res);
    })
  }
  
  return {
    success: true,
    data: {
      sender: sender,
      receiver: receiver,
      time: time,
      content: content,
    }
  }
};
