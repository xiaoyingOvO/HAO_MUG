/**
 * 机台分布式锁（machine_lock 集合）
 * ================================================================
 * 所有「会改队列」的操作都要先抢这台机台的锁，避免两个人同时操作时
 * 队列被交叉改写（典型后果：两条记录指向同一个人 → 链表分叉）。
 *
 * 实现方式和 Deplain / Enqueue / Embark 里各存一份的版本完全一致，
 * 这里是给新函数（switchMulti）用的公共版本，避免再复制一遍。
 * ⚠️ 本模块不 cloud.init —— 由各入口函数初始化，这里只取 database()。
 */

const cloud = require('wx-server-sdk')

const db_machine_lock = 'machine_lock'
const max_retry_time = 5
const retry_wait_seconds = 0.5
// 抢到锁后 2 秒自动过期：即使调用方崩在中间没释放，也不会把机台永久锁死
const max_machine_lock_seconds = 2

async function acquireQueueLock(params) {
  const db = cloud.database()
  const openid = params.openid
  const machine_id = params.machine_id
  let updated = 0

  for (var retry_time = 1; retry_time <= max_retry_time; retry_time++) {
    const machine_lock_record = await db.collection(db_machine_lock)
      .where({ machine_id: machine_id })
      .field({ openid: true, release_time: true })
      .get()

    if (machine_lock_record != null && machine_lock_record.data.length == 0) {
      return {
        success: false,
        errMsg: '该机器分布式锁不存在，请联系管理员！',
      }
    }

    const old_openid = machine_lock_record.data[0].openid
    const old_release_time = machine_lock_record.data[0].release_time

    // 锁被别人占着且还没过期 → 等一会再试
    const now = new Date()
    if (old_openid != openid && now < old_release_time) {
      await sleep(retry_wait_seconds)
      continue
    }

    // CAS 抢锁：把「谁持有 + 过期时间」一起条件更新，只有一个人能成功
    const release_time = new Date()
    release_time.setSeconds(release_time.getSeconds() + max_machine_lock_seconds)
    await db.collection(db_machine_lock)
      .where({
        machine_id: machine_id,
        openid: old_openid,
        release_time: old_release_time,
      })
      .update({
        data: {
          openid: openid,
          release_time: release_time,
        },
      })
      .then(res => {
        updated = res.stats.updated
      })

    if (updated != 0) return { success: true }
    await sleep(retry_wait_seconds)
  }

  return { success: false }
}

async function releaseQueueLock(params) {
  const db = cloud.database()
  await db.collection(db_machine_lock)
    .where({
      machine_id: params.machine_id,
      openid: params.openid,
    })
    .update({
      data: { release_time: new Date(0) },
    })
    .catch(err => console.error('[queueLock] 释放锁失败', err))
}

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

module.exports = { acquireQueueLock, releaseQueueLock }
