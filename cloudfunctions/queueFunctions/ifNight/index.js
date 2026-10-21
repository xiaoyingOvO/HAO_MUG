const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_card = 'card'
const db_cmd = db.command;

// 夜场可入店的两类卡：夜场票（预约/临时购买）+ 夜场桌游麻将票
const NIGHT_CARD_ID = 'e33be08d678e255a0189586d3b0d8a79';      // 夜场票
const BOARD_NIGHT_CARD_ID = 'df40db4d6ad4af26010239057dae6a3c';   // 桌游麻将票·夜场（23:00-次日10:00）

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
      var card_id = cards[i].card_id
      console.log('start_time:', start_time, 'end_time:', end_time, 'card_id:', card_id)
      // 只认「夜场票」和「夜场桌游麻将票」两张卡（按 card_id 判断），
      // 且当前时间在其有效期内。其他卡（日间/全天畅玩、日场桌游麻将票等）不构成夜场入店资格。
      const isNightCard = (card_id === NIGHT_CARD_ID) || (BOARD_NIGHT_CARD_ID && card_id === BOARD_NIGHT_CARD_ID)
      if (isNightCard && current_time >= start_time && current_time <= end_time){
        hasCard = true
        break
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