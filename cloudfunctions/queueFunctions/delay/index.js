const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_user = "user"
const db_machine_lock = 'machine_lock'

const max_retry_time = 5;
const retry_wait_seconds = 0.5;
const max_machine_lock_seconds = 2;

// 移动云函数入口
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  // 发起这次拖动的人（在排卡板上长按拖卡片的那个人）。
  // 注意这跟「被移动的人」可以是两个不同的人 —— 任何人都能把任何一张卡挪位置。
  const operator = wxContext != null && 'OPENID' in wxContext
    ? wxContext.OPENID
    : event.params.operator_openid
  const move_openid = event.params.from_openid   // 被移动的人
  const move_final = event.params.to_openid      // 移到这个人的前面；"-1" 表示队尾
  const machine_id = event.params.machine_id
  console.log('operator:', operator, 'move:', move_openid, '-> before:', move_final, 'machine:', machine_id)

  // 队列顺序存在 next_id 单链表里，两个人同时拖同一台机台会把链表改坏，
  // 所以先抢这台机台的分布式锁（和 checkUpdate 用的是同一套锁），改完再放。
  //
  // ⚠️ 原来这里校验的是「分布式锁必须已经属于被移动的那个人」，但：
  //    ① 前端从来不抢锁 —— miniprogram 里没有任何一个页面调用 checkUpdate，
  //       而抢锁是 checkUpdate 的职责，所以锁永远不在被移动的人手里；
  //    ② 拖动的人和被移动的人可以是两个人，本来就对不上。
  //    那个校验必然失败（锁记录缺失时还会因为 data[0] 是 undefined 直接抛异常），
  //    表现就是每次拖动都弹「排序失败」。
  //    改成：由本函数自己抢锁，锁的持有者是发起拖动的这个人。
  await ensureLockRecord(machine_id)
  const lockRes = await acquireQueueLock({ openid: operator, machine_id: machine_id })
  if (!lockRes.success) {
    return { success: false, errMsg: lockRes.errMsg || '队列正忙，请稍后重试' }
  }

  try {
    // 读出本机台队列（链表结构，next_id 指向下一位）
    const db_queue = "queue_" + machine_id
    const queue_record = await db.collection(db_queue).get()

    // 补上用户信息（昵称头像），返回给前端直接用
    let moved_user = null
    for (let i = 0; i < queue_record.data.length; i++) {
      const user_record = await db.collection(db_user)
        .where({ openid: queue_record.data[i].openid })
        .field({ openid: true, avatar: true, nickname: true })
        .get()
      const info = user_record.data[0]
      if (info && info.openid === move_openid) moved_user = info
      queue_record.data[i].user_info = info
    }

    const move_result = await moveUserToPosition(queue_record, move_openid, move_final, machine_id)
    if (!move_result.success) {
      return { success: false, errMsg: move_result.errMsg }
    }

    // 写队列日志
    const db_log = "queue_log_" + machine_id
    const who = moved_user ? moved_user.nickname : move_openid
    await db.collection(db_log).add({
      data: {
        timestamp: new Date(),
        openid: move_openid,
        log_info: "用户" + who + "于" + new Date() + "将自身位置移至第" + move_result.final_place + "位"
      }
    })

    return {
      success: true,
      data: move_result.sortedQ
    }
  } catch (e) {
    console.error('移动队列位置出错', e)
    return { success: false, errMsg: '排序出错：' + (e && e.message ? e.message : '未知错误') }
  } finally {
    // 不管成功、校验失败还是抛异常，都要把锁放开，
    // 否则这台机台的队列操作会一直被这次拖动挡着
    await releaseQueueLock({ openid: operator, machine_id: machine_id })
  }
}

/**
 * 把 move_openid 移动到 move_final 这一位之前；move_final === "-1" 表示排到队尾。
 *
 * ⚠️ 这个函数**先校验、后写库**：任何会导致失败的检查都在动数据库之前做完，
 *    校验不通过时数据库一个字都不会改。
 *
 *    之前的写法是「先把要移动的人从链表上摘下来（这时已经写库了），
 *    再去校验目标节点找不找得到」，于是校验失败时人已经被摘出链表 ——
 *    库里数据坏了，但函数只是返回失败，前端也只看到一句「排序失败」。
 *    更麻烦的是坏掉之后：那个人在库里还在、但不在链表上，
 *    别人拖到他前面时又会因为「目标不在链上」而失败，谁都动不了，只能退队重建队列。
 */
async function moveUserToPosition(queue_record, move_openid, move_final, machine_id) {
  const db_queue = "queue_" + machine_id

  if (!queue_record || !queue_record.data || queue_record.data.length === 0) {
    console.error("队列数据为空或无效")
    return { success: false, errMsg: "队列数据为空" }
  }

  const nodeMap = new Map()
  queue_record.data.forEach((qdata) => nodeMap.set(qdata.openid, qdata))

  // 头节点 = 没有任何人把它当作 next_id 的那个人
  let headNode = null
  queue_record.data.forEach((qdata) => {
    if (!queue_record.data.some((n) => n.next_id === qdata.openid)) headNode = qdata
  })
  if (!headNode) {
    console.error("队列链表没有头节点，next_id 数据异常")
    return { success: false, errMsg: "队列数据异常，请退队后重试" }
  }

  // ===== 阶段一：只读。沿链表从头走一遍，顺便校验链表完整 =====
  const chain = []
  let cursor = headNode
  while (cursor) {
    if (chain.some((n) => n.openid === cursor.openid)) {
      console.error("队列链表出现环，节点：", cursor.openid)
      return { success: false, errMsg: "队列数据异常，请退队后重试" }
    }
    chain.push(cursor)
    if (cursor.next_id === "-1") break
    const next = nodeMap.get(cursor.next_id)
    if (!next) {
      console.error("队列链表断了，找不到 next_id 指向的节点：", cursor.next_id)
      return { success: false, errMsg: "队列数据异常，请退队后重试" }
    }
    cursor = next
  }

  if (!nodeMap.get(move_openid)) {
    console.error("未找到要移动的用户")
    return { success: false, errMsg: "未找到要移动的用户" }
  }
  if (!chain.some((n) => n.openid === move_openid)) {
    // 记录在库里，但不在链表上（之前被改坏过）。
    // 不静默把人捡回队尾 —— 那样是把「数据坏了」伪装成「能跑」，明确报错让人重建队列。
    console.error("要移动的用户不在队列链表上：", move_openid)
    return { success: false, errMsg: "队列数据异常，请退队后重试" }
  }

  const moveNode = nodeMap.get(move_openid)

  // 目标就是自己：原地不动，当前顺序直接返回
  if (move_final === move_openid) {
    return buildResult(chain, move_openid)
  }

  // ===== 阶段二：只在内存里算新顺序，仍然不写库 =====
  // 先把自己摘掉得到「摘除后」的链，然后把新顺序整体重算一遍 next_id。
  // 不分别去改「原前驱」和「新前驱」—— 那样很容易漏掉一条，链表就断了。
  const chainAfter = chain.filter((n) => n.openid !== move_openid)
  if (chainAfter.length === 0) {
    // 队里只有他自己，没有位置可调
    return buildResult(chain, move_openid)
  }

  let insertAt
  if (move_final === "-1") {
    insertAt = chainAfter.length            // 排到队尾
  } else {
    if (!nodeMap.get(move_final) || !chainAfter.some((n) => n.openid === move_final)) {
      console.error("未找到目标位置的用户：", move_final)
      return { success: false, errMsg: "目标用户已不在队列中，请刷新重试" }
    }
    insertAt = chainAfter.findIndex((n) => n.openid === move_final)
  }

  const newOrder = chainAfter.slice()
  newOrder.splice(insertAt, 0, moveNode)

  // 按最终顺序重算每个人的 next_id，只写「真的变了」的那些
  const writes = []
  for (let i = 0; i < newOrder.length; i++) {
    const node = newOrder[i]
    const want = (i === newOrder.length - 1) ? "-1" : newOrder[i + 1].openid
    if (node.next_id !== want) writes.push({ openid: node.openid, next_id: want })
  }

  // ===== 阶段三：校验都过了，才开始写库 =====
  await applyNextIdWrites(db_queue, writes)

  return buildResult(newOrder, move_openid)
}

// 把重算出来的 next_id 逐条写回数据库。走到这里说明校验已经全部通过。
async function applyNextIdWrites(db_queue, writes) {
  if (writes.length === 0) {
    console.log("队列顺序没有变化，不需要写库")
    return
  }
  console.log("队列 next_id 更新：", writes)
  for (let i = 0; i < writes.length; i++) {
    await db.collection(db_queue).where({
      openid: writes[i].openid
    }).update({
      data: {
        next_id: writes[i].next_id
      }
    })
  }
}

// 按给定顺序算出返回值：新的队列数组 + 被移动的人排在第几位（从 1 开始）
function buildResult(orderedNodes, move_openid) {
  const sortedQ = orderedNodes.slice()
  const final_place = sortedQ.findIndex((n) => n.openid === move_openid) + 1
  console.log("更新后的队列:", sortedQ, "第", final_place, "位")
  return { success: true, sortedQ: sortedQ, final_place: final_place }
}

/**
 * machine_lock 是「一台机台一条」的分布式锁记录，正常应由管理员在云开发控制台预先建好：
 * acquireQueueLock 查不到记录时会直接返回「该机器分布式锁不存在，请联系管理员！」，
 * 它自己不负责创建。
 *
 * 这里在抢锁前补一条「已释放」的记录 —— 已释放的表示就是 release_time 为 1970-01-01，
 * 与 releaseQueueLock 的写法一致。这不是伪造业务数据，是让锁本身可用；
 * 否则任何一台机台漏建了锁记录，那台机台的拖动排序就整个用不了。
 */
async function ensureLockRecord(machine_id) {
  const found = await db.collection(db_machine_lock)
    .where({ machine_id: machine_id })
    .get()
  if (found.data.length > 0) return
  await db.collection(db_machine_lock).add({
    data: {
      machine_id: machine_id,
      openid: '',
      release_time: new Date(0)
    }
  })
  console.log("machine_lock 缺少该机台的锁记录，已按「已释放」补建：", machine_id)
}

// 分布式锁获取（与 checkUpdate/index.js 的实现保持一致）
async function acquireQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
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
    success: false
  }
}

// 释放分布式锁：把 release_time 归到 1970-01-01，表示这把锁已空闲
async function releaseQueueLock(params) {
  const openid = params.openid;
  const machine_id = params.machine_id;
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
