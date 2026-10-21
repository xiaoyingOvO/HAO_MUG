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

// 云函数入口函数
exports.main = async (event, context) => {
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
  }
};
        
