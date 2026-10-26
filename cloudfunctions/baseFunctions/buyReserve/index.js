const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const max_reserve_cnt = 3;
const max_reserve_month = 6;

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';
const db_reserve = 'reserve';
const db_reserve_lock = 'reserve_lock';
const db_card = 'card';
const db_meta = 'meta';

const { toBJHour, toBJMinutes, durationMinutes } = require('../timeUtil');

// 夜场票（预约夜场成功后发放，时段 23:00 ~ 次日 10:00，含桌游麻将）
const night_card_id = 'e33be08d678e255a0189586d3b0d8a79';

// 桌游麻将票（独立购买，只能玩桌游/麻将，30 点/30 元）—— 与夜场票彻底分离，勿与 night_card_id 混用。
// 分两张卡：日场 10:00~23:00、夜场 23:00~次日 10:00，前端合并展示、切场次需重新购买对应那张。
// 建好卡后把真实 _id 填到下面两个常量（当前为占位值，未填前预约/购买不会发到这两张卡）。
const board_card_day_id = 'df40db4d6ad4af17010238800070046a';      // 桌游麻将票·日场（10:00-23:00）
const board_card_night_id = 'df40db4d6ad4af26010239057dae6a3c';    // 桌游麻将票·夜场（23:00-次日10:00）

const max_retry_time = 5;
const retry_wait_seconds = 0.5;
const max_reserve_lock_seconds = 2;

// 购买预约云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  console.log('openid: ' + openid);

  // 提取预约时间
  if (!('reserve_date' in event.params)) {
    return {
      success: false,
      errMsg: '未传入预约时间信息'
    }
  }
  // let tmp = new Date();
  // tmp.setDate(tmp.getDate() + 2);
  // tmp.setHours(0, 0, 0, 0);
  // console.log('tmp: ' + tmp.getTime());

  // const reserve_date = new Date(event.params.reserve_date);
  // console.log('reserve_date:', reserve_date);
  const reserve_date_str = event.params.reserve_date;
  const parts = reserve_date_str.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);

  const reserve_date_utc_midnight = Date.UTC(year, month - 1, day);
  const reserve_date = new Date(reserve_date_utc_midnight - (8 * 60 * 60 *1000));
  console.log('reserve_date:', reserve_date, reserve_date.toISOString());

  // 预约时间超限则报错
  const now = new Date();
  // 当前 CST 时间小时数
  const nowCST = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const currentCSTHour = nowCST.getUTCHours();
  console.log('当前CST近似小时数：' + currentCSTHour);
  // 当前日期的 CST 午夜时间
  const nowCSTMidnight = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - (8 * 60 * 60 * 1000));
  // 昨天日期的 CST 午夜时间
  const yesterdayMidnight = new Date(nowCSTMidnight.getTime() - (24 * 60 * 60 * 1000));

  // 计算最早可预约时间
  let minReserveDateTimestamp;
  if (currentCSTHour < 10) {
      const yesterdayCSTMidnightTimestamp = nowCSTMidnight.getTime() - (24 * 60 * 60 * 1000);
      minReserveDateTimestamp = yesterdayCSTMidnightTimestamp;
  } else {
      minReserveDateTimestamp = nowCSTMidnight.getTime();
  }

  // 最远可预约时间
  let max_reserve_date = new Date(now);
  max_reserve_date.setMonth(max_reserve_date.getMonth() + max_reserve_month);
  const maxReserveDateCSTMidnight = new Date(Date.UTC (max_reserve_date.getFullYear(), max_reserve_date.getMonth(), max_reserve_date.getDate()) - (8 * 60 * 60 * 1000));

  // 判断是否可预约
  const reserveTimestamp = reserve_date.getTime();
  if (reserveTimestamp < minReserveDateTimestamp || reserveTimestamp > maxReserveDateCSTMidnight.getTime()) {
      let errMsg = '预约时间不符合规则';
      if (reserveTimestamp < minReserveDateTimestamp) {
          const yesterdayTimestamp = nowCSTMidnight.getTime() - (24 * 60 * 60 * 1000);
          if (reserveTimestamp === yesterdayTimestamp && currentCSTHour >= 10) {
              errMsg = '已超过昨日预约截止时间（10：00）';
          } else {
              errMsg = currentCSTHour < 10 ? '只能预约昨天以后的日期' : '只能预约今天以后的日期';
          }
      } else {
          errMsg = `只能预约未来${max_reserve_month}个月内的日期`;
      }
      return {
          success: false,
          errMsg: errMsg,
      }
  }

//   if (reserve_date.getTime() < nowCSTMidnight.getTime() ||
//       reserve_date.getTime() > maxReserveDateCSTMidnight.getTime()) {
//         return {
//           success: false,
//           errMsg: '预约时间不符合规则'
//         }
//       }
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

  // 第一次获取卡持续天数和余量
  var res = await getUserAndReserveInfo({
    openid: openid,
    reserve_date: reserve_date,
    reserve_limit: reserve_limit,
    reserve_max: reserve_max,
    reserve_cost: reserve_cost,
  });
  if (res.success == false) {
    return res
  }

  // 尝试获取分布式锁
  if (!reserve_limit) {
    let lockRes = await acquireReserveLock({
      openid: openid,
      reserve_date: reserve_date
    });
  
    if (!lockRes.success) {
      return {
        success: false,
        errMsg: "预约人数太多，预约失败，请重试..."
      }
    }

    // 第二次获取卡持续天数和余量
    res = await getUserAndReserveInfo({
      openid: openid,
      reserve_date: reserve_date,
      reserve_limit: reserve_limit,
      reserve_max: reserve_max,
      reserve_cost: reserve_cost,
    });
    if (res.success == false) {
      return res
    }
  }

  // 添加信息至数据库
  if (res.data.has_day) {
    await db.collection(db_reserve)
      .where({
        day: reserve_date
      })
      .update({
        data: {
          openids: db_cmd.push(openid)
        }
      })
      .then(res => {
        console.log(res);
      })
  } else {
    await db.collection(db_reserve)
      .add({
        data: {
          day: reserve_date,
          openids: [openid]
        }
      })
      .then(res => {
        console.log(res);
      })
  }

  // 扣费
  res = await chargeReserve({
    openid: openid,
    reserve_date: reserve_date,
    reserve_cost: reserve_cost,
  });
  if (!res.success) {
    // 扣费失败，删除购买记录并报错
    await db.collection(db_reserve)
      .where({
        day: reserve_date
      })
      .update({
        data: {
          openids: db_cmd.pull(openid)
        }
      })
      .then(res => {
        console.log(res);
      })
    return res;
  }

  // 如果获取过锁，更新完释放锁
  await releaseReserveLock({
    openid: openid,
    reserve_date: reserve_date
  })

  return {
    success: true
  };
};


async function getUserAndReserveInfo(params) {
  const openid = params.openid;
  const reserve_date = params.reserve_date;
  const reserve_limit = params.reserve_limit;
  const reserve_max = params.reserve_max;
  const reserve_cost = params.reserve_cost;

  // 查看当天预约情况
  let reserve_record = await db.collection(db_reserve)
    .where({
      day: reserve_date
    })
    .field({
      _id: false,
      openids: true
    })
    .limit(1)
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
    
  console.log(reserve_record);
  if (reserve_record == null || reserve_record.data == null) {
    console.log("查询预约信息失败，请联系管理员");
    return {
      success: false,
      errMsg: "查询预约信息失败，请联系管理员"
    };
  }

  // 校验能否预约
  if (reserve_record.data.length == 1) {
    if (reserve_record.data[0].openids.find(elem => openid === elem)) {
      console.log("已预约过该时段");
      return {
        success: false,
        errMsg: "已预约过该时段"
      };
    }
    if (reserve_limit && reserve_record.data[0].openids.length >= reserve_max) {
      console.log("该时段已预约满员");
      return {
        success: false,
        errMsg: "该时段已预约满员"
      };
    }
  }

  return {
    success: true,
    data: {
      has_day: reserve_record.data.length == 0 ? false : true
    }
  }
}

async function acquireReserveLock(params) {
  const openid = params.openid;
  const reserve_date = params.reserve_date;

  let updated = 0;
  // 重试流程
  for (var retry_time = 1; retry_time <= max_retry_time; retry_time++) {
    // 查询分布式锁当前状况
    let reserve_lock_record = await db.collection(db_reserve_lock)
      .where({
        day: reserve_date,
      })
      .field({
        openid: true,
        release_time: true
      })
      .limit(1)
      .get({
        success: function (res) {
          console.log('query reserve lock success!!!');
          return res;
        },
        fail: console.error
      });
    
    // 如果锁不存在，建立锁，并重新尝试获取
    if (reserve_lock_record != null && reserve_lock_record.data.length == 0) {
      console.log('不存在锁：', reserve_date);
      await db.collection(db_reserve_lock)
        .add({
          data: {
            day: reserve_date,
            openid: openid,
            release_time: new Date(0)
          }
        });
      console.log('已生成锁：', reserve_date);
      await sleep(retry_wait_seconds);
      continue;
    }

    // 锁被其他占有，重试
    const old_openid = reserve_lock_record.data[0].openid;
    const old_release_time = reserve_lock_record.data[0].release_time;
    const release_time = new Date();
    console.log('old_release_time:', old_release_time,
      'release_time:', release_time);
    if (old_openid != openid && release_time < old_release_time) {
      console.log("reserve lock retry time: " + retry_time);
      await sleep(retry_wait_seconds);
      continue;
    }

    // CAS尝试获取分布式锁
    release_time.setSeconds(release_time.getSeconds() + max_reserve_lock_seconds);
    await db.collection(db_reserve_lock)
      .where({
        day: reserve_date,
        release_time: old_release_time
      })
      .limit(1)
      .update({
        data: {
          openid: openid,
          release_time: release_time
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })

    // 上锁成功
    if (updated != 0) {
      console.log("上锁成功");
      return {
        success: true
      }
    }

    // 重试
    console.log("reserve lock retry time: " + retry_time);
    await sleep(retry_wait_seconds);
  }

  // 上锁失败
  console.log("上锁失败");
  return {
    success:false
  }
}


async function releaseReserveLock(params) {
  const openid = params.openid;
  const reserve_date = params.reserve_date;

  await db.collection(db_reserve_lock)
    .where({
      day: reserve_date,
      openid: openid
    })
    .update({
      data: {
        release_time: new Date(0)
      }
    })
    .then(res => {
      console.log(res);
    });
    console.log("释放锁成功");
}


async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}


async function chargeReserve(params) {
  const origin_reserve_date = params.reserve_date;   // 预约日 00:00 北京时间（UTC 表示）
  let remain_need = params.reserve_cost;

  const night_card_record = await db.collection(db_card)
    .where({
      _id: night_card_id
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    });
  if (!night_card_record.data || night_card_record.data.length == 0) {
    return {
      success: false,
      errMsg: '未搜到夜场卡信息'
    }
  }

  // 夜场卡有效期：预约日 start_time 起，到 end_time 止。
  // duration.start_time/end_time 历史上可能是字符串 "HH:MM"、Date 或 { $date }，
  // 统一用公共工具解析成「北京时间时分」，避免对字符串调用 getHours()/getUTCHours() 抛错。
  const duration = night_card_record.data[0].duration || {};
  // durationMinutes 在 start_time 解析失败时回落到 start_hour/end_hour，
  // 避免 start_time: null 的卡（真实数据常见结构）算不出正确有效期。
  const startMin = durationMinutes(duration, 'start');
  const endMin = durationMinutes(duration, 'end');

  // 解析失败时退回 23:00 / 次日 10:00 的默认夜场时段，避免 NaN 写库
  const startBJMin = startMin === null ? 23 * 60 : startMin;   // 默认 23:00
  const endBJMin = endMin === null ? 10 * 60 : endMin;         // 默认 10:00

  // start_time = 预约日 00:00（北京）+ startBJMin 分钟
  const start_time = new Date(origin_reserve_date.getTime() + startBJMin * 60 * 1000);
  // end_time：结束分钟小于开始分钟说明跨天（如 23:00 ~ 次日 10:00），顺延一天
  const endOffsetMin = endBJMin < startBJMin ? endBJMin + 24 * 60 : endBJMin;
  const end_time = new Date(origin_reserve_date.getTime() + endOffsetMin * 60 * 1000);

  console.log('夜场卡时段(北京分钟):', startBJMin, '->', endBJMin,
    '| start_time:', start_time, 'end_time:', end_time);

  // 用户信息查询
  let openid = params.openid;
  let user_remain_record = await db.collection(db_user).where({
      openid: openid
    }) 
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    });

  // 信用等级不可低于85
  const credit = user_remain_record.data[0].credit;
  if (credit < 85) {
    return {
      success: false,
      errMsg: '信用等级过低',
    };
  }
  
  // lv6 预约免费
  const exp = user_remain_record.data[0].exp;
  if (exp >= 114514) {
    remain_need = 0;
  }

  // 扣费逻辑
  let extra_point = user_remain_record.data[0].extra_point;
  let real_point = user_remain_record.data[0].real_point;
  let after_extra_point = extra_point;
  let after_real_point = real_point;
  if (extra_point >= remain_need) {
    after_extra_point = extra_point - remain_need;
  } else if (real_point >= remain_need - extra_point) {
    after_real_point = real_point - (remain_need - extra_point);
    after_extra_point = 0;
  } else {
    // 余额不足
    return {
      success: false,
      errMsg: "余额不足，请充值",
    }
  }

  // 余额充足
  await db.collection(db_user)
  .where({
    openid: openid,
  })
  .update({
    data: {
      exp: db_cmd.inc(remain_need),
      real_point: after_real_point,
      extra_point : after_extra_point,
      cards: db_cmd.push({
        card_id: night_card_id,
        start_time: start_time,
        end_time: end_time
      })
    }
  })
  .then(res => {
    console.log(res);
  })

  return {
    success: true
  }
}
