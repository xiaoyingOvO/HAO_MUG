const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command
const db_report = "report";
const db_user = "user";
const order_field = 'timestamp';
const order_sort = 'desc';

// 获取举报内容云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const from_openid = 'from_openid' in event.params ? event.params.from_openid : null;
  const to_openid = 'to_openid' in event.params ? event.params.to_openid : null;
  const start_time = 'start_time' in event.params ? new Date(event.params.start_time) : new Date(0);
  const end_time = 'end_time' in event.params ? new Date(event.params.end_time) : new Date(3000, 11, 31);
  const handled = 'handled' in event.params ? event.params.handled : null;
  const page_no = 'page_no' in event.params ? event.params.page_no : 0;
  const page_size = 'page_size' in event.params ? event.params.page_size : 50;
  console.log('from_openid:', from_openid, 'to_openid:', to_openid, 'start_time:', start_time,
    'end_time:', end_time, 'handled:', handled, 'page_no:', page_no, 'page_size:', page_size);

  // 查举报信息
  let condition = {
    timestamp: db_cmd.and(
      db_cmd.gte(start_time), 
      db_cmd.lte(end_time)
    ),
  };
  if (from_openid != null) {
    condition.from_openid = from_openid;
    console.log("from_openid exist:", condition.from_openid);
  }
  if (to_openid != null) {
    condition.to_openid = to_openid;
    console.log("to_openid exist:", condition.to_openid);
  }
  if (handled != null) {
    condition.handled = handled;
    console.log("handled exist:", condition.handled);
  }
  const report_record = await paginationQuery(db_report, order_field, order_sort, 
    page_no, page_size, condition);
  if (report_record.data == null) {
    return {
      success: false,
      errMsg: "查询举报信息失败",
    };
  }
  const report_result = report_record.data;

  // 查询 user 表获取相应头像与昵称
  const user_openids = [...new Set(
    [...report_result.map(item => item.from_openid), ...report_result.map(item => item.to_openid)]
  )];
  let user_record = await db.collection(db_user)
    .where({
      openid: db_cmd.in(user_openids),
    })
    .field({
      openid: true,
      nickname: true,
      avatar: true,
    })
    .get({
      success: function (res) {
        console.log('query user record success!!!');
        return res;
      },
      fail: console.error
    });
  if (user_record.data == null) {
    return {
      success: false,
      errMsg: "查询用户信息失败",
    };
  }
  const user_result = user_record.data;

  // 合并信息
  let result = report_result.map(report => {
    // 查找from用户
    const from_user = user_result.find(u => u.openid === report.from_openid) || {};
    // 查找to用户
    const to_user = user_result.find(u => u.openid === report.to_openid) || {};
    return {
      ...report,  // 保留原有字段
      from_avatar: from_user.avatar,
      from_nickname: from_user.nickname,
      to_avatar: to_user.avatar,
      to_nickname: to_user.nickname
    };
  });
  console.log("result: \n", result);

  return {
    success: true,
    data: result,
  };
}

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