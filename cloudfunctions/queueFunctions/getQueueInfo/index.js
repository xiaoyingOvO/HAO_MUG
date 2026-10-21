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
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  if (machine_record.data[0].max_player === 0){
    return {
      success: false,
      errMsg: "机器不可用"
    }
  }
  // 查排队机器情况
  db_queue += machine_id
  queue_record = await db.collection(db_queue)
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  // 添加用户信息
  for (var i = 0 ; i  < queue_record.data.length ; i++){
    let user_record = await db.collection(db_user)
    .where({
      openid: queue_record.data[i].openid
    })
    .field({
      openid: true,
      avatar: true,
      nickname: true,
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
    queue_record.data[i].user_info = user_record.data[0]
  }
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