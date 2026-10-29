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

// 链表还原 / 重排写库（和 Enqueue、Deplain、autoEmbark 共用同一份实现）
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT } = require('../queueChain')
// 上机挑选规则：拼机优先、单刷的人跳过等着（和 autoEmbark 共用同一份）
const { countBlockersAhead } = require('../seatPlan')
// 上机标签（先上机 / 后上机）的字段名和读取口径，只定义在 embarkOrder.js 一处
const { SEQ_FIELD, prepareEmbarkSeq } = require('../embarkOrder')

// 是否允许「插队上机」：
//   false（默认）= 只有等候区第 1 位能上机，保证上机顺序和排队顺序一致
//   true         = 允许店员把任意一张卡拖到座位上（仍会按新顺序重排链表，不会串位）
// 要恢复「谁都能先上机」的旧行为，把它改成 true 即可。
const ALLOW_JUMP_QUEUE = false

// 上机云函数入口
exports.main = async (event, context) => {
  var db_queue = "queue_"
  // 获取openid
  const wxContext = cloud.getWXContext()
  var openid = wxContext != null && 'OPENID' in wxContext ?
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params) {
    openid = event.params.openid
  }
  console.log('openid: ' + openid)
  // 获取操作者openid（实际调用者，用于日志）
  const operatorOpenid = wxContext && wxContext.OPENID ? wxContext.OPENID : openid
  // 获取参数
  const machine_id = event.params.machine_id
  // is_multi 缺省按「拼机」处理，避免老前端不传时把人误判成单刷
  const is_multi = event.params.is_multi !== false
  const play_position = Number(event.params.play_position)

  // 特殊情况（机器不可用）
  let machine_record = await db.collection(db_machine).where({
    _id: machine_id
  }).get()
  if (!machine_record.data.length) {
    return { success: false, errMsg: "机台不存在" }
  }
  const machine = machine_record.data[0]
  if (machine.is_disabled) {
    return { success: false, errMsg: "机器不可用" }
  }
  const maxPlayer = Number(machine.max_player)

  // 获取分布式锁
  let lockRes = await acquireQueueLock({
    openid: openid,
    machine_id: machine_id
  });
  console.log("Get Lock!")
  if (!lockRes.success) {
    return {
      success: false,
      errMsg: "一键上机人数太多，上机失败，请重试...",
    }
  }

  try {
    // ============ 一、读整条队列，算出当前真实状态 ============
    db_queue += machine_id
    const rows = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
    const chain = buildChain(rows)
    const me = chain.find(r => r.openid === openid)

    if (!me) {
      return { success: false, errMsg: "当前用户排队状态有误，请刷新页面重试" }
    }
    if (me.play_status === true) {
      return { success: false, errMsg: "当前用户已经在游玩了，请刷新页面重试" }
    }

    const playing = chain.filter(r => r.play_status === true)

    // ============ 二、校验（顺序：容量 → 单刷 → 座位 → 排队顺序） ============
    // ① 座位已满
    if (maxPlayer > 0 && playing.length >= maxPlayer) {
      return { success: false, errMsg: "当前游玩人数已满，请耐心等待" }
    }
    // ② 机上有人在单刷 → 整台机台被独占，空位也不能上人
    //    （单刷要的是一个人玩，另一个人必须等对方下机后才能上机）
    if (playing.some(r => r.is_multi === false)) {
      return { success: false, errMsg: "这台机有人在单刷，需要等对方下机后才能上机" }
    }
    // ③ 自己想单刷，但机上已经有人 → 不允许（等于强迫别人跟你拼一台）
    if (!is_multi && playing.length > 0) {
      return { success: false, errMsg: "机台还有其他人，不能单刷：请等对方下机，或改为拼机" }
    }
    // ④ 座位号必须有效且空闲（前端也会拦，这里是并发下的最后一道）
    if (!Number.isInteger(play_position) || play_position < 0 ||
        (maxPlayer > 0 && play_position >= maxPlayer)) {
      return { success: false, errMsg: "座位号无效，请刷新页面重试" }
    }
    if (playing.some(r => Number(r.play_position) === play_position)) {
      return { success: false, errMsg: "这个座位已经有人了，请刷新页面重试" }
    }
    // ⑤ 上机顺序：不能插到「能上机的人」前面去
    //    拼机优先，所以排在前面的**单刷者不算挡路** —— 单刷要等整台机空出来，
    //    后面拼机的人可以先上（这也是店员确认过的规则）。
    //    这条不只是业务规则 —— 旧实现允许插队，插队时会把链表挂到错误的位置
    //    （被插队的人反而排到上机的人后面），队列顺序就此乱掉。
    if (!ALLOW_JUMP_QUEUE) {
      const blockersAhead = countBlockersAhead(chain, openid)
      if (blockersAhead > 0) {
        return {
          success: false,
          errMsg: "前面还有 " + blockersAhead + " 人排队，请按顺序上机",
        }
      }
    }

    // ============ 三、重排链表：把「我」从等候区移到游玩区末尾 ============
    //   链上顺序 = [游玩中的人...] + [排队的人...]，所以「游玩区末尾」的下标
    //   正好等于当前游玩人数。整体重算 next_id，不分别去改前驱和后继，
    //   漏改一条链表就断了。
    const rest = chain.filter(r => r.openid !== openid)
    const newOrder = rest.slice()
    newOrder.splice(playing.length, 0, me)
    await rewriteChain(db, db_queue, newOrder)

    // ============ 四、写「我」的上机信息 ============
    const now = new Date()
    // 上机标签 = 台上已有的人（1、2、3…）之后的下一号，和 autoEmbark 同口径。
    //   prepareEmbarkSeq 会先把台上老数据的标签整成连续的序号，再返回下一个号，
    //   所以「我先上机、你后上机」永远成立：后上机的人一定是更大的号。
    //   不用毫秒时间戳：同一毫秒内连续上机会拿到相同的值，分不出先后。
    const nextSeq = await prepareEmbarkSeq(db, db_queue, chain)
    await db.collection(db_queue)
      .where({
        openid: openid,
      })
      .update({
        data: {
          play_status: true,
          play_position: play_position,
          is_multi: is_multi,
          // 上机标签：手动上机也记一条，和自动上机（autoEmbark.js）口径一致。
          //   后面判断「谁先上机」、下机回队尾的先后都靠它。
          [SEQ_FIELD]: nextSeq,
          embark_time: now
        }
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

    // ============ 五、返回新的排队情况（附带昵称头像） ============
    // 内存里的 me 同步成上机后的状态，返回给前端的顺序就是最新顺序
    me.play_status = true
    me.play_position = play_position
    me.is_multi = is_multi

    const qUserMap = await fetchUserMap(chain.map(r => r.openid))
    const sortedQ = newOrder.map(r => Object.assign({}, r, {
      user_info: qUserMap[r.openid] || null
    }))
    const cur_user = qUserMap[openid] || { nickname: openid }
    let operator_name = cur_user.nickname || '未知用户'
    if (operatorOpenid !== openid) {
      const operatorRecord = await db.collection(db_user).where({
        openid: operatorOpenid
      }).get()
      if (operatorRecord.data.length > 0) {
        operator_name = operatorRecord.data[0].nickname || '未知用户'
      }
    }

    // 写队列日志数据库
    const db_log = "queue_log_" + machine_id
    const bjNow = new Date(now.getTime() + 8 * 3600 * 1000);
    const timeStr = pad2(bjNow.getHours()) + ":" + pad2(bjNow.getMinutes()) + ":" + pad2(bjNow.getSeconds());
    let content = "[" + timeStr + "] " + cur_user.nickname + "上机了"
    if (operatorOpenid !== openid) {
      content = "[" + timeStr + "] " + operator_name + "让" + cur_user.nickname + "上机了"
    }
    await db.collection(db_log).add({
      data: {
        timestamp: new Date(),
        openid: openid,
        log_info: content
      }
    }).catch(err => console.error('[Embark] 写日志失败', err))

    return {
      success: true,
      data: sortedQ
    }
  } finally {
    // ⚠️ 不管是校验失败、写库报错还是正常返回，锁都要放开。
    //    旧实现在「已在游玩」「座位已满」等分支直接 return，锁只能靠 2 秒后自然过期，
    //    这 2 秒里别人上机/下机都会失败，表现成偶发「上机人数太多」。
    await releaseQueueLock({
      openid: openid,
      machine_id: machine_id
    })
  }
};

// 批量查昵称头像（分片，避免 where in 超过 100）
async function fetchUserMap(openids) {
  const map = {}
  const ids = (openids || []).filter(Boolean)
  if (!ids.length) return map
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const ur = await db.collection(db_user)
      .where({ openid: db.command.in(chunk) })
      .field({ openid: true, avatar: true, nickname: true })
      .get()
    ur.data.forEach(u => { map[u.openid] = u })
  }
  return map
}

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
      .get();

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
    success: false
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
    .catch(err => console.error('[Embark] 释放锁失败', err))
  console.log("释放锁成功");
}

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}
