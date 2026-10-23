const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = 'user';
const db_meta = 'meta';

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
  // lite = true：调用方只要本人的入店状态，不需要三个区的人数统计。
  //   排卡页就走这条 —— 能把「2 次串行数据库往返」压成 1 次，首屏少等一次网络。
  const lite = !!(event.params && event.params.lite)

  // 并行查营业状态和用户信息
  const [meta_record, user_record] = await Promise.all([
    db.collection(db_meta).where({ key: 'business_status' }).field({ key: true, value: true }).get(),
    db.collection(db_user).where({ openid: openid }).field({
      openid: true, real_point: true, extra_point: true, enter_state: true,
      enter_time: true, machine_id: true, area: true,
    }).get()
  ])

  if (meta_record.data.length != 1) {
    return { success: false, errMsg: '未查询到营业状态' };
  }
  const business_status = meta_record.data[0].value;

  if (user_record.data.length != 1) {
    return { success: false, errMsg: '未查询到该用户' };
  }
  const res = user_record.data[0];

  // 人数统计：用轻量级 count 查询（不 aggregate 全表扫描）
  // 互斥分区：休息区(state=1) / 桌游区(area=board, state>1) / 音游区(area≠board, state>1)
  let relaxR = { total: 0 }, boardR = { total: 0 }, arcadeR = { total: 0 }
  if (!lite) {
    const counted = await Promise.all([
      db.collection(db_user).where({ enter_state: 1 }).count(),
      db.collection(db_user).where({ area: 'board', enter_state: db.command.gt(1) }).count(),
      db.collection(db_user).where({ area: db.command.neq('board'), enter_state: db.command.gt(1) }).count(),
    ])
    relaxR = counted[0]
    boardR = counted[1]
    arcadeR = counted[2]
  }
  res.relax_num = relaxR.total || 0
  res.board_num = boardR.total || 0
  res.arcade_num = arcadeR.total || 0
  res.play_num = res.board_num + res.arcade_num
  res.business_status = business_status
  res.area = res.area === 'board' ? 'board' : 'arcade'
  return {
    success: true,
    data: res,
  };
};
