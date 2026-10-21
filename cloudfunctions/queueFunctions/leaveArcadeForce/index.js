const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database()
const db_cmd = db.command
const db_user = "user"
const db_arcade_log = "arcade_log"

// 退店云函数入口
exports.main = async (event, context) => {
  console.log('[queueFunctions: leaveArcadeForce]')

  try {
    const targetOpenid = event.params?.targetOpenid;
    if (!targetOpenid || typeof targetOpenid !== 'string') {
      return { success: false, errMsg: '无效的目标用户ID' };
    }
    console.log(`[leaveArcadeForce] Target OpenID: ${targetOpenid}`);

    const userResult = await db.collection(db_user)
      .where({ openid: targetOpenid })
      .field({
        openid: true,
        machine_id: true,
        enter_state: true,
      })
      .limit(1)
      .get();

    if (!userResult.data || userResult.data.length === 0) {
      return {
        success: false,
        errMsg: '未找到该用户'
      };
    }
    const userInfo = userResult.data[0];

    if (userInfo.enter_state === 0) {
      console.log(`[leaveArcadeForce] User ${targetOpenid} is already out of store.`);
      return {
        success: true,
        message: '用户已离店，无需操作'
      };
    }

    console.log(`[leaveArcadeForce] User state: ${userInfo.enter_state}, Machine ID: ${userInfo.machine_id}`);

    if (userInfo.enter_state > 1) {
      if (userInfo.machine_id) {
        console.log(`[leaveArcadeForce] User is in queue/playing, attempting to dequeue from machine ${userInfo.machine_id}`);
        const dequeueResult = await cloud.callFunction({
          name: 'queueFunctions',
          data: {
            type: "Dequeue",
            params: {
              openid: userInfo.openid,
              machine_id: userInfo.machine_id
            }
          },
        });

        if (!dequeueResult.result || !dequeueResult.result.success) {
          console.error('[leaveArcadeForce] Dequeue failed:', dequeueResult.result);
          return {
            success: false,
            errMsg: `强制退队失败： ${dequeueResult.result?.errMsg || '未知错误'}`
          };
        }
        console.log(`[leaveArcadeForce] Dequeue successful for user ${targetOpenid}`);
      } else {
        console.warn(`[leaveArcadeForce] User state is ${userInfo.enter_state} but machine_id is missing. Skipping dequeue.`);
      }
    }

    console.log(`[leaveArcadeForce] Attempting to execute leaveArcade for user ${targetOpenid}`);
    const leaveArcadeResult = await cloud.callFunction({
      name: 'queueFunctions',
      data: {
        type: "leaveArcade",
        params: {
          openid: userInfo.openid
        }
      },
    });

    if (!leaveArcadeResult.result || !leaveArcadeResult.result.success) {
      console.error('[leaveArcadeForce] leaveArcade call failed: ', leaveArcadeResult.result);
      return {
        success: false,
        errMsg: `强制离店失败： ${leaveArcadeResult.result?.errMsg || '计费或更新状态出错'}`
      };
    }
    console.log(`[leaveArcadeForce] leaveArcade call successful for user ${targetOpenid}`);

    return { success: true};
  } catch (error) {
    console.error('[leaveArcadeForce] An unexpected error occurred:', error);
    return {
      success: false,
      errMsg: '执行强制离店时发生服务器内部错误'
    };
  }
  
};