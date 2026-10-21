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

// 一键上机云函数入口
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
  is_multi = event.params.is_multi
  play_position = event.params.play_position
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
  var maxPlayer = machine_record.data[0].max_player
  if (machine_record.data[0].is_disabled){
    return {
      success: false,
      errMsg: "机器不可用"
    }
  }
  // 查询余额状况
  let cur_openID = openid
  let user_remain_record = await db.collection(db_user).where({
    openid: cur_openID
  }).get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  let credit = user_remain_record.data[0].credit
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
  switch (credit){
    case credit >= 85:
      break
    case credit < 85 && credit >= 70:
      remain_need = remain_need * 1.2
    case credit >= 60 && credit < 70:
      remain_need = remain_need * 1.5
    case credit < 60:
      remain_need = 114514
  }
  // if (remain_need > remain_total){
  //   // 余额不足
  //   return {
  //     success: false,
  //     errMsg: "余额不足",
  //   }
  // }
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
      errMsg: "一键上机人数太多，上机失败，请重试...",
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
  if (queue_record.data.length == 0 || queue_record.data[0].play_status == true){
    return {
      success: false,
      errMsg: "当前用户排队状态有误，请刷新页面重试",
    }
  }

  // 查询游玩人数和单刷情况
  let queue_play_record = await db.collection(db_queue).where({
    play_status: true
  }).get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  if (queue_play_record.data.length == maxPlayer || (queue_play_record.data.length && !is_multi)){
    return {
      success: false,
      errMsg: "当前游玩人数已满请耐心等待",
    }
  }
  queue_record = await db.collection(db_queue).where({
    play_status: true,
    is_multi: false
  }).get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  if (queue_record.data.length != 0){
    return {
      success: false,
      errMsg: "当前游玩人数已满请耐心等待",
    }
  }
  // 将用户移动至游玩区
  await db.collection(db_queue)
  .where({
    openid: openid,
  })
  .update({
    data: {
      play_status: true
    }
  })
  .then(res => {
    updated = res.stats.updated;
    console.log(res);
  }) 
     // 更新当前用户的排队前一位用户的nextid
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
    // 获取游玩区所有用户的排队情况,并进行单链表排序
    var PlayerNodeMap = new Map()
    queue_play_record.data.forEach(qdata => {
      PlayerNodeMap.set(qdata.openid, qdata)
    })
    var lastPlayerOpenID = "-1"
    for(var i = 0 ; i < queue_play_record.data.length ; i++){
      var nxid = queue_play_record.data[i].next_id
      if (!PlayerNodeMap.has(nxid)){
        lastPlayerOpenID = queue_play_record.data[i].openid
      }
    }
    // 查询排队用户中的第一位
    let queue_wait_record = await db.collection(db_queue).where({
      play_status: false
    }).get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
    console.log(queue_wait_record)
    let headNodePlayer = null
    queue_wait_record.data.forEach(qdata => {
      if(!queue_wait_record.data.some(n => n.next_id === qdata.openid)){
        headNodePlayer = qdata
      }
    })
    console.log(headNodePlayer)
    var firstWaiterOpenID = "-1"
    if (headNodePlayer != null){
      firstWaiterOpenID = headNodePlayer.openid
    }
    // 更新queue表游玩区最后一位和当前用户的nextID
    if (lastPlayerOpenID != "-1"){
      await db.collection(db_queue)
        .where({
          openid: lastPlayerOpenID,
        })
        .update({
          data: {
            next_id: openid
          }
        })
        .then(res => {
          updated = res.stats.updated;
          console.log(res);
        })      
    }
    await db.collection(db_queue)
      .where({
        openid: openid,
      })
      .update({
        data: {
          next_id: firstWaiterOpenID,
          is_multi: is_multi,
          play_position: play_position
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      }) 
  // 更新User表信息
  await db.collection(db_user)
      .where({
        openid: openid,
      })
      .update({
        data: {
          enter_state: 3,
          machine_id: machine_id
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
  var cur_user = ""
  // 添加用户信息（批量查询，避免 N+1）
  const qOpenids = queue_record.data.map(q => q.openid).filter(Boolean)
  const qUserMap = {}
  if (qOpenids.length > 0) {
    const chunks = []
    for (let ci = 0; ci < qOpenids.length; ci += 100) chunks.push(qOpenids.slice(ci, ci + 100))
    for (const chunk of chunks) {
      const ur = await db.collection(db_user).where({
        openid: db.command.in(chunk)
      }).field({ openid: true, avatar: true, nickname: true }).get()
      ur.data.forEach(u => { qUserMap[u.openid] = u })
    }
  }
  queue_record.data.forEach(q => {
    const u = qUserMap[q.openid]
    if (u) {
      if (u.openid === openid) cur_user = u
      q.user_info = u
    }
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
// 释放分布式锁
  await releaseQueueLock({
    openid: openid,
    machine_id: machine_id
})
  // 写队列日志数据库
  var db_log = "queue_log_" + machine_id
  console.log(db_log)
  var content = "用户" + cur_user.nickname + "于" + new Date() + "上机"
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
  return {
    success: true,
    data: sortedQ
  }
};

// 分布式锁获取函数
async function acquireQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
  // var db_machine_lock = 'machine_lock_' + params.machine_id;
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
  // var db_machine_lock = 'machine_lock_' + params.machine_id;
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