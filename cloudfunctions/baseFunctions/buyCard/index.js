const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_user = 'user';
const db_card_lock = 'card_lock';

const { toBJHour, toBJMinutes, nowBJMinutes, durationMinutes } = require('../timeUtil');

const max_retry_time = 5;
const retry_wait_seconds = 0.5;
const max_card_lock_seconds = 2;

// Lv6 阈值：exp >= 114514 免单。
// 与 buyReserve / getConsumePoint / enterArcade 用的是同一个边界，改这里要同步改那边。
const MAX_LEVEL_EXP = 114514;

// 购买优惠卡云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  console.log('openid: ' + openid);

  // 获取卡信息，优先用id，否则name
  let card_id = 'card_id' in event.params ? event.params.card_id : "";
  const card_name = card_id == "" ? event.params.card_name : "";
  if (card_id == "" && card_name == "") {
    return {
      success: false,
      errMsg: '未传入优惠卡信息'
    }
  }
  console.log('card_id: ' + card_id, '; card_name: ' + card_name);

  // 第一次获取卡持续天数和余量
  var res = await getUserAndCardInfo({
    openid: openid,
    card_id: card_id,
    card_name: card_name
  });
  if (res.success == false) {
    return res
  }
  card_id = res.data.card_id;
  const cardCost = res.data.cost;
  const initialRemain = res.data.remain;
  let userCardInfo = res.data.card;
  let durationInfo = res.data.duration;


  // 如果有余量限制，需分布式锁阶段
  // needLock 单独记标志：后面 res 会被 recordBuyInfo 的返回值覆盖，
  // 原来用 res.data.remain 判断「要不要释放锁」，一旦购买失败（res.data 为空）
  // 就会在这里抛 Cannot read properties of undefined。
  let needLock = false;
  if (res.data.remain > 0) {
    needLock = true;
    // 尝试获取分布式锁
    let lockRes = await acquireCardLock({
      openid: openid,
      card_id: card_id
    });

    if (!lockRes.success) {
      return {
        success: false,
        errMsg: "购买人数太多，购买失败，请重试...",
        data: {
          remain: res.data.remain
        }
      }
    }

    // 第二次获取卡持续天数和余量
    res = await getUserAndCardInfo({
      openid: openid,
      card_id: card_id,
      card_name: card_name
    });
    if (res.success == false) {
        // 这里原来写的是 cardCost: card_id，参数名不对，锁实际没释放掉
        await releaseCardLock({
            openid: openid,
            card_id: card_id
        });
        return res;
    }
    const currentRemain = res.data.remain;
    userCardInfo = res.data.card;
    durationInfo = res.data.duration;
  }

  // 添加信息至数据库
  res = await recordBuyInfo({
    openid: openid,
    card_id: card_id,
    card: res.data.card,
    duration: res.data.duration,
    remain: res.data.remain,
    cost: cardCost
  });

  // 加过锁就释放，成功失败都要放。
  // 原来只在成功且 res.data.remain > 0 时释放，失败时锁要等 2 秒超时才失效，
  // 这段时间别人买这张限量卡会一直看到「购买人数太多」。
  if (needLock) {
    await releaseCardLock({
      openid: openid,
      card_id: card_id
    })
  }

  return res;
};


async function getUserAndCardInfo(params) {
  const openid = params.openid;
  const card_name = params.card_name;
  let card_id = params.card_id;

  // 查卡持续天数和余量
  let card_record = await db.collection(db_card)
    .where(db_cmd.or([
      {
        _id: card_id
      },
      {
        card_name: card_name
      },
    ]))
    .field({
      _id: true,
      card_name: true,
      duration: true,
      remain: true,
      cost: true,
      is_deleted: true,
      is_hidden: true
    })
    .get();
    
  console.log(card_record);
  
  if (!card_record?.data?.length) {
    console.log("该优惠卡不存在");
    return {
      success: false,
      errMsg: "该优惠卡不存在"
    };
  }

  // 下架 / 已删除的卡禁止购买。
  // getCardInfo 已经不把它们返回给前端，这里再校验一次，防止有人直接构造 card_id 调用云函数绕过。
  // 注意：is_hidden 只拦「购买」，不拦「使用」——存量持卡人进店/计费仍按原逻辑走。
  const cardRow = card_record.data[0];
  if (cardRow.is_deleted === true || cardRow.is_hidden === true) {
    console.log("该优惠卡已下架:", cardRow._id);
    return {
      success: false,
      errMsg: "该优惠卡已下架"
    };
  }
  
  card_id = card_record.data[0]._id;
  const duration = card_record.data[0].duration;
  const remain = card_record.data[0].remain;
  const cost = card_record.data[0].cost;
  const cardCost = (typeof cost === 'number' && cost >= 0) ? cost : 0;
  console.log("card_id:", card_id, "duration:", duration,
    "remain:", remain, "cost:", cardCost);

  // 防御式校验优惠卡余量
  if (remain !== undefined && remain <= 0 && remain > -100) {
    console.log("该优惠卡已售罄");
    return {
      success: false,
      errMsg: "该优惠卡已售罄",
      data: {
        remain: remain
      }
    }
  }

  // 校验今日还能否使用该卡（兼容字符串/Date/$date 多种时段存法）
  // 支持跨天时段：startMin > endMin 表示跨天（如夜场 23:00-次日 10:00）
  if (duration && duration.type == 0) {
    const nowMin = nowBJMinutes(new Date());
    // durationMinutes 会在 start_time 解析失败时回落到 start_hour/end_hour。
    // 若直接用 toBJMinutes(duration.start_time)，真实数据里的 start_time: null 会得到 null，
    // 导致下面 inRange 恒为 false → 明明是可购买时段却报「当前不在可购买时段」，买不了卡。
    const startMin = durationMinutes(duration, 'start');
    const endMin = durationMinutes(duration, 'end');

    let inRange = false;
    if (startMin !== null && endMin !== null) {
      if (startMin < endMin) {
        // 不跨天：如 10:00-17:00
        inRange = nowMin >= startMin && nowMin < endMin;
      } else {
        // 跨天：如 23:00-次日 10:00（startMin=1380, endMin=600）
        inRange = nowMin >= startMin || nowMin < endMin;
      }
    }

    if (!inRange) {
      return {
        success: false,
        errMsg: "当前不在可购买时段"
      };
    }
  }

  // user查询用户卡信息
  let user_record = await db.collection(db_user)
    .where({
      openid: openid
    })
    .field({
      cards: true
    })
    .limit(1)
    .get();
  console.log(user_record);

  if (user_record == null ||  user_record.data.length == 0) {
    console.log("用户不存在");
    return {
      success: false,
      errMsg: "用户不存在",
      data: {
        remain: remain
      }
    };
  }

  let card = null;
  const user_cards = user_record.data[0].cards;
  if (Array.isArray(user_cards)) {
      // 查找卡，并确保找到的 item 和 item.end_time 存在且为 Date 对象
      card = user_cards.find(item =>
        item && item.card_id === card_id && item.end_time instanceof Date
        );
  } else {
      console.log(`用户 ${openid} 不包含 'cards' 字段或不是一个数组`);
  }
  console.log('card:', card);

  now = new Date();
  if (card != null && now < card.end_time) {
    console.log("已有该优惠卡");
    return {
      success: false,
      errMsg: "已有该优惠卡",
      data: {
        remain: remain
      }
    };
  } 
  
  return {
      success: true,
      data: {
          duration: duration,
          remain: remain,
          card_id: card_id,
          card: card,
          cost: cardCost,
      }
  };
}

async function acquireCardLock(params) {
  const openid = params.openid;
  const card_id = params.card_id;

  let updated = 0;
  // 重试流程
  for (var retry_time = 1; retry_time <= max_retry_time; retry_time++) {
    // 查询分布式锁当前状况
    let card_lock_record = await db.collection(db_card_lock)
      .where({
        card_id: card_id,
      })
      .field({
        openid: true,
        release_time: true
      })
      .get({
        success: function (res) {
          console.log('query card lock success!!!');
          return res;
        },
        fail: console.error
      });
    
    // 如果锁不存在，报错
    if (card_lock_record != null && card_lock_record.data.length == 0) {
      console.log("该优惠卡分布式锁不存在");
      return {
        success: false,
        errMsg: "该优惠卡分布式锁不存在，请联系管理员！"
      };
    }

    const old_openid = card_lock_record.data[0].openid;
    const old_release_time = card_lock_record.data[0].release_time;
    // 锁被其他占有，重试
    const release_time = new Date();
    if (old_openid != openid && release_time < old_release_time) {
      console.log("card lock retry time: " + retry_time);
      await sleep(retry_wait_seconds);
      continue;
    }

    // CAS尝试获取分布式锁
    release_time.setSeconds(release_time.getSeconds() + max_card_lock_seconds);
    await db.collection(db_card_lock)
      .where({
        card_id: card_id,
        openid: old_openid,
        release_time: old_release_time
      })
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
    console.log("card lock retry time: " + retry_time);
    await sleep(retry_wait_seconds);
  }

  // 上锁失败
  console.log("上锁失败");
  return {
    success:false
  }
}


async function releaseCardLock(params) {
  const openid = params.openid;
  const card_id = params.card_id;

  await db.collection(db_card_lock)
    .where({
      card_id: card_id,
      openid: openid
    })
    .limit(1)
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


async function calStartEndTime(duration) {
  // 云函数跑在 UTC 时区，而所有卡的时段语义都是「北京时间」。
  // 用「当前北京时间」定日期，再按 BJ = UTC + 8 反推出 UTC 时间戳写库，
  // 避免出现「UTC 日期还没到 / 已经过了」导致卡在正确时段内却无法使用的问题。
  const nowUTC = new Date();
  const nowBJ = new Date(nowUTC.getTime() + 8 * 60 * 60 * 1000);
  // 取北京时间的年月日（nowBJ 是偏移后的 Date，用 UTC 取值即为北京时间）
  const bjY = nowBJ.getUTCFullYear();
  const bjM = nowBJ.getUTCMonth();
  const bjD = nowBJ.getUTCDate();
  console.log('now_date (UTC):', nowUTC, 'now (BJ):', nowBJ, 'BJ date:', bjY, bjM + 1, bjD);

  // 把「北京时间 Y-M-D h:m」转成真正的 UTC 时间戳
  // Date.UTC 会自动处理小时为负（即往前退一天）的情况
  const bjToDate = (hour, minute) =>
    new Date(Date.UTC(bjY, bjM, bjD, hour - 8, minute, 0, 0));

  let start_time;
  let end_time;

  if (duration.type == 0) {
    // 时段卡：duration.start_time/end_time 历史上可能是字符串 "HH:MM"、Date 或 { $date }，
    // 统一用公共工具解析成「北京时间时分」，避免对字符串调用 getHours() 抛错。
    //
    // ⚠️ 必须用 durationMinutes（解析失败时回落到 start_hour/end_hour）：
    //   真实数据形如 { type: 0, start_hour: 8, end_hour: 10, start_time: null, end_time: null }，
    //   直接 toBJMinutes(duration.start_time) 会拿到 null → 落到下面的 0 兜底 →
    //   start_time == end_time == 今天 00:00，有效期长度为零，卡买了等于没买。
    const sm = durationMinutes(duration, 'start');
    const em = durationMinutes(duration, 'end');
    const startHour = sm === null ? 0 : Math.floor(sm / 60);
    const startMin = sm === null ? 0 : sm % 60;
    const endHour = em === null ? 0 : Math.floor(em / 60);
    const endMin = em === null ? 0 : em % 60;

    start_time = bjToDate(startHour, startMin);
    end_time = bjToDate(endHour, endMin);

    // 跨天时段（如夜场 23:00 ~ 次日 10:00）：结束时间顺延一天
    if (em !== null && sm !== null && em <= sm) {
      end_time = new Date(end_time.getTime() + 24 * 60 * 60 * 1000);

      // 关键：如果「当前时刻」已经落在本场的次日段（如凌晨 00:30 买夜场票），
      // 用户要进的是「昨晚 23:00 开始」的那一场，而不是今晚 23:00 才开始的那一场。
      // 不往前推一天的话，买完要等近 23 小时卡才生效，
      // 表现为主页一直提示「夜场请预约」、无法入店。
      const nowMin = nowBJ.getUTCHours() * 60 + nowBJ.getUTCMinutes();
      if (nowMin < em) {
        console.log('跨天卡处于次日段，有效期整体前移一天。nowMin:', nowMin, 'endMin:', em);
        start_time = new Date(start_time.getTime() - 24 * 60 * 60 * 1000);
        end_time = new Date(end_time.getTime() - 24 * 60 * 60 * 1000);
      }
    }
  } else if (duration.type == 1) {
    // 天数卡：从今天 10:00（北京时间）开始，持续 duration.days 天，最后一天 22:00 结束
    start_time = bjToDate(10, 0);
    const endBase = bjToDate(22, 0);
    const days = (typeof duration.days === 'number' && duration.days > 0) ? duration.days : 1;
    end_time = new Date(endBase.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
  } else {
    // 未知类型：给一个保底值，避免写库时为 undefined
    start_time = nowUTC;
    end_time = nowUTC;
  }

  console.log('start_time:', start_time, 'end_time:', end_time);

  return {
    start_time: start_time,
    end_time: end_time
  };
}


async function recordBuyInfo(params) {
  const openid = params.openid;
  const card_id = params.card_id;
  const card = params.card;
  const duration = params.duration;
  const remain = params.remain;
  const cost = params.cost;

  let currentUserPoints = { real_point: 0, extra_point: 0, exp: 0 };
  try {
      const userPointsRecord = await db.collection(db_user)
        .where({ openid: openid })
        .field({ real_point: true, extra_point: true, exp: true })
        .limit(1)
        .get();

        if (userPointsRecord?.data?.length > 0) {
            currentUserPoints = userPointsRecord.data[0];
            currentUserPoints.real_point = Number(currentUserPoints.real_point) || 0;
            currentUserPoints.extra_point = Number(currentUserPoints.extra_point) || 0;
            currentUserPoints.exp = Number(currentUserPoints.exp) || 0;
        } else {
            return {
                success: false,
                errMsg: '用户信息异常，无法扣除点数'
            };
        }
  } catch(err) {
      return {
          success: false,
          errMsg: '查询用户点数失败'
      };
  }

  // Lv6 免单：买优惠卡不消耗点数。
  // 边界与 buyReserve / getConsumePoint / enterArcade 一致，统一用 exp >= 114514。
  // 原先这里没有判断，Lv6 因为平时消费全免、余额很低，买卡会直接报「点数不足」买不了。
  const isLv6 = currentUserPoints.exp >= MAX_LEVEL_EXP;
  const effectiveCost = isLv6 ? 0 : cost;

  const totalPoints = currentUserPoints.real_point + currentUserPoints.extra_point;
  if (totalPoints < effectiveCost) {
      return {
          success: false,
          errMsg: `点数不足，需要 ${effectiveCost}, 当前 ${totalPoints}`
      };
  }

  let after_extra_point = currentUserPoints.extra_point;
  let after_real_point = currentUserPoints.real_point;
  let remaining_cost = effectiveCost;

  if (after_extra_point >= remaining_cost) {
    after_extra_point -= remaining_cost;
    remaining_cost = 0;
  } else {
    remaining_cost -= after_extra_point;
    after_extra_point = 0;
  }
  after_real_point -= remaining_cost;

  console.log('扣除后的点数：', {real_point: after_real_point, extra_point: after_extra_point });


  // 计算结束时间
  const {start_time, end_time} = await calStartEndTime(duration);
  let updateResult;
  try {
      if (card) {
          updateResult = await db.collection(db_user)
            .where({
                openid: openid,
                'cards.card_id': card_id,
            })
            .update({
                data: {
                    real_point: after_real_point,
                    extra_point: after_extra_point,
                    'cards.$.start_time': start_time,
                    'cards.$.end_time': end_time,
                }
            });
      } else {
          updateResult = await db.collection(db_user)
            .where({ openid: openid })
            .update({
                data: {
                    real_point: after_real_point,
                    extra_point: after_extra_point,
                    cards: db_cmd.push({
                        card_id: card_id,
                        start_time: start_time,
                        end_time: end_time,
                    })
                }
            });
      }
  } catch (err) {
      return {
          success: false,
          errMsg: '更新用户信息失败'
      };
  }


//   if (card != null) {
//     // 如果有超时的相同卡，直接更新
//     await db.collection(db_user)
//       .where({
//         openid: openid,
//         'cards.$[]': {
//           card_id: card_id,
//           start_time: card.start_time,
//           end_time: card.end_time
//         }
//       })
//       .update({
//         data: {
//           'cards.$[].start_time': start_time,
//           'cards.$[].end_time': end_time
//         }
//       })
//       .then(res => {
//         console.log(res);
//       })
//   } else {
//     // 如果没该卡，插入新卡
//     await db.collection(db_user)
//       .where({
//         openid: openid
//       })
//       .update({
//         data: {
//           cards: db_cmd.push({
//             card_id: card_id,
//             start_time: start_time,
//             end_time: end_time
//           })
//         }
//       })
//       .then(res => {
//         console.log(res);
//       })
//   }

  // 如果限量，card表更新remain信息
  if (remain != undefined && remain > 0)  {
      try {
          const remainUpdateResult = await db.collection(db_card)
            .where({ _id: card_id })
            .update({
                data: {
                    remain: db_cmd.inc(-1)
                }
            });
      } catch (err) {
          console.error(`更新卡片时出错 ${card_id}:`, err);
          console.error(`CRITICAL: 成功购买后无法减少 ${card_id} 的余额`);
      }
  }

  console.log("购买完成！");
  return {
    success: true,
    data: {
      openid: openid,
      card_id: card_id,
      start_time: start_time,
      end_time: end_time,
      remain: (remain != undefined && remain > -100 && remain >= 0) ? remain - 1 : remain,
      new_real_point: after_real_point,
      new_extra_point: after_extra_point,
    }
  };
}