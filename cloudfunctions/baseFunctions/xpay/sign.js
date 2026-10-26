/**
 * 虚拟支付签名。
 *
 * 官方算法（《签名详解》）：
 *   支付签名   paySig    = hex(hmac_sha256(appKey,     uri + '&' + signData))
 *   用户态签名 signature = hex(hmac_sha256(sessionKey, signData))
 *
 * 两个致命细节：
 *   1. wx.requestVirtualPayment 的 uri 固定为 'requestVirtualPayment'，服务端接口则填
 *      实际路径（如 '/xpay/query_order'），且不能带 ? 及其后的 query string。
 *   2. signData 只能 JSON.stringify 一次。参与签名的字符串必须与实际传给微信的
 *      字符串完全一致，序列化两次字段顺序可能变，签名必然校验失败（-15006）。
 */

const crypto = require('crypto');

// 基础库发起支付时的固定 uri
const WX_API_URI = 'requestVirtualPayment';

function hmacHex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * 计算支付签名 paySig
 * @param {string} uri          接口路径，wx API 传 WX_API_URI
 * @param {string} signDataStr  已序列化的 signData / post body
 * @param {string} appKey       对应环境的 AppKey
 */
function calcPaySig(uri, signDataStr, appKey) {
  return hmacHex(appKey, uri + '&' + signDataStr);
}

/**
 * 计算用户态签名 signature
 * @param {string} signDataStr 与传给 wx 的 signData 完全相同的字符串
 * @param {string} sessionKey  当前用户有效 session_key
 */
function calcSignature(signDataStr, sessionKey) {
  return hmacHex(sessionKey, signDataStr);
}

module.exports = {
  WX_API_URI,
  calcPaySig,
  calcSignature,
};
