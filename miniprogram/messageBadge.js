const READ_ANNOUNCEMENT_IDS_KEY = 'readAnnouncementIds';
const TAB_BAR_INDEX = 3;

module.exports = {
  checkBadge
}

async function checkBadge(tabBarIndex) {
  const userInfo = wx.getStorageSync('userInfo');
  if (!userInfo || !userInfo.openid) {
    updateBadge(0);
    return { totalUnreadCount: 0 };
  }

  try {
    const res = await wx.cloud.callFunction({
      name: 'baseFunctions',
      data: {
        type: 'getUnreadMessageCount',
        params: '',
      }
    });

    if (res.result && res.result.success) {
      const { personalUnreadCount, announcementIds } = res.result.data;
      const readAnnouncementIds = wx.getStorageSync(READ_ANNOUNCEMENT_IDS_KEY) || [];

      let unreadAnnouncementCount = 0;
      if (Array.isArray(announcementIds)) {
        announcementIds.forEach(id => {
          if (!readAnnouncementIds.includes(id)) {
            unreadAnnouncementCount++;
          }
        });
      }

      const totalUnreadCount = personalUnreadCount + unreadAnnouncementCount;
      console.log(`[messageBadge] 检查到总未读数： ${totalUnreadCount}`);
      updateBadge(totalUnreadCount, tabBarIndex);
      return { totalUnreadCount };
    } else {
      console.error("[messageBadge] 云函数返回失败：", res.result);
      return { totalUnreadCount: 0 };
    }
  } catch (err) {
    console.error("[messageBadge] 调用云函数异常：", err);
    return { totalUnreadCount: 0 };
  }
}

function updateBadge(count) {
  const newCount = Math.max(0, count);
  wx.setStorageSync('unreadMessageCount', newCount);

  if (newCount > 0) {
    wx.setTabBarBadge({
      index: TAB_BAR_INDEX,
      text: String(newCount > 99 ? '99+' : newCount),
    });
  } else {
    wx.removeTabBarBadge({
      index: TAB_BAR_INDEX,
    });
  }
}
