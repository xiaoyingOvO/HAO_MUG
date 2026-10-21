Page({
    data: {
      calendar: null,     // 月历数据 { year, month, cells: [{key,dayNum,status,disabled,isToday,reserve,selected}] }
      selectedDate: '',   // 选中日期展示文本（M/D）
      selectedDateKey: '', // 选中日期键（YYYY-MM-DD），用于日历选中框高亮
      reserveData: [],    // 全部预约数据（整月）
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

    /* ============================================================
     * 【一】登录与用户信用分
     *   checkLoginState / redirectToLogin —— 登录校验
     *   getUserInfo / _updateCreditDisplay —— 信用分获取与等级显示
     * ============================================================ */

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
                // ⚠️ 重新计算可预约状态：openid 到位后，之前 loadReserveData 里
                //    那次 _updateCanReserveStatus 可能因 openid 还为空而误判「已满员」。
                //    这里补算一次，保证 openid + currentReserve 都到位后结果正确。
                this._updateCanReserveStatus();
                // ⚠️ 重新构建月历状态：openid 到位后，「我预约/别人预约」的格子着色才能正确。
                //    若 loadReserveData 先于 getUserInfo 完成，此时日历已按「openid 为空」渲染，
                //    所有预约格子都会误标成「他人预约」。这里用最新 openid 重算日历。
                if (this.data.reserveData && this.data.reserveData.length > 0) {
                  this.setData({ calendar: this._buildCalendar(this.data.reserveData) });
                  // 重建日历后重新标记选中框（否则 selected 被重置为 false）
                  this._markSelectedCell();
                }

            } else {
                console.error('获取用户信息失败：',res.result);
                this._updateCreditDisplay(null);
            }
        } catch (err) {
            console.error('发生异常：', err);
            this._updateCreditDisplay(null);
        }
    },

    /* ============================================================
     * 【二】预约数据加载与日期选择
     *   loadReserveData / _silentRefreshReserve —— 预约数据（含缓存预取）
     *   handleDateSelect —— 切换日期
     * ============================================================ */

    // 后台静默刷新预约数据（命中缓存后调用，保证下次 onShow 用的是最新数据）
    _silentRefreshReserve() {
      const app = getApp();
      wx.cloud.callFunction({
        name: 'baseFunctions',
        data: { type: 'getReserveInfo', params: { days: 28 } }
      }).then(r => {
        if (r && r.result && r.result.success && app.globalData && app.globalData.pageCache) {
          app.globalData.pageCache.reserve = r.result.data;
        }
      }).catch(err => {
        console.warn('[Reserve] 静默刷新预约数据失败：', err);
      });
    },

    // 加载预约数据（从今天起 28 天，4 行日历形式展示）
    async loadReserveData() {
        this.setData({ isLoading: true });

      try {
        // 优先读全局预取缓存：app 启动时已预取，命中则秒开，再后台静默刷新
        const app = getApp();
        const cached = app.globalData && app.globalData.pageCache && app.globalData.pageCache.reserve;
        let res;
        if (cached) {
          res = { result: { success: true, data: cached } };
          // 后台静默刷新，保证数据是最新的（下一次 onShow 直接用新缓存）
          this._silentRefreshReserve();
        } else {
          res = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: {
                type: 'getReserveInfo',
                params: { days: 28 }
            }
          });
          // 写回全局缓存
          if (res.result && res.result.success && app.globalData && app.globalData.pageCache) {
            app.globalData.pageCache.reserve = res.result.data;
          }
        }

        if (res.result.success) {
          // 预约数据：整月，每项 { day: Date, openids: [] }
          const reserveData = (res.result.data.reserve_data || []).map(item => ({
            ...item,
            day: new Date(item.day),
            openids: item.openids || [],
          }));

          const reserve_limit = res.result.data.reserve_limit;
          const reserve_max = res.result.data.reserve_max ?? 3;
          const reserve_cost = res.result.data.reserve_cost ?? 100;

          // 构建月历数据结构
          const calendar = this._buildCalendar(reserveData);

          // 默认选中今天（若今天已过去则选今天；今天在未来月不存在的场景一般不会发生）
          const todayKey = this._dateKey(new Date());
          const defaultIdx = reserveData.findIndex(r => this._dateKey(r.day) === todayKey);
          const todayReserve = defaultIdx >= 0 ? reserveData[defaultIdx] : reserveData[0];

          this.setData({
            reserveData: reserveData,
            calendar: calendar,
            reserve_limit: reserve_limit,
            reserve_max: reserve_max,
            reserve_cost: reserve_cost,
            currentReserve: todayReserve,
            selectedDate: todayReserve ? this.formatDate(todayReserve.day) : '',
            selectedDateKey: todayReserve ? this._dateKey(todayReserve.day) : '',
            alreadyReserved: false,
          });
          // 标记默认选中格子（今天）
          this._markSelectedCell();
          // 更新可预约状态
          this._updateCanReserveStatus();

          // 加载今天预约用户列表
          const initialOpenids = todayReserve?.openids || [];
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

    /* ============================================================
     * 【二·扩展】月历构建与状态判断
     *   _buildCalendar —— 把整月预约数据组装成日历格子（含前置空格）
     *   _dateKey —— 生成 YYYY-MM-DD 键
     *   _dayStatus —— 判断某天是「我约/别人约/空闲」
     * ============================================================ */

  // 生成 YYYY-MM-DD 键
  _dateKey(date) {
    if (!(date instanceof Date)) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  // 刷新日历选中态：根据当前 selectedDate 给对应格子打上 selected 标记
  _markSelectedCell() {
    const calendar = this.data.calendar;
    if (!calendar || !Array.isArray(calendar.cells)) return;
    const selectedKey = this.data.selectedDateKey;
    const cells = calendar.cells.map(c => {
      if (c.empty) return c;
      return { ...c, selected: selectedKey ? c.key === selectedKey : false };
    });
    this.setData({ 'calendar.cells': cells });
  },

    // 构建日历格子数组：从「今天所在周的周日」开始，显示 4 行（4 行 × 7 列 = 28 天）
    // 今天之前（本周日~昨天）的已过日期保留为灰色占位，保证星期表头始终对齐；
    // 今天起为可预约日期。这样不再显示「上个月整月」里那些无价值的已过日期。
    // 返回 [{ key, dayNum, level, isMine, disabled, isToday, reserve, selected }]
    //   level: 'low' | 'medium' | 'high' | 'full'  —— 按已预约人数分档着色
    //     low(<3)=绿  medium(3~5)=橙  high(5~8)=红  full(>8)=深红(偏褐)
    //   isMine: 是否「我的预约」，右下角打勾
    _buildCalendar(reserveData) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 今天 0 点
      const todayKey = this._dateKey(today);

      // 本周起始日 = 今天 - 今天所在星期几（周日为 0）
      const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());

      // 建立日期 -> reserve 映射
      const map = {};
      reserveData.forEach(r => {
        map[this._dateKey(r.day)] = r;
      });

      const cells = [];
      // 从本周日起连续 28 天（4 行）
      for (let i = 0; i < 28; i++) {
        const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
        const key = this._dateKey(date);
        const reserve = map[key] || { day: date, openids: [] };
        const openids = reserve.openids || [];
        const count = openids.length;
        const isMine = openids.indexOf(this.data.openid) >= 0;
        // 过去日期（今天之前）置灰不可点
        const isPast = date.getTime() < today.getTime();
        // 按人数分档
        const level = count < 3 ? 'low' : (count <= 5 ? 'medium' : (count <= 8 ? 'high' : 'full'));

        cells.push({
          empty: false,
          key,
          dayNum: date.getDate(),
          level,
          isMine,
          disabled: isPast,
          isToday: key === todayKey,
          selected: false,
          reserve,
          // 1 号格子左上角标注月份（跨月时标出下个月）
          monthLabel: date.getDate() === 1 ? `${date.getMonth() + 1}月` : '',
        });
      }

      return {
        year: today.getFullYear(),
        month: today.getMonth() + 1,
        cells,
      };
    },

    // 日期选择处理（点日历格子）
    async handleDateSelect(e) {
      const key = e.currentTarget.dataset.key;
      const cell = (this.data.calendar.cells || []).find(c => c.key === key);
      if (!cell || cell.disabled) {
        return; // 空格子或过去日期不可点
      }
      const currentReserve = cell.reserve;
      if (!currentReserve || !currentReserve.day) {
        console.error('选择的日期数据异常：', currentReserve);
        wx.showToast({ title: '选择的日期数据错误', icon: 'none' });
        return;
      }
      const selectedDate = this.formatDate(currentReserve.day);
      const currentOpenids = currentReserve.openids || [];

      this.setData({
        currentReserve,
        reserveList: currentOpenids.map(id => ({ openid: id, nickname: '加载中...' })),
        selectedDate,
        selectedDateKey: key,
        isLoadingUserInfo: currentOpenids.length > 0,
        alreadyReserved: false,
      });
      // 切换选中框高亮到当前点击的日期
      this._markSelectedCell();
      this._updateCanReserveStatus();

      // 批量获取用户信息
      if (currentOpenids.length > 0) {
        await this.batchGetUserInfo(currentOpenids);
        this.setData({ isLoadingUserInfo: false });
      } else {
        this.setData({ reserveList: [], isLoadingUserInfo: false });
      }
    },

    /* ============================================================
     * 【三】预约操作与用户信息批量获取
     *   _updateCanReserveStatus —— 更新预约资格/是否已约
     *   batchGetUserInfo —— 按 openid 批量取昵称
     *   handleReserve —— 发起预约
     * ============================================================ */

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
                    // 记录刚预约的日期，刷新后重新选中它
                    const bookedKey = this._dateKey(this.data.currentReserve.day);
                    await this.loadReserveData();
                    // 重新定位到刚预约的日期，刷新其用户列表
                    const updatedReserve = (this.data.reserveData || []).find(r => this._dateKey(r.day) === bookedKey);
                    if (updatedReserve) {
                      this.setData({ currentReserve: updatedReserve, selectedDate: this.formatDate(updatedReserve.day), selectedDateKey: bookedKey });
                      this._markSelectedCell();
                      this._updateCanReserveStatus();
                      const updatedOpenids = updatedReserve.openids || [];
                      if (updatedOpenids.length > 0) {
                        this.setData({ isLoadingUserInfo: true });
                        await this.batchGetUserInfo(updatedOpenids);
                        this.setData({ isLoadingUserInfo: false });
                      } else {
                        this.setData({ reserveList: [], isLoadingUserInfo: false });
                      }
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
  
    /* ============================================================
     * 【四】日期工具函数
     *   getWeekday / formatISODate / formatDate
     * ============================================================ */

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
