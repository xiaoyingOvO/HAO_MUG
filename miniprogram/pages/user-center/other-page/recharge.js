// pages/user-center/other-page/recharge.js
const app = getApp();

// 单笔充值金额范围（元）。普通微信支付按「分」结算，天然支持小数点后两位。
//
// 超过上限时直接锁到上限：输入框里显示的就是实际会被受理的金额，
// 用户不会看到一个自己输的、但实际不会生效的数字。
const MIN_RECHARGE = 1;
const MAX_RECHARGE = 10000;

// 金额允许的小数位数。普通支付按分计价（1 元 = 100 分），固定 2 位。
const PAY_PRECISION = 2;

// 云端「点数充值」工作流的 ID（云开发 → 工作流）。
// 它负责调用微信支付下单接口，把 prepay 参数（timeStamp / nonceStr / package / paySign）
// 返回给小程序；支付成功的回调由工作流触发 buyPoint 云函数加点，
// 所以前端拿不到到账结果，只能刷新用户信息 —— 见 handleRecharge 的注释。
const PAY_WORKFLOW_NAME = 'sywxzfapifqzf_73b1098';

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
    payPrecision: PAY_PRECISION, // 金额允许的小数位数，普通支付固定 2 位（精确到分）
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
  // 允许输入小数，固定 2 位（精确到分）。
  // 历史上这里出过「12.5 被洗成 125」的 10 倍扣款事故，所以小数点处理必须严格：
  // 先切出整数部分和小数部分，再各自规整，最后拼回去，绝不直接删字符。
  handleAmountInput(e) {
    const precision = PAY_PRECISION;
    let raw = String(e.detail.value || '');

    // 只保留数字和点
    raw = raw.replace(/[^\d.]/g, '');

    // 只认第一个小数点，后面的点一律丢掉
    let intPart = raw;
    let decPart = '';
    const dotIdx = raw.indexOf('.');
    const hadDot = dotIdx >= 0;
    if (hadDot) {
      intPart = raw.slice(0, dotIdx);
      decPart = raw.slice(dotIdx + 1).replace(/\./g, '');
    }

    // 整数部分：去前导 0（保留单个 "0"）。
    // 位数不设上限——上限由 MAX_RECHARGE 在数值层面统一收敛，
    // 输入阶段硬截断会让用户输到一半突然跳数。
    if (intPart.length > 1) intPart = intPart.replace(/^0+/, '');
    // 清空输入时保持空（".5" 这种才补 0），否则输入框会被填成 "0" 删不掉
    if (intPart === '') intPart = hadDot ? '0' : '';

    // 小数部分按精度截断；精度为 0 时整个小数部分丢弃
    if (decPart.length > precision) decPart = decPart.slice(0, precision);

    // 用户打了点、且当前精度允许小数，才保留小数点（否则 "12." 这种中间态会闪）
    const keepDot = hadDot && precision > 0;
    let value = keepDot ? intPart + '.' + decPart : intPart;

    // 超过单笔上限直接锁到上限。这一步在输入阶段做，输入框里显示的就是
    // 实际会被受理的金额，用户不会出现「输的是 100000、付的是 10000」的错位。
    if (value !== '' && Number(value) > MAX_RECHARGE) {
      value = String(MAX_RECHARGE);
    }

    this.setData({
      rechargeAmountInput: value
    }, () => {
      this.processRechargeValue();
    });
  },

  // 处理和校验充值金额，并计算赠送
  processRechargeValue() {
    const valueStr = this.data.rechargeAmountInput;
    // 用 parseFloat 而不是 parseInt：parseInt('12.5') 会把小数悄悄吃掉
    let numericValue = parseFloat(valueStr);

    if (!Number.isFinite(numericValue) || numericValue < 0) {
      numericValue = 0;
    }
    // 兜底：input 阶段已经锁过上限，这里防的是直接从代码/data 写入超限值的路径
    if (numericValue > MAX_RECHARGE) {
      numericValue = MAX_RECHARGE;
    }
    // 消掉浮点尾巴（12.34 * 100 可能是 1233.9999）
    numericValue = Math.round(numericValue * 100) / 100;

    const extraPoint = this.calculateExtraPoint(numericValue);

    if (extraPoint !== this.data.lastExtraPoint && !this.data.animating) {
      this.runHintAnimation();
      this.setData({
        lastExtraPoint: extraPoint
      });
    }

    this.setData({
      numericRechargeAmount: numericValue,
      isValidRechargeAmount: numericValue >= MIN_RECHARGE,
      rechargeAmount: numericValue.toFixed(2),
      extraPoint: extraPoint,
      extraPointDisplay: extraPoint.toFixed(2)
    })
  },

  // 计算赠送点数
  // 规则：按用户等级（exp）赠送，不设金额门槛 —— 与后端 buyPoint/index.js 完全一致。
  // 历史问题：这里原先有 `if (real_point >= 100)` 判定，导致充值不足 100 元时
  // 页面永远显示「赠送 0.00 点」，而后端其实一直在按等级赠送，形成前后端不一致。
  calculateExtraPoint(real_point) {
      const exp = this.data.userInfo?.exp || 0;
      let bonus = 0; // 赠送倍数
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

      // 与后端 buyPoint 采用相同算法，避免两边四舍五入结果不一致
      let finalExtra = Math.round(real_point * bonus * 100) / 100;
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

  // 充值主函数（普通微信支付）
  //
  // 流程：
  //   1. 调云端「点数充值」工作流，拿微信支付下单参数
  //      （timeStamp / nonceStr / package / paySign）
  //   2. wx.requestPayment 拉起微信收银台
  //   3. 支付成功的回调由工作流触发 buyPoint 云函数加点 —— 前端拿不到这个结果，
  //      所以这里只能刷新用户信息并提示「点数可能稍有延迟到账」。
  //
  // 与虚拟支付的区别：虚拟支付前端手里有订单号（outTradeNo），可以轮询查单确认到账；
  // 普通支付这条链路里订单号由工作流内部持有，前端查不到，因此不做轮询。
  async handleRecharge() {
    const openid = this.data.userInfo?.openid;
    if (!this.data.isReady || !openid) {
      this.handleInvalidUser();
      return;
    }

    // 金额校验
    const amount = Number(this.data.numericRechargeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入充值金额', icon: 'none' });
      return;
    }
    if (amount < MIN_RECHARGE) {
      wx.showToast({ title: '最低充值 ' + MIN_RECHARGE + ' 元', icon: 'none' });
      return;
    }
    if (amount > MAX_RECHARGE) {
      wx.showToast({ title: '单笔最高 ' + MAX_RECHARGE + ' 元', icon: 'none' });
      return;
    }
    // Lv6（exp >= 114514）后端会直接拒绝充值，必须在发起支付前拦住，
    // 否则会出现「钱付了、点数没到账」。
    if ((this.data.userInfo?.exp || 0) >= 114514) {
      wx.showToast({ title: '最高等级用户无需充值', icon: 'none' });
      return;
    }
    if (this.data.isRecharging) return;

    this.setData({ isRecharging: true });
    wx.showLoading({ title: '正在发起支付...', mask: true });

    try {
      // 1. 调云端工作流，生成微信支付下单参数
      const payOrder = await wx.cloud.callFunction({
        name: 'cloudbase_module',
        data: {
          name: PAY_WORKFLOW_NAME,
          data: {
            description: '点数充值',
            openid: openid,
            point: amount,
          },
        },
      });

      // 2. 校验参数完整性。workflow 内部出错时 result.data 为空，
      //    真正的错因在 errMsg 里，要原样抛给用户，别用一句兜底话盖掉。
      const paymentData = payOrder.result && payOrder.result.data;
      if (!paymentData || !paymentData.timeStamp || !paymentData.nonceStr
          || !paymentData.packageVal || !paymentData.paySign) {
        console.error('支付参数不完整:', paymentData);
        throw new Error((payOrder.result && payOrder.result.errMsg) || '获取支付参数失败');
      }

      // 3. 拉起微信收银台
      await wx.requestPayment({
        timeStamp: paymentData.timeStamp,
        nonceStr: paymentData.nonceStr,
        package: paymentData.packageVal,
        signType: paymentData.signType || 'RSA',
        paySign: paymentData.paySign,
      });

      // 4. 支付成功。加点由工作流的支付回调驱动 buyPoint 完成，
      //    这个回调可能比前端 success 晚几秒，所以这里只刷新信息、不做「已到账」断言。
      await this._refreshUserInfo();
      wx.hideLoading();
      wx.showModal({
        title: '支付成功',
        content: '充值成功！点数可能稍有延迟到账，请稍后查看。',
        showCancel: false,
        confirmText: '好的',
      });
      this._resetAmount();
    } catch (err) {
      wx.hideLoading();
      console.error('充值流程错误:', err);
      const errMsg = (err && err.errMsg) || '';
      if (errMsg.indexOf('requestPayment:fail cancel') >= 0) {
        wx.showToast({ title: '支付已取消', icon: 'none' });
      } else {
        // 微信支付失败时 errMsg 形如 "requestPayment:fail 签名错误"，
        // 前缀本身有 18 个字符，既没有信息量、又会把短文案撑过弹窗阈值，
        // 所以先剥掉前缀再判断用 toast 还是弹窗。
        const detail = String(errMsg).replace(/^requestPayment:\s*fail\s*/i, '').trim();
        const text = (err instanceof Error && err.message)
          ? err.message
          : (detail || '充值失败，请稍后再试');
        // toast 会被截断，而工作流/支付返回的具体原因往往很长
        // （如「商户号未绑定 AppID」「签名错误」），恰恰是唯一能定位问题的信息，
        // 所以长文案改用弹窗完整展示。
        if (String(text).length > 12) {
          wx.showModal({
            title: '支付失败',
            content: text,
            showCancel: false,
            confirmText: '知道了',
          });
        } else {
          wx.showToast({ title: text, icon: 'none', duration: 2500 });
        }
      }
    } finally {
      this.setData({ isRecharging: false });
    }
  },

  // 刷新用户信息（余额、等级、赠送比例都依赖它）
  async _refreshUserInfo() {
    try {
      const refreshRes = await wx.cloud.callFunction({
        name: 'baseFunctions',
        data: { type: 'getUsrInfo' },
      });
      if (refreshRes.result?.success && refreshRes.result.data) {
        const latestUsrInfo = refreshRes.result.data;
        app.globalData.userInfo = latestUsrInfo;
        wx.setStorageSync('userInfo', latestUsrInfo);
        this.setData({ userInfo: latestUsrInfo });
      }
    } catch (err) {
      // 刷新失败不影响已经完成的支付结果，下次进页面会重新拉
      console.warn('刷新用户信息失败:', err);
    }
  },

  _resetAmount() {
    const zero = this.calculateExtraPoint(0);
    this.setData({
      rechargeAmountInput: '',
      numericRechargeAmount: 0,
      isValidRechargeAmount: false,
      rechargeAmount: '0.00',
      extraPoint: zero,
      extraPointDisplay: zero.toFixed(2),
      lastExtraPoint: zero,
    });
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