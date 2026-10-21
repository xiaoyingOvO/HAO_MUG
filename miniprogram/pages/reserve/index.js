Page({
    data: {
      dates: [],          // 日期按钮数据
      activeIndex: 0,     // 当前选中日期索引
      selectedDate: '',
      reserveData: [],    // 全部预约数据
      openid: '',
      credit: 100,          // 用户信用分
      creditGrade: 'S',   // 用户信用分等级
      creditClass: 'credit-S',    // 信用样式类
      reserveQualification: true, // 预约资格
      // maxCapacity: 3,     // 最大预约容量
      reserve_limit: true,  // 是否限制预约
      reserve_max: 3,   // 最大预约人数
      reserve_cost: 100,    // 预约消耗点数
      canReserve: false,  // 显示状态字段
      alreadyReserved: false, // 是否已预约当前日期
      userMap: {},        // 用户信息缓存
      reserveList: [],    // 当前展示预约列表
      currentReserve: { openids: [] },
      isLoadingUserInfo: false, //  添加加载状态
      isYesterdayHidden: false, //  标记昨天是否隐藏
    },
  
    onLoad() {
      this.checkLoginState();
      this.getUserInfo();
      this.loadReserveData();
    },

    onShow() {
      this.getUserInfo();
      this.loadReserveData();
    },

    // 检查登录状态
  async checkLoginState() {
    // wx.showLoading({
    //   title: '正在验证登录...',
    //   mask: true
    // })
    let userInfo = null;
    let loginStatusIsValid = false;
    
    try {
        const cloudRes = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: {
                type: 'getUsrInfo'
            }
        });
        if (cloudRes.result && cloudRes.result.success === true && cloudRes.result.data?.openid) {
            userInfo = cloudRes.result.data;
            wx.setStorageSync('userInfo', userInfo);
            this.setData({ userInfo: userInfo });
            wx.hideLoading();
            return Promise.resolve(true); // 检查通过
        } else {
            wx.removeStorageSync('userInfo'); // 清除可能的无效缓存
            loginStatusIsValid = false;
             wx.hideLoading();
          //   wx.showLoading({
          //     title: '跳转至登录页',
          //     icon: 'loading',
          //     duration: 1500,
          //     mask: true
          //   });
          //   await new Promise(resolve => setTimeout(resolve, 1500));
          //   wx.reLaunch({
          //     url: '/pages/login/index',
          //     complete: () => {
          //         wx.hideLoading();
          //     }
          //   });
          //   return Promise.reject("重定向至登录页");
        }
    } catch (cloudError) {
        console.error('云函数调用异常：', cloudError);
        wx.removeStorageSync('userInfo');
        loginStatusIsValid = false;
        wx.hideLoading();
      //   wx.showToast({
      //     title: '验证失败, 请登录',
      //     icon: 'none',
      //     duration: 2000,
      //     mask: true
      // });
        // 延迟跳转
      //   await new Promise(resolve => setTimeout(resolve, 2000));
      //   wx.reLaunch({
      //     url: '/pages/login/index',
      //   });
      //   return Promise.reject("因异常重定向至登录页");
    };

    if (loginStatusIsValid) {
        this.setData({
            userInfo: userInfo,
            isLoading: false,
        });
        // 加载页面其他数据
    } else {
        this.setData({
            userInfo: null,
            isLoading: false
        });
    }
},
// 预览状态登录
redirectToLogin() {
    wx.reLaunch({
        url: '/pages/login/index' 
      });
  },

    // 计算信用等级
    _updateCreditDisplay(credit) {
      let grade = 'C';
      let cssClass = 'credit-C';
      if (credit === null || credit === undefined) {
          grade = '-'; // 处理未获取到信用分的情况
          cssClass = '';
      } else if (credit >= 85) {
        grade = 'S';
        cssClass = 'credit-S';
      } else if (credit >= 70) {
        grade = 'A';
        cssClass = 'credit-A';
      } else if (credit >= 60) {
        grade = 'B';
        cssClass = 'credit-B';
      }
  
      this.setData({
        creditGrade: grade,
        creditClass: cssClass,
      });
    },
  
    // 获取信用分
    async getUserInfo() {
        try {
            const res = await wx.cloud.callFunction({
                name: 'baseFunctions',
                data: {
                    type: 'getUsrInfo',
                    params: {}
                }
            });

            if (res.result.success) {
                const credit = res.result.data.credit;
                const openids = res.result.data.openid;
                const reserveQualification = credit >= 85;
                this.setData({ 
                  credit, 
                  openid: openids,
                  reserveQualification,
                });
                // 获取到 credit 后更新显示
                this._updateCreditDisplay(credit);

            } else {
                console.error('获取用户信息失败：',res.result);
                this._updateCreditDisplay(null);
            }
        } catch (err) {
            console.error('发生异常：', err);
            this._updateCreditDisplay(null);
        }
    },

    // 加载预约数据
    async loadReserveData() {
        this.setData({ isLoading: true });
        const DEBUG_MODE = false;
        let debugHour = 12;

      try {
        const res = await wx.cloud.callFunction({
          name: 'baseFunctions',
          data: {
              type: 'getReserveInfo',
              //params: {}, 
              params: { days: 5 } 
          }
        });

        if (res.result.success) {
            // 获取原始的 6 天数据
          const fullReserveData = res.result.data.reserve_data.map(item => ({
            ...item,
            day: new Date(item.day), // 转换日期字符串为Date对象
            openids: item.openids || [],
          }));

          // 判断当前时间决定是否隐藏昨天
          const now = new Date();
          const nowCST = new Date(now.getTime() + (8 * 60 * 60 * 1000));
          //const currentCSTHour = nowCST.getUTCHours();
          let currentCSTHour;
          if (DEBUG_MODE) {
              currentCSTHour = debugHour;
          } else {
              currentCSTHour = nowCST.getUTCHours();
          }
          let realReserveData = [...fullReserveData];    // 复制显示数组
          let isYesterdayHidden = false;
          let activeIndexOffset = 0;    // 索引偏移量
          if (currentCSTHour >= 10) {
              if (realReserveData.length > 0) {
                  realReserveData.shift();  // 移除昨天
                  isYesterdayHidden = true;
                  activeIndexOffset = 1;
              }
          } else {
              isYesterdayHidden = false;
              activeIndexOffset = 0;
          }
          let realActiveIndex = this.data.activeIndex;  //  获取当前索引
          if (isYesterdayHidden) {
              realActiveIndex = Math.max(0, realActiveIndex - activeIndexOffset);
          }
          realActiveIndex = Math.min(realActiveIndex, realReserveData.length - 1);
          if (realReserveData === 0) {
              realActiveIndex = 0;
          }
    
          // 生成日期按钮数据
          const dates = realReserveData.map(item => ({
            weekday: this.getWeekday(item.day),
            date: this.formatDate(item.day),
          }));

          const reserve_limit = res.result.data.reserve_limit;
          const reserve_max = res.result.data.reserve_max ?? 3;
          const reserve_cost = res.result.data.reserve_cost ?? 100;

          // 确定当前选中数据
          const currentReserve = realReserveData.length > 0 ? realReserveData[realActiveIndex] : { day: new Date(), openids: []};
    
          this.setData({
            fullReserveData: fullReserveData,
            reserveData: realReserveData,
            dates: dates,
            reserve_limit: reserve_limit,
            reserve_max: reserve_max,
            reserve_cost: reserve_cost,
            //credit: res.result.data.credit,
            //reserveQualification: res.result.data.reserve_qualification,
            currentReserve: currentReserve,
            activeIndex: realActiveIndex,
            selectedDate: currentReserve ? this.formatDate(currentReserve.day) : '',
            alreadyReserved: false,
            isYesterdayHidden: isYesterdayHidden,
          });
          // 更新可预约状态
          this._updateCanReserveStatus();

          const initialOpenids = currentReserve?.openids || [];
          if (initialOpenids.length > 0) {
              this.setData({ isLoadingUserInfo: true });
              await this.batchGetUserInfo(initialOpenids);
              this.setData({ isLoadingUserInfo: false });
          } else {
              this.setData({ reserveList: [] });
          }

        } else {
          console.error('加载预约数据失败：', res.result.errMsg);
          wx.showToast({
            title: '加载数据失败',
            icon: 'none'
          });
        }
      } catch (err) {
        console.error('加载预约数据异常：', err);
        wx.showToast({
          title: `未找到用户信息或未登录`,
          icon: 'none'
        });
      }
    },
  
    // 日期选择处理
    async handleDateSelect(e) {
      const index = e.currentTarget.dataset.index;
      if (index < 0 || index >= this.data.reserveData.length) {
        console.warn('无效的日期索引：', index);
        return;
      }
      const currentReserve = this.data.reserveData[index];
      // 添加检查
      if (!currentReserve || !currentReserve.day) {
        console.error('选择的日期数据异常：', currentReserve);
        wx.showToast({
          title: '选择的日期数据错误',
          icon: 'none'
        });
        return;
      }
      const selectedDate = this.formatDate(currentReserve.day);
      const currentOpenids = currentReserve.openids || [];  // 确保是数组

      if (!currentReserve?.openids) {
          console.warn('当前日期无预约数据');
          this.setData({ reserveList: [] });
          return;
      }

      this.setData({
        activeIndex: index,
        currentReserve,
        reserveList: currentOpenids.map(id => ({ openid: id, nickname: '加载中...'})),    // 清空旧数据，显示加载状态
        selectedDate,
        isLoadingUserInfo: true,
        alreadyReserved: false,
      });
      this._updateCanReserveStatus();

      // 批量获取用户信息
        await this.batchGetUserInfo(currentOpenids);
        this.setData({ isLoadingUserInfo: false });
    },

    // 更新可预约状态的辅助函数
    _updateCanReserveStatus() {
      const { openid, reserveQualification, currentReserve, reserve_limit, reserve_max } = this.data;
      let isReserved = false;
      let canStillReserve = false;
      if (openid && currentReserve && Array.isArray(currentReserve.openids)) {
          // 当前用户是否在当前日期预约列表中
          isReserved = currentReserve.openids.includes(openid);
          let isFull = false;
          if (reserve_limit === true) {
              isFull = currentReserve.openids.length >= reserve_max;
          }
          canStillReserve = reserveQualification && !isFull && !isReserved;
      } else {
          // 数据不完整，不允许预约
          isReserved = false;
          canStillReserve = false;
      }
      this.setData({
            alreadyReserved: isReserved,
            canReserve: canStillReserve 
        });
    },

    // 获取用户信息方法 
    async batchGetUserInfo(openids) {
      if (!Array.isArray(openids) || openids.length ===0) {
        this.setData({ reserveList: [] });
        return;
      }
      const uncached = openids.filter(id => id && !this.data.userMap[id]);

      const newUserMap = { ...this.data.userMap };
      if(uncached.length > 0) {
        try {
          
          const res = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: {
              type: 'getUsrNameByOpenids',
              params: {
                openids: uncached
              }
            }
          });

          if (res.result && res.result.success && Array.isArray(res.result.data)) {
            res.result.data.forEach(userInfo => {
              if (userInfo && userInfo.openid) {
                newUserMap[userInfo.openid] = userInfo.nickname || '匿名用户';
              }
            });
            uncached.forEach(id => {
              if (!newUserMap[id]) {
                newUserMap[id] = '获取失败';
              }
            });
          } else {
            console.error('获取用户信息失败或返回格式错误：', res.result);
            uncached.forEach(id => {
              newUserMap[id] = '获取失败';
            });
          }
        } catch (err) {
          console.error('调用云函数异常：', err);
          uncached.forEach(id => {
            newUserMap[id] = '获取异常';
          });
        }
      } else {
      }

      const finalReserveList = openids.map(id => ({
        openid: id,
        nickname: newUserMap[id] || '加载中...'
      }));

      this.setData({
        userMap: newUserMap,
        reserveList: finalReserveList,
      });
    },

    // 预约操作
    async handleReserve() {
        this._updateCanReserveStatus();
        if (!this.data.canReserve) {
          let title = '';
          if (this.data.alreadyReserved) {
              title = '您已预约过';
          } else if (!this.data.reserveQualification) {
              title= '信用分不足，无法预约';
          } else {
              title = '预约已满';
          }
          wx.showToast({
            title: title,
            icon: 'none',
          });
          return;
        }

        const { currentReserve, openid, selectedDate } = this.data;
        if (!currentReserve || !currentReserve.day || !openid) {
          wx.showToast({
            title: '数据错误，请稍后重试',
            icon: 'none',
          });
          console.error("预约所需数据不完整：", currentReserve, openid);
          return;
        }

        const isoDate = this.formatISODate(this.data.currentReserve.day);

      wx.showModal({
        title: '确认预约',
        content: `确认预约 ${this.data.selectedDate} 的夜场吗？`+ `\n` + `预约成功后无法取消预约！`,
        success: async (modalRes) => {
          if (modalRes.confirm) {
            wx.showLoading({
              title: '正在预约...',
            });
            try{
                const cloudRes = await wx.cloud.callFunction({
                    name: 'baseFunctions',
                    data: {
                        type: 'buyReserve',
                        params: {
                            reserve_date: isoDate,  // 传递格式为 YYYY-MM-DD
                            openid: openid,
                        }
                    }
                });
                wx.hideLoading();
                if (cloudRes.result?.success) {
                    wx.showToast({
                    title: '预约成功',
                    icon: 'success',
                    });
                    await this.loadReserveData();
                    // 刷新预约用户列表
                    const updatedCurrentReserve = this.data.reserveData[this.data.activeIndex];
                    const updatedOpenids = updatedCurrentReserve?.openids || [];
                    if (updatedOpenids.length > 0) {
                        this.setData({ isLoadingUserInfo: true });
                        await this.batchGetUserInfo(updatedOpenids);
                        this.setData({ isLoadingUserInfo: false });
                    } else {
                        this.setData({ reserveList: [], isLoadingUserInfo: false });
                    }
                } else {
                    wx.showToast({
                    title: cloudRes.result?.errMsg || '预约失败',
                    icon: 'none'
                    });
                    this.loadReserveData();

                    // 若已预约过
                    // if (cloudRes.result.errMsg?.includes('已预约过该时段')) {
                    //     this.setData({ canReserve: false });
                    // }
                }
            } catch (err) {
                wx.hideLoading();
                wx.showToast({
                  title: '网络异常',
                  icon: 'none'
                });
                console.error("发生异常：", err);
            }
          }
        } 
      });
    },
  
    // 工具方法：获取星期
    getWeekday(date) {
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return weekdays[date.getDay()];
    },

    // 标准日期格式化方法，用于传参给云函数 (YYYY-MM-DD)
    formatISODate(date) {
      if (!(date instanceof Date)) return '';
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0'); // 补零
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`; 
    },

    // 工具方法：格式化日期 (M/D)
    formatDate(date) {
      if (!(date instanceof Date)) return '';
      return `${date.getMonth() + 1}/${date.getDate()}`;
    },

  });
