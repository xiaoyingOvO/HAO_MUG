const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const db_user = 'user'
const db_machine_lock = 'machine_lock'

const max_retry_time = 5
const retry_wait_seconds = 0.5
const max_machine_lock_seconds = 2

// 座位空出来后按规则自动补位
const { autoEmbarkAfterDeplain, logTimeBeforeEmbark } = require('../autoEmbark')
// 「把人放回队尾」的公共实现（切单刷挤走同台的人也用这个）
const { kickToTail } = require('../kickToTail')
// 「先上机 / 后上机」标签：全部下机时按它决定回队尾的先后（先上机的先回）
const { sortByEmbarkOrder } = require('../embarkOrder')
// 整条队列的链表视图（判断「游玩区有谁」「等候区还有没有别人」）
const { buildChain, QUEUE_FETCH_LIMIT } = require('../queueChain')

/**
 * 强制下机（**不结算费用**）
 *
 * 和 Deplain 唯一的区别：不调 getConsumePoint、不扣点数、不写消费记录。
 * 用途：店员把占着座位的人请下来（人跑开了没点下机、机台要腾给别人等），
 *       人被放回**等候区队尾**，仍然在店内（enter_state=2）、仍然排在这台机台的队列里。
 *
 * 权限：**操作者必须在这台机台的队列里**（游玩中或等候中都算），否则拒绝。
 *       不在队伍里的人（刚退队、在别的机台、路过的）不能把别人请下去。
 *
 * 参数：
 *   params.machine_id  机台 id
 *   params.openid      被强制下机的人（不传 = 自己）
 *   params.all         true = 游玩区的人**全部**下机（设置页的「全部下机」按钮）：
 *                      一次把所有人放回队尾，只写一条日志、只补一次位。
 *                      传了 all 就忽略 openid。
 */
exports.main = async (event, context) => {
  const params = (event && event.params) || {}
  const machine_id = params.machine_id
  // all = 游玩区所有人一起下机（设置页的「全部下机」）
  const all = params.all === true
  const wxContext = cloud.getWXContext()
  const callerOpenid = wxContext && wxContext.OPENID ? wxContext.OPENID : ''
  const targetOpenid = params.openid || callerOpenid

  if (!machine_id) {
    return { success: false, errMsg: '缺少机台参数' }
  }
  if (!targetOpenid) {
    return { success: false, errMsg: '缺少用户参数' }
  }

  const db_queue = 'queue_' + machine_id
  // 锁由「实际操作的人」持有：被强制下机的人自己同时点下机时，
  // 两边不会因为 openid 相同而同时拿到锁（那样会重复摘链、重复补位）
  const lockOwner = callerOpenid || targetOpenid

  const lockRes = await acquireQueueLock({ openid: lockOwner, machine_id: machine_id })
  if (!lockRes.success) {
    return {
      success: false,
      errMsg: lockRes.errMsg || '机台正忙，请稍后重试',
    }
  }

  try {
    // ⓪ 操作者必须还在这台机台的队列里（游玩中、等候中都算）
    //    不在队伍里的人没资格把台上的人请下去：路过的、已经退队去别的机台的都不行。
    //    前端设置页也会拦（不在队列时点不开强制下机面板），但云函数能被直接调用，
    //    前端那道只能防误触，这道才是规则本身。
    if (!callerOpenid) {
      return { success: false, errMsg: '缺少操作者信息，请重新进入小程序' }
    }
    const callerRecord = await db.collection(db_queue).where({
      openid: callerOpenid
    }).get()
    if (callerRecord.data.length == 0) {
      return { success: false, errMsg: '你不在本机台的队列中，不能强制下机' }
    }

    // 全部下机：走单独的一条流程（一次拿锁、一次补位、一条日志）
    if (all) {
      return await forceAllDown({ machine_id: machine_id, callerOpenid: callerOpenid })
    }

    // ① 目标必须在游玩状态
    const queueRecord = await db.collection(db_queue).where({
      openid: targetOpenid
    }).get()
    if (queueRecord.data.length == 0) {
      return { success: false, errMsg: '该用户已不在队列表中，请刷新重试' }
    }
    if (queueRecord.data[0].play_status != true) {
      return { success: false, errMsg: '该用户当前不在游玩状态，请刷新重试' }
    }

    // ② ~ ④ 摘链 → 追加队尾 → 整体重算 next_id → 清游玩字段 → enter_state=2
    //   和「切成单刷时把同台的人移下去」共用同一份实现（kickToTail.js）
    const kicked = await kickToTail({
      machine_id: machine_id,
      openid: targetOpenid,
    })
    if (!kicked.success) {
      return { success: false, errMsg: kicked.errMsg || '强制下机失败，请重试' }
    }

    // ⑤ 空出来的座位按规则自动补位（排除刚被请下来的人，否则他又被排回去）
    const autoRes = await autoEmbarkAfterDeplain({
      machine_id: machine_id,
      exclude_openids: [targetOpenid]
    })
    console.log('[ForceDeplain] 自动上机结果：', autoRes)

    // ⑥ 写队列日志
    //    时间戳用 logTimeBeforeEmbark：日志页是时间倒序，这条要比那批
    //    「自动上机」日志**更早**，才会显示在它们下面 —— 读起来是「先强制下机，再上机」。
    await writeQueueLog({
      machine_id: machine_id,
      operatorOpenid: callerOpenid,
      targetOpenid: targetOpenid,
      logTime: logTimeBeforeEmbark(autoRes),
    })

    return {
      success: true,
      embarked: autoRes && autoRes.embarked ? autoRes.embarked : [],
    }
  } catch (e) {
    console.error('[ForceDeplain] 执行出错：', e)
    return { success: false, errMsg: '强制下机失败，请重试' }
  } finally {
    await releaseQueueLock({ openid: lockOwner, machine_id: machine_id })
  }
}

/**
 * 全部下机：把游玩区的人一次性请下来
 * ================================================================
 * 步骤和单人版一样（回队尾 → 补位 → 写日志），只是**批量**做：
 *   ① 找出正在游玩的人，按「先上机 / 后上机」标签排序 → 先上机的先回队尾，
 *      队尾里还是「先上机的人在前」（和 DeplainAll 拼机一起下机的口径一致）；
 *   ② 逐个 kickToTail（position='tail'），不结算、不清 is_multi；
 *   ③ 补位：**等候区还有别人**才补，一个人都没有就让机台空着
 *      （台下没人却还把刚请下来的人扶回去，等于这个按钮什么都没做）。
 *      刚被请下来的人**不排除**：他们已经排在队尾，跟着队伍重新竞争。
 *      这里要是像单人版那样排除他们，就会出现半空的机台：
 *      2 座机上 A、B 在玩，台下只排着 1 个单刷的 C → 把 A、B 排除掉之后
 *      只有 C 能上，机台坐 1 人空 1 座，而 A、B 明明还排在台下。
 *   ④ 写**一条**日志：「某某让A、B强制下机了」（日志页的解析规则不用改）。
 *
 * ⚠️ 补位后**不要**把老标签改写回去（以前写过一版，是错的）：
 *    全部下机是「所有人都真的下过机」，谁都不再保留「我先来的」这个身份，
 *    重新上机时先后**就是排队顺序**——队首的 C 先领号（先上机），
 *    接着被补上来的 A 后领号（后上机），B 留在队伍里。
 *    autoEmbark 的 prepareEmbarkSeq 本来就是按挑选顺序发号的（1、2、3…），
 *    正好就是这个语义；再拿 `seqBefore` 把 A 的老号盖回去，A 会重新变成「先上机」，
 *    和「已经下去过一轮」的事实矛盾。
 *    只有**单人**强制下机才需要保住台上那位的先后——他压根没下去过，
 *    而且那个人根本不在补位候选里（exclude_openids），号本来也不会被动。
 */
async function forceAllDown(params) {
  const machine_id = params.machine_id
  const callerOpenid = params.callerOpenid
  const db_queue = 'queue_' + machine_id

  // ① 谁在游玩（按标签排：先上机的先回队尾）
  const rows = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
  const chain = buildChain(rows)
  const playing = sortByEmbarkOrder(chain.filter(r => r.play_status === true))
  if (!playing.length) {
    return { success: false, errMsg: '这台机台当前没有人在游玩' }
  }

  // ② 逐个回队尾
  const downed = []
  for (let i = 0; i < playing.length; i++) {
    const kicked = await kickToTail({
      machine_id: machine_id,
      openid: playing[i].openid,
      position: 'tail',
    })
    if (kicked.success) downed.push(playing[i].openid)
    else console.error('[ForceDeplain] 全部下机：移下机失败', playing[i].openid, kicked && kicked.errMsg)
  }
  if (!downed.length) {
    return { success: false, errMsg: '强制下机失败，请重试' }
  }

  // ③ 等候区还有没有「别人」：有 → 按规则补位；没有 → 机台空着（这正是全部下机的意义）
  const downSet = new Set(downed)
  const rowsAfter = (await db.collection(db_queue).limit(QUEUE_FETCH_LIMIT).get()).data
  const waitingOthers = rowsAfter.filter(r => r.play_status !== true && !downSet.has(r.openid))
  let autoRes = { embarked: [] }
  if (waitingOthers.length) {
    autoRes = await autoEmbarkAfterDeplain({ machine_id: machine_id })
    console.log('[ForceDeplain] 全部下机后自动上机结果：', autoRes)
  }

  // ④ 写一条日志（顺序 = 回队尾的顺序）
  //    上机标签这里不用管：autoEmbark 按挑选顺序发号（1、2、3…）——队首的 C 先上、
  //    先领号（先上机），被他带上来的 A 后领号（后上机），正好是「全部下机之后
  //    按排队顺序重新上机」的语义。别再拿老号盖回去（见上面的 ⚠️）。
  const downedRows = playing.filter(p => downSet.has(p.openid))
  await writeQueueLogMulti({
    machine_id: machine_id,
    operatorOpenid: callerOpenid,
    openids: downedRows.map(p => p.openid),
    // 同单人版：这条日志要显示在这一批「自动上机」上面（先强制下机，再上机）
    logTime: logTimeBeforeEmbark(autoRes),
  })

  return {
    success: true,
    downed: downed,
    embarked: autoRes && autoRes.embarked ? autoRes.embarked : [],
  }
}

/**
 * 名字连接：「一个人」「A和B」「A、B和C」
 *   只下机一个人时不出现「和」；两个人用「和」；三个及以上最后一个人前面用「和」，
 *   前面的用顿号（中文习惯写法，日志页整串当成被操作者，不参与切分）。
 */
function joinNames(names) {
  const list = (names || []).filter(Boolean)
  if (list.length <= 1) return list.join('')
  return list.slice(0, -1).join('、') + '和' + list[list.length - 1]
}

/**
 * 全部下机的日志：「某某让A和B强制下机了」
 *   日志页的 /^让(.+?)强制下机了$/ 规则天然吃得下多个名字（整串当成被操作者），
 *   所以不用为多人改解析器。
 *   操作者自己也在被请下来的人里时，名字列表里**一定**要去掉他——
 *   强制下机只下别人，写「小明让小明和小红强制下机了」是错的。
 *   如果台上只有操作者一个人 → 退化成「小明下机了」（见 writeQueueLog）。
 */
async function writeQueueLogMulti(params) {
  const { machine_id, operatorOpenid, openids, logTime } = params
  const list = (openids || []).filter(Boolean)
  if (!list.length) return
  try {
    // 操作者自己也在台上、点了「全部强制下机」→ 等价于「自己直接下机」，
    //   整台的人（包括自己）都只写「昵称下机了」，不出现「让X强制下机」。
    if (operatorOpenid && list.indexOf(operatorOpenid) >= 0) {
      // 日志页「越上面越晚」：list 已按上机先后排（sortByEmbarkOrder，先上机在前），
      //   先上机的人更早、下机日志该在下面（时间戳小），后上机的在上面（时间戳大）。
      //   第 i 个人用 logTime - (n-1-i)，整批最大值 logTime 不变，仍压在自动上机日志下面。
      const cnt = list.length
      for (let i = 0; i < list.length; i++) {
        await writeQueueLog({
          machine_id: machine_id,
          operatorOpenid: list[i],
          targetOpenid: list[i],
          logTime: logTime ? new Date(new Date(logTime).getTime() - (cnt - 1 - i)) : null,
        })
      }
      return
    }

    const operatorName = operatorOpenid ? await nicknameOf(operatorOpenid) : ''
    const names = []
    for (let i = 0; i < list.length; i++) {
      names.push(await nicknameOf(list[i]))
    }

    const bjNow = new Date(Date.now() + 8 * 3600 * 1000)
    const timeStr = pad2(bjNow.getHours()) + ':' + pad2(bjNow.getMinutes()) + ':' + pad2(bjNow.getSeconds())

    // 操作者不在台下：正常写「操作者让X强制下机了」
    const content = operatorName
      ? '[' + timeStr + '] ' + operatorName + '让' + joinNames(names) + '强制下机了'
      : '[' + timeStr + '] ' + joinNames(names) + '强制下机了'
    await db.collection('queue_log_' + machine_id).add({
      data: {
        timestamp: logTime || new Date(),
        openid: list[0],
        log_info: content,
      }
    })
  } catch (e) {
    // 日志写失败不能影响「人已经被请下来」这个事实
    console.error('[ForceDeplain] 写全部下机日志失败：', e)
  }
}

async function nicknameOf(openid) {
  try {
    const res = await db.collection(db_user).where({ openid: openid }).field({ nickname: true }).get()
    return (res.data[0] && res.data[0].nickname) || '未知用户'
  } catch (e) {
    return '未知用户'
  }
}

/**
 * 写一条队列日志：「某某让某某强制下机了」
 *   · 操作者 = 被下机的人（自己把自己请下去）→ 写「某某下机了」，
 *     强制下机只会下**别人**，没有「让」的对象就不该出现「强制」二字；
 *   · 其余情况 → 「某某让某某强制下机了」。
 *   日志页的解析器（pages/play-log/log.js）对「让X强制下机了」有单独的切分规则，
 *   改文案时两边要一起改，否则名字会被切错。
 */
async function writeQueueLog(params) {
  const { machine_id, operatorOpenid, targetOpenid, logTime } = params
  try {
    const targetRes = await db.collection(db_user).where({
      openid: targetOpenid
    }).field({ nickname: true }).get()
    const targetName = (targetRes.data[0] && targetRes.data[0].nickname) || '未知用户'

    let operatorName = ''
    if (operatorOpenid && operatorOpenid !== targetOpenid) {
      const operatorRes = await db.collection(db_user).where({
        openid: operatorOpenid
      }).field({ nickname: true }).get()
      operatorName = (operatorRes.data[0] && operatorRes.data[0].nickname) || '未知用户'
    }

    const bjNow = new Date(Date.now() + 8 * 3600 * 1000)
    const timeStr = pad2(bjNow.getHours()) + ':' + pad2(bjNow.getMinutes()) + ':' + pad2(bjNow.getSeconds())
    const content = operatorName
      ? '[' + timeStr + '] ' + operatorName + '让' + targetName + '强制下机了'
      : '[' + timeStr + '] ' + targetName + '下机了'

    await db.collection('queue_log_' + machine_id).add({
      data: {
        timestamp: logTime || new Date(),
        openid: targetOpenid,
        log_info: content,
      }
    })
  } catch (e) {
    // 日志写失败不能影响「人已经被请下来」这个事实
    console.error('[ForceDeplain] 写日志失败：', e)
  }
}

// 分布式锁获取（和 Deplain / Embark / Enqueue 同一套）
async function acquireQueueLock(params) {
  const openid = params.openid
  const machine_id = params.machine_id
  let updated = 0

  for (var retry_time = 1; retry_time <= max_retry_time; retry_time++) {
    let machine_lock_record = await db.collection(db_machine_lock)
      .where({ machine_id: machine_id })
      .field({ openid: true, release_time: true })
      .get()

    if (machine_lock_record != null && machine_lock_record.data.length == 0) {
      console.log('该机器分布式锁不存在')
      return {
        success: false,
        errMsg: '该机器分布式锁不存在，请联系管理员！'
      }
    }

    const old_openid = machine_lock_record.data[0].openid
    const old_release_time = machine_lock_record.data[0].release_time
    const release_time = new Date()
    // 锁被别人占着且还没过期 → 等一等再来
    if (old_openid != openid && release_time < old_release_time) {
      console.log('machine lock retry time: ' + retry_time)
      await sleep(retry_wait_seconds)
      continue
    }

    // CAS 抢锁
    release_time.setSeconds(release_time.getSeconds() + max_machine_lock_seconds)
    await db.collection(db_machine_lock).where({
      machine_id: machine_id,
      openid: old_openid,
      release_time: old_release_time
    }).update({
      data: {
        openid: openid,
        release_time: release_time
      }
    }).then(res => {
      updated = res.stats.updated
    })

    if (updated != 0) {
      console.log('上锁成功')
      return { success: true }
    }

    console.log('machine lock retry time: ' + retry_time)
    await sleep(retry_wait_seconds)
  }

  console.log('上锁失败')
  return { success: false }
}

async function releaseQueueLock(params) {
  const openid = params.openid
  const machine_id = params.machine_id
  await db.collection(db_machine_lock).where({
    machine_id: machine_id,
    openid: openid
  }).update({
    data: { release_time: new Date(0) }
  })
  console.log('释放锁成功')
}

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}
