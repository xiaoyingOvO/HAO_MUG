const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';
const db_reserve = 'reserve';
const db_meta = 'meta';

// 获取预约信息云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  console.log('openid: ' + openid);

  // 检查用户是否可以预约夜场
  let user_record = await db.collection(db_user).where({
    openid: openid
  }) 
  .field({
    openid: true,
    credit: true,
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  });
  if (user_record.data.length != 1) {
    return {
      success: false,
      errMsg: '未查询到该用户',
    };
  }
  let credit = user_record.data[0].credit;
  let reserve_qualification = credit >= 85 ? true : false;

  // 查询是否有预约人数限制
  let meta_result = await db.collection(db_meta)
    .where({
      key: db_cmd.in([
        'reserve_limit',
        'reserve_max',
        'reserve_cost',
    ])})
    .field({
      key: true,
      value: true,
    })
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(meta_result);
  const reserve_limit = meta_result.data.find(item => item.key == 'reserve_limit').value;
  const reserve_max = meta_result.data.find(item => item.key == 'reserve_max').value;
  const reserve_cost = meta_result.data.find(item => item.key == 'reserve_cost').value;

  // 计算查询日期段：从「昨天」起向后覆盖 29 天（昨天 + 未来 28 天）
  // 夜场预约延续到次日 10:00，所以 0:00-10:00 期间前端需要展示昨天的预约数据。
  // 1. 获取当前时间的 CST 日期部分
  const now = new Date();
  const nowCST = new Date(now.getTime() + (8 * 60 * 60 * 1000)); // 粗略转为 CST
  const year = nowCST.getUTCFullYear();
  const month = nowCST.getUTCMonth(); // 0-indexed
  const date = nowCST.getUTCDate();

  // 昨天 0 点（CST 午夜）
  const first_day_utc_midnight = Date.UTC(year, month, date - 1);
  const first_day = new Date(first_day_utc_midnight - (8 * 60 * 60 * 1000));
  // 未来第 28 天（今天 + 27 = 昨天起算 29 天）
  const last_day_utc_midnight = Date.UTC(year, month, date + 27);
  const last_day = new Date(last_day_utc_midnight - (8 * 60 * 60 * 1000));
  const days = 29;

  console.log('first day (CST Midnight): ' + first_day + '; last_day (CST Midnight): ' + last_day);
  // let first_day = new Date();
  // first_day.setHours(0, 0, 0, 0);
  // let last_day = new Date(first_day);
  // last_day.setDate(last_day.getDate() + (days - 1));
  // console.log('first day: ' + first_day + '; last_day: ' + last_day);
 
  // 查日期段内所有预约信息（整月）
  let record = await db.collection(db_reserve)
    .where({
      day: db_cmd.gte(first_day).and(db_cmd.lte(last_day))
    })
    .field({
      _id: false,
      day: true,
      openids: true
    })
    .orderBy('day', 'asc')
    .limit(days)
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
  console.log(record);

  // 时间从早到晚排序，没有预约的天数置空并添加
  let reserve_data = []

  const recordMap = new Map();
  if (record && record.data) {
    record.data.forEach(elem => {
      if (elem.day instanceof Date) {
        recordMap.set(elem.day.getTime(), elem);
      }
    });
  }

  let current_day = new Date(first_day.getTime());
  while(current_day.getTime() <= last_day.getTime()) {
    let tmp_data = recordMap.get(current_day.getTime());
    if (tmp_data != null) {
      reserve_data.push(tmp_data);
    } else {
      reserve_data.push({
        day: new Date(current_day.getTime()),
        openids: []
      });
    }

    let current_utc_midnight = current_day.getTime() + (8 * 60 * 60 * 1000);
    let next_day_utc_midnight  = current_utc_midnight + (24 * 60 * 60 * 1000);
    current_day.setTime(next_day_utc_midnight - (8 * 60 * 60 * 1000));
  }

  // for (let tmp_day = first_day; tmp_day <= last_day; tmp_day.setDate(tmp_day.getDate() + 1)) {
  //   let tmp_data = record.data.find(elem => elem.day.getTime() === tmp_day.getTime()); 
  //   if (tmp_data != null) {
  //     reserve_data.push(tmp_data);
  //   } else {
  //     reserve_data.push({
  //       day: new Date(tmp_day),
  //       openids: []
  //     })
  //   }
  // }
  console.log(reserve_data);

  // 返回
  return {
    success: true,
    data: {
      reserve_qualification: reserve_qualification,
      reserve_data: reserve_data,
      reserve_limit: reserve_limit,
      reserve_max: reserve_max,
      reserve_cost: reserve_cost,
    }
  };
};
