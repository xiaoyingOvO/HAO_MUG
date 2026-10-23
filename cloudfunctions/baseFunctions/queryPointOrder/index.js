/**
 * 查询充值订单状态（支付成功后的到账确认 + 兜底补发货）。
 *
 * 为什么要这个接口：
 *   微信的支付推送分支可能丢失（用户支付瞬间杀进程、网络抖动等），
 *   官方也建议「推送 + 轮询至少实现一个」。这里作为轮询入口：
 *   前端支付 success 后调它确认到账；发现已支付但没发货时顺手补发。
 *
 * 入参：{ params: { outTradeNo } }
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const COLL_ORDER = 'order';

const { readConfig, missingKeys } = require('../xpay/config');
const {
  deliverByOutTradeNo,
  queryRemoteOrder,
  isPaidResponse,
} = require('../xpay/pointService');

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const params = (event && event.params) || {};
  const outTradeNo = params.outTradeNo;

  if (!openid) {
    return { success: false, errMsg: '未获取到用户身份' };
  }
  if (!outTradeNo) {
    return { success: false, errMsg: '缺少订单号' };
  }

  const res = await db.collection(COLL_ORDER)
    .where({ out_trade_no: outTradeNo, openid })
    .limit(1)
    .get();
  if (!res.data || res.data.length === 0) {
    return { success: false, errMsg: '订单不存在' };
  }
  const order = res.data[0];

  // 已到账 / 已失败，直接返回本地状态
  if (order.state === 1) {
    return {
      success: true,
      data: {
        state: 1,
        point: order.point,
        extraPoint: order.extra_point || 0,
        delivered: true,
      },
    };
  }
  if (order.state === 2) {
    return {
      success: true,
      data: {
        state: 2,
        point: order.point,
        extraPoint: 0,
        delivered: false,
        errMsg: order.fail_reason || '支付未完成',
      },
    };
  }

  // state=0：向微信查单，确认是否已支付但推送丢了
  const conf = readConfig();
  const appId = wxContext.APPID;
  if (missingKeys(conf).length === 0 && appId) {
    try {
      const remote = await queryRemoteOrder(outTradeNo, openid, appId);
      console.log('[xpay] 查单结果 outTradeNo=' + outTradeNo + ' =>', JSON.stringify(remote));
      if (isPaidResponse(remote)) {
        const wxOrderId = (remote.order && (remote.order.order_id || remote.order.wx_order_id))
          || (remote.order_info && remote.order_info.order_id)
          || '';
        const delivered = await deliverByOutTradeNo(outTradeNo, { wxOrderId });
        if (delivered.ok) {
          return {
            success: true,
            data: {
              state: 1,
              point: order.point,
              extraPoint: delivered.extraAdd || order.extra_point || 0,
              delivered: true,
              by: 'query',
            },
          };
        }
      }
    } catch (err) {
      // 查单只是兜底，失败不改变「支付中」结论，等推送来即可
      console.warn('[xpay] 查单失败（忽略）：', err && err.message);
    }
  } else {
    console.warn('[xpay] 查单跳过：虚拟支付环境变量不完整');
  }

  return {
    success: true,
    data: {
      state: 0,
      point: order.point,
      extraPoint: 0,
      delivered: false,
    },
  };
};
