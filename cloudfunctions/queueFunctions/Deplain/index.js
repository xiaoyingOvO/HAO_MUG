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

// 下机后自动把等候区 1、2 号位排上机（公共模块，和 DeplainAll 共用）
const { autoEmbarkAfterDeplain, logTimeBeforeEmbark } = require('../autoEmbark')
// 链表还原 / 重排写库（和 Enqueue、Embark、autoEmbark 共用同一份实现）
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT } = require('../queueChain')

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
  // 获取操作者openid（实际调用者，用于日志）
  const operatorOpenid = wxContext && wxContext.OPENID ? wxContext.OPENID : openid
  // 锁的持有者用「操作者」而不是「被下机的人」。
  //   默认情况下两者相同；只有设置页的「强制下机」会传别人的 openid 进来，
  //   这时如果拿被下机人的 openid 去抢锁，正好他本人也在点下机，两边会同时拿到锁
  //   （CAS 判断里 openid 相同 → 都算抢到），导致同一次消费被结算两次。
  const lockOwner = operatorOpenid || openid
  // 获取参数
  //   ⚠️ 以前这里漏了 const，machine_id 变成了一个隐式全局变量：
  //      并发处理两个机台的请求时，后一个请求会把前一个的值覆盖掉，
  //      下机日志可能写到别的机台的 queue_log 里。
  const machine_id = event.params.machine_id
  // 获取分布式锁
  let lockRes = await acquireQueueLock({
    openid: lockOwner,
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
    // 提前返回也要放锁：否则这台机台的上机/下机都会被这把锁挡到 2 秒后自然过期，
    // 表现成偶发的「下机人数太多，请重试」
    await releaseQueueLock({ openid: lockOwner, machine_id: event.params.machine_id })
    return {
      success: false,
      errMsg: "当前用户排队状态有误，请刷新页面重试",
    }
  }
  let errMsg = ""
  // 查询当前用户余额是否足够支付
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
  // 用户记录不存在（账号被清 / openid 变了）：继续往下走会在 data[0].real_point 上抛异常，
  //   而这时候锁已经拿到手了，异常会把整台机台卡到锁自然过期。
  if (!user_remain_record.data.length) {
    await releaseQueueLock({ openid: lockOwner, machine_id: event.params.machine_id })
    return {
      success: false,
      errMsg: "用户信息异常，请重新登录后重试",
    }
  }
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
    errMsg = "余额不足"
    if (remain_need == -1){
      errMsg = "信用不好"
    }
    // 判断有没有在当前用户之前的用户
    var prev_user = await db.collection(db_queue).where({
      next_id: cur_openID
    }).get({
      success: function (res) {
        console.log('get prev user success')
        return res
      },
      fail: console.error
    })
    // 如果没有上一位用户
    if (prev_user.data.length === 0){
      // 直接滚出队列
      await db.collection(db_queue).where({
        openid: cur_openID
      }).remove()
      .then(res => {
        console.log(res);
      })
    }else{
      // 如果有上一位用户,且当前用户不在队尾，修改上一位用户的nextID
      await db.collection(db_queue).where({
        openid: prev_user.data[0].openid
      }).update({
        data: {
          next_id: queue_record.data[0].next_id
        }
      })
      .then(res => {
        console.log(res);
      })
      // 删除当前用户的记录
      await db.collection(db_queue).where({
        openid: cur_openID
      }).remove()
      .then(res => {
        console.log(res);
      })
    }

    // 修改User用户表　
    await db.collection(db_user)
    .where({
      openid: cur_openID,
    })
    .update({
      data: {
        enter_state: 1
      }
    }).then(res => {
      updated = res.stats.updated;
      console.log(res);
    })}else{
      // ===== 正常下机：从链表上摘下来 → 追加到队尾 → 整体重算 next_id =====
      // 旧实现是「把上一位的 next 指向我的下一位」+「把所有 next_id = -1 的人指向我」，
      // 后者在脏数据（历史遗留两个队尾）下会把多条记录同时指向自己，链表当场分叉；
      // 而且这两步写库中间失败的话，人就彻底掉出链表了。
      // 现在改成先把链读出来、在内存里算好最终顺序，再只写变动的 next_id。
      const rows = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
      const chain = buildChain(rows)
      const meNode = chain.find(r => r.openid === cur_openID)
      if (meNode) {
        const rest = chain.filter(r => r.openid !== cur_openID)
        // 下机后重新回到队尾（不是原地不动，也不是插回原来的位置）
        const newOrder = rest.concat([meNode])
        await rewriteChain(db, db_queue, newOrder)
      } else {
        // 人还在库里但不在链表上（历史脏数据）：至少保证不会挡住别人
        await db.collection(db_queue).where({
          openid: cur_openID,
        }).update({
          data: { next_id: "-1" }
        })
      }
      // 修改当前用户的排队状态
      await db.collection(db_queue)
      .where({
        openid: cur_openID,
      })
      .update({
        data: {
          play_status: false,
          // 拼机 / 单刷**保持不动**：切成单刷的人下机后仍然是单刷，
          //   不能因为一次下机就把用户自己选的状态偷偷改回拼机。
          // 座位号一并清掉：不清的话下一个人拿到的座位上会带着上一个人的
          // play_position，看起来就像「两个人都坐在同一个位子上」
          play_position: null,
          // 本次上机的顺序号作废，下次上机重新计时
          embark_seq: 0,
          embark_time: null
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
// ========== 下机后自动上机：等候区 1、2 号位直接上位 ==========
// 规则（详见 autoEmbark.js）：
//   · 1 号位单刷  → 只上 1 个（机上还有别人时，单刷的人要等机器空下来）
//   · 1、2 号位拼机 → 两个一起上
//   · 2 号位单刷  → 只上 1 号位，不硬拼
//   · 机上有人在单刷 → 整台机台独占，空位也不上人
  // 刚下机的本人已经排到队尾：外人先上，空位还有剩才轮到他
  const autoRes = await autoEmbarkAfterDeplain({
    machine_id: machine_id,
    downed_openids: [cur_openID]
  })
  console.log("自动上机结果:", autoRes)

// 返回新的排队情况
  //   ⚠️ 必须显式 limit：云函数里 get() 默认只返回 100 条，
  //      队列超过 100 人时尾部的人会凭空消失（前端渲染的名单和真实队列对不上）。
  //      QUEUE_FETCH_LIMIT 和入队 / 上机 / 补位用的是同一个上限。
  queue_record = await db.collection(db_queue)
  .limit(QUEUE_FETCH_LIMIT)
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  // 添加用户信息（批量查，一人一次查询在 20 人队列上就是 20 次往返）
  {
    const openids = queue_record.data.map(q => q.openid).filter(Boolean)
    const userMap = {}
    for (let ci = 0; ci < openids.length; ci += 100) {
      const chunk = openids.slice(ci, ci + 100)
      const ur = await db.collection(db_user)
        .where({ openid: db.command.in(chunk) })
        .field({ openid: true, avatar: true, nickname: true })
        .get()
      ur.data.forEach(u => { userMap[u.openid] = u })
    }
    queue_record.data.forEach(q => { q.user_info = userMap[q.openid] || null })
  }
  // 单链表排序：统一走 queueChain.buildChain —— 断链 / 两个队尾这类脏数据
  // 它能兜底（把没走到的人按入队时间补到队尾），手写的 while 循环会直接少人。
  const sortedQ = buildChain(queue_record.data)
// 释放分布式锁
  await releaseQueueLock({
    openid: lockOwner,
    machine_id: machine_id
  })

  // ========== 写队列日志（无论成功或失败都记录） ==========
  // 获取操作者昵称
  var operator_name = user_remain_record.data[0].nickname || '未知用户'
  if (operatorOpenid !== openid) {
    const operatorRecord = await db.collection(db_user).where({
      openid: operatorOpenid
    }).get()
    if (operatorRecord.data.length > 0) {
      operator_name = operatorRecord.data[0].nickname || '未知用户'
    }
  }
  var db_log = "queue_log_" + machine_id
  var now = new Date();
  var bjNow = new Date(now.getTime() + 8 * 3600 * 1000);
  var timeStr = pad2(bjNow.getHours()) + ":" + pad2(bjNow.getMinutes()) + ":" + pad2(bjNow.getSeconds());
  var content = "[" + timeStr + "] " + user_remain_record.data[0].nickname + "下机了"
  if (operatorOpenid !== openid) {
    content = "[" + timeStr + "] " + operator_name + "让" + user_remain_record.data[0].nickname + "下机了"
  }
  // 余额不足 / 信用不足的人是被**移出队列**的（不是回队尾），日志要说清楚，
  //   否则店员只看到「某某下机了」，以为人还在队里等（和 DeplainAll 同一口径）。
  if (errMsg !== "") {
    content = content + "（" + errMsg + "，已移出队列）"
  }
  await db.collection(db_log).add({
    data: {
      // 时间戳要比上面那批「自动上机」日志更晚：日志页时间倒序，
      //   这条才会显示在上机上面 —— 读起来是「先下机，再有人补上机」。
      timestamp: logTimeBeforeEmbark(autoRes),
      openid: openid,
      log_info: content
    }
  }).then(res => {
    console.log('[Deplain] 下机日志写入成功:', res);
  }).catch(err => {
    console.error('[Deplain] 下机日志写入失败:', err);
  })
  // =====================================================

  if (errMsg != ""){
    return {
      success: false,
      data: sortedQ,
      errMsg: errMsg
    }    
  }
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

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}