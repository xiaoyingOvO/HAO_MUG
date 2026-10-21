const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_user = 'user';

// 删除优惠卡云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  const card_id = event.params.card_id;
  console.log('openid: ' + openid + '; card_id: ' + card_id);

  // 查卡持续天数和余量
  let card_record = await db.collection(db_card)
    .where({
      _id: card_id
    })
    .field({
      remain: true
    })
    .get({
      success: function (res) {
        console.log('success!!!');
        return res;
      },
      fail: console.error
    });
    
  console.log(card_record);
  if (card_record == null || card_record.data.length == 0) {
    console.log("该优惠卡不存在");
    return {
      success: false,
      errMsg: "该优惠卡不存在"
    };
  }

  const remain = card_record.data[0].remain;

  // 回滚用户表信息
  let updated = 0;
  await db.collection(db_user)
    .where({
      openid: openid
    })
    .update({
      data: {
        cards: db_cmd.pull({
          card_id: card_id
        })
      }
    })
    .then(res => {
      updated = res.stats.updated;
      console.log(res);
    })

  if (updated == 0) {
    return {
      success: false,
      errMsg: "用户不存在或未拥有该荣誉卡"
    };
  }

  // 如果是余量优惠卡，回滚优惠卡表
  if (remain >= 0) {
    await db.collection(db_card)
    .where({
      _id: card_id,
      remain: db_cmd.gte(0)
    })
    .update({
      data: {
        remain: db_cmd.inc(1)
      }
    })
    .then(res => {
      console.log(res);
    })
  }

  return {
    success: true
  };
};
