const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';
const db_user_unauthorized = 'user_unauthorized';
const db_blacklist = 'blacklist';

// 获取用户信息云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  console.log('openid: ' + openid);
  // 根据opendid查用户数据库
  let record = await db.collection(db_user)
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
  
  // 用户数据库已有，返回并直接登录
  if (record.data.length != 0) {
    const phone = record.data[0].phone;
    const qq_id = record.data[0].qq_id;
    // 检查电话和qq是否在黑名单中
    const blacklist_record = await db.collection(db_blacklist)
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

    // 黑名单不允许登录
    if (blacklist_record.list.length != 0) {
      return {
        success: false,
        data: {
          register: true,
          openid: openid
        }
      }
    }

    console.log('已注册授权openid');
    return {
      success: true,
      data: record.data[0]
    };
  }

  // 用户数据库没有，查未认证用户库
  record = await db.collection(db_user_unauthorized)
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

  // 判断未授权用户数据库是否包含该openid
  if (record.data.length == 0) {
    console.log('未注册openid');
    return {
      success: false,
      data: {
        register: false,
        openid: openid
      }
    };
  } else {
    console.log('已注册未授权openid');
    return {
      success: false,
      data: {
        register: true,
        openid: openid
      }
    };
  }
};
