/**
 * 虚拟支付消息推送处理器（云开发「消息推送」能力的接收端）。
 *
 * 接入方式（不需要自建服务器、不需要验签）：
 *   开发者工具 → 云开发 → 设置 → 其他设置 → 消息推送
 *   → 推送模式选「云函数」
 *   → 添加配置：消息类型 event，事件类型 xpay_goods_deliver_notify，云函数选 baseFunctions
 *   （建议同时勾上 xpay_refund_notify、xpay_complaint_notify）
 *
 * 云开发会把事件解析成明文对象直接传进来，所以这里拿到的是扁平字段，
 * 不需要解析 XML，也不需要校验签名。
 *
 * 响应约定：返回 ErrCode=0 表示处理成功，否则微信会重试（最多 15 次）。
 * 因此「订单不存在」这类无法通过重试解决的错误也必须返回 0，否则会被重试打满。
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const COLL_ORDER = 'order';

const { deliverByOutTradeNo } = require('../xpay/pointService');

const EVENT_GOODS_DELIVER = 'xpay_goods_deliver_notify';
const EVENT_COIN_PAY = 'xpay_coin_pay_notify';
const EVENT_REFUND = 'xpay_refund_notify';
const EVENT_COMPLAINT = 'xpay_complaint_notify';

function ok() {
  return { ErrCode: 0, ErrMsg: 'success' };
}

/**
 * 把各种可能的入参包法统一成扁平事件对象。
 * 云开发的「云函数」推送模式给的是扁平对象，但不同基础库/工具版本偶尔会包一层 data，
 * 这里做兼容，避免回调静默失败。
 */
function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return {};
  if (event.Event) return event;
  if (event.data && event.data.Event) return event.data;
  if (event.event && typeof event.event === 'object') return event.event;
  // 兜底：把可能存在的 JSON 字符串 body 解析一次
  if (typeof event.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      if (parsed && parsed.Event) return parsed;
    } catch (e) {
      // 忽略
    }
  }
  return event;
}

exports.main = async (event, context) => {
  const e = normalizeEvent(event);
  const eventType = e.Event;

  console.log('[xpayNotify] 收到推送：', eventType, JSON.stringify(e));

  if (!eventType) {
    console.warn('[xpayNotify] 推送缺少 Event 字段，忽略');
    return ok();
  }

  // ---- 道具发货：支付成功后发放点数 ----
  if (eventType === EVENT_GOODS_DELIVER) {
    const outTradeNo = e.OutTradeNo;
    const payInfo = e.WeChatPayInfo || {};
    const wxOrderId = payInfo.MchOrderNo || '';
    const paidTime = Number(payInfo.PaidTime) || 0;

    if (!outTradeNo) {
      console.error('[xpayNotify] 发货推送缺少 OutTradeNo');
      return ok();
    }

    try {
      const result = await deliverByOutTradeNo(outTradeNo, {
        wxOrderId,
        paidAt: paidTime ? new Date(paidTime * 1000) : new Date(),
      });
      if (result.ok) {
        console.log('[xpayNotify] 发货完成 outTradeNo=' + outTradeNo
          + ' realAdd=' + result.realAdd + ' extraAdd=' + result.extraAdd
          + (result.duplicated ? '（重复推送，已忽略）' : ''));
      } else {
        // 订单不存在 / 用户不存在：重试也解决不了，记日志后返回成功
        console.error('[xpayNotify] 发货失败 outTradeNo=' + outTradeNo + '：' + result.errMsg);
      }
    } catch (err) {
      // 真正的临时性异常（数据库抖动等）返回非 0，让微信重试
      console.error('[xpayNotify] 发货异常，等待重试：', err && err.message);
      return { ErrCode: -1, ErrMsg: 'internal error' };
    }
    return ok();
  }

  // ---- 退款通知：只留痕，不自动扣点 ----
  // 点数可能已被消费掉，自动扣减会把余额扣成负数并影响排队/进店判断，
  // 所以这里只把订单标记为已退款，具体处理交给管理员。
  if (eventType === EVENT_REFUND) {
    const outTradeNo = e.OutTradeNo;
    if (outTradeNo) {
      try {
        await db.collection(COLL_ORDER)
          .where({ out_trade_no: outTradeNo })
          .update({
            data: {
              refund_state: 'notified',
              refund_at: new Date(),
              refund_raw: JSON.stringify(e).slice(0, 1000),
            },
          });
        console.log('[xpayNotify] 退款通知已记录 outTradeNo=' + outTradeNo);
      } catch (err) {
        console.error('[xpayNotify] 记录退款通知失败：', err && err.message);
      }
    }
    return ok();
  }

  // ---- 代币支付通知：本项目不使用代币模式，收到说明配置有误 ----
  if (eventType === EVENT_COIN_PAY) {
    console.warn('[xpayNotify] 收到代币支付通知，但本项目用的是道具模式，请检查后台配置');
    return ok();
  }

  // ---- 用户投诉：留痕 ----
  if (eventType === EVENT_COMPLAINT) {
    console.warn('[xpayNotify] 用户投诉：', JSON.stringify(e));
    return ok();
  }

  console.log('[xpayNotify] 未处理的事件类型：' + eventType);
  return ok();
};
