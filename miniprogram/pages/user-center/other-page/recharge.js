// pages/user-center/other-page/recharge.js
import { MOCK_ENABLED } from '../../../mock/cloudMock.js';
import cloudFcn from '../../../cloudFcn.js';

const app = getApp();

// 单笔充值金额范围（元）。虚拟支付按「1 元/份」的道具下单，数量必须正整数，
// 所以本页只接受整数金额，上限用于挡住多打两个 0 的误操作。
const MIN_RECHARGE = 1;
const MAX_RECHARGE = 1000;

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
    payEnabled: true,   // 虚拟支付是否已配置可用（配置不全时置灰）
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

    // 检查自助充值是否可用：虚拟支付环境变量没配齐时按钮要置灰，
    // 而不是等用户点了才报「缺少 XPAY_OFFER_ID」。
    this.checkPayReady();
  },

  // 查询虚拟支付配置是否就绪
  async checkPayReady() {
    if (MOCK_ENABLED) return; // mock 下恒可用
    try {
      const res = await cloudFcn.getPointPayStatus();
      const d = res && res.result && res.result.data;
      if (d && d.enabled === false) {
        this.setData({ payEnabled: false });
        console.warn('自助充值暂未开放，缺少配置：', d.missing);
      }
    } catch (err) {
      // 检查失败不阻塞，真正的兜底在 createPointOrder 返回里
      console.warn('检查充值可用性失败:', err);
    }
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

  // --- 输入处理（虚拟支付按「1 元/份」下单，只接受整数元）---
  handleAmountInput(e) {
    let raw = String(e.detail.value || '');
    // 数字键盘可能仍能打出小数点。虚拟支付的 buyQuantity 必须是整数，
    // 这里直接截掉小数部分——绝不能把 "12.5" 洗成 "125"，那是 10 倍扣款。
    if (raw.indexOf('.') >= 0) raw = raw.split('.')[0];

    let value = raw.replace(/\D/g, '');
    // 去掉多余的前导 0，但保留单个 "0"
    if (value.length > 1) value = value.replace(/^0+/, '');
    // 最多 4 位（上限 1000 元）
    if (value.length > 4) value = value.slice(0, 4);

    this.setData({
      rechargeAmountInput: value
    }, () => {
      this.processRechargeValue();
    });
  },

  // 处理和校验充值金额，并计算赠送
  processRechargeValue() {
    const valueStr = this.data.rechargeAmountInput;
    let numericValue = parseInt(valueStr, 10);

    if (isNaN(numericValue) || numericValue < 0) {
      numericValue = 0;
    }
    // 超过上限时按上限算，避免用户输 9999 后到支付时才被拒
    if (numericValue > MAX_RECHARGE) {
      numericValue = MAX_RECHARGE;
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

  // 充值主函数（小程序虚拟支付）
  //
  // 为什么不能用 wx.requestPayment：
  //   点数是虚拟商品，微信 2026-04-01 起要求虚拟商品在所有终端都必须走
  //   「小程序虚拟支付」wx.requestVirtualPayment，普通支付卖虚拟商品属于违规，
  //   会被审核驳回直到下架。
  //
  // 流程：
  //   1. wx.login 拿 code（云函数要用它换 session_key 做用户态签名）
  //   2. 云函数 createPointOrder 落单 + 算出 signData/paySig/signature
  //   3. wx.requestVirtualPayment 拉起支付
  //   4. 轮询 queryPointOrder 确认到账（发货回调可能比 success 回调晚）
  async handleRecharge() {
    const openid = this.data.userInfo?.openid;
    if (!this.data.isReady || !openid) {
      this.handleInvalidUser();
      return;
    }

    // 配置没配齐（虚拟支付未开通）时不放行，避免用户点了看到技术性报错
    if (!this.data.payEnabled) {
      wx.showModal({
        title: '自助充值暂未开放',
        content: '请在店内联系店员充值，或稍后再试。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    // 金额校验：虚拟支付按「1 元/份」的道具下单，数量必须是正整数
    const amount = Number(this.data.numericRechargeAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      wx.showToast({ title: '请输入整数金额', icon: 'none' });
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

    // 基础库 2.19.2 起才有 wx.requestVirtualPayment
    if (!this._supportVirtualPay()) {
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信版本不支持小程序内充值，请升级微信后重试。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    this.setData({ isRecharging: true });
    wx.showLoading({ title: '正在发起支付...', mask: true });

    try {
      // 1. 拿登录 code（session_key 会轮换，每次支付前换最新的，避免 -15007）
      const code = await this._wxLogin();

      // 2. 云函数落单 + 签名
      const orderRes = await cloudFcn.createPointOrder(amount, code);
      const order = orderRes && orderRes.result;
      if (!order || !order.success || !order.data) {
        throw new Error((order && order.errMsg) || '创建订单失败，请重试');
      }
      const pay = order.data;

      // 3. mock 环境没有虚拟支付，直接走到账确认
      if (MOCK_ENABLED || pay.mock) {
        wx.hideLoading();
        await this._finishRecharge(pay.outTradeNo, amount);
        return;
      }

      // 4. 拉起虚拟支付
      await this._requestVirtualPayment(pay);

      // 5. 确认到账（回调可能晚几百毫秒到几秒）
      wx.showLoading({ title: '确认到账中...', mask: true });
      const result = await this._pollDelivery(pay.outTradeNo);
      wx.hideLoading();

      if (result.delivered) {
        await this._finishRecharge(pay.outTradeNo, amount, result.data);
      } else if (result.failed) {
        throw new Error((result.data && result.data.errMsg) || '支付未完成');
      } else {
        // 支付已成功但回调还没到，提示稍后查看，避免用户重复付款
        wx.showModal({
          title: '支付成功',
          content: '点数将于稍后到账，请勿重复支付。如 5 分钟后仍未到账，请联系店员。',
          showCancel: false,
          confirmText: '好的',
        });
        this._resetAmount();
      }
    } catch (err) {
      wx.hideLoading();
      console.error('充值流程错误:', err);
      const errMsg = (err && err.errMsg) || '';
      if (errMsg.indexOf('requestVirtualPayment:fail cancel') >= 0 || err.code === -2) {
        wx.showToast({ title: '支付已取消', icon: 'none' });
      } else {
        const text = err.virtualPayText || (err instanceof Error ? err.message : '充值失败，请稍后再试');
        wx.showToast({ title: text, icon: 'none', duration: 2500 });
      }
    } finally {
      this.setData({ isRecharging: false });
    }
  },

  // 到账后的收尾：刷新用户信息 + 清空输入 + 提示
  async _finishRecharge(outTradeNo, amount, delivered) {
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

    const extra = delivered && delivered.extraPoint ? delivered.extraPoint : this.calculateExtraPoint(amount);
    wx.showModal({
      title: '充值成功',
      content: '已到账 ' + amount + ' 点' + (extra > 0 ? '，赠送 ' + extra + ' 点' : '') + '。',
      showCancel: false,
      confirmText: '好的',
    });
    this._resetAmount();
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

  // 基础库是否支持虚拟支付
  _supportVirtualPay() {
    if (typeof wx.canIUse !== 'function') return false;
    return wx.canIUse('requestVirtualPayment');
  },

  // 包一层 Promise 的 wx.login
  _wxLogin() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (res) => {
          if (res.code) resolve(res.code);
          else reject(new Error('登录失败，请重试'));
        },
        fail: (err) => {
          console.error('wx.login 失败:', err);
          // 不要把 "login:fail xxx" 这种原始错误抛给用户看
          reject(new Error('登录失败，请检查网络后重试'));
        },
      });
    });
  },

  // 拉起虚拟支付（非 Promise 接口，手工包装）
  _requestVirtualPayment(pay) {
    return new Promise((resolve, reject) => {
      wx.requestVirtualPayment({
        signData: pay.signData,
        paySig: pay.paySig,
        signature: pay.signature,
        mode: pay.mode || 'short_series_goods',
        success: (res) => resolve(res),
        fail: (err) => {
          const code = err && err.errCode;
          const text = this._virtualPayErrorText(code, err && err.errMsg);
          const e = new Error(text);
          e.code = code;
          e.errMsg = (err && err.errMsg) || '';
          e.virtualPayText = text;
          reject(e);
        },
      });
    });
  },

  // 轮询确认到账：回调通常 1-3 秒内到，给 6 次机会
  async _pollDelivery(outTradeNo, times = 6) {
    for (let i = 0; i < times; i++) {
      try {
        const res = await cloudFcn.queryPointOrder(outTradeNo);
        const r = res && res.result;
        const d = r && r.data;
        if (r && r.success && d) {
          if (d.state === 1) return { delivered: true, data: d };
          if (d.state === 2) return { delivered: false, failed: true, data: d };
        }
      } catch (e) {
        console.warn('查询订单失败（继续重试）:', e);
      }
      await this._sleep(1000);
    }
    return { delivered: false, pending: true };
  },

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  // 虚拟支付错误码 → 人话，方便店员/用户判断问题出在哪
  _virtualPayErrorText(errCode, errMsg) {
    const map = {
      '-1': '支付失败，请稍后重试',
      '-2': '支付已取消',
      '-4': '支付被风控拦截，请稍后重试',
      '-5': '开通签约结果未知',
      '-15001': '支付参数错误，请联系管理员',
      '-15002': '订单号重复，请重新发起',
      '-15004': '币种参数错误',
      '-15005': '用户态签名校验失败，请重试',
      '-15006': '支付签名校验失败，请联系管理员检查 AppKey',
      '-15007': '登录状态已过期，请重试',
      '-15008': '商户进件未完成，请联系管理员',
      '-15009': '代币未发布',
      '-15010': '充值道具未发布，请稍后重试',
      '-15011': '支付环境配置错误（现网版本不能用沙箱）',
      '-15012': '下单失败，请重新发起',
      '-15013': '道具价格与后台不一致，请联系管理员',
      '-15014': '道具刚发布，约 10 分钟后生效，请稍后重试',
      '-15017': '商户收款功能被限制，请联系管理员',
      '-15018': '道具审核未通过，请联系管理员',
      '-15019': '商户受限，请联系管理员',
      '-15020': '操作过快，请稍候再试',
      '-15021': '交易过于频繁，请稍后再试',
    };
    return map[String(errCode)] || errMsg || '支付失败';
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