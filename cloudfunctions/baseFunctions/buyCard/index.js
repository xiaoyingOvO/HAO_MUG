const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_user = 'user';
const db_card_lock = 'card_lock';

const max_retry_time = 5;
const retry_wait_seconds = 0.5;
const max_card_lock_seconds = 2;

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
  if (res.data.remain > 0) {
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
        await releaseCardLock({
            openid: openid,
            cardCost: card_id
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

  // 如果获取过锁，更新完释放锁
  if (res.data.remain > 0) {
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
      duration: true,
      remain: true,
      cost: true
    })
    .get();
    
  console.log(card_record);
  
  if (!card_record?.data?.length > 0) {       // card_record == null || card_record.data.length == 0
    console.log("该优惠卡不存在");
    return {
      success: false,
      errMsg: "该优惠卡不存在"
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

  // 校验今日还能否使用该卡
  let now = new Date();
  if (duration.type == 0) {
    let tmp_time = new Date(now);
    tmp_time.setHours(duration.end_time.getHours());
    tmp_time.setMinutes(duration.end_time.getMinutes());
    tmp_time.setSeconds(duration.end_time.getSeconds());
    tmp_time.setMilliseconds(duration.end_time.getMilliseconds());
    console.log('can_buy -- now:', now, 'end_time:', tmp_time);
    if (now >= tmp_time) {
      return {
        success: false,
        errMsg: "今日已无法使用该优惠卡"
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
  // var card = user_record.data[0].cards.find(item => card_id == item.card_id); 
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

//   var card = user_record.data[0].cards.find(item => card_id == item.card_id); 
//   console.log('card:', card);
//   const now = new Date();
//   let tmp_time = new Date(now);
//   tmp_time.setFullYear(card.end_time.getFullYear());
//   tmp_time.setMonth(card.end_time.getMonth());
//   tmp_time.setDate(card.end_time.getDate());
//   if (card != null && now < card.end_time) {
//     console.log("已有该优惠卡");
//     return {
//       success: false,
//       errMsg: "已有该优惠卡",
//       data: {
//         remain: remain
//       }
//     };
//   } else if (tmp_time > card.end_time) {
//     return {
//       success: false,
//       errMsg: "今日已无法使用该优惠卡"
//     };
//   }

//   return {
//     success: true,
//     data: {
//       duration: duration,
//       remain: remain,
//       card_id: card_id
//     }
//   }
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
  let start_time = new Date();
  let end_time = new Date();
  console.log("now_date:", start_time);

  if (duration.type == 0) {
    start_time.setHours(duration.start_time.getHours());
    start_time.setMinutes(duration.start_time.getMinutes());
    start_time.setSeconds(duration.start_time.getSeconds());
    end_time.setHours(duration.end_time.getHours());
    end_time.setMinutes(duration.end_time.getMinutes());
    end_time.setSeconds(duration.end_time.getSeconds());
  } else if (duration.type == 1) {
    start_time.setHours(10);
    start_time.setMinutes(0);
    start_time.setSeconds(0);
    end_time.setDate(end_time.getDate() + duration.days - 1);
    end_time.setHours(22);
    end_time.setMinutes(0);
    end_time.setSeconds(0);
  }
  console.log("start_time:", start_time, "end_time:", end_time);

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

  let currentUserPoints = { real_point: 0, extra_point: 0 };
  try {
      const userPointsRecord = await db.collection(db_user)
        .where({ openid: openid })
        .field({ real_point: true, extra_point: true })
        .limit(1)
        .get();

        if (userPointsRecord?.data?.length > 0) {
            currentUserPoints = userPointsRecord.data[0];
            currentUserPoints.real_point = Number(currentUserPoints.real_point) || 0;
            currentUserPoints.extra_point = Number(currentUserPoints.extra_point) || 0;
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

  const totalPoints = currentUserPoints.real_point + currentUserPoints.extra_point;
  if (totalPoints < cost) {
      return {
          success: false,
          errMsg: `点数不足，需要 ${cost}, 当前 ${totalPoints}`
      };
  }

  let after_extra_point = currentUserPoints.extra_point;
  let after_real_point = currentUserPoints.real_point;
  let remaining_cost = cost;

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

//   if (remain > 0) {
//     await db.collection(db_card)
//     .where({
//       _id: card_id
//     })
//     .update({
//       data: {
//         remain: db_cmd.inc(-1)
//       }
//     })
//     .then(res => {
//       console.log(res);
//     })
//   }
  
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