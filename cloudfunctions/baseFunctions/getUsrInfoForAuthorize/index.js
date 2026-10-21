const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user_unauthorized = 'user_unauthorized';

// 获取用户信息云函数入口
exports.main = async (event, context) => {
  // 获取查询数
  const query_num = 'query_num' in event.params ? event.params.query_num : -1;
  let skip_num = 'skip_num' in event.params || !(event.params.skip_num >= 0) ? 
    event.params.skip_num : 0;
  console.log('query_num:', query_num, 'skip_num:', skip_num);

  // 查未认证用户库
  if (query_num >= 1) {
    record = await db.collection(db_user_unauthorized)
      .skip(skip_num)
      .limit(query_num)
      .get({
        success: function (res) {
          console.log('success!!!');
          return res;
        },
        fail: console.error
      });
  } else {
    record = await db.collection(db_user_unauthorized)
      .skip(skip_num)
      .get({
        success: function (res) {
          console.log('success!!!');
          return res;
        },
        fail: console.error
      });
  }
  console.log(record);

  return {
    success: true,
    data: record.data
  };
};
