// 优惠卡 duration 时段解析公共工具
//
// 背景：数据库 card 集合里 duration.start_time / end_time 历史上有多种存法：
//   ① 字符串 "23:00"（夜场畅玩卡、桌游麻将票）
//   ② Date 对象（控制台手动建卡时选的日期类型）
//   ③ { $date: 毫秒 }（数据库导出/JSON 导入格式）
//   ④ 数字（start_hour / end_hour，mock 层）
// 云函数默认跑在 UTC 时区，而卡的时段语义是「北京时间」，所以 Date / $date
// 必须按 UTC 小时 +8 换算，否则会差 8 小时。
//
// 这里统一成一套解析，供 getCardInfo / buyCard / getConsumePoint 等复用，
// 避免「这里修了、那里又坏」。

// 把「某个时段值」解析成北京时间的小时数(0~24)。
// 支持：字符串 "HH:MM" / Date / { $date: 毫秒 } / 数字。解析失败返回 null。
function toBJHour(value) {
  if (value === undefined || value === null) return null;
  // 字符串 "23:00"
  if (typeof value === 'string') {
    const m = value.match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) return parseInt(m[1], 10);
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  // Date 对象
  if (value instanceof Date) {
    return (value.getUTCHours() + 8) % 24;
  }
  // { $date: 毫秒 }
  if (typeof value === 'object' && value.$date !== undefined) {
    return (Math.floor(Number(value.$date) / 3600000) + 8) % 24;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

// 把「某个时段值」解析成北京时间的分钟数(0~1440)。支持同上。失败返回 null。
function toBJMinutes(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  if (value instanceof Date) {
    return ((value.getUTCHours() + 8) % 24) * 60 + value.getUTCMinutes();
  }
  if (typeof value === 'object' && value.$date !== undefined) {
    const d = new Date(Number(value.$date));
    return ((d.getUTCHours() + 8) % 24) * 60 + d.getUTCMinutes();
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

// 当前北京时间的分钟数(0~1440)
function nowBJMinutes(now) {
  const t = new Date((now || new Date()).getTime() + 8 * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/**
 * 解析卡片的「时段起点/终点」（北京时间分钟数 0~1440），解析失败返回 null。
 *
 * ⚠️ 为什么不能写成 `duration.start_time !== undefined ? duration.start_time : duration.start_hour`：
 *   数据库里 card.duration 长期是「两套字段并存」的结构 ——
 *       { type: 0, start_hour: 8, end_hour: 10, start_time: null, end_time: null }
 *   `start_time` 这个 key 是存在的，只是值为 null，所以 `!== undefined` 恒为 true，
 *   取到的就是 null，`start_hour: 8` 永远不会被读到 → 时段解析失败 → 免单时段丢失。
 *   早八畅玩套餐（08:00-10:00 免单）打超时「把早八那两小时也计费」就是这个原因。
 *
 * 所以这里改成「按可解析性回落」：先试 start_time，解析不出来再试 start_hour。
 *
 * @param {object} duration card.duration
 * @param {'start'|'end'} which 取起点还是终点
 * @returns {number|null} 北京时间分钟数
 */
function durationMinutes(duration, which) {
  const dur = duration || {};
  const primary = which === 'start' ? dur.start_time : dur.end_time;
  const legacy = which === 'start' ? dur.start_hour : dur.end_hour;

  // 裸数字（没有 "HH:MM" 格式可辨）按「小时」理解，与 start_hour 语义保持一致。
  // 否则 toBJMinutes(8) 会按「8 分钟」处理，把 08:00 算成 00:08。
  if (typeof primary === 'number') {
    const h = toBJHour(primary);
    return h === null ? null : h * 60;
  }

  const p = toBJMinutes(primary);
  if (p !== null) return p;

  // 回落：老字段只存「小时」，换算成分钟
  const h = toBJHour(legacy);
  return h === null ? null : h * 60;
}

/**
 * 同上，但只取「小时」（0~24）。用于只看小时粒度的场景（如免单时段抵扣）。
 * @param {object} duration card.duration
 * @param {'start'|'end'} which
 * @returns {number|null} 北京时间小时数
 */
function durationHour(duration, which) {
  const dur = duration || {};
  const primary = which === 'start' ? dur.start_time : dur.end_time;
  const legacy = which === 'start' ? dur.start_hour : dur.end_hour;

  const p = toBJHour(primary);
  if (p !== null) return p;

  return toBJHour(legacy);
}

module.exports = {
  toBJHour,
  toBJMinutes,
  nowBJMinutes,
  durationMinutes,
  durationHour,
};
