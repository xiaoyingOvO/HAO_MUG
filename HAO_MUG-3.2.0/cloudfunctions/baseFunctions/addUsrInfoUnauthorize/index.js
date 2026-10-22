const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user_unauthorized = 'user_unauthorized';
const db_user = 'user';
const db_blacklist = 'blacklist';

// 添加用户云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const wxContext = cloud.getWXContext();
  const openid = 'openid' in event.params ? 
    event.params.openid : wxContext.OPENID;
  const phone = event.params.phone;
  const qq_id = event.params.qq_id;
  const nickname = event.params.nickname;
  const avatar = event.params.avatar;
  console.log('openid: ' + openid + ' phone: ' + phone + 
    ' qq_id: ' + qq_id + ' nickname: ' + nickname + 
    ' avatar: ' + avatar);

  // 检查电话和qq是否在黑名单中
  record = await db.collection(db_blacklist)
    .aggregate()
    .match(db_cmd.or([
      {
        phones: phone
      },
      {
        qq_ids: qq_id
      }
    ]))
    .count('cnt_blacklist')
    .end();
  console.log(record);
  
  // 黑名单不允许注册
  if (record.list.length != 0) {
    return {
      success: false,
      errMsg: '注册失败...'
    }
  }

  // 查用户数据库
  let record = await db.collection(db_user)
    .where(db_cmd.or([
      {
        openid: openid
      },
      {
        phone: phone
      },
      {
        qq_id: qq_id
      }
    ]))
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(record);

  // 数据库已有相关信息
  if (record.data.length != 0) {
    let errMsg = "";
    for (var data of record.data) {
      if (data.openid == openid) {
        return {
          success: false,
          errMsg: '同一账号不允许多次注册'
        };
      }
      if (data.phone == phone) {
        errMsg += '手机号已注册；';
      }
      if (data.qq_id == qq_id) {
        errMsg += 'qq号已注册';
      }
    }
    return {
      success: false,
      errMsg: errMsg
    };
  }

  // 查未授权用户数据库
  record = await db.collection(db_user_unauthorized)
    .where(db_cmd.or([
      {
        openid: openid
      },
      {
        phone: phone
      },
      {
        qq_id: qq_id
      }
    ]))
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(record);

  // 未授权数据库已有相关信息
  if (record.data.length != 0) {
    let errMsg = "";
    for (var data of record.data) {
      if (data.openid == openid) {
        return {
          success: false,
          errMsg: '同一账号不允许多次注册'
        };
      }
      if (data.phone == phone) {
        errMsg += '手机号已注册；';
      }
      if (data.qq_id == qq_id) {
        errMsg += 'qq号已注册';
      }
    }
    return {
      success: false,
      errMsg: errMsg
    };
  }

  // 添加信息至数据库
  await db.collection(db_user_unauthorized).add({
    data: {
      openid: openid,
      phone: phone,
      qq_id: qq_id,
      nickname: nickname,
      avatar: avatar,
    }
  })
  .then(res => {
    console.log(res);
  })
  
  return {
    success: true
  };
};
