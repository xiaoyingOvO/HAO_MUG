const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
var db_machine_lock = 'machine_lock'

// 把节点的新 next_id 写回数据库的公共动作
async function updateNextId(db_queue, node) {
  await db.collection(db_queue).where({
    openid: node.openid
  }).update({
    data: {
      next_id: node.next_id
    }
  });
}

// 移动云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  var openid = event.params.from_openid;
  console.log('openid: ' + openid)
  var move_final = event.params.to_openid
  var machine_id = event.params.machine_id
  // 检查分布式锁是否是自己上的
  var lock_record = await db.collection(db_machine_lock)
    .where({
      machine_id: machine_id
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  if (lock_record.data[0].openid != openid){
    await releaseQueueLock({
      openid: openid,
      machine_id: machine_id
    })
    return {
      success: false,
      errMsg: "分布式锁非用户持有，请重试"
    }
  }
  // 读出本机台队列（链表结构，next_id 指向下一位）
  var db_queue = "queue_"
  db_queue += machine_id
  var queue_record = await db.collection(db_queue)
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  // 提前存当前用户的信息
  let cur_user = ""
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
    if (user_record.data[0].openid === openid){
      cur_user = user_record.data[0]
    }
    queue_record.data[i].user_info = user_record.data[0]
  }
  let move_result = await moveUserToPosition(queue_record, openid, move_final, machine_id)
  if (!move_result.success) {
    // 排序失败也要放锁，否则该用户会一直占着机台锁
    await releaseQueueLock({
      openid: openid,
      machine_id: machine_id
    })
    return {
      success: false,
      errMsg: move_result.errMsg
    }
  }
  // 写队列日志数据库
  var db_log = "queue_log_" + machine_id
  var content = "用户" + cur_user.nickname + "于" + new Date() + "将自身位置移至第" + move_result.final_place + "位"
  await db.collection(db_log).add({
    data: {
      timestamp: new Date(),
      openid: openid,
      log_info: content
    }
  })
  .then(res => {
    console.log(res);
  })
  // 释放分布式锁
  await releaseQueueLock({
    openid: openid,
    machine_id: machine_id
  })

  return {
    success: true,
    data: move_result.sortedQ
  }
}

// 把 move_openid 移动到 move_final 这一位之前；move_final === "-1" 表示排到队尾
async function moveUserToPosition(queue_record, move_openid, move_final, machine_id) {
  var db_queue = "queue_"
  db_queue += machine_id

  if (!queue_record || !queue_record.data || queue_record.data.length === 0) {
    console.error("队列数据为空或无效");
    return { success: false, errMsg: "队列数据为空" };
  }

  const nodeMap = new Map();
  let headNode = null;
  let moveNode = null;
  let movePrevNode = null;

  // 构建映射表，并找到关键节点
  queue_record.data.forEach(qdata => {
      nodeMap.set(qdata.openid, qdata);
      if (!queue_record.data.some(n => n.next_id === qdata.openid)) {
          headNode = qdata; // 找到头节点
      }
      if (qdata.openid === move_openid) {
          moveNode = qdata; // 需要移动的用户
      }
  });

  if (!moveNode) {
      console.error("未找到要移动的用户");
      return { success: false, errMsg: "未找到要移动的用户" };
  }

  // 找到 moveNode 的前一个节点
  queue_record.data.forEach(qdata => {
      if (qdata.next_id === move_openid) {
          movePrevNode = qdata;
      }
  });

  // 目标就是自己：原地不动，直接返回当前顺序
  if (moveNode.openid === move_final) {
      return buildResult(headNode, nodeMap, moveNode.openid);
  }

  // 1) 先把自己从链表上摘下来（内存和数据库一起改）
  if (movePrevNode) {
      movePrevNode.next_id = moveNode.next_id; // 让前一个节点跳过 moveNode
      await updateNextId(db_queue, movePrevNode);
  } else {
    headNode = moveNode.next_id !== "-1" ? nodeMap.get(moveNode.next_id) : null; // 如果移动的是头节点，更新头节点
  }

  // 摘完只剩自己一个人，没有位置可调
  if (!headNode) {
      return buildResult(moveNode, nodeMap, moveNode.openid);
  }

  // 2) 把自己插到目标之前
  if (move_final === "-1") {
      // 目标是队尾：接到最后一个节点后面
      let tailNode = headNode;
      while (tailNode && tailNode.next_id !== "-1") {
          tailNode = nodeMap.get(tailNode.next_id);
      }
      if (!tailNode) {
          console.error("找不到队尾节点");
          return { success: false, errMsg: "队列数据异常" };
      }
      moveNode.next_id = "-1";
      tailNode.next_id = moveNode.openid;
      await updateNextId(db_queue, moveNode);
      await updateNextId(db_queue, tailNode);
  } else {
      const finalNode = nodeMap.get(move_final);
      if (!finalNode) {
          console.error("未找到目标位置的用户");
          return { success: false, errMsg: "未找到目标位置的用户" };
      }

      if (finalNode.openid === headNode.openid) {
          // 目标在队首：自己成为新的队首
          moveNode.next_id = headNode.openid;
          headNode = moveNode;
          await updateNextId(db_queue, moveNode);
      } else {
          // 找目标节点在「自己摘除之后」的前驱，
          // 必须沿摘除后的活链表走：目标的前驱有可能就是自己（比如拖到自己的下一位之前），
          // 那样的话摘除后目标的前驱已经换成了自己的前驱。
          let finalPreNode = null;
          let cursor = headNode;
          while (cursor && cursor.openid !== finalNode.openid) {
              if (cursor.next_id === finalNode.openid) {
                  finalPreNode = cursor;
                  break;
              }
              cursor = nodeMap.get(cursor.next_id);
          }
          if (!finalPreNode) {
              console.error("找不到目标位置的前一位");
              return { success: false, errMsg: "队列数据异常" };
          }
          moveNode.next_id = finalNode.openid;
          finalPreNode.next_id = moveNode.openid;
          await updateNextId(db_queue, moveNode);
          await updateNextId(db_queue, finalPreNode);
      }
  }

  return buildResult(headNode, nodeMap, moveNode.openid);
}

// 顺着链表重建顺序，并算出移动后用户排在第几位
function buildResult(headNode, nodeMap, move_openid) {
  const sortedQ = [];
  let currentNode = headNode;
  let final_place = -1;
  let idx = 1;
  while (currentNode) {
      sortedQ.push(currentNode);
      if (currentNode.openid === move_openid) {
          final_place = idx;
      }
      if (currentNode.next_id === "-1") break;
      currentNode = nodeMap.get(currentNode.next_id);
      idx++;
  }
  console.log("更新后的队列:", sortedQ, "第", final_place, "位");
  return { success: true, sortedQ: sortedQ, final_place: final_place };
}

async function releaseQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
  // var db_machine_lock = 'machine_lock_' + machine_id;
  await db.collection(db_machine_lock)
    .where({
      machine_id: machine_id,
      openid: openid
    })
    .update({
      data: {
        release_time: new Date(0)
      }
    })
    .then(res => {
      console.log(res);
    });
    console.log("释放锁成功");
}
