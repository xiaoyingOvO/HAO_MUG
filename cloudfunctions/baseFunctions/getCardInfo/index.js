const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_user = 'user';

const { toBJMinutes, nowBJMinutes } = require('../timeUtil');

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
  // 查所有卡信息（过滤已删除的卡，如 is_deleted: true 的「日间畅玩套餐」）
  let card_record = await db.collection(db_card)
    .where({
      is_deleted: db_cmd.neq(true)
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
        // 统一用公共工具解析「北京时间分钟」，兼容字符串/Date/$date 三种存法
        const startMin = toBJMinutes(card?.duration?.start_time);
        const endMin = toBJMinutes(card?.duration?.end_time);
        const nowMin = nowBJMinutes(now);

        if (startMin !== null && nowMin < startMin) {
            notStarted = true;
        }
        if (endMin !== null && nowMin >= endMin) {
            timeEnded = true;
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
