/**
 * 创建点数充值订单，并返回 wx.requestVirtualPayment 需要的三个参数。
 *
 * 为什么用「道具模式 + 数量」而不是「代币模式」：
 *   代币模式会把点数托管到微信侧，业务库里的 real_point / extra_point 就没意义了，
 *   进店扣费、排队计费、点数转移、免单卡全要重写。道具模式则保留现有库表，
 *   只在支付成功后由回调加点，改造面最小。
 *
 * 为什么单价很小、金额放在 buyQuantity：
 *   道具模式下金额 = goodsPrice × buyQuantity，而 buyQuantity 只能是正整数，
 *   所以「金额能精确到几位小数」就等于道具单价的大小。
 *   后台把道具价格设成 0.01 元，buyQuantity 就等于「金额的分」，
 *   一个道具就能覆盖任意两位小数金额，且在后台只需要维护一个道具。
 *   若把单价设成 1 元，则只能充整数元——精度完全由 XPAY_GOODS_PRICE 决定。
 *
 * 入参：{ params: { amount: 金额（元，最多两位小数）, code: wx.login 拿到的 code } }
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const COLL_USER = 'user';
const COLL_ORDER = 'order';

const { readConfig, currentAppKey, missingKeys, amountPrecision } = require('../xpay/config');
const { calcPaySig, calcSignature, WX_API_URI } = require('../xpay/sign');
const { code2Session } = require('../xpay/http');
const { calcBonus } = require('../xpay/pointService');

// 单笔金额限制（元）。上限用于挡住误输入，比如多打两个 0。
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 10000;

// 购买份数上限。份数 = 金额(分) / 道具单价(分)，单价越小份数越大，
// 例如 0.01 元道具充 1 万元要买 100 万份。超过平台限制会报参数错误，
// 这里提前拦下来，给一句人话。
const MAX_QUANTITY = 1000000;

// 订单 30 天过期，沿用原充值订单的时间口径
const ORDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function genOutTradeNo() {
  const ts = Date.now().toString();
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  // 要求 8-32 字符，只能是数字、字母和 _-|*@，且不能以下划线开头
  return 'P' + ts + rand;
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const appId = wxContext.APPID;
  const openid = wxContext.OPENID;
  const params = (event && event.params) || {};

  if (!openid) {
    return { success: false, errMsg: '未获取到用户身份，请重新进入小程序' };
  }

  // ---- 金额校验：元 → 分（整数），再按道具单价折算购买份数 ----
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, errMsg: '请输入有效的充值金额' };
  }
  if (amount < MIN_AMOUNT) {
    return { success: false, errMsg: '最低充值 ' + MIN_AMOUNT + ' 元' };
  }
  if (amount > MAX_AMOUNT) {
    return { success: false, errMsg: '单笔最高 ' + MAX_AMOUNT + ' 元，可分多笔充值' };
  }

  // 元 → 分。用 Math.round 吸收浮点误差，12.5 * 100 在 JS 里是 1249.9999999999998。
  const amountCents = Math.round(amount * 100);
  // 差得远说明输入超过两位小数（比如 12.345），直接拒，不做四舍五入
  if (Math.abs(amountCents - amount * 100) > 1e-6) {
    return { success: false, errMsg: '充值金额最多两位小数' };
  }

  // ---- 配置校验：缺参数直接报人话，别让前端看到 -15001 ----
  const conf = readConfig();
  const miss = missingKeys(conf);
  if (miss.length) {
    console.error('[xpay] 缺少环境变量：', miss.join(', '));
    return { success: false, errMsg: '虚拟支付未配置完成（缺少 ' + miss.join('、') + '），请联系管理员' };
  }

  // ---- 份数折算：金额必须是道具单价的整数倍 ----
  // 单价 1 元的道具只能充整数元；单价 0.1 元的道具才能充到角。
  if (!Number.isInteger(conf.goodsPrice) || conf.goodsPrice <= 0) {
    console.error('[xpay] XPAY_GOODS_PRICE 非法：', conf.goodsPrice);
    return { success: false, errMsg: '虚拟支付配置有误（道具单价非法），请联系管理员' };
  }
  if (amountCents % conf.goodsPrice !== 0) {
    const precision = amountPrecision(conf.goodsPrice);
    const unit = conf.goodsPrice / 100;
    const tip = precision === 0
      ? '线上充值仅支持整数金额，小数部分请到店充值'
      : '充值金额需精确到 ' + unit + ' 元';
    return { success: false, errMsg: tip };
  }
  const buyQuantity = amountCents / conf.goodsPrice;
  if (buyQuantity > MAX_QUANTITY) {
    return { success: false, errMsg: '单笔金额超出限制，请分多笔充值' };
  }

  // ---- 用户校验：Lv6 无需充值，下单前拦住，避免「钱付了、点没到」 ----
  const userRes = await db.collection(COLL_USER)
    .where({ openid })
    .field({ exp: true })
    .limit(1)
    .get();
  if (!userRes.data || userRes.data.length === 0) {
    return { success: false, errMsg: '该用户不存在' };
  }
  const userExp = userRes.data[0].exp;
  const bonusInfo = calcBonus(userExp);
  if (!bonusInfo.ok) {
    return { success: false, errMsg: '最高等级用户无需充值' };
  }

  // ---- 换 session_key（用户态签名要用，且必须是当前有效的） ----
  let sessionKey;
  try {
    sessionKey = await code2Session(appId, conf.appSecret, params.code);
  } catch (err) {
    console.error('[xpay] code2Session 失败：', err && err.message);
    return { success: false, errMsg: '登录状态获取失败，请重试' };
  }

  // ---- 组 signData ----
  // 注意：下面这个对象只序列化一次，签名和传参共用同一个字符串。
  const outTradeNo = genOutTradeNo();
  const signDataObj = {
    offerId: conf.offerId,
    buyQuantity,
    env: conf.env,
    currencyType: 'CNY',
    productId: conf.productId,
    goodsPrice: conf.goodsPrice,
    outTradeNo,
    // attach 里放「分」，避免小数在透传链路上被二次处理
    attach: 'p' + amountCents,
  };
  const signData = JSON.stringify(signDataObj);

  const appKey = currentAppKey(conf);
  const paySig = calcPaySig(WX_API_URI, signData, appKey);
  const signature = calcSignature(signData, sessionKey);

  // ---- 落订单（state=0 支付中），管理端「充值查询」读的就是这张表 ----
  const now = new Date();
  const extraPreview = Math.round(amount * bonusInfo.bonus * 100) / 100;
  try {
    await db.collection(COLL_ORDER).add({
      data: {
        openid,
        point: amount,
        extra_point: 0,
        state: 0,
        time_order: now,
        time_expire: new Date(now.getTime() + ORDER_TTL_MS),
        // 虚拟支付相关
        out_trade_no: outTradeNo,
        product_id: conf.productId,
        goods_price: conf.goodsPrice,
        buy_quantity: buyQuantity,
        amount_cents: amountCents,
        env: conf.env,
        channel: 'virtual_pay',
        wx_order_id: '',
        paid_at: null,
        delivered_at: null,
      },
    });
  } catch (err) {
    console.error('[xpay] 写订单失败：', err && err.message);
    return { success: false, errMsg: '订单创建失败，请稍后重试' };
  }

  console.log('[xpay] 下单成功 outTradeNo=' + outTradeNo + ' amount=' + amount
    + ' 元（' + amountCents + ' 分 × ' + buyQuantity + ' 份）'
    + ' env=' + conf.env + ' offerId=' + conf.offerId);

  return {
    success: true,
    data: {
      signData,
      paySig,
      signature,
      mode: 'short_series_goods',
      outTradeNo,
      amount,
      amountCents,
      buyQuantity,
      // 前端仅用于展示，真实赠送以发货时算出的为准
      extraPoint: extraPreview,
      env: conf.env,
    },
  };
};
