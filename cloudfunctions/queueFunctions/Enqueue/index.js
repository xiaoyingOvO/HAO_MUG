const cloud = require('wx-server-sdk');
const { autoEmbarkAfterDeplain, logTimeBeforeEmbark } = require('../autoEmbark');
// 链表还原 / 重排写库（和 Deplain / Embark / autoEmbark 共用同一份实现）
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT } = require('../queueChain')

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

// 插入排队云函数入口
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
  var machine_id = event.params.machine_id
  var is_multi = event.params.is_multi
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
      nickname: true,
      area: true
    })
    .get({
      success: function (res) {
        console.log('success!!!')
        return res
      },
      fail: console.error
    })
  const enter_state = user_info.data[0].enter_state
  if (enter_state == 0){
    return {
      success: false,
      errMsg: "用户未入店，请重试",
    }
  } else if (enter_state != 1) {
    return {
      success: false,
      errMsg: "用户正在其他机器上排队，请先退队后重试",
    }
  }
  // 跨区排卡拉黑：机台所属区域必须和用户当前入店区域一致。
  //   桌游区的人只能排日麻（machine.area = 'board'），音游区的人只能排音游机台。
  // ⚠️ 依赖 machine 集合的 area 字段（日麻 = 'board'，其余 'arcade'）；
  //    老数据没有该字段时按音游区处理，即改版前的行为。
  const my_area = user_info.data[0].area === 'board' ? 'board' : 'arcade'
  const machine_area = machine_record.data[0] && machine_record.data[0].area === 'board' ? 'board' : 'arcade'
  if (my_area !== machine_area) {
    return {
      success: false,
      errMsg: my_area === 'board'
        ? "桌游区无法排音游机台，请先离店后重新选择音游区入店"
        : "日麻属于桌游区，请先离店后重新选择「桌游/日麻」入店",
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
  if (remain_need > remain_total){
    // 余额不足
    return {
      success: false,
      errMsg: "余额不足",
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
      errMsg: "入队人数太多，入队失败，请重试...",
    }
  }
  // 分布式锁获取成功，获取排队机器最后一位用户openid
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
  if (queue_record.data.length != 0){
    // 提前返回也要放锁，否则这台机台会被这次请求挡到锁自然过期（2 秒）
    await releaseQueueLock({ openid: openid, machine_id: machine_id })
    return {
      success: false,
      errMsg: "当前用户已在队列中，请刷新重试",
    }
  }
  // 队尾 = 链表还原后的最后一位。
  //   原来用 where({next_id:"-1"}).get() 取第一条当代「队尾」—— 一旦库里因为历史原因
  //   存在两个 next_id=-1 的记录，新来的人就会挂到错误的那个后面，队列当场分叉。
  const allRows = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
  const chain = buildChain(allRows)
  console.log("Get Last User!")
  var lastUserOpenID = "-1"
  if (chain.length != 0){
    lastUserOpenID = chain[chain.length - 1].openid
  }
  // 插入记录
  if (lastUserOpenID != "-1"){
    //更新旧版本最后一位用户的next_id为当前用户openID
    await db.collection(db_queue)
    .where({
      openid: lastUserOpenID,
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
  // 排队表中插入新用户记录
  await db.collection(db_queue).add({
    data: {
      openid: openid,
      timestamp: new Date(),
      play_status: false,
      is_multi: is_multi,
      next_id: "-1",
      play_position: null,
      embark_seq: 0,
      embark_time: null
    }
  })
  .then(res => {
    console.log(res);
  })
  // 插入后整体重算一次 next_id：
  //   ① 保证新人确实挂在队尾
  //   ② 顺手把历史遗留的脏链表（两个队尾、断链）修回单链 ——
  //      修一次的成本就是一次读 + 几条写，比等到「谁都排不上」再人工重建队列便宜得多
  {
    const rowsAfter = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
    await rewriteChain(db, db_queue, buildChain(rowsAfter))
  }
  // 更新User表信息
  await db.collection(db_user)
      .where({
        openid: openid,
      })
      .update({
        data: {
          enter_state: 2,
          machine_id: machine_id
        }
      })
      .then(res => {
        updated = res.stats.updated;
        console.log(res);
      })
// ========== 入队后自动补空位：有座位空着就立刻把等候区 1、2 号位排上机 ==========
// 规则与下机后的自动上机一致（详见 autoEmbark.js）：
//   · 1 号位单刷     → 只上 1 个
//   · 1、2 号位拼机  → 两个一起上
//   · 2 号位单刷     → 只上 1 号位，不硬拼
//   · 座位被单刷锁定 / 日麻桌游（超过 2 座）/ 机台停用 → 不上人
// 这里不排除任何人：刚入队的人如果正好排到 1 号位、机器又空着，
// 就应该直接上机（这就是「一有人入队就补空位」）。
// 一定要在「重新读队列」之前调用，否则返回给前端的还是没上机的旧状态。
  const autoRes = await autoEmbarkAfterDeplain({
    machine_id: machine_id,
    exclude_openids: []
  })
  if (autoRes && autoRes.embarked && autoRes.embarked.length > 0) {
    console.log("入队后自动补位:", autoRes.embarked)
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
    var content = "[" + timeStr + "] " + user_remain_record.data[0].nickname + "加入了队列"
    await db.collection(db_log).add({
      data: {
        // 时间戳要比上面那批「自动上机」更早：日志页时间倒序（最新的在最上面），
        //   真实先后是「先入队 → 再自动上机」，所以「加入了队列」要显示在
        //   「上机了（自动上机）」下面。
        //   直接用 new Date() 会和上机日志撞在同一毫秒，顺序退化成库里的返回顺序。
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
  // 本次入队是否被「自动补位」直接排上机：前端据此提示「已上机」而不是「排队中」
  const myAutoEmbark = (autoRes && autoRes.embarked ? autoRes.embarked : [])
    .find(b => b.openid === openid)
  return {
    success: true,
    data: sortedQ,
    embarked: !!myAutoEmbark,
    play_position: myAutoEmbark ? myAutoEmbark.position : null
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