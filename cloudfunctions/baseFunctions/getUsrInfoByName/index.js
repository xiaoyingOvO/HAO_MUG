const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';

// 获取用户信息云函数入口
exports.main = async (event, context) => {
  const nickname = event.params.nickname;
  console.log("nickname: " + nickname);
 
  // 根据opendid查数据库
  let record = await db.collection(db_user)
    .where({
      nickname: db.RegExp({
        regexp: nickname,
        options: 'i'
      })
    })
    .field({
      openid: true,
      nickname: true,
      avatar: true,
      credit: true,
      exp: true,
      real_point: true,
      extra_point: true,
      role: true,
    })
    .limit(20)
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(record);

  return {
    success: true,
    data: record.data
  };
};
