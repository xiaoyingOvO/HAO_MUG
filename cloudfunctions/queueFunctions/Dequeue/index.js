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

// 退出排队云函数入口
exports.main = async (event, context) => {
  console.log('---退队云函数---')
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
  var machine_id = event.params.machine_id
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
  // 检查用户状态
  let user_info = await db.collection(db_user)
  .where({
    openid: openid
  })
  .field({
    openid: true,
    enter_state: true,
    nickname: true
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  if (user_info.data[0].enter_state != 2 && user_info.data[0].enter_state != 3){
    return {
      success: false,
      errMsg: "用户不在队列中，请重试",
    }
  }
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
      errMsg: "退队人数太多，退队失败，请重试...",
    }
  }
  // 分布式锁获取成功，获取排队机器中退队用户前一位的openid
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
  if (queue_record.data.length == 0){
    return {
      success: false,
      errMsg: "当前用户已不在队列中，请刷新重试",
    }
  }
  queue_record = await db.collection(db_queue).where({
      next_id : openid
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  console.log("Get Pre User!")
  var preUserOpenID = "-1"
  if (queue_record.data.length != 0){
    preUserOpenID = queue_record.data[0].openid
  }
  // 获取退队用户下一位用户的openid
  queue_record = await db.collection(db_queue).where({
    openid: openid
  }).get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  console.log("Get Current User")
  var lastUserOpenID = "-1"
  if (queue_record.data.length != 0){
    lastUserOpenID = queue_record.data[0].next_id
  }
  // 删除记录
  if (preUserOpenID != "-1"){
  //更新旧版本上一位用户ID
    await db.collection(db_queue)
      .where({
        openid: preUserOpenID,
        })
      .update({
      data: {
        next_id: lastUserOpenID
      }
    })
    .then(res => {
      updated = res.stats.updated;
      console.log(res);
    })
  }
  // 排队表中删除当前用户记录
  await db.collection(db_queue).where({
      openid: openid
    }).remove()
    .then(res => {
      console.log(res);
    })
  // 更新User表信息
  await db.collection(db_user)
    .where({
      openid: openid,
    })
    .update({
      data: {
        enter_state: 1,
        machine_id: ""
      }
    })
    .then(res => {
      updated = res.stats.updated;
      console.log(res);
    })
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
for (var i = 0 ; i < queue_record.data.length ; i++){
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
  // 写队列日志数据库
  var db_log = "queue_log_" + machine_id
  console.log(db_log)
  var content = "用户" + user_info.data[0].nickname + "于" + new Date() + "退出队列"
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