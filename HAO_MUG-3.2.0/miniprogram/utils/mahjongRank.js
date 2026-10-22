/**
 * 麻将段位规则（可插拔框架）
 *
 * ⚠️ 积分/段位的具体规则由店家后续提供，当前为占位实现：
 *    只保证接口稳定 —— 页面只依赖 computeRank(stats) 的返回结构，
 *    之后把规则填进本文件即可，页面无需改动。
 *
 * stats 输入（来自 mahjongGetMyStats）：
 * {
 *   total, rankCounts: {1,2,3,4}, rankRates: {1,2,3,4},
 *   flyRate, avgRank, avgPoints, maxPoints, recent: [...]
 * }
 *
 * 返回结构（页面渲染依赖，字段名不要改）：
 * {
 *   title:  '雀士',       // 段位头衔文案
 *   level:  0,            // 段位序号（0 起），可用于选头衔配色/图
 *   pt:     0,            // 当前 pt
 *   ptMax:  80,           // 升级所需 pt（进度条分母）
 *   ptNote: ''            // 备注文案（可选，如「下一级：雀杰」）
 * }
 */

// 段位头衔占位表：level -> 文案。规则定了之后按需扩充（雀士/雀杰/雀豪/雀圣…）
const RANK_TITLES = ['雀士', '雀杰', '雀豪', '雀圣'];

/**
 * 由战绩计算段位。占位实现：按总局数给个固定展示，pt 恒 0。
 * TODO: 等积分规则（各名次加减 pt、升降级门槛）确定后重写本函数。
 */
export function computeRank(stats) {
  if (!stats || !stats.total) {
    return { title: '暂无段位', level: -1, pt: 0, ptMax: 80, ptNote: '完成首局后定段' };
  }
  return {
    title: RANK_TITLES[0],
    level: 0,
    pt: 0,
    ptMax: 80,
    ptNote: '段位规则待定'
  };
}

/**
 * 顺位趋势格颜色主题（1~4 位），供页面 wxml class 映射。
 * 1位金 / 2位灰 / 3位橙 / 4位蓝灰 —— 与雀魂战绩页一致。
 */
export const RANK_CELL_CLASS = { 1: 'c1', 2: 'c2', 3: 'c3', 4: 'c4' };

export default { computeRank, RANK_CELL_CLASS };
