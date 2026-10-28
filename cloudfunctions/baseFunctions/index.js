const addUsrInfo = require('./addUsrInfo/index');
const addUsrInfoUnauthorize = require('./addUsrInfoUnauthorize/index');
const authorizeUsrInfo = require('./authorizeUsrInfo/index');
const denyUsrInfo = require('./denyUsrInfo/index');
const getUsrInfo = require('./getUsrInfo/index');
const getUsrInfoByName = require('./getUsrInfoByName/index');
const decryptPhone = require('./decryptPhone/index');
const getUsrNameByOpenids = require('./getUsrNameByOpenids/index')
const getUsrInfoForAuthorize = require('./getUsrInfoForAuthorize/index');
const modifyUsrInfo = require('./modifyUsrInfo/index');
const getCardInfo = require('./getCardInfo/index');
const buyCard = require('./buyCard/index');
const removeCard = require('./removeCard/index');
const getPointInfo = require('./getPointInfo/index');
const buyPoint = require('./buyPoint/index');
const removePoint = require('./removePoint/index');
const transferPoint = require('./transferPoint/index');
const getOrderInfo = require('./getOrderInfo/index');
const getReserveInfo = require('./getReserveInfo/index');
const buyReserve = require('./buyReserve/index');
const getNotice = require('./getNotice/index');
const sendMail = require('./sendMail/index');
const getMail = require('./getMail/index');
const readMail = require('./readMail/index');
const getUnreadMessageCount = require('./getUnreadMessageCount/index');
const mahjongStats = require('./mahjongStats/index');
const createPointOrder = require('./createPointOrder/index');
const queryPointOrder = require('./queryPointOrder/index');
const pointPayStatus = require('./pointPayStatus/index');
const xpayNotify = require('./xpayNotify/index');

// 云函数入口函数
exports.main = async (event, context) => {
  // 虚拟支付的消息推送不走 type 分发：云开发「消息推送」把事件以扁平字段直接传进来，
  // 只带 Event（如 xpay_goods_deliver_notify），没有 type 字段。
  // 必须放在 switch 之前拦截，否则会掉到 undefined 分支，微信会重试 15 次。
  if (event && typeof event.Event === 'string' && event.Event.indexOf('xpay_') === 0) {
    return await xpayNotify.main(event, context);
  }

  switch (event.type) {
    // 用户信息相关
    case 'addUsrInfo':
      return await addUsrInfo.main(event, context);
    case 'addUsrInfoUnauthorize':
      return await addUsrInfoUnauthorize.main(event, context);
    case 'authorizeUsrInfo':
      return await authorizeUsrInfo.main(event, context);
    case 'denyUsrInfo':
      return await denyUsrInfo.main(event, context);
    case 'getUsrInfo':
      return await getUsrInfo.main(event, context);
    case 'getUsrInfoByName':
      return await getUsrInfoByName.main(event, context);
    case 'decryptPhone':
      return await decryptPhone.main(event, context);
    case 'getUsrNameByOpenids':
      return await getUsrNameByOpenids.main(event, context);
    case 'getUsrInfoForAuthorize':
      return await getUsrInfoForAuthorize.main(event, context);
    case 'modifyUsrInfo':
      return await modifyUsrInfo.main(event, context);
    // 优惠卡相关
    case 'getCardInfo':
      return await getCardInfo.main(event, context);
    case 'buyCard':
      return await buyCard.main(event, context);
    case 'removeCard':
      return await removeCard.main(event, context);
    // 点数套餐相关
    case 'getPointInfo':
      return await getPointInfo.main(event, context);
    case 'buyPoint':
      return await buyPoint.main(event, context);
    case 'removePoint':
      return await removePoint.main(event, context);
    case 'transferPoint':
      return await transferPoint.main(event, context);
    case 'getOrderInfo':
      return await getOrderInfo.main(event, context);
    // 虚拟支付（点数充值）
    case 'createPointOrder':
      return await createPointOrder.main(event, context);
    case 'queryPointOrder':
      return await queryPointOrder.main(event, context);
    case 'pointPayStatus':
      return await pointPayStatus.main(event, context);
    // 预约夜场相关
    case 'getReserveInfo':
      return await getReserveInfo.main(event, context);
    case 'buyReserve':
      return await buyReserve.main(event, context);
    // 通知公告相关
    case 'getNotice':
      return await getNotice.main(event, context);
    case 'sendMail':
      return await sendMail.main(event, context);
    case 'getMail':
      return await getMail.main(event, context);
    case 'readMail':
      return await readMail.main(event, context);
    case 'getUnreadMessageCount':
      return await getUnreadMessageCount.main(event, context);
    // 麻将对局战绩相关
    case 'mahjongAddGame':
      return await mahjongStats.addGameMain(event, context);
    case 'mahjongGetMyStats':
      return await mahjongStats.getMyStatsMain(event, context);
    case 'mahjongGetRanking':
      return await mahjongStats.getRankingMain(event, context);
    case 'mahjongGetGames':
      return await mahjongStats.getGamesMain(event, context);
    case 'mahjongGrantTitle':
      return await mahjongStats.grantTitleMain(event, context);
    case 'mahjongRevokeTitle':
      return await mahjongStats.revokeTitleMain(event, context);
    case 'mahjongGetPlayerTitles':
      return await mahjongStats.getPlayerTitlesMain(event, context);
    case 'mahjongDeleteGame':
      return await mahjongStats.deleteGameMain(event, context);
    case 'mahjongUpdateGame':
      return await mahjongStats.updateGameMain(event, context);
    case 'mahjongGetGameDetail':
      return await mahjongStats.getGameDetailMain(event, context);
    case 'mahjongRebuildStats':
      return await mahjongStats.rebuildPlayerStatsMain(event, context);
  }
};
        
