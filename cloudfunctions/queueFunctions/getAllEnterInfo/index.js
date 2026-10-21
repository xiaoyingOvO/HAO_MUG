const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = "user";

// 查询当前所有入店人员云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const page_no = 'page_no' in event.params ? event.params.page_no : 0
  const page_size = 'page_size' in event.params ? event.params.page_size : 50
  console.log('page_no', page_no, 'page_size', page_size)

  // 查询 user 表获取相应头像与昵称，page_no 从 0 开始
  let user_record = await db.collection(db_user)
    .where({
      enter_state: db_cmd.in([1, 2, 3])
    })
    .field({
      openid: true,
      nickname: true,
      avatar: true,
    })
    .skip(page_no * page_size)
    .limit(page_size)
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

  return {
    success: true,
    data: user_record.data,
  }
}