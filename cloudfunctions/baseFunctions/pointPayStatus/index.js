/**
 * 查询自助充值是否可用。
 *
 * 用途：虚拟支付的环境变量还没配齐时，充值页要把按钮置灰并显示「暂未开放」，
 * 而不是等用户点了才报「缺少 XPAY_OFFER_ID」。
 * 这既是体验问题，也是审核问题——审核员点进充值页看到报错会判功能不完整。
 *
 * 只返回「缺哪些变量名」，不返回任何密钥值。
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const { readConfig, missingKeys, priceYuan, amountPrecision } = require('../xpay/config');

exports.main = async (event, context) => {
  const conf = readConfig();
  const missing = missingKeys(conf);

  return {
    success: true,
    data: {
      enabled: missing.length === 0,
      missing,
      env: conf.env,
      // 道具单价决定充值金额的小数位数：0.01 元道具 → 精确到分。
      // 前端据此限制输入框的小数位数，避免用户输了一堆却在下单时才被拒。
      goodsPrice: conf.goodsPrice,
      unit: priceYuan(conf.goodsPrice),
      precision: amountPrecision(conf.goodsPrice),
    },
  };
};
