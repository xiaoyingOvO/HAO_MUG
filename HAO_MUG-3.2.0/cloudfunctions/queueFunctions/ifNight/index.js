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
// 早八畅玩套餐：08:00-10:00，落在夜场判定区间（bjHour < 10）内，需单独识别以免被「夜场请预约」拦下
const MORNING_CARD_ID = 'ab52283f6783807201221ba02db6611e';    // 早八畅玩套餐（08:00-10:00）

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
  const current_time = new Date(); // 获取当前时间（UTC）
  // 云函数跑在 UTC 时区，getHours() 拿到的是 UTC 小时，必须转成北京时间再判断夜场
  const bjNow = new Date(current_time.getTime() + 8 * 3600 * 1000)
  const bjHour = bjNow.getUTCHours()
  console.log('UTC hours:', current_time.getHours(), 'BJ hours:', bjHour)

  var night = false
  var hasCard = false
  // 是否处于早八时段（北京时间 08:00 ~ 09:59）
  var isMorning = (bjHour >= 8 && bjHour < 10)
  // 夜场时段（北京时间）：23:00 ~ 次日 09:59
  if (bjHour >= 23 || bjHour < 10) {
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
      // 只认「夜场票」「夜场桌游麻将票」两张卡（按 card_id 判断），
      // 且当前时间在其有效期内。其他卡（日间/全天畅玩、日场桌游麻将票等）不构成夜场入店资格。
      const isNightCard = (card_id === NIGHT_CARD_ID) || (BOARD_NIGHT_CARD_ID && card_id === BOARD_NIGHT_CARD_ID)
      if (isNightCard && current_time >= start_time && current_time <= end_time){
        hasCard = true
        break
      }
      // 早八票：仅在早八时段（08:00-10:00）内，且卡在有效期内 → 视为可入店（与夜场票同等放行）
      const isMorningCard = (MORNING_CARD_ID && card_id === MORNING_CARD_ID)
      if (isMorningCard && isMorning && current_time >= start_time && current_time <= end_time){
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