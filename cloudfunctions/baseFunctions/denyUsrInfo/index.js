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

  // 检查电话和qq是否在黑名单中
  record = await db.collection(db_blacklist)
    .where(db_cmd.or([
      {
        phones: phone
      },
      {
        qq_ids: qq_id
      }])
    )
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(record);
  // qq号在黑名单，手机也列入黑名单
  if (record.data.length != 0 || qq_id in record.data[0].qq_ids) {
    console.log(`qq号: ${qq_id}在黑名单里`);
    await db.collection(db_blacklist)
      .where({
        _id: record.data[0]._id
      })
      .update({
        data: {
          phones: db_cmd.push(phone)
        }
      })
      .then(res => {
        console.log(res);
      })
  }

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
      openid: openid,
    }
  };
};