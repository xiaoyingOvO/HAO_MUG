const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_card = 'card'
const db_cmd = db.command;

// 获取入店情况云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
  const current_time = new Date(); // 获取当前时间
  const hours = current_time.getHours(); // 获取当前小时（24小时制）
  console.log(hours)
  var night = false
  var hasCard = false
  if ((hours >= 23 && hours <= 24) || (hours >= 0 && hours <= 9)) {
      night = true;
  }
  let user_record = await db.collection(db_user)
    .where({
      openid: openid
    })
    .field({
      openid: true,
      cards: true
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  let cards = user_record?.data?.[0]?.cards ?? [];
  for(let i = 0 ; i < cards.length ; i++){
      var start_time = cards[i].start_time
      var end_time = cards[i].end_time
      console.log('start_time:', start_time, 'end_time:', end_time)
      // 现在的时间在优惠卡有效期内
      if(current_time >= start_time && current_time <= end_time){
        hasCard = true
        // var card_id = cards[i].card_id
        // // 查询优惠卡具体信息
        // let card_info = await db.collection(db_card).where({
        //   _id: card_id
        // }).get({
        //   success: function (res) {
        //     console.log('success!!!')
        //     return res
        //   },
        //   fail: console.error
        // })
        // if (card_info.data[0].card_name == "夜场"){
        //   hasCard = true
        //   break
        // } 
      }
  }
  return {
    success: true,
    data: {
      ifNight : night,
      hasCard : hasCard
    }
  }
};