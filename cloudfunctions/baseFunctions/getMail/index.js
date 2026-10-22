const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const db_cmd = db.command
const db_mail = 'mail'
const order_field = 'time'
const order_sort = 'desc'


// 添加用户云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const start_time = 'start_time' in event.params ? new Date(event.params.start_time) : new Date(0)
  const end_time = 'end_time' in event.params ? new Date(event.params.end_time) : new Date(3000, 11, 31)
  const sender = 'sender' in event.params ? event.params.sender : ""
  const receiver = 'receiver' in event.params ? event.params.receiver : ""

  // 查询是否是管理
  const is_sender_admin = false
  const is_receiver_admin = false
  if ('sender' in event.params && 'receiver' in event.params) {
    const user_result = await db.collection(db_name)
      .where({
        openid: db_cmd.in([sender, receiver])
      })
      .field({
        openid: true,
        role: true,
      })
      .limit(2)
      .get({
        success: function (res) {
          console.log('query user record success!!!');
          return res;
        },
        fail: console.error
      })
    is_sender_admin = user_result.data.find(
      item => item.openid == sender && (item.role == "admin" || item.role == "master")) != null
    is_receiver_admin = user_result.data.find(
      item => item.openid == receiver && (item.role == "admin" || item.role == "master")) != null
  }

  // 统合查找条件
  var cond = {
    time: db_cmd.and(db_cmd.gte(start_time), db_cmd.lte(end_time)),
  }
  if ('read' in event.params) {
    cond.read = event.params.read
  }
  if ('sender' in event.params && 'receiver' in event.params) {
    cond.sender = sender
    cond.receiver = receiver
  } else if ('sender' in event.params) {
    if (is_sender_admin) {
      cond.sender = db_cmd.or(
        db_cmd.eq(sender), 
        db_cmd.eq("admin")
      )
    } else {
      cond.sender = sender
    }
  } else if ('receiver' in event.params) {
    if (is_receiver_admin) {
      cond.receiver = db_cmd.or(
        db_cmd.eq(receiver), 
        db_cmd.eq("admin"),
        db_cmd.eq("all"),
      )
    } else {
      cond.receiver = db_cmd.or(
        db_cmd.eq(receiver),
        db_cmd.eq("all"),
      )
    }
  } else {
    return {
      success: false,
      errMsg: "缺少发送者或接收者",
    }
  }
  
  const page_no = 'page_no' in event.params ? event.params.page_no : 0
  const page_size = 'page_size' in event.params ? event.params.page_size : 50
  console.log('page_no:', page_no, 'page_size:', page_size, 'condition:', cond)

  // 查询信息
  mail_record = await paginationQuery(db_mail, order_field, order_sort, 
    page_no, page_size, cond);
  if (mail_record.data == null) {
    return {
      success: false,
      errMsg: "查询邮件失败",
    };
  }
  
  return {
    success: true,
    data: mail_record.data
  }
};

// page_no 从 0 开始
async function paginationQuery(db_name, order_field, order_sort, 
    page_no, page_size, condition) {
  return await db.collection(db_name)
    .where(condition)
    .orderBy(order_field, order_sort)
    .skip(page_no * page_size)
    .limit(page_size)
    .get({
      success: function (res) {
        console.log('query user record success!!!');
        return res;
      },
      fail: console.error
    });
}