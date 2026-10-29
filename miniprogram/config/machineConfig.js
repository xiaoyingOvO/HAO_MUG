// /miniprogram/config/machineConfig.js
// 机台的「拼机 / 单刷」能力配置。
//
//   只有「两个座位都能坐人一起玩」的机台才谈得上拼机：
//     · 舞萌·官机（M01）：2 座，可拼机
//     · 日麻：4 人一桌开局，切成单刷会把剩下 3 个座位全锁死，不适用
//     · MML / ADX / 中二节奏：单人机台，本来就没有拼机概念
//
//   排卡页（点座位切换）和设置页（切换拼机状态）共用这份名单，
//   以后新增可拼机机台只改这里一处，两边行为不会对不上。

const MULTI_PLAY_MACHINE_IDS = ['M01']

function isMultiPlayMachine(machineId) {
  if (!machineId) return false
  return MULTI_PLAY_MACHINE_IDS.indexOf(machineId) !== -1
}

module.exports = {
  MULTI_PLAY_MACHINE_IDS,
  isMultiPlayMachine,
}
