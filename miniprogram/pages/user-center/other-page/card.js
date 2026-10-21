import { add } from '../../../decimal.js';

Page({
    data: {
      cardList: [], // 卡片列表
      isLoading: true, // 是否正在加载列表
      userPoints: null, // 用户点数
      isLoadingPoints: true, // 是否正在加载点数
      userPointsIsNumber: false,
    },
  
    onLoad(options) {
        const eventChannel = this.getOpenerEventChannel();
        let hasReceivedUserInfo = false;
    
        if (eventChannel && eventChannel.on) {
            eventChannel.on('acceptUserInfo', (data) => {
                if (data && data.userInfo) {
                    const userInfo = data.userInfo;
                    const real_point = Number(userInfo.real_point) || 0;
                    const extra_point = Number(userInfo.extra_point) || 0;
                    const totalPoints = add(real_point, extra_point);
    
                    this.setData({
                        userPoints: totalPoints,
                        userPointsIsNumber: true,
                        isLoadingPoints: false, 
                        // receivedUserInfoViaEvent: true
                    });
                    hasReceivedUserInfo = true;
                } else {
                     console.warn('Received acceptUserInfo event, but data or userInfo is missing.');
                }
            });
        } else {
        }
    
        // 加载卡数据
        this.setData({ isLoading: true });
        this.loadCardData().catch(err => {
            console.error("Error loading card data:", err);
        }).finally(() => {
            this.setData({ isLoading: false });
        });
    
        setTimeout(() => {
            if (!hasReceivedUserInfo) {
                this.getUserPoints();
            }
        }, 100);
    },

    // 获取用户点数(用云函数获取)
    async getUserPoints() {
        this.setData({ isLoadingPoints: true });
        let pointsValue = null;
        let isNumber = false;
        try {
          const res = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: {
              type: 'getUsrInfo', 
              params: {}
            }
          });
          if (res.result && res.result.success && res.result.data) {
            const real_point = Number(res.result.data.real_point) || 0;
            const extra_point = Number(res.result.data.extra_point) || 0;
            pointsValue = add(real_point, extra_point);
            isNumber = true;
          } else {
            console.error('Failed to get user points:', res.result?.errMsg);
            pointsValue = '获取失败';
            isNumber = false;
          }
        } catch (err) {
          console.error('Error calling getUserInfo:', err);
          this.setData({ userPoints: '网络错误' });
          isNumber = false;
        } finally {
            this.setData({ 
                userPoints: pointsValue,
                userPointsIsNumber: isNumber,
                isLoadingPoints: false
            });
        }
      },
  
    // 加载卡片数据
    async loadCardData() {
      this.setData({ isLoading: true });
      try {
        const res = await wx.cloud.callFunction({
          name: 'baseFunctions', 
          data: {
            type: 'getCardInfo',
            params: {},
          }
        });

        if (res.result && res.result.success && Array.isArray(res.result.data)) {
          const now = new Date();
          // 优惠卡固定展示顺序（按 card_name 关键字匹配，越小越靠前；日场排在夜场前）
          const CARD_ORDER = [
            '早八',               // 早八畅玩套餐 08:00-10:00
            '日间',               // 日间畅玩套餐 10:00-17:00
            '全天',               // 全天畅玩套餐 10:00-23:00
            '桌游麻将票·日场',     // 桌游麻将票·日场 10:00-23:00
            '桌游麻将票·夜场',     // 桌游麻将票·夜场 23:00-次日10:00（必须排在「夜场」关键字之前，否则会被「夜场」抢先匹配）
            '夜场',               // 夜场畅玩卡 23:00-次日10:00
            '高级会员',           // 高级会员卡
          ];
          const orderOf = (name) => {
            const idx = CARD_ORDER.findIndex(k => name && name.includes(k));
            return idx === -1 ? CARD_ORDER.length : idx;
          };
          // 夜场票也正常展示、可直接购买（临时起意购买用），不再过滤
          const processedList = res.result.data
            .map(card => {
                let theme = 'default';

                if (card.card_name.includes('高级会员')) {
                    theme = 'premium-gold';
                } else if (card.card_name.includes('早八')) {
                    theme = 'morning-sky';
                } else if (card.card_name.includes('日间')) {
                    theme = 'daylight-sun';
                } else if (card.card_name.includes('全天')) {
                    theme = 'full-day-royal';
                } else if (card.card_name.includes('桌游麻将')) {
                    // 必须排在「夜场」之前判断，否则「桌游麻将票·夜场」会被误配成夜场主题
                    theme = 'board-green';
                } else if (card.card_name.includes('夜场')) {
                    theme = 'night-mystic';
                } else if (card.cost >= 80) {   // 如果有其他高价卡，使用备用主题
                    theme = 'high-value-alt';
                }

                const notStarted = card.notStarted === true;   // 尚未到当日可购买时段
                const timeEnded = card.timeEnded === true;     // 已过当日可购买时段
                return {
                    ...card,
                    theme: theme,
                    isPurchasing: false,
                    notStarted: notStarted,
                    timeEnded: timeEnded,
                };
            })
            .sort((a, b) => orderOf(a.card_name) - orderOf(b.card_name));
          this.setData({
            cardList: processedList,
          });
        } else {
          console.error('获取卡列表失败:', res.result?.errMsg);
          wx.showToast({ title: res.result?.errMsg || '加载失败', icon: 'none' });
        }
      } catch (err) {
        console.error('调用 getCardInfo 异常:', err);
        wx.showToast({ title: '网络或服务异常', icon: 'none' });
      } finally {
        this.setData({ isLoading: false });
      }
    },

    // 处理购买按钮点击事件
    handleBuyCard(e) {
      const cardId = e.currentTarget.dataset.cardId;
      const cardName = e.currentTarget.dataset.cardName; // 获取卡名用于提示
  
      if (!cardId) {
        wx.showToast({ title: '无法识别卡片', icon: 'none' });
        return;
      }
  
      // 查找被点击的卡片在列表中的索引
      const cardIndex = this.data.cardList.findIndex(item => item._id === cardId);
      if (cardIndex === -1) {
          wx.showToast({ title: '卡片数据错误', icon: 'none' });
          return;
      }
  
      // 防止重复点击
      if (this.data.cardList[cardIndex].isPurchasing) {
        return;
      }

      const selectedCard = this.data.cardList[cardIndex];
      if (selectedCard.notStarted) {
          wx.showToast({ title: '还没到可购买时段', icon: 'none' });
          return;
      }
      if (selectedCard.timeEnded) {
          wx.showToast({ title: '今日时段已结束，明日再来', icon: 'none' });
          return;
      }
  
      // 弹窗确认
      wx.showModal({
        title: '确认购买',
        content: `确定要购买 "${cardName || '此优惠卡'}" 吗？ \n（消耗点数：${this.data.cardList[cardIndex].cost || 0}）`,
        success: async (res) => {
          if (res.confirm) {
            // 设置特定卡片的购买状态为 true
            this.setData({
              [`cardList[${cardIndex}].isPurchasing`]: true
            });
            // wx.showLoading({ title: '正在购买...', mask: true });
  
            try {
              const buyRes = await wx.cloud.callFunction({
                name: 'baseFunctions',
                data: {
                  type: 'buyCard',
                  params: {
                    card_id: cardId
                  }
                }
              });

              // wx.hideLoading();
  
              if (buyRes.result && buyRes.result.success) {
                wx.showToast({ title: '购买成功！', icon: 'success' });
                // 购买成功后，刷新整个卡片列表以更新状态和库存
                setTimeout(() => {
                    Promise.all([
                        this.loadCardData(),
                        this.getUserPoints(),
                    ]).catch(err =>
                        console.error("购买后刷新数据错误：", err));
                }, 1000);
              } else {
                wx.showToast({ title: buyRes.result?.errMsg || '购买失败', icon: 'none', duration: 2000 });
                 this.setData({
                   [`cardList[${cardIndex}].isPurchasing`]: false
                 });
                 // 如果售罄，立即刷新列表更新状态
                 if (buyRes.result?.errMsg?.includes('售罄')) {
                     this.loadCardData();
                 }
              }
            } catch (err) {
              // wx.hideLoading();
              console.error('调用 buyCard 异常:', err);
              wx.showToast({ title: '购买服务异常', icon: 'none' });
              this.setData({
                [`cardList[${cardIndex}].isPurchasing`]: false
              });
            }
            // } else {
            //   this.setData({
            //     [`cardList[${cardIndex}].isPurchasing`]: false
            //   });
          }
        }
      });
    },
  
  });