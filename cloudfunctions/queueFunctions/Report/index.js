const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_report = "report"
const db_user = "user"
const _ = db.command
const page_size = 50

// 举报云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  const to_openid = event.params.to_openid
  const content = event.params.content
  const now = new Date()

  console.log('openid: ' + openid)
  // 向举报数据表中插入
  await db.collection(db_report).add({
    data: {
      from_openid: openid,
      timestamp: now,
      to_openid: to_openid,
      content: content,
      handled: false
    }
  })
  .then(res => {
    console.log(res);
  })

  // 查被投诉用户名
  const user_result = await db.collection(db_user)
    .where({
      openid: to_openid,
    })
    .get({
      success: function (res) {
        console.log('query user record success!!!');
        return res;
      },
      fail: console.error
    })
  if (user_result.data.length != 1) {
    return {
      success: false,
      errMsg: "查询用户名失败",
    }
  }
  const to_nickname = user_result.data[0].nickname

  // 发信给管理
  const time = new Date()
  const result = await cloud.callFunction({
    name: 'baseFunctions', // 被调用云函数的名称
    data: {
      type : "sendMail",
      params:{
        sender : openid,
        receiver: "admin",
        time: time,
        title: `举报 ${to_nickname} ${to_openid}`,
        content: content,
      }
    },
  }); 

  return {
    success: true,
    errMsg: "举报成功",
  }
}

async function getTotalCount(db_name, condition) {
    const countResult = await db.collection(db_name)
      .where(condition)
      .count()
    return countResult.total
  }

async function paginationQuery(db_name, page_no, page_size, condition) {
    return await db.collection(db_name)
      .where(condition)
      .skip(page_no * page_size)
      .limit(page_size)
      .get({
        success: function (res) {
          return res
        },
        fail: console.error
      })
  }
  