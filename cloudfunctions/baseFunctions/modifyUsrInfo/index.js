const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';

// 获取用户信息云函数入口
exports.main = async (event, context) => {
  // 获取openid
  if (!'openid' in event.params) {
    return {
      success: false,
      errMsg: 'openid not in params',
    }
  }
  const openid = event.params.openid
  
  // 获取要修改的字段
  var update_data = {}
  if ('exp' in event.params) {
    if (!event.params.exp instanceof Number) {
      return {
        success: false,
        errMsg: "exp must be a number...",
      }
    }
    if (event.params.exp < 0) {
      return {
        success: false,
        errMsg: "exp can't be negative...",
      }
    }
    update_data.exp = Number(event.params.exp)
  }
  if ('role' in event.params) {
    if (!event.params.role in ['admin', 'user']) {
      return {
        success: false,
        errMsg: "unsupported role...",
      }
    }
    update_data.role = event.params.role
  }
  if ('display_title' in event.params) {
    // 这里不再维护一份 key 白名单。它和前端 utils/mahjongTitles.js、以及
    // mahjongStats 里的 VALID_TITLE_KEYS 是同一份东西的第三个副本，而且已经漂了:
    // 少列了 suankoutanki / kokushijuusanmen / chuurenjunsei / kazoe 四个双倍役满，
    // 玩家把「纯正九莲宝灯」设为展示称号会被判 unsupported。
    // display_title 只影响展示（前端渲染时查字典，不认识的 key 显示为「—」），
    // 所以这里只校验形态：允许 null / ''（清空），或一个短的小写 key。
    const dt = event.params.display_title;
    if (dt !== null && dt !== undefined && dt !== '') {
      if (typeof dt !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(dt)) {
        return {
          success: false,
          errMsg: "unsupported display_title...",
        }
      }
    }
    update_data.display_title = dt || null
  }
  if ('avatar' in event.params) {
    const av = event.params.avatar
    if (av !== null && av !== undefined) {
      // 头像只接受两种来源：用户中心上传后拿到的云存储 fileID（cloud://...），
      // 以及历史数据里的 https 外链。显式排除 data:/javascript: 这类可执行 scheme。
      if (typeof av !== 'string' || av.length > 512) {
        return {
          success: false,
          errMsg: "avatar must be a string shorter than 512...",
        }
      }
      if (!/^(cloud:\/\/|https:\/\/)/.test(av)) {
        return {
          success: false,
          errMsg: "unsupported avatar scheme...",
        }
      }
    }
    update_data.avatar = av || null
  }
  if ('credit' in event.params) {
    if (!event.params.credit instanceof Number) {
      return {
        success: false,
        errMsg: "credit must be a number...",
      }
    }
    if (event.params.credit < 0 || event.params.credit > 100) {
      return {
        success: false,
        errMsg: "credit must between 0 and 100...",
      }
    }
    update_data.credit = Number(event.params.credit)
  }
  if ('real_point' in event.params) {
    if (!event.params.real_point instanceof Number) {
      return {
        success: false,
        errMsg: "real_point must be a number...",
      }
    }
    update_data.real_point = Number(event.params.real_point)
  }
  if ('extra_point' in event.params) {
    if (!event.params.extra_point instanceof Number) {
      return {
        success: false,
        errMsg: "extra_point must be a number...",
      }
    }
    update_data.extra_point = Number(event.params.extra_point)
  }
  console.log('update data:', update_data)

  // 根据opendid查用户数据库
  await db.collection(db_user)
    .where({
      openid: openid,
    })
    .limit(1)
    .update({
      data: update_data
    })
    .then(res => {
      console.log(res);
    })
  
  return {
    success: true,
    data: update_data
  }
};