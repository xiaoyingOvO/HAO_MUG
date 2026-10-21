const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_card_lock = 'card_lock';

// 购买优惠卡云函数入口
exports.main = async (event, context) => {
  // 获取优惠卡信息
  const card_name = event.params.card_name;
  const trial = event.params.trial;
  const discount = event.params.discount;
  const duration = event.params.duration;
  const remain = event.params.remain;
  const cost = event.params.cost;

  const type = duration.type;
  let desc = "${card_name}：";
  if (type == 0) {
    desc = "${desc}${cost}元//(${duration.start_hour}:00-{duration.end_hour}:00)";
  } else if (type == 1) {
    desc = "${desc}${cost}元//${duration.days}天";
  }

  console.log('card_name: ' + card_name +
    'trial: ' + trial +
    'discount: ' + discount +
    'duration: ' + duration +
    'remain: ' + remain +
    'cost: ' + cost +
    'desc: ' + desc);

  // 将新卡信息添加至数据库
  let res = "";
  await db.collection(db_card)
    .add({
      data: {
        card_name: card_name,
        trial: trial,
        discount: discount,
        duration: duration,
        remain: remain,
        cost: cost,
        desc: desc,
      },
      success: function(tmp_res) {
        res = tmp_res;
        console.log(tmp_res);
      },
      fail: console.error,
      complete: console.log
    })

  // 如果有总量限制，更新card_lock表
  if (remain > 0) {
    await db.collection(db_card_lock)
      .add({
        data: {
          card_id: res._id,
          openid: "xx",
          release_time: new Date(0),
        },
        success: function(tmp_res) {
          console.log(tmp_res)
        },
        fail: console.error,
        complete: console.log
      })
  }

  return {
    success: true
  };
};
