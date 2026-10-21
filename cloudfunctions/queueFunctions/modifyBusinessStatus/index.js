const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_meta = 'meta';

// 获取用户信息云函数入口
exports.main = async (event, context) => {
  console.log("---modifyBusinessStatus---")
  // 获取openid
  if (!'business_status' in event.params) {
    return {
      success: false,
      errMsg: 'business status not in params',
    }
  }
  const business_status = Boolean(event.params.business_status)
  console.log("business_status:", business_status)
  
  // 修改营业状态
  await db.collection(db_meta)
    .where({
      key: 'business_status',
    })
    .limit(1)
    .update({
      data: {
        value: business_status,
      }
    })
    .then(res => {
      console.log(res);
    })
  
  // 闭店时调定时任务批量退店
  if (!business_status) {
    const scheduledTaskResult = await cloud.callFunction({
      name: 'scheduledTask',
      data: {
        leave_arcade_force: true,
      },
    });

    if (!scheduledTaskResult.result || !scheduledTaskResult.result.success) {
      console.error('[scheduledTask] scheduledTask call failed: ', scheduledTaskResult.result);
      return {
        success: false,
        errMsg: `批量离店失败： ${scheduledTaskResult.result?.errMsg || '计费或更新状态出错'}`
      };
    }
  }
  
  return {
    success: true,
    data: {
      business_status: business_status,
    }
  }
};