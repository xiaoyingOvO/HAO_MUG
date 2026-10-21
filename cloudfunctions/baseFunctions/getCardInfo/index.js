const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_card = 'card';
const db_user = 'user';

// 购买优惠卡云函数入口
exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
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
  // 查所有卡信息
  let card_record = await db.collection(db_card)
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
  // let user_card_ids = [];
  // let userCardArray = null;
  // if (user_record?.data?.length > 0) {
  //     const userData = user_record.data[0];
  //     console.log('用户数据：', JSON.stringify(userData));
  //     if (userData & 'cards' in userData) {
  //         if (Array.isArray(userData.cards)) {
  //             userCardArray = userData.cards;
  //             console.log('用户卡：', JSON.stringify(userCardArray));
  //             user_card_ids = userCardArray
  //               .filter(card => {
  //                   const isValid = card && typeof card.card_id === 'string' && card.card_id.length > 0;
  //                   console.log(`过滤用户卡： ${JSON.stringify(card)}, isValid:${isValid}`);
  //                   return isValid;
  //               })
  //               .map(card => {
  //                   console.log(`Mapping user card_id: ${card.card_id}`);
  //                   return card.card_id;
  //               });
  //         } else {
  //             console.warn(`用户 ${openid} 拥有'cards'字段, 但不是一个数组:`, userData.cards);
  //         }
  //     } else {
  //         console.log(`用户 ${openid} 存在, 但未包含 'cards' 字段`);
  //     }
  // } else {
  //     console.log(`用户 ${openid} 不存在`);
  // }
  // console.log('第三步得到的用户卡 ID ：', JSON.stringify(user_card_ids));

  const now = new Date();
  // 添加 own 状态
  console.log('第四步：添加 own 状态给所有卡');
  const cards_with_own_status = (card_record?.data || []).map(card => {
    let own = false;
    let ownedCardInfo = null; // 存储用户拥有的卡信息
    let isExpired = true; // 默认为已过期或未拥有
    let isTimeExpired = false;  // 默认为未超过当日有效期

    let now = new Date();
    if (card?.duration.type == 0) {
        let tmp_time = new Date(now);
        tmp_time.setHours(card?.duration.end_time.getHours());
        tmp_time.setMinutes(card?.duration.end_time.getMinutes());
        tmp_time.setSeconds(card?.duration.end_time.getSeconds());
        tmp_time.setMilliseconds(card?.duration.end_time.getMilliseconds());
        console.log('当前时间：', now, 'card 时间：', tmp_time);
        if (now >= tmp_time) {
            isTimeExpired = true;
        };
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
        isTimeExpired: isTimeExpired,
        // userCardEndTime: own ? ownedCardInfo.end_time : null
    };
});
  // const allCardsData = card_record.data || [];
  // const cards_with_own_status = allCardsData.map((card, index) => {
  //     console.log(`正在处理中的卡片：${index}: ${JSON.stringify(card)}`);
  //     let currentCardId = null;
  //     let own = false;
  //     if (card && typeof card._id === 'string' && card._id.length > 0) {
  //         currentCardId = card._id;
  //         console.log(`检查卡片 ID：${currentCardId}`);
  //         if (Array.isArray(user_card_ids)) {
  //             try {
  //                 own = user_card_ids.includes(currentCardId);
  //                 console.log(`检查 ID ${currentCardId} 的结果 (用户是否拥有): ${own}`);
  //             } catch (includesError) {
  //                 console.error(`在 user_card_ids 数组上执行 includes 方法时出错 (检查 ID: ${currentCardId}):`, includesError);
  //                 own = false;  // 出错等于不拥有
  //             }
  //         } else {
  //             console.warn('警告：尝试检查卡片归属时，user_card_ids 不是一个有效的数组。');
  //             own = false;
  //         }
  //     } else {
  //         console.warn(`警告：索引 ${index} 处的卡片数据无效或缺少有效的 _id: ${JSON.stringify(card)}`);
  //         own = false;
  //     }
  //     return {
  //         ...card,
  //         own: own
  //     };
  // });
  console.log('第四步：拥有的卡：', cards_with_own_status.length);

  console.log('第五步：返回结果');
  return {
      success: true,
      data: cards_with_own_status
  };
//   return {
//     success: true,
//     data: card_record.data
//   };

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
