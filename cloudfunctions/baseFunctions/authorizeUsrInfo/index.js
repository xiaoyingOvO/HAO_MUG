const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';
const db_user_unauthorized = 'user_unauthorized';
const db_blacklist = 'blacklist';

const role = "user";
const credit = 100;
const real_point = 0;
const extra_point = 0;
const cards = [];
const enter_state = 0;
const enter_time = null;
const machine_id = "";
const exp = 0;

// 授权用户云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const openid = event.params.openid;
  console.log('openid: ' + openid);
  
  // 根据openid查未授权用户库
  let record = await db.collection(db_user_unauthorized)
    .where({
      openid: openid
    })
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(record);

  // 如果未授权库中不存在openid，报错
  if (record.data.length == 0) {
    return {
      success: false,
      errMsg: '该用户不存在于未授权用户数据库'
    };
  }
  const phone = record.data[0].phone;
  const qq_id = record.data[0].qq_id;
  const nickname = record.data[0].nickname;
  const avatar = record.data[0].avatar;
  console.log(' phone: ' + phone + '; qq_id: ' + qq_id + 
  '; nickname: ' + nickname + '; avatar: ' + avatar);

  // 根据openid查用户数据库
  record = await db.collection(db_user)
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
  console.log('用户经验：' + exp);

  // 添加信息至数据库
  await db.collection(db_user).add({
    data: {
      openid: openid,
      phone: phone,
      qq_id: qq_id,
      exp: exp,
      role: role,
      cards: cards,
      credit: credit,
      nickname: nickname,
      avatar: avatar,
      real_point: real_point,
      extra_point: extra_point,
      enter_state: enter_state,
      enter_time: enter_time,
      machine_id: machine_id
    }
  })
  .then(res => {
    console.log(res);
  })

  // 删除未授权数据库信息
  await db.collection(db_user_unauthorized).where({
      openid: openid
    })
    .remove()
    .then(res => {
      console.log(res);
    });
  
  return {
    success: true,
    data: {
      exp: exp,
      real_point: real_point,
      extra_point: extra_point,
      cards: cards,
      enter_state: enter_state,
      enter_time: enter_time,
      machine_id: machine_id
    }
  };
};