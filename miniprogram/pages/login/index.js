// pages/login/login.js
import cloudFcn from '../../cloudFcn.js'
import { compressImage } from '../../utils/image.js'
const app = getApp();

Page({
    data: {
      nickName: '',         // 用户昵称
      avatarUuid: '',       // 头像云存储UUID
      avatarCloudPath: '',  // 头像云存储路径
      avatarFileID: '',     // 头像云存储ID
      phone: '',            // 手机号
      qq: '',               // QQ号码
      formValid: false,     // 表单是否有效
      loading: false,       // 加载状态
      openid: '',           // 用户openid
      logoUrl: 'https://6861-hao-2gz8w8z212e63bcf-1347707526.tcb.qcloud.la/logo.jpg?sign=2baa5654c2321358d942c933c47047bb&t=1746890775',    // LOGO地址
      appName: '萌动',
      appSubtitle: '欢迎来到萌动的世界',
      // 动画相关
      cardAnimation: {},    // 卡片动画
      buttonAnimation: {},  // 按钮动画
      waveAnimation: {},     // 水波动画
      // isSubmitting: false,    // 提交状态标识
      faqList: [],            // FAQ 数据
      isFaqRead: false,       // FAQ 是否已读
      modalVisible: false,    // 控制页面滚动状态
      pageStyle: '',
      //logoTitleAnimation,   // 标题动画
    },
  
    onLoad() {
      this.initializePage();
    },

    async initializePage() {
      try {
        const userInfo = await app.ensureLoggedIn();

        if (userInfo && !userInfo.isNewUser) {
          // --- 用户已登录 ---
          wx.showToast({
            title: '您已登录',
            icon: 'success',
            duration: 1500,
            mask: true,
          });
          setTimeout(() => {
            wx.reLaunch({
              url: '/pages/home/home',
            });
          }, 1500);
          return;  // 提前返回，终止后续所有操作**
        }
        
        // --- 用户未登录 ---
        this.initAnimations();
        this.loadFaqData();
        
        if (userInfo && userInfo.isNewUser) {
          this.setData({ openid: userInfo.openid });
        } else {
          console.warn('[Login Page] 未能从 app.js 获取到 openid');
        }
  
      } catch (err) {
        // ---  登录检查失败 (网络等) ---
        console.error('[Login Page] ensureLoggedIn 失败:', err);
        wx.showModal({
          title: '错误',
          content: '无法获取用户标识，请检查网络后重试。',
          showCancel: false,
          confirmText: '重试',
          success: () => {
            app.globalData.loginPromise = null;
            this.initializePage(); // 重新执行初始化流程
          }
        });
      }
    },
  
    // 初始化动画效果
    initAnimations() {
      const card = wx.createAnimation({
        duration: 800,
        timingFunction: 'ease'
      });
      card.opacity(1).translateY(0).step();
      
      const button = wx.createAnimation({
        duration: 600,
        delay: 300,
        timingFunction: 'ease'
      });
      button.scale(1).opacity(1).step();   
      this.setData({
        cardAnimation: card.export(),
        buttonAnimation: button.export(),
      });
    },

    // 加载 FAQ 数据
    async loadFaqData() {
        try {
            const res = await cloudFcn.getNotice();
            if (res.result && res.result.success && Array.isArray(res.result.data.faq)) {
                this.setData({
                    faqList: res.result.data.faq
                });
            } else {
                 console.error("FAQ 加载失败");
            }
        } catch(err) {
            console.error("FAQ 加载出错:", err);
        }
    },

    // 直接进入
    enterAsGuest() {
        wx.reLaunch({
          url: '/pages/home/home',
        })
    },

    // 获取用户信息
    async getUserInfoFromCloud() {
        const res = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: { "type": 'getUsrInfo' }
        });
        return res.result;
    },
  
    // 选择头像
    async onChooseAvatar(e) {
      // 获取头像临时路径
      const avatarUrl = e && e.detail && e.detail.avatarUrl;
      if (!avatarUrl) return;

      wx.showLoading({ title: '处理中', mask: true });

      // 先压缩再上传：头像在这个页面只显示 120rpx 左右，原图直传白耗
      // 云存储和 CDN 流量（流量按每次加载计费，才是真正的成本大头）
      const ready = await compressImage(avatarUrl, { maxEdge: 512 });
      if (ready.changed) {
        console.log('[avatar] 压缩 ' + Math.round(ready.sizeFrom / 1024) +
          'KB → ' + Math.round(ready.sizeTo / 1024) + 'KB');
      }

      // 用正则取后缀。原来是 avatarUrl.substring(lastIndexOf('.'))：
      // 路径没有扩展名时 lastIndexOf 返回 -1，而 substring(-1) 等价于
      // substring(0)，会把**整条路径**拼进 cloudPath。
      const suffix = (String(ready.path).match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
      // 生成头像云存储路径
      const avatarUuid = this.genUuid();
      const avatarCloudPath = `avatar/${avatarUuid}${suffix}`;
      // 上传云存储
      wx.cloud.uploadFile({
        cloudPath: avatarCloudPath,
        filePath: ready.path,
      }).then(res => {
        // 获取资源ID
        const avatarFileID = res.fileID;
        // 本地保存参数
        this.setData({
          avatarCloudPath: avatarCloudPath,
          avatarFileID: avatarFileID
        }, () => {
            this.validateForm();
        });
        wx.hideLoading();
      }).catch(error => {
        // 报错
        wx.hideLoading();
        wx.showToast({
          title: (error && error.errMsg) || '头像上传失败',
          icon: 'none',
          duration: 3000
        });
      });
    },

    onNicknameinput(e) {
      this.setData({
        nickName: e.detail.value
      });
      this.validateForm();
    },
  
    // 获取手机号
    async getPhoneNumber(e) {
        wx.showLoading({
          title: '验证中',
          mask: 'true',
        });
        try {
            const res = await wx.cloud.callFunction({
                name: 'baseFunctions',
                data: {
                    type: 'decryptPhone',
                    params: {
                      code: e.detail.code
                    }
                }
            });
            wx.hideLoading();
            if (res.result?.success) {
              this.setData({ phone: res.result.data.phone }, () => this.validateForm());
            } else {
              throw new Error(res.result?.errMsg || '手机号解析失败');
            }
        } catch (err) {
          wx.hideLoading();
            this.handleError(err);
        }
      },

    // QQ输入处理
    onQQInput(e) {
      const qq = e.detail.value.trim();
      this.setData({ qq });
      this.validateQQ(qq);
      this.validateForm();
    },
  
    // QQ号校验
    validateQQ(qq) {
      const reg = /^[1-9][0-9]{4,11}$/;
      const isValid = reg.test(qq);
      this.setData({ qqError: isValid ? '' : 'QQ号格式不正确' });
      return isValid;
    },
  
    // 表单验证
    validateForm() {
      const valid = !!this.data.phone && 
                   !!this.data.qq && 
                   this.validateQQ(this.data.qq) &&
                   !!this.data.avatarFileID &&
                   !!this.data.nickName;
      this.setData({ formValid: valid });
      return valid;
    },
  
    // 播放水波动画
    playWaveAnimation() {
      const wave = wx.createAnimation({
        duration: 600,
        timingFunction: 'linear'
      });
      wave.opacity(1).scale(10).step({ duration: 300 });
      wave.opacity(0).scale(15).step({ duration: 300 });
      
      this.setData({ waveAnimation: wave.export() });
    },

    // 提交表单
    async submit() {    
        if (this.data.loading) return;
    
        if (!this.validateForm()) {
            wx.showToast({
                title: '请完善信息',
                icon: 'error'
            });
            return;
        }
    
        if (!this.data.isFaqRead) {
            this.setData({ 
                modalVisible: true,
                pageStyle: 'overflow: hidden; heigh: 100%;' 
            });
            this.selectComponent('#faqModal').showModal();
            return;
        }
        this.setData({
            loading: true,
        });
        this.playWaveAnimation();
        wx.showLoading({
          title: '注册中',
          mask: true,
        });
        try {
          this.registerUser();
        } catch (err) {
          console.error('[Login Page] 注册流程出错：', err);
          wx.hideLoading();
          this.setData({ loading: false });
          this.handleError(err);
        }
    },

    // FAQ 确认回调
    onFaqConfirm() {
        this.setData({
            isFaqRead: true,
            modalVisible: false
        });
        this.submit();
    },
    onFaqCancel() {
        this.setData({ modalVisible: false });
    },

    // 注册
    async registerUser() {
        const { phone, qq, nickName, avatarFileID } = this.data;
        const currentOpenid = this.data.openid;
        if (!currentOpenid) {
          throw new Error('用户标识获取失败');
        }
        try {
          const res = await wx.cloud.callFunction({
            name: 'baseFunctions',
            data: {
                "type": 'addUsrInfo',
                "params": {
                    "openid": currentOpenid, 
                    "phone": phone,
                    "qq_id": qq,
                    "nickname": nickName,
                    "avatar": avatarFileID
                }
            }
          });        
        if (res.result && res.result.success) {
          wx.hideLoading();
          wx.showToast({
            title: '注册成功',
            icon: 'success',
            duration: 1500
          });
          app.globalData.loginPromise = null;
          // 不再自己缓存用户信息，而是调用全局管理函数重新获取用户信息并更新全局状态
          await app.silentLogin();
          setTimeout(() => {
            wx.reLaunch({
              url: '/pages/home/home',
            });
          }, 1500);
            // 本地缓存用户信息
            // wx.setStorageSync('userInfo', this.data);
            // console.log("本地缓存成功");
            // wx.showToast({
            //   title: '注册成功',
            //   incon: 'success',
            //   duration: 1500,
            //   success: () => {
            //       setTimeout(() => {
            //           wx.reLaunch({
            //             url: '/pages/home/home',
            //           });
            //       }, 500);
            //   }
            // });
          } else {
            throw new Error(res.result.errMsg || '注册失败');
          }
        } catch (err) {
          wx.hideLoading();
          this.setData({ loading: false });
          this.handleError(err);
        }
    },

  // 统一错误处理函数
  handleError(error) {
    const errMsg = error.message || error.errMsg || '请求失败';
    const mapping = {
        '手机号已注册': 'phoneError',
        'qq号已注册': 'qqError'
    };

    Object.entries(mapping).forEach(([key, field]) => {
        if (errMsg.includes(key)) {
            this.setData({ [field]: key });
        }
    });

    const userFriendlyMsg = {
        '手机号已注册': '该手机号已绑定其他账号',
        'qq号已注册': 'QQ号已被使用',
        'default': '注册失败，请稍后再试'
    };

    wx.showToast({
      title: userFriendlyMsg[error.errMsg] || userFriendlyMsg.default,
      icon: 'none',
      duration: 3000
    });
  },
  
    // 页面卸载时清理动画
    onUnload() {
      this.setData({
        cardAnimation: {},
        buttonAnimation: {},
        waveAnimation: {}
      });
    },

    genUuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0,
              v = c == 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
      });
  }
  });

 