const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
var db_machine = 'machine'
var db_machine_lock = 'machine_lock'

const max_retry_time = 5;
const retry_wait_seconds = 0.5;
const max_machine_lock_seconds = 2;

// 一键下机云函数入口
exports.main = async (event, context) => {
  var db_queue = "queue_"
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
  // 获取参数
  machine_id = event.params.machine_id
  // 获取分布式锁
  let lockRes = await acquireQueueLock({
    openid: openid,
    machine_id: event.params.machine_id
  });
  console.log("Get Lock!")
  // 分布式锁获取失败
  if (!lockRes.success) {
    return {
      success: false,
      errMsg: "一键下机人数太多，下机失败，请重试...",
    }
  }
  // 分布式锁获取成功
  // 查询当前排队表中该用户状态
  db_queue += machine_id
  let queue_record = await db.collection(db_queue).where({
    openid : openid
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  console.log("Get Current User!")
  if (queue_record.data.length == 0 || queue_record.data[0].play_status != true){
    return {
      success: false,
      errMsg: "当前用户排队状态有误，请刷新页面重试",
    }
  }
  // 查询当前游玩的人，一键滚蛋
  let queue_play_record = await db.collection(db_queue).where({
    play_status: true
  }).get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  // 排序
  const PlayerNodeMap = new Map()
  let PlayerHeadNode = null
  queue_play_record.data.forEach(qdata => {
    PlayerNodeMap.set(qdata.openid, qdata)
    if(!queue_play_record.data.some(n => n.next_id === qdata.openid)){
      PlayerHeadNode = qdata
    }
  })
  const PlayerSortedQ = []
  let PlayerCurrentNode = PlayerHeadNode
  while(PlayerCurrentNode){
    PlayerSortedQ.push(PlayerCurrentNode)
    if (!PlayerNodeMap.has(PlayerCurrentNode.next_id)) break;
    PlayerCurrentNode = PlayerNodeMap.get(PlayerCurrentNode.next_id)
  }
  let errMsg = ""
  // 循环，逐个判断
  for(let i = 0 ; i < PlayerSortedQ.length ; i++){
    // 查询当前用户余额是否足够支付
    let cur_openID = PlayerSortedQ[i].openid
    let user_remain_record = await db.collection(db_user).where({
      openid: cur_openID
    }).get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
    let remain_total = user_remain_record.data[0].real_point + user_remain_record.data[0].extra_point
    const result = await cloud.callFunction({
      name: 'queueFunctions', // 被调用云函数的名称
      data: {
        type : "getConsumePoint",
        params:{
          openid : openid
        }
      },
    });
    console.log(result,remain_total)
    let remain_need = result.result.data.points
    // 余额不足
    if (remain_need > remain_total || remain_need == -1){
      // 如果余额不足的用户是当前用户，提示余额不足信息
      if (cur_openID == openid){
        errMsg = "余额不足"
      }
      if (remain_need == -1){
        errMsg = "信用不好"
      }
      // 直接滚出队列
      await db.collection(db_queue).where({
        openid: cur_openID
      }).remove()
      .then(res => {
        console.log(res);
      })
      // 修改User用户表　
      await db.collection(db_user)
      .where({
        openid: cur_openID,
      })
      .update({
        data: {
          enter_state: 1
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })
    }else{
      // 修改本来是队尾的用户nextID
      await db.collection(db_queue)
      .where({
        next_id: "-1",
      })
      .update({
        data: {
          next_id: cur_openID
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })
      // 修改当前循环用户的nextID
      await db.collection(db_queue)
      .where({
        openid: cur_openID,
      })
      .update({
        data: {
          next_id: "-1",
          play_status: false
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })
      // 修改User用户表　
      await db.collection(db_user)
      .where({
        openid: cur_openID,
      })
      .update({
        data: {
          enter_state: 2
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })
    }
    // 写队列日志数据库
    var db_log = "queue_log_" + machine_id
    var content = "用户" + user_remain_record.data[0].nickname + "于" + new Date() + "一键下机"
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
  }
// 返回新的排队情况
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
// 释放分布式锁
  await releaseQueueLock({
    openid: openid,
    machine_id: machine_id
  })
  if (errMsg != ""){
    return {
      success: false,
      data: sortedQ,
      errMsg: errMsg
    }    
  }else{
    return {
      success: true,
      data: sortedQ,
      errMsg: errMsg
    }     
  }

};

// 分布式锁获取函数
async function acquireQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
  // var db_machine_lock = 'machine_lock_' + machine_id;
  let updated = 0;
  // 重试流程
  for (var retry_time = 1; retry_time <= max_retry_time; retry_time++) {
    // 查询分布式锁当前状况
    console.log(db_machine_lock)
    let machine_lock_record = await db.collection(db_machine_lock)
      .where({
        machine_id: machine_id,
      })
      .field({
        openid: true,
        release_time: true
      })
      .get({
        success: function (res) {
          console.log('query machine lock success!!!');
          return res;
        },
        fail: console.error
      });
    
    // 如果锁不存在，报错
    if (machine_lock_record != null && machine_lock_record.data.length == 0) {
      console.log("该机器分布式锁不存在");
      return {
        success: false,
        errMsg: "该机器分布式锁不存在，请联系管理员！"
      };
    }

    const old_openid = machine_lock_record.data[0].openid;
    const old_release_time = machine_lock_record.data[0].release_time;
    // 锁被其他占有，重试
    const release_time = new Date();
    if (old_openid != openid && release_time < old_release_time) {
      console.log("machine lock retry time: " + retry_time);
      await sleep(retry_wait_seconds);
      continue;
    }

    // CAS尝试获取分布式锁
    release_time.setSeconds(release_time.getSeconds() + max_machine_lock_seconds);
    await db.collection(db_machine_lock)
      .where({
        machine_id: machine_id,
        openid: old_openid,
        release_time: old_release_time
      })
      .update({
        data: {
          openid: openid,
          release_time: release_time
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })

    // 上锁成功
    if (updated != 0) {
      console.log("上锁成功");
      return {
        success: true
      }
    }

    // 重试
    console.log("machine lock retry time: " + retry_time);
    await sleep(retry_wait_seconds);
  }

  // 上锁失败
  console.log("上锁失败");
  return {
    success:false
  }
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