const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
// 链表还原（和入队 / 上机 / 下机 / 补位共用同一份实现）
const { buildChain, QUEUE_FETCH_LIMIT } = require('../queueChain')

var db_machine = "machine"
const db_user = "user"

exports.main = async (event, context) => {
  var db_queue = "queue_"
  const machine_id = event.params.machine_id
  db_queue += machine_id
  // 机台信息 + 队列并行查：原来这两步是串行的，白等一次数据库往返
  // （排队数据本身不依赖机台的 is_disabled 判断，可以同时发）
  // ⚠️ 队列必须显式 limit：get() 默认只回 100 条，队列超过 100 人时
  //    排卡板和设置页看到的名单会缺人，而云端实际还在按完整队列排人。
  const [machine_record, queue_record] = await Promise.all([
    db.collection(db_machine).where({ _id: machine_id }).get(),
    db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get(),
  ])
  if (!machine_record.data.length) {
    return { success: false, errMsg: "机台不存在" }
  }
  if (machine_record.data[0].is_disabled){
    return {
      success: false,
      errMsg: "机器不可用"
    }
  }

  // 一次性批量查所有排队用户的昵称头像（解决 N+1 查询问题）
  const openids = queue_record.data.map(q => q.openid).filter(Boolean)
  const userMap = {}
  if (openids.length > 0) {
    const chunks = []
    for (let i = 0; i < openids.length; i += 100) chunks.push(openids.slice(i, i + 100))
    for (const chunk of chunks) {
      const users = await db.collection(db_user).where({
        openid: db.command.in(chunk)
      }).field({ openid: true, avatar: true, nickname: true }).get()
      users.data.forEach(u => { userMap[u.openid] = u })
    }
  }

  // 给每条队列记录附加用户信息
  queue_record.data.forEach(q => {
    q.user_info = userMap[q.openid] || null
  })

  // 单链表排序：统一走 queueChain.buildChain
  //   断链 / 两个队尾这类历史脏数据它能兜底（把没走到的人按入队时间补到队尾），
  //   手写的 while 循环遇到断链会直接少人 —— 前端就会「看不见队里的人」。
  const sortedQ = buildChain(queue_record.data)
  return {
    success: true,
    data: sortedQ
  };
}
