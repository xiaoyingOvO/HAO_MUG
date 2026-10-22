const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = "user";

exports.main = async (event, context) => {
  try {
    const page_no = event.params?.page_no || 0;
    const page_size = event.params?.page_size || 15;
    console.log(`[getCurrentInStoreInfo] page_no: ${page_no}, page_size: ${page_size}`);

    const condition = {
      enter_state: db_cmd.gt(0) //  enter_state > 0
    };

    const countPromise = db.collection(db_user).where(condition).count();
    const userPromise = db.collection(db_user)
      .where(condition)
      .field({
        openid: true,
        nickname: true,
        avatar: true,
        enter_state: true,
        enter_time: true
      })
      .skip(page_no * page_size)
      .limit(page_size)
      .orderBy('enter_time', 'asc') // 按入店时间升序
      .get();
    
    const [countResult, userResult] = await Promise.all([countPromise, userPromise]);

    const total = countResult.total;
    const userList = userResult.data;

    console.log(`[getCurrentInStoreInfo] Found ${total} users in store. Returning page ${page_no} with ${userList.length} users.`);

    return {
      success: true,
      data: userList,
      total: total
    };
  } catch (error) {
    console.error("Error in getCurrentInStoreInfo: ", error);
    return {
      success: false,
      errMsg: "获取在店用户列表失败"
    };
  }
};