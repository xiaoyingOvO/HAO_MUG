const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})
const db = cloud.database();
const db_cmd = db.command;
const db_mail = 'mail';

exports.main = async (event, context) => {
  try {
    const wxContext = cloud.getWXContext();
    const user_openid = wxContext.OPENID;

    if (!user_openid) {
      console.warn('Could not get OPENID from context.');
      return {
        success: true,
        data: {
          personalUnreadCount: 0,
          announcementIds: [],
        }
      };
    }
    console.log(`Checking for user: ${user_openid}`);

    const personalUnreadPromise = db.collection('mail')
      .where({
        receiver: user_openid,
        read: false
      })
      .count();

      const announcementPromise = db.collection('mail')
        .where({
          receiver: 'all',
        })
        .field({
          _id: true
        })
        .limit(1000)
        .get();     
        const [personalUnreadResult, announcementResult] = await Promise.all([
          personalUnreadPromise,
          announcementPromise
        ]);
        const personalUnreadCount = personalUnreadResult.total;
        const allAnnouncements = announcementResult.data || [];
        const announcementIds = allAnnouncements.map(item => item._id);

        return {
          success: true,
          data: {
            personalUnreadCount: personalUnreadCount,
            announcementIds: announcementIds,
          }
        };
  } catch (error) {
    console.error('An unexpected error occurred:', error);
    return {
      success: false,
      errMsg: '获取未读消息数失败',
      error: error
    };
  }
};
