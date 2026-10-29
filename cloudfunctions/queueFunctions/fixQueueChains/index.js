const cloud = require('wx-server-sdk');
const { buildChain, rewriteChain, QUEUE_FETCH_LIMIT, SEQ_FIELD } = require('../queueChain');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 一次性给所有机台的队列补上 queue_seq（排队顺序号），并修好断链 / 分叉。
 * ================================================================
 * 背景：队列先后原来只靠 next_id 单链表表达。链表一旦被历史版本写乱
 *   （断链、两个队尾、顺序错），就再也无法可靠还原「谁该排在前面」——
 *   尤其「被请下台插到队首」的人入队时间晚、却该排最前，靠入队时间猜会错。
 *
 * 本函数的职责（**只做安全的事，不猜正确顺序**）：
 *   1. 给每条队列记录补写 queue_seq（按当前链序编号 1、2、3…）——
 *      之后 buildChain 优先按 queue_seq 排序，链再乱也能按号还原；
 *   2. 若 next_id 链真的断掉 / 分叉（有人掉出链），按
 *      「游玩中的人在前 + 等候的人按入队时间」把它拼回一条完整单链。
 *
 *   ⚠️ 不重排「本来连成一条链但顺序可能有争议」的队伍：那种情况事后无从判断，
 *      由下一次操作（入队 / 下机 / 拖动）触发 rewriteChain 时按业务规则修正。
 *
 * 触发方式：type = 'fixQueueChains'。
 *   · 默认 dryRun=true 只报告；传 dryRun=false 才写库。
 *   · 传 machine_id 只修这一台，不传则扫全部。
 */
exports.main = async (event, context) => {
  const params = (event && event.params) || {};
  const dryRun = params.dryRun !== false;
  const onlyMachineId = params.machine_id || null;

  const result = { success: true, dryRun, repaired: [], errors: [] };

  try {
    const machines = [];
    if (onlyMachineId) {
      const r = await db.collection('machine').where({ _id: onlyMachineId }).limit(1000).get();
      machines.push(...r.data);
    } else {
      const r = await db.collection('machine').limit(1000).get();
      machines.push(...r.data);
    }

    for (const m of machines) {
      const machineId = m._id;
      const dbQueue = 'queue_' + machineId;
      try {
        const rows = (await db.collection(dbQueue).limit(QUEUE_FETCH_LIMIT).get()).data;
        if (!rows.length) continue;

        // ① 是否缺 queue_seq（老数据）或链断裂（buildChain 兜底丢人/重排）
        const missingSeq = rows.some(r => !(Number(r[SEQ_FIELD]) > 0));
        const chain = buildChain(rows);
        const chainBroken = chain.length !== rows.length;

        if (!missingSeq && !chainBroken) continue; // 健康，跳过

        // ② 拼出「能写入的顺序」：
        //    链完整 → 直接用 buildChain 还原的顺序（不重排，只补号）
        //    链断裂 → 游玩在前（按入队时间）+ 等候按入队时间，兜底拼回一条链
        let order;
        if (!chainBroken) {
          order = chain;
        } else {
          const playing = rows.filter(r => r.play_status === true).sort((a, b) => tsOf(a) - tsOf(b));
          const waiting = rows.filter(r => r.play_status !== true).sort((a, b) => tsOf(a) - tsOf(b));
          order = playing.concat(waiting);
        }

        if (dryRun) {
          result.repaired.push({
            machineId,
            missingSeq,
            chainBroken,
            order: order.map(r => r.openid).join(' → '),
          });
        } else {
          const n = await rewriteChain(db, dbQueue, order);
          result.repaired.push({
            machineId,
            missingSeq,
            chainBroken,
            order: order.map(r => r.openid).join(' → '),
            writes: n,
          });
        }
      } catch (e) {
        result.errors.push({ machineId, err: e && e.message ? e.message : String(e) });
      }
    }
  } catch (e) {
    result.success = false;
    result.errMsg = e && e.message ? e.message : String(e);
  }

  return result;
};

// 入队时间戳（毫秒）；缺失 / 非法当 0（最老）
function tsOf(row) {
  const t = row && row.timestamp ? new Date(row.timestamp).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}
