const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

// 添加用户云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const wxContext = cloud.getWXContext();
  const openid = 'openid' in event.params ? 
    event.params.openid : wxContext.OPENID;
  const code = event.params.code;
  console.log('openid: ', openid, 'code: ', code);

  // 获取手机号
  try {
    const result = await cloud.openapi.phonenumber.getPhoneNumber({
      "code": code,
      "openid": openid,
    });
    console.log('phone msg: ', result);

    return {
      success: true,
      data: {
        phone: result.phoneInfo.phoneNumber
      }
    };
  } catch (err) {
    console.log('获取手机号信息失败');
    return err
  }
  
  
};