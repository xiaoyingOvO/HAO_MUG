// cloudfunctions/scheduledTask/index.js
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database()
const db_cmd = db.command
const db_user = "user"
const db_card = "card"
const page_size = 50

// 区域
const AREA_ARCADE = 'arcade'   // 音游区：23 点强制离店（老版行为）
const AREA_BOARD = 'board'     // 桌游区：23 点**不**强制离店，继续计费（一把时间可能过长）

exports.main = async (event, context) => {
  console.log('---schedule_task---')
  console.log('定时任务触发时间:', new Date());
  // 获取强制退店参数
  const leave_arcade_force = "leave_arcade_force" in event ? 
    Boolean(event.leave_arcade_force) : false;
  // 获取有存量的卡表
  var card_result = await db.collection(db_card).where({
    remain: db.command.neq(-100)
  }).get({
    success: function (res) {
      return res
    },
    fail: console.error
  })
  // 遍历卡表，设置map
  var card_map = new Map()
  for (let i = 0 ; i < card_result.data.length ; i++){
    card_map.set(card_result.data[i]._id,0)
  }
  console.log("卡表",card_map)
  // 分页获取全用户
  var total = await getTotalCount(db_user, {})
  console.log('user count:', total)

  var user_datas = []
  const page_times = Math.ceil(total / page_size);
  for (let page_no = 0; page_no < page_times; page_no++) {
    const user_result = await paginationQuery(db_user, page_no, page_size, {})
    user_datas.push(...user_result.data)
    console.log('query user page:', page_no)
  }
  console.log('user data count:', user_datas.length)
  
  // 遍历用户
  for(var i = 0 ; i < user_datas.length ; i++) {
    var cards = user_datas[i].cards
    var updateCards = []

    var current_time = new Date()
    const time_10 = await customTime(10, 0, 0, 0)
    const time_23 = await customTime(23, 0, 0, 0)

    if (user_datas[i].enter_state >= 1) {
      console.log('店内用户:', user_datas[i])
      var cardFlag = false

      // 入店区域：老数据没有 area 字段时按音游区处理
      var area = user_datas[i].area === AREA_BOARD ? AREA_BOARD : AREA_ARCADE
      var isBoard = area === AREA_BOARD
      // 23 点强制离店：只对音游区生效。
      //   桌游区一把时间可能过长，23 点后不离店、继续计费，等用户自己离店时结算。
      //   （管理员手动强制离店 leave_arcade_force 仍然对所有区域生效）
      if (leave_arcade_force || (current_time >= time_23 && !isBoard)) {
        // --定时任务2--：23 点强制离店或自定义强制离店
        // 用户正在排队,退队
        if (user_datas[i].enter_state == 3 || user_datas[i].enter_state == 2){
          const waitQueueResult = await cloud.callFunction({
            name: 'queueFunctions', // 被调用云函数的名称
            data: {
              type: "Dequeue",
              params:{
                openid : user_datas[i].openid,
                machine_id : user_datas[i].machine_id
              }
            },
          })
          console.log('退队:', user_datas[i].openid)
        }
        // 退店
        const leaveArcadeResult = await cloud.callFunction({
          name: 'queueFunctions', // 被调用云函数的名称
          data: {
            type : "leaveArcade",
            params:{
              openid : user_datas[i].openid
            }
          },
        })
        console.log('退店:', user_datas[i].openid)
      } else if (current_time >= time_10 && !isBoard) {
        // --定时任务1--：10 点修改 enter_time（仅音游区）
        // 桌游区**不重置**：桌游区跨夜继续计费，若在这里把 enter_time 改成今天 10:00，
        // 会把整夜的游玩时长抹掉、费用清零，与「23 点后继续计费」的规则冲突。
        await db.collection(db_user)
          .where({
            enter_state: db_cmd.gte(1),
            enter_time: db_cmd.lte(time_10),
            openid: user_datas[i].openid,
          })
          .limit(1)
          .update({
            data: {
              enter_time: time_10
            }
          })
          .then(res => {
            console.log(res);
          });
        console.log("更新入店时间:", user_datas[i].openid);
      }
    }

    for(var j = 0 ; j < cards.length ; j++){
      // --定时任务3--：过期卡清除
      current_time = new Date()
      var cardsID = cards[j].card_id
      // 卡未被使用
      if (current_time <= cards[j].end_time){
        updateCards.push(cards[j])
        console.log("有效的卡",updateCards)
      } else {
        cardFlag = true
        // 卡不在有效期内且卡有余量限制
        if(card_map.has(cardsID)){
          card_map.set(cardsID,card_map.get(cardsID) + 1)
        }
      }
    }
    
    if (cardFlag) {
      await db.collection(db_user).where({
        openid: user_datas[i].openid
      }).update({
        data: {
          cards: updateCards
        }
      }).then(res => {
        // console.log(res);
      })
      console.log('用户卡信息更新成功:', user_datas[i].openid)
    }
  }

  console.log("更新后卡表",card_map)
  // 卡余量加回
  for (const [k, v] of card_map) {
    await db.collection(db_card).where({
      _id: k
    }).update({
      data: {
        remain: db.command.inc(v)
      }
    }).then(res => {
      updated = res.stats.updated;
      console.log(res);
    })
  }
  
  return {
    success: true,
    errMsg: "定时任务触发成功",
  }
};

async function getTotalCount(db_name, condition) {
  const countResult = await db.collection(db_name)
    .where(condition)
    .count()
  return countResult.total
}

// page_no 从 0 开始
async function paginationQuery(db_name, page_no, page_size, condition) {
  return await db.collection(db_name)
    .where(condition)
    .skip(page_no * page_size)
    .limit(page_size)
    .get({
      success: function (res) {
        return res
      },
      fail: console.error
    })
}

async function customTime(hours, minutes, seconds, milliseconds) {
  var my_time = new Date()
  my_time.setHours(hours)
  my_time.setMinutes(minutes)
  my_time.setSeconds(seconds)
  my_time.setMilliseconds(milliseconds)
  return my_time
}