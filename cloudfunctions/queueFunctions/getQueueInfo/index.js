const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

var db_machine = "machine"
const db_user = "user"

exports.main = async (event, context) => {
  var db_queue = "queue_"
  machine_id = event.params.machine_id
  // 特殊情况（机器不可用）
  let machine_record = await db.collection(db_machine).where({
    _id: machine_id
  })
  .get()
  if (machine_record.data[0].is_disabled){
    return {
      success: false,
      errMsg: "机器不可用"
    }
  }
  // 查排队机器情况
  db_queue += machine_id
  const queue_record = await db.collection(db_queue).get()

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

  // 单链表排序
  const nodeMap = new Map()
  let headNode = null
  queue_record.data.forEach(qdata => {
    nodeMap.set(qdata.openid, qdata)
    if(!queue_record.data.some(n => n.next_id === qdata.openid)){
      headNode = qdata
    }
  })
  console.log(headNode,nodeMap)
  const sortedQ = []
  let currentNode = headNode
  while(currentNode){
    sortedQ.push(currentNode)
    if (currentNode.next_id === "-1") break;
    currentNode = nodeMap.get(currentNode.next_id)
  }
  return {
    success: true,
    data: sortedQ
  };
}
