/**
 * 点数发货（虚拟支付回调 / 查单兜底共用的唯一入口）。
 *
 * 设计要点：
 *   1. 幂等：同一笔 out_trade_no 重复通知只发一次货。用事务读订单状态判断，
 *      而不是「先查再写」，避免并发回调都读到 state=0 各发一次。
 *   2. 赠送规则与 baseFunctions/buyPoint 完全一致（按 exp 分档，Lv6 拒绝充值），
 *      这里不改规则，只把「已付款」这件事翻译成加点动作。
 *   3. 充值同时增加 exp，规则对齐 mock 的 applyPendingRecharge：
 *      exp += 充值金额（1 元 = 1 点 = 1 exp）。
 *
 * 订单集合沿用 'order'（管理端「充值查询」读的就是它），只追加虚拟支付相关字段，
 * 老字段 point / state / time_order / time_expire 的含义保持不变：
 *   state: 0 支付中 / 1 支付成功 / 2 支付失败
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

const COLL_USER = 'user';
const COLL_ORDER = 'order';

// Lv6 阈值，与 buyPoint / recharge 页保持一致
const MAX_LEVEL_EXP = 114514;

/**
 * 按等级算赠送倍率，规则严格对齐 cloudfunctions/baseFunctions/buyPoint/index.js
 * @returns {{ ok: boolean, bonus: number }}
 */
function calcBonus(exp) {
  const e = Number(exp) || 0;
  if (e <= 2000) return { ok: true, bonus: 0 };
  if (e <= 8000) return { ok: true, bonus: 0.05 };
  if (e <= 18000) return { ok: true, bonus: 0.10 };
  if (e <= 30000) return { ok: true, bonus: 0.20 };
  if (e < MAX_LEVEL_EXP) return { ok: true, bonus: 0.30 };
  // 最高等级用户无需充值
  return { ok: false, bonus: 0 };
}

/**
 * 按订单号发货（幂等）
 *
 * @param {string} outTradeNo 业务订单号
 * @param {object} meta       可选：{ wxOrderId 平台单号, paidAt 支付时间 }
 * @returns {Promise<{ok:boolean, duplicated?:boolean, errMsg?:string, realAdd?:number, extraAdd?:number}>}
 */
async function deliverByOutTradeNo(outTradeNo, meta) {
  const m = meta || {};
  if (!outTradeNo) return { ok: false, errMsg: '缺少订单号' };

  const orderRes = await db.collection(COLL_ORDER)
    .where({ out_trade_no: outTradeNo })
    .limit(1)
    .get();
  if (!orderRes.data || orderRes.data.length === 0) {
    return { ok: false, errMsg: '订单不存在：' + outTradeNo };
  }
  const order = orderRes.data[0];

  // 快速路径：已经发过货
  if (order.state === 1) {
    return { ok: true, duplicated: true, realAdd: 0, extraAdd: 0 };
  }

  const userRes = await db.collection(COLL_USER)
    .where({ openid: order.openid })
    .field({ _id: true, exp: true })
    .limit(1)
    .get();
  if (!userRes.data || userRes.data.length === 0) {
    return { ok: false, errMsg: '用户不存在：' + order.openid };
  }
  const user = userRes.data[0];

  const bonus = calcBonus(user.exp);
  if (!bonus.ok) {
    // 最高等级用户不该走到这里（下单前已拦），兜底标记失败并留痕
    await db.collection(COLL_ORDER).doc(order._id).update({
      data: {
        state: 2,
        fail_reason: 'MAX_LEVEL_EXP',
        failed_at: new Date(),
      },
    });
    return { ok: false, errMsg: '最高等级用户无需充值' };
  }

  const realAdd = Number(order.point) || 0;
  const extraAdd = Math.round(realAdd * bonus.bonus * 100) / 100;

  const updateOrder = {
    state: 1,
    extra_point: extraAdd,
    paid_at: m.paidAt || new Date(),
    delivered_at: new Date(),
  };
  if (m.wxOrderId) updateOrder.wx_order_id = m.wxOrderId;

  // 事务保证「加点」和「改订单状态」原子完成：要么都成，要么都不成。
  const tx = await db.startTransaction();
  try {
    const fresh = await tx.collection(COLL_ORDER).doc(order._id).get();
    if (!fresh.data) {
      await tx.rollback();
      return { ok: false, errMsg: '订单已不存在' };
    }
    if (fresh.data.state === 1) {
      // 并发下另一条通知已经发过货
      await tx.rollback();
      return { ok: true, duplicated: true, realAdd: 0, extraAdd: 0 };
    }

    await tx.collection(COLL_USER).doc(user._id).update({
      data: {
        real_point: _.inc(realAdd),
        extra_point: _.inc(extraAdd),
        exp: _.inc(Math.round(realAdd)),
      },
    });

    await tx.collection(COLL_ORDER).doc(order._id).update({
      data: updateOrder,
    });

    await tx.commit();
    return { ok: true, realAdd, extraAdd };
  } catch (err) {
    try {
      await tx.rollback();
    } catch (e) {
      // rollback 失败说明事务已结束，忽略
    }
    throw err;
  }
}

/** 把订单标记为失败（支付失败/取消时用，失败不影响主流程） */
async function markOrderFailed(outTradeNo, reason) {
  if (!outTradeNo) return;
  try {
    await db.collection(COLL_ORDER)
      .where({ out_trade_no: outTradeNo, state: 0 })
      .update({
        data: {
          state: 2,
          fail_reason: reason || '',
          failed_at: new Date(),
        },
      });
  } catch (e) {
    console.warn('[xpay] 标记订单失败出错：', e && e.message);
  }
}

/**
 * 查单（兜底用），返回微信原始响应
 * @param {string} outTradeNo 业务订单号
 * @param {string} openid
 * @param {string} appId 小程序 AppID（由调用方从 cloud.getWXContext() 取）
 */
async function queryRemoteOrder(outTradeNo, openid, appId) {
  const { readConfig, currentAppKey } = require('./config');
  const http = require('./http');
  const { calcPaySig } = require('./sign');

  const conf = readConfig();
  const appKey = currentAppKey(conf);
  const bodyObj = {
    openid,
    env: conf.env,
    order_id: outTradeNo,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const paySig = calcPaySig('/xpay/query_order', bodyStr, appKey);

  // access_token 用 AppSecret 换
  const token = await http.getAccessToken(appId || '', conf.appSecret);
  const path = '/xpay/query_order?access_token=' + encodeURIComponent(token)
    + '&pay_sig=' + encodeURIComponent(paySig);
  return await http.requestJson('POST', path, bodyStr);
}

/**
 * 判断查单结果是否已支付。
 * 微信虚拟支付订单状态与米大师一致，2 表示已支付；
 * 字段名在不同接口版本里可能是 status / order_status，这里做兼容。
 * 判不准时一律当作未支付，宁可让回调来发货，也不误发。
 */
function isPaidResponse(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.errcode && Number(res.errcode) !== 0) return false;
  const o = res.order || res.order_info || res;
  const raw = o.status != null ? o.status : (o.state != null ? o.state : o.order_status);
  if (raw == null) return false;
  return String(raw) === '2';
}

module.exports = {
  MAX_LEVEL_EXP,
  calcBonus,
  deliverByOutTradeNo,
  markOrderFailed,
  queryRemoteOrder,
  isPaidResponse,
};
