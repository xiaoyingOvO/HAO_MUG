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

module.exports = {
  toBJHour,
  toBJMinutes,
  nowBJMinutes,
};
