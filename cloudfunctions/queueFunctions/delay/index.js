const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
var db_machine_lock = 'machine_lock'
var final_place = -1
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
  // 移动位置(用户为u，改变u-1的nextid，u的nextid，move_final的nextid)
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
  console.log(queue_record)
  let sortedQ = await moveUserToPosition(queue_record,openid,move_final,machine_id)
  console.log(sortedQ)
  // 写队列日志数据库
  var db_log = "queue_log_" + machine_id
  console.log("!!!!",final_place)
  var content = "用户" + cur_user.nickname + "于" + new Date() + "将自身位置移至第" + final_place + "位"
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
    data: sortedQ
  }
}

async function moveUserToPosition(queue_record, move_openid, move_final, machine_id) {
  var db_queue = "queue_";
  db_queue += machine_id;

  if (!queue_record || !queue_record.data || queue_record.data.length === 0) {
      console.error("队列数据为空或无效");
      return;
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
  console.log("moveNode!", moveNode);

  if (!moveNode) {
      console.error("未找到要移动的用户");
      return;
  }

  // 找到 moveNode 的前一个节点
  queue_record.data.forEach(qdata => {
      if (qdata.next_id === move_openid) {
          movePrevNode = qdata;
      }
  });

  // 如果 moveNode 已经在目标位置，则无需操作
  if (moveNode.openid === move_final) {
      console.log("用户已经在目标位置");
      return;
  }
  console.log("movePrevNode!", movePrevNode);
  // 解除 moveNode 当前位置的链接
  if (movePrevNode) {
      movePrevNode.next_id = moveNode.next_id; // 让前一个节点跳过 moveNode
      // 更新数据库中 movePrevNode 的 next_id
      await db.collection(db_queue).where({
          openid: movePrevNode.openid
      }).update({
          data: {
              next_id: moveNode.next_id
          }
      }).then(res => {
        updated = res.stats.updated;
        console.log(res);
      })
  } else {
    headNode = moveNode.next_id !== "-1" ? nodeMap.get(moveNode.next_id) : null; // 如果移动的是头节点，更新头节点
    console.log("headNode!!",headNode)
  }

  // 找到 move_final 节点
  let finalNode = nodeMap.get(move_final);
  if (!finalNode) {
      console.error("未找到目标位置的用户");
      return;
  }

  // 如果目标是队列的最前面，插入到第一位
  if (move_final === headNode.openid && 
        ((movePrevNode && headNode.openid == movePrevNode.openid) || headNode.next_id != "-1")) {
      console.log(headNode.next_id)
      moveNode.next_id = headNode.openid;
      headNode = moveNode;
    console.log("1!",moveNode,headNode)
      // 更新数据库中的 headNode 和 moveNode 的 next_id
      await db.collection(db_queue).where({
          openid: moveNode.openid
      }).update({
          data: {
              next_id: moveNode.next_id
          }
      });

      await db.collection(db_queue).where({
          openid: headNode.openid
      }).update({
          data: {
              next_id: headNode.next_id
          }
      });
  } 
  // 如果目标是队列的最后面，插入到最后一位
  else if (finalNode.next_id === "-1" && finalNode != movePrevNode) {
      moveNode.next_id = "-1";
      finalNode.next_id = moveNode.openid;
      console.log("2!",moveNode,finalNode)
      // 更新数据库中的 finalNode 和 moveNode 的 next_id
      await db.collection(db_queue).where({
          openid: moveNode.openid
      }).update({
          data: {
              next_id: moveNode.next_id
          }
      });

      await db.collection(db_queue).where({
          openid: finalNode.openid
      }).update({
          data: {
              next_id: finalNode.next_id
          }
      });
  } 
  // 否则，插入到目标节点之后
  else {
      // 找到finalNode的上一个节点
      var finalPreNode = null
      queue_record.data.forEach(qdata => {
        if (qdata.next_id === finalNode.openid) {
            finalPreNode = qdata;
        }
      });
      console.log("3!",moveNode,finalNode)
      moveNode.next_id = finalNode.openid;
      console.log("3!",moveNode,finalNode)
      finalPreNode.next_id = moveNode.openid;
      console.log("3!",moveNode,finalNode,finalPreNode)
      // 更新数据库中的 moveNode 和 finalNode 的 next_id
      await db.collection(db_queue).where({
          openid: moveNode.openid
      }).update({
          data: {
              next_id: moveNode.next_id
          }
      });

      await db.collection(db_queue).where({
          openid: finalPreNode.openid
      }).update({
          data: {
              next_id: finalPreNode.next_id
          }
      });
  }

  // 重新构建排序后的队列
  const sortedQ = [];
  let currentNode = headNode;
  var idx = 1
  while (currentNode) {
      sortedQ.push(currentNode);
      if (currentNode.openid === moveNode.openid) {
        final_place = idx
        console.log("!!!",final_place)
      }
      if (currentNode.next_id === "-1") break;
      currentNode = nodeMap.get(currentNode.next_id);
      idx++
  }

  console.log("更新后的队列:", sortedQ);
  return sortedQ;
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

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}