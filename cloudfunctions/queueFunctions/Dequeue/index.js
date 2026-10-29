const cloud = require('wx-server-sdk');
// 座位空出来后自动补位（和下机共用规则）
const { autoEmbarkAfterDeplain, logTimeBeforeEmbark } = require('../autoEmbark')
// 链表还原（读回来给前端排序用，和入队 / 上机 / 下机共用同一份实现）
const { buildChain, QUEUE_FETCH_LIMIT } = require('../queueChain')

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
  if (machine_record.data[0].is_disabled){
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
    // 提前返回也要放锁，不然这台机台会被这次请求挡到锁自然过期
    await releaseQueueLock({ openid: openid, machine_id: machine_id })
    return {
      success: false,
      errMsg: "当前用户已不在队列中，请刷新重试",
    }
  }
  // 退队的人是「正在游玩」还是「在等候」：
  //   游玩中退队 = 座位上的人走了，座位空出来，必须让等候区第 1 位补上；
  //   等候中退队 = 只是队里少一个人，座位没变，不需要自动上机。
  const wasPlaying = queue_record.data[0].play_status === true
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
  // ========== 座位空出来了 → 等候区第 1 位自动补上 ==========
  //   和「下机」(Deplain) 走同一套规则（详见 autoEmbark.js）：
  //   1 号位单刷只上 1 个、2 号位单刷不硬拼、机上有人单刷时不上人。
  //   不调用的话，游玩中的人点了「退队」（比如换机台），座位会一直空着，
  //   后面排队的人只能干等，直到下一次有人入队/下机才被补上去。
  let autoRes = { embarked: [] }
  if (wasPlaying) {
    try {
      autoRes = await autoEmbarkAfterDeplain({
        machine_id: machine_id,
        exclude_openids: [openid]
      })
      console.log("[Dequeue] 自动补位结果:", autoRes)
    } catch (e) {
      // 补位失败不影响退队本身（人已经从队列里删掉了）
      console.error("[Dequeue] 自动补位失败:", e)
    }
  }
  // 返回新的排队情况
  //   ⚠️ 必须显式 limit：get() 默认只回 100 条，队列超过 100 人时名单会缺人
  queue_record = await db.collection(db_queue)
  .limit(QUEUE_FETCH_LIMIT)
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
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
    q.user_info = qUserMap[q.openid] || null
  })
  // 单链表排序：统一走 queueChain.buildChain（断链 / 两个队尾能兜底，不会少人）
  const sortedQ = buildChain(queue_record.data)
  // 写队列日志数据库
  var db_log = "queue_log_" + machine_id
  console.log(db_log)
  var now = new Date();
  var bjNow = new Date(now.getTime() + 8 * 3600 * 1000);
  var timeStr = pad2(bjNow.getHours()) + ":" + pad2(bjNow.getMinutes()) + ":" + pad2(bjNow.getSeconds());
  var content = "[" + timeStr + "] " + user_info.data[0].nickname + "离开了队列"
  await db.collection(db_log).add({
    data: {
      // 比上面那批「自动上机」更晚：日志页时间倒序，「离开了队列」才会显示在
      //   「上机了」上面（先离开座位，再有人补上）。同一毫秒会退化成库返回顺序。
      timestamp: logTimeBeforeEmbark(autoRes),
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

function pad2(n) {
  return String(n).padStart(2, '0');
}