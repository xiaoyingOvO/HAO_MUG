const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_meta = 'meta';
const db_cmd = db.command;
const $ = db.command.aggregate;

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

  // 查营业信息
  let meta_record = await db.collection(db_meta)
    .where({
      key: 'business_status'
    })
    .field({
      key: true,
      value: true,
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  console.log(meta_record)
  if (meta_record.data.length != 1) {
    return {
      success: false,
      errMsg: '未查询到营业状态',
    };
  }
  const business_status = meta_record.data[0].value;

  // 查用户信息（入店情况、余额信息、排队机器）
  let user_record = await db.collection(db_user)
    .where({
      openid: openid
    })
    .field({
      openid: true,
      real_point: true,
      extra_point: true,
      enter_state: true,
      enter_time: true,
      machine_id: true,
      area: true,
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  console.log(user_record)
  if (user_record.data.length != 1) {
    return {
      success: false,
      errMsg: '未查询到该用户',
    };
  }
  res = user_record.data[0];

  const count_result = await db.collection(db_user).aggregate()
    .group({
      _id: "$enter_state",
      count: $.sum(1),
    })
    .end()
  console.log(count_result)
  
  const play_result = count_result.list.find(a => a._id > 1)
  const play_num = play_result != null ? play_result.count : 0;
  console.log('游玩中/候机人数:', play_num)

  // 三区域人数（**互斥分区**：休息区 + 音游区 + 桌游区 = 店内总人数）
  //   休息区 = enter_state 1（休息中：没排队、没上机，两个区都算）
  //   桌游区 = area 'board' 且 enter_state > 1（排上日麻 2 / 上桌游玩 3）
  //   音游区 = 非 board 且 enter_state > 1（候机 2 / 游玩 3）
  //   老数据没有 area 字段时按音游区计
  // 表示「当前在干什么」而不是「人在哪个房间」：
  //   桌游区排队中 → 桌游区；在日麻队列里退队 → 回到休息区（人仍在桌游区，可再排）
  // ⚠️ 必须按「area + enter_state」复合分组，只按 area 分组分不出休息区。
  const area_result = await db.collection(db_user).aggregate()
    .match({
      enter_state: db_cmd.gte(1) // 只统计已在店内的人
    })
    .group({
      _id: { area: "$area", state: "$enter_state" },
      count: $.sum(1),
    })
    .end()
  console.log('分区域统计:', area_result)

  let arcade_num = 0;
  let board_num = 0;
  let relax_num = 0;
  for (const a of area_result.list) {
    const area = a._id && a._id.area === 'board' ? 'board' : 'arcade';
    const state = Number(a._id && a._id.state) || 0;
    if (state === 1) relax_num += a.count;             // 休息区：没排队、没上机
    else if (area === 'board') board_num += a.count; // 桌游区：排上日麻 / 上桌游玩
    else arcade_num += a.count;                        // 音游区：候机 / 游玩
  }
  console.log('音游区人数:', arcade_num, '桌游区人数:', board_num, '休息区人数:', relax_num)

  res.relax_num = relax_num
  res.play_num = play_num
  res.arcade_num = arcade_num
  res.board_num = board_num
  res.business_status = business_status
  // 当前所在区域：'arcade' 音游区 / 'board' 桌游区。老数据没有该字段时按音游区处理
  res.area = res.area === 'board' ? 'board' : 'arcade'
  return {
    success: true,
    data: res,
  };
};
