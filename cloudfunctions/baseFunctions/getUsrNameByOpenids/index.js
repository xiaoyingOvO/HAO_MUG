const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_cmd = db.command;

// 获取用户信息云函数入口

exports.main = async (event, context) => {
  console.log('云函数 getUsrNameByOpenids 接收事件：', JSON.stringify(event));
  if (!event.params || !Array.isArray(event.params.openids)) {
    console.error('Invalid input: event.params.openids is not an array or params is missing.');
    return { success: false, errMsg: '参数错误：缺少 openids 数组', data: [] };
  }

  // 获取openid
  const openids = event.params.openids;
  console.log('openids:', openids);

  if (openids.length === 0) {
    console.log('Input openids array is empty, returning empty data.');
    return { success: true, data: [] };
  }
 
  try {
    console.log(`Querying db collection '${db_user}' for openids:`, openids);

    // 根据opendid查数据库
    let record = await db.collection(db_user)
      .where({
        openid: db_cmd.in(openids)
      })
      .field({
        openid: true,
        nickname: true,
      })
      .get(); //  直接调用 .get()
    console.log(record);

    console.log('Database query result:', JSON.stringify(record));


    return {
      success: true,
      data: record.data
    };
  } catch (error) {
    console.error('Error executing getUsrNameByOpenids:', error);

    return {
      success: false,
      errMsg: error.message || '云函数内部错误',
      errorDetails: JSON.stringify(error),
      data: []
    };
  }
};
