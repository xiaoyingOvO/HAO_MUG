const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_user = 'user';

const { nowBJMinutes, durationMinutes } = require('../timeUtil');

// 购买优惠卡云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event?.params?.openid;
  console.log('openid: ' + openid);

  if (!openid) {
      return {
          success: false,
          errMsg: '无法获取用户信息',
          data: []
      };
  }

  try {
      console.log('第一步： 查询所有卡');
  // 查所有在售卡信息。
  // 卡的两个状态字段（语义严格区分，不要混用）：
  //   is_hidden  —— 已下架/隐藏：用户端不展示、不可购买，但卡本身仍有效，
  //                 存量持卡人的权益照常可用，内部（ifNight / buyReserve / 计费）仍需读取该卡。
  //                 典型例子：「夜场畅玩卡」不再上架售卖，但夜场入场凭证仍靠它的 _id 与时段。
  //   is_deleted —— 已删除（软删）：彻底作废，列表不展示、不可购买；新逻辑不应再引用。
  // 两者都不进售卖列表。字段缺省视为 false（$ne 会匹配字段不存在的文档）。
  let card_record = await db.collection(db_card)
    .where({
      is_deleted: db_cmd.neq(true),
      is_hidden: db_cmd.neq(true)
    })
    .orderBy('trial', 'desc')
    .orderBy('cost', 'desc')
    .get();
  console.log(card_record);
  if (!card_record || !Array.isArray(card_record.data)) {
      console.error('获取卡列表失败或数据为空数组');
      card_record = { data: [] };
  }

  // 查用户拥有的卡
  console.log('第二步：查询用户信息');
  let user_record = await db.collection(db_user)
    .where({
      openid: openid
    })
    .field({
      openid: true,
      cards: true
    })
    .limit(1)
    .get();
  console.log(user_record);

  // 处理用户拥有的卡 ID
  console.log('第三步：处理用户拥有卡 ID');
  let userOwnedCardsMap = new Map(); 

    if (user_record?.data?.length > 0 && Array.isArray(user_record.data[0].cards)) {
        user_record.data[0].cards.forEach(card => {
            if (card && typeof card.card_id === 'string' && card.card_id.length > 0 && card.end_time instanceof Date) {
                if (!userOwnedCardsMap.has(card.card_id) || card.end_time > userOwnedCardsMap.get(card.card_id).end_time) {
                     userOwnedCardsMap.set(card.card_id, { end_time: card.end_time });
                }
            }
        });
    }
    console.log('用户拥有的卡:', userOwnedCardsMap);

  const now = new Date();
  // 添加 own 状态
  console.log('第四步：添加 own 状态给所有卡');
  const cards_with_own_status = (card_record?.data || []).map(card => {
    let own = false;
    let ownedCardInfo = null; // 存储用户拥有的卡信息
    let isExpired = true; // 默认为已过期或未拥有
    let notStarted = false; // 尚未到当日购买/使用时段
    let timeEnded = false;  // 已过当日购买/使用时段

    let now = new Date();
    if (card?.duration?.type == 0) {
        // 统一用公共工具解析「北京时间分钟」，兼容字符串/Date/$date 三种存法，
        // 并在 start_time 为 null 时回落到 start_hour/end_hour（真实数据就是这种结构）
        const startMin = durationMinutes(card?.duration, 'start');
        const endMin = durationMinutes(card?.duration, 'end');
        const nowMin = nowBJMinutes(now);

        if (startMin !== null && endMin !== null) {
            if (startMin < endMin) {
                // 不跨天：如 10:00-17:00
                notStarted = nowMin < startMin;
                timeEnded = nowMin >= endMin;
            } else {
                // 跨天：如 23:00-次日 10:00（startMin=1380, endMin=600）
                // 可购买区间：[startMin, 1440) ∪ [0, endMin)
                // 不可购买区间：[endMin, startMin)
                const inRange = nowMin >= startMin || nowMin < endMin;
                notStarted = false;
                timeEnded = !inRange;
            }
        }
    }

    if (card?._id && userOwnedCardsMap.has(card._id)) { // 检查用户是否拥有这张卡
        own = true;
        ownedCardInfo = userOwnedCardsMap.get(card._id);
        if (ownedCardInfo.end_time > now) { // 检查是否过期
            isExpired = false;
        }
    }

    return {
        ...card,
        own: own,
        isExpired: own ? isExpired : null,
        notStarted: notStarted,
        timeEnded: timeEnded,
    };
});
  console.log('第四步：拥有的卡：', cards_with_own_status.length);

  console.log('第五步：返回结果');
  return {
      success: true,
      data: cards_with_own_status
  };

  } catch (error) {
      console.error(`处理 getCardInfo 云函数时发生严重错误 (用户 OpenID: ${openid}):`, error);
      console.error('错误堆栈:', error.stack);
      return {
          success: false,
          errMsg: error.message || '查询卡信息时发生内部错误',
          errorDetails: JSON.stringify(error),
          data: [],
      };
  }
};
