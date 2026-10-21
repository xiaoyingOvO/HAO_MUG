/**
 * 将一个数字乘以 100 并取整
 * @param {number | string} num
 * @returns {number}
 */
function toCents(num) {
  if (typeof num !== 'number' && typeof num !== 'string') return 0;
  const numAsFloat = parseFloat(num);
  if (isNaN(numAsFloat)) return 0;
  // 先乘以100，然后使用 Math.round 来处理可能的浮点误差，最后得到一个整数
  return Math.round(numAsFloat * 100);
}

/**
 * 将“分”转换为“元” (浮点数)
 * @param {number} cents
 * @returns {number}
 */
function toYuan(cents) {
  if (typeof cents !== 'number') return 0;
  return cents / 100;
}

/**
 * 加法
 * @param {number} num1
 * @param {number} num2
 * @returns {number}
 */
function add(num1, num2) {
  const cents1 = toCents(num1);
  const cents2 = toCents(num2);
  return toYuan(cents1 + cents2);
}

/**
 * 减法
 * @param {number} num1
 * @param {number} num2
 * @returns {number}
 */
function subtract(num1, num2) {
  const cents1 = toCents(num1);
  const cents2 = toCents(num2);
  return toYuan(cents1 - cents2);
}

module.exports = {
  add,
  subtract,
  toCents,
  toYuan
};