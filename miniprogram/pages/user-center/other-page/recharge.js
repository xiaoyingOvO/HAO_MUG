// pages/user-center/other-page/recharge.js
const app = getApp();

Page({
  data: {
    rechargeAmount: '0.00', // 初始化为 '0.00'
    rechargeAmountInput: '',
    numericRechargeAmount: 0,
    isValidRechargeAmount: false,
    userInfo: null,
    pointAnim: {},
    lastExtraPoint: 0,  // 记录上次的赠送值
    animating: false,   // 动画状态锁
    extraPoint: 0,      // 当前计算的赠送点数
    extraPointDisplay: 0.00,  //显示格式化赠送点数
    isReady: false,
    isRecharging: false, // 防止重复点击充值
    canvasContext: null, // 存储 canvas 上下文
    canvasNode: null,   // 存储 canvas 节点
    particles: [],      // 粒子数组
    animationFrameId: null, // 动画帧 ID
  },

  onLoad: function (options) {
    // 监听 userInfo
    this.eventChannel = this.getOpenerEventChannel();
    if (this.eventChannel && this.eventChannel.on) {
        this.eventChannel.on('acceptData', (data) => {
            console.log('充值页接收到 userInfo:', data.userInfo);
            if (data && data.userInfo && data.userInfo.openid && data.userInfo.nickname){
              this.setData({
                userInfo: data.userInfo,
                isReady: true,
              });
            } else {
              console.error("接收到的 userInfo 无效或缺少 openid");
              this.handleInvalidUser();
            }
        });
    } else {
        console.warn('无法获取 EventChannel，可能无法接收 userInfo');
    }

    // 初始化动画对象
    this.animation = wx.createAnimation({
      duration: 300,
      timingFunction: 'ease-out',
    });

    // 初始化粒子效果
    this.initCanvas();
  },

    // 处理无效用户状态
    handleInvalidUser: function() {
      this.setData({ isReady: false });
      wx.showModal({
        title: '错误',
        content: '无法获取您的登录信息，请返回检查登录状态。',
        showCancel: false,
        confirmText: '返回',
        success: (res) => {
          if (res.confirm) {
            wx.reLaunch({
              url: '/pages/user-center/index',
            })
          }
        }
      });
    },

  onUnload() {
    // 页面卸载时停止粒子动画
    if (this.data.animationFrameId && this.data.canvasNode) {
        this.data.canvasNode.cancelAnimationFrame(this.data.animationFrameId);
    }
  },


  // --- 输入处理 ---
  handleAmountInput(e) {
    let value = e.detail.value;

    if (value.startsWith('.')) {
      value = '0' + value;
    }

    const decimalCount = (value.match(/\./g) || []).length;
    if (decimalCount > 1) {
      const parts = value.split('.');
      value = parts[0] + '.' + parts.slice(1).join('');
    }

    if (value.includes('.')) {
      const parts = value.split('.');
      if (parts[1] && parts[1].length > 2) {
        parts[1] = parts[1].slice(0, 2);
        value = parts[0] + '.' + parts[1];
      }
    }

    value = value.replace(/[^\d.]/g, '');

    this.setData({
      rechargeAmountInput: value
    }, () => {
      this.processRechargeValue();
    });
  },

  // 处理和校验充值金额，并计算赠送
  processRechargeValue() {
    const valueStr = this.data.rechargeAmountInput;
    let numericValue = parseFloat(valueStr);

    if (isNaN(numericValue) || numericValue < 0) {
      numericValue = 0;
    }

    const extraPoint = this.calculateExtraPoint(numericValue);

    if (extraPoint !== this.data.lastExtraPoint && !this.data.animating) {
      this.runHintAnimation();
      this.setData({
        lastExtraPoint: extraPoint
      });
    }

    this.setData({
      numericRechargeAmount: numericValue,
      isValidRechargeAmount: numericValue > 0,
      rechargeAmount: numericValue.toFixed(2),
      extraPoint: extraPoint,
      extraPointDisplay: extraPoint.toFixed(2)
    })
  },


  // 计算赠送点数
  calculateExtraPoint(real_point) {
      const exp = this.data.userInfo?.exp || 0;
      console.log("当前exp：", exp, "充值金额:", real_point);
      let bonus = 0; // 赠送倍数
      if (real_point >= 100) {  // 充值大于等于100元赠送
        if (exp > 30000) {        // 5级 30%
            bonus = 0.30;
          } else if (exp > 18000) { // 4级 20%
              bonus = 0.20;
          } else if (exp > 8000) {  // 3级 10%
              bonus = 0.10;
          } else if (exp > 2000) {  // 2级 5%
              bonus = 0.05;
          } else {
              bonus = 0; // 1级 不额外赠送
          }
      }

      

      let finalExtra = real_point * bonus;
      finalExtra = parseFloat(finalExtra.toFixed(2));   // 保留两位小数
      // console.log(`基础赠送: ${baseExtra}, 倍数: ${multiplier}, 最终赠送: ${finalExtra}`);
      return finalExtra;
  },

  // 提示文字动画
  runHintAnimation() {
      if (this.data.animating) return; // 防止动画重叠

      this.setData({ animating: true });

      this.animation.translateY(-15).opacity(0).step({ duration: 0 }); // 瞬移到上面并透明
      this.setData({ pointAnim: this.animation.export() }, () => {
          wx.nextTick(() => { // 确保UI更新后再执行下一步动画
              this.animation.translateY(0).opacity(1).step({ duration: 300, timingFunction: 'ease-out' }); // 滑下并恢复不透明
              this.setData({ pointAnim: this.animation.export() });
              setTimeout(() => {
                  this.setData({ animating: false });
              }, 300); // 动画结束后解锁
          });
      });
    },


  // 充值主函数
  async handleRecharge() {
    const openid = this.data.userInfo?.openid;
    if (!this.data.isReady || !openid) {
      this.handleInvalidUser();
      return;
    }

    // 检查金额是否有效
    const amount = Number(this.data.numericRechargeAmount);
    if (!amount || amount <= 0) {
        wx.showToast({ title: '请输入有效金额', icon: 'none' });
        return;
    }
    // 检查是否已在充值中
    if (this.data.isRecharging) return;

    this.setData({ isRecharging: true }); // 设置状态为充值中
    wx.showLoading({ title: '正在发起支付...', mask: true }); // 增加 mask

    try {
      // 1. 获取 openid
      const openid = this.data.userInfo?.openid;
      if (!openid) {
          throw new Error('无法获取用户信息，请重试');
      }

      // 2. 调用工作流生成支付参数
      console.log(`调用支付工作流，金额: ${amount}, openid: ${openid}`);
      const payOrder = await wx.cloud.callFunction({
        name: 'cloudbase_module',
        data: {
          name: 'sywxzfapifqzf_73b1098',  // 工作流ID
          data: {
            description: "点数充值",
            openid: openid,
            point: amount, 
            // total_fee: amount * 100,
          }
        }
      });
      console.log('支付工作流返回:', payOrder);

      // 3. 检查支付参数
      const paymentData = payOrder.result?.data;
      if (!paymentData || !paymentData.timeStamp || !paymentData.nonceStr || !paymentData.packageVal || !paymentData.paySign) {
          console.error("支付参数不完整:", paymentData);
          throw new Error(payOrder.result?.errMsg || '获取支付参数失败');
      }

      // 4. 唤起微信支付
      console.log("发起微信支付参数:", paymentData);
      await wx.requestPayment({
        timeStamp: paymentData.timeStamp,
        nonceStr: paymentData.nonceStr,
        package: paymentData.packageVal,
        signType: paymentData.signType || 'RSA',
        paySign: paymentData.paySign,
      });
      console.log("微信支付接口调用成功 (不代表支付成功)");

      // 5. 支付成功后的处理 
      const refreshRes = await wx.cloud.callFunction({
        name: 'baseFunctions',
        data: {
          type: 'getUsrInfo'
        }
      });
      if (refreshRes.result?.success && refreshRes.result.data) {
        const latestUsrInfo = refreshRes.result.data;
        console.log('支付成功后，获取到最新用户信息：', latestUsrInfo);
        app.globalData.userInfo = latestUsrInfo;
        wx.setStorageSync('userInfo', latestUsrInfo);
        this.setData({ userInfo: latestUsrInfo });
      }

      wx.hideLoading();
      wx.showModal({
          title: '支付成功',
          content: '充值成功！点数可能稍有延迟到账，请稍后查看。',
          showCancel: false,
          confirmText: '好的',
          success: () => {
              // wx.navigateBack();
          }
      });
       this.setData({
         rechargeAmountInput: '',
         numericRechargeAmount: 0,
         isValidRechargeAmount: false,
         rechargeAmount: '0.00',
         extraPoint: this.calculateExtraPoint(0),
         extraPointDisplay: (this.calculateExtraPoint(0)).toFixed(2),
         lastExtraPoint: this.calculateExtraPoint(0),
       }); // 清空输入框

    } catch (err) {
      wx.hideLoading(); // 确保出错时也隐藏 loading
      console.error('充值流程错误:', err);
      if (err.errMsg === 'requestPayment:fail cancel') {
        wx.showToast({ title: '支付已取消', icon: 'none' });
      } else {
        const errMsg = (err instanceof Error) ? err.message : (err.errMsg || '充值失败，请稍后再试');
        wx.showToast({ title: errMsg, icon: 'none', duration: 2000 });
      }
    } finally {
        this.setData({ isRecharging: false }); // 无论成功失败，结束充值状态
    }
  },

  // --- 粒子效果相关函数 ---
  initCanvas() {
    const query = wx.createSelectorQuery();
    query.select('#particle-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res[0] || !res[0].node) {
            console.error("无法获取 Canvas 节点");
            return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio;
        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;
        ctx.scale(dpr, dpr);

        this.setData({ canvasContext: ctx, canvasNode: canvas }, () => {
            this.createParticles(canvas.width / dpr, canvas.height / dpr);
            this.drawParticles(); // 开始绘制
        });
      });
  },

  createParticles(width, height) {
      const particles = [];
      const count = 50; // 粒子数量
      for (let i = 0; i < count; i++) {
          particles.push({
              x: Math.random() * width,
              y: Math.random() * height,
              vx: Math.random() * 0.5 - 0.25, // x 轴速度
              vy: Math.random() * 0.5 - 0.25, // y 轴速度
              radius: Math.random() * 1.5 + 0.5, // 粒子半径
              color: `rgba(46, 204, 113, ${Math.random() * 0.5 + 0.2})` // 半透明绿色
          });
      }
      this.setData({ particles, canvasWidth: width, canvasHeight: height });
  },

  drawParticles() {
    const ctx = this.data.canvasContext;
    const canvas = this.data.canvasNode;
    if (!ctx || !canvas) return;

    const width = this.data.canvasWidth;
    const height = this.data.canvasHeight;

    ctx.clearRect(0, 0, width, height); // 清除画布

    this.data.particles.forEach(p => {
      // 更新粒子位置
      p.x += p.vx;
      p.y += p.vy;

      // 边界处理 (循环出现)
      if (p.x < 0) p.x = width;
      if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      if (p.y > height) p.y = 0;

      // 绘制粒子
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    });

    // 请求下一帧动画
    const animationFrameId = canvas.requestAnimationFrame(this.drawParticles.bind(this));
    this.setData({ animationFrameId });
  }

});