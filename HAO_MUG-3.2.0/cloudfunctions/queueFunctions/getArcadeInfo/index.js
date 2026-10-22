const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = "user";
const db_arcade_log = "arcade_log";
const order_field = 'time';
const order_sort = 'desc';

// 入店云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const openid = 'openid' in event.params ? event.params.openid : null;
  const start_time = 'start_time' in event.params ? new Date(event.params.start_time) : new Date(0);
  const end_time = 'end_time' in event.params ? new Date(event.params.end_time) : new Date(3000, 11, 31);
  const page_no = 'page_no' in event.params ? event.params.page_no : 0;
  const page_size = 'page_size' in event.params ? event.params.page_size : 50;
  console.log('openid:', openid, 'start_time:', start_time, 'end_time:', end_time,
    'page_no', page_no, 'page_size', page_size);
  
  // 查日志
  let log_record = null;
  var condition = {
    time: db_cmd.and(
      db_cmd.gte(start_time), 
      db_cmd.lte(end_time)
    ),
  };
  if (openid != null) {
    condition.openid = openid;
    console.log("openid exist:", condition.openid);
  }
  log_record = await paginationQuery(db_arcade_log, order_field, order_sort, 
    page_no, page_size, condition);
  if (log_record.data == null) {
    return {
      success: false,
      errMsg: "查询日志信息失败",
    };
  }
  const log_result = log_record.data;
  // console.log(log_result);
  
  // 查询 user 表获取相应头像与昵称
  const user_openids = [...new Set(log_result.map(item => item.openid))];
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
  // console.log(user_result);

  // 合并信息
  let result = log_result.map(item1 => {
    const item2 = user_result.find(item2 => item1.openid === item2.openid);
    return item2 ? { ...item1, ...item2 } : item1; // 如果找到匹配项，则合并，否则直接返回原项
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