// components/faq-modal/faq-modal.js
Component({
    properties: {
      title: {
        type: String,
        value: '用户须知'
      },
      faqList: {
        type: Array,
        value: [],
        // 使用 observer 预处理换行符
        observer: function(newVal) {
          if (newVal && newVal.length > 0) {
            const formattedList = newVal.map(item => {
              // 将 item.a 中的 &hc&hc 替换为 \n
              const a_formatted = item.a ? item.a.replace(/&hc&hc/g, '\n') : '';
              return {
                ...item,
                a_formatted: a_formatted,
                isOpened: false,
              };
            });
            this.setData({
              _faqList: formattedList
            });
          }
        }
      }
    },
    data: {
      show: false,
      _faqList: [] // 内部使用的、格式化后的列表
    },
    methods: {
      // 显示弹窗
      showModal() {
        this.setData({ show: true });
      },
      // 隐藏弹窗
      hideModal() {
        this.setData({ show: false });
      },
      // 用户点击确认按钮
      onConfirm() {
        this.hideModal(); // 先隐藏
        this.triggerEvent('confirm'); // 触发 confirm 事件，通知父页面用户已确认
      },
      // 遮罩点击事件
      onMaskTap() {
          this.hideModal();
          this.triggerEvent('cancel');
      },
      // 切换 FAQ 项
      toggleFaqItem(e) {
          const index = e.currentTarget.dataset.index;
          const faqList = this.data._faqList;
          faqList[index].isOpened = !faqList[index].isOpened;
          this.setData({ _faqList: faqList });
      }
    }
  })