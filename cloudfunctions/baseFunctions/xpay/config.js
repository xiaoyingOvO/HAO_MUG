/**
 * 小程序虚拟支付（xpay / 米大师）配置读取。
 *
 * 所有敏感值一律走云函数环境变量，不写进仓库。
 * 配置位置：云开发控制台 → 云函数 → baseFunctions → 配置 → 环境变量
 *
 * 需要配置的环境变量：
 *   XPAY_OFFER_ID         虚拟支付 OfferID（MP后台 → 虚拟支付 → 基本配置）
 *   XPAY_APP_KEY          现网 AppKey
 *   XPAY_APP_KEY_SANDBOX  沙箱 AppKey（env=1 时使用，可留空）
 *   XPAY_PRODUCT_ID       道具 ID（后台创建的「点数」道具）
 *   XPAY_GOODS_PRICE      道具单价（分），必须与后台道具价格完全一致，默认 100
 *                         这个值直接决定充值金额能精确到几位小数：
 *                         1 分（0.01 元）→ 可精确到分；10 分（0.1 元）→ 到角；100 分 → 只能整数元
 *   XPAY_ENV              0 现网 / 1 沙箱，默认 0（现网版本只能填 0，否则 -15011）
 *   MP_APPSECRET          小程序 AppSecret（用于换 session_key / access_token）
 *
 * 注意：XPAY_APP_KEY 与 MP_APPSECRET 是两套完全不同的密钥，不要混用。
 *   AppKey  → 算 paySig
 *   AppSecret → 换 session_key（用户态签名 signature）和 access_token（查单）
 */

const ENV_PROD = 0;
const ENV_SANDBOX = 1;

// 点数与人民币 1:1，所以道具单价固定 1 元 = 100 分，用 buyQuantity 承载金额。
const DEFAULT_GOODS_PRICE = 100;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readConfig() {
  const env = num(process.env.XPAY_ENV, ENV_PROD) === ENV_SANDBOX ? ENV_SANDBOX : ENV_PROD;
  return {
    offerId: process.env.XPAY_OFFER_ID || '',
    appKeyProd: process.env.XPAY_APP_KEY || '',
    appKeySandbox: process.env.XPAY_APP_KEY_SANDBOX || '',
    productId: process.env.XPAY_PRODUCT_ID || '',
    goodsPrice: num(process.env.XPAY_GOODS_PRICE, DEFAULT_GOODS_PRICE),
    env,
    appSecret: process.env.MP_APPSECRET || '',
  };
}

// 当前环境对应的 AppKey（现网/沙箱）
function currentAppKey(conf) {
  return conf.env === ENV_SANDBOX ? (conf.appKeySandbox || conf.appKeyProd) : conf.appKeyProd;
}

/**
 * 校验关键配置是否齐全，返回缺失项列表。
 * 缺配置时直接给出人话错误，避免报 -15001/-15006 这种看不出原因的错。
 */
function missingKeys(conf) {
  const miss = [];
  if (!conf.offerId) miss.push('XPAY_OFFER_ID');
  if (!conf.productId) miss.push('XPAY_PRODUCT_ID');
  if (!currentAppKey(conf)) miss.push(conf.env === ENV_SANDBOX ? 'XPAY_APP_KEY_SANDBOX' : 'XPAY_APP_KEY');
  if (!conf.appSecret) miss.push('MP_APPSECRET');
  return miss;
}

/**
 * 道具单价（元）。后台道具配置里的价格就是这个数。
 */
function priceYuan(goodsPrice) {
  return num(goodsPrice, DEFAULT_GOODS_PRICE) / 100;
}

/**
 * 充值金额支持的小数位数，由道具单价决定。
 *
 * 虚拟支付的实付金额 = 道具单价 × buyQuantity，而 buyQuantity 必须是正整数，
 * 所以金额的最小步进就等于道具单价：
 *   单价 1 元（100 分）  → 商品只能 1 元 1 元地买，充值只能填整数元，0 位小数
 *   单价 0.1 元（10 分） → 可以 0.1 元 0.1 元地买，充值支持到角，1 位小数
 *   单价 0.01 元（1 分） → 支持到分，2 位小数
 *
 * 这样同一套代码既能跑「只能充整数」的 1 元道具，也能跑更细的道具，
 * 精度只由环境变量 XPAY_GOODS_PRICE 决定，不用改代码。
 */
function amountPrecision(goodsPrice) {
  const yuan = priceYuan(goodsPrice);
  // toFixed(2) 后去掉末尾的 0 和孤立的小数点："1.00"→"1"、"0.10"→"0.1"、"0.01"→"0.01"
  const s = yuan.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

module.exports = {
  ENV_PROD,
  ENV_SANDBOX,
  DEFAULT_GOODS_PRICE,
  readConfig,
  currentAppKey,
  missingKeys,
  priceYuan,
  amountPrecision,
};
