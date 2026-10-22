// pages/user-center/other-page/membership.js
Page({
    data: {
      levelRules: [
        { level: 1, expNeeded: 2000, perks: '无特殊加成' },
        { level: 2, expNeeded: 8000, perks: '购买点数额外赠送+5%' },
        { level: 3, expNeeded: 18000, perks: '购买点数额外赠送+10%' },
        { level: 4, expNeeded: 30000, perks: '购买点数额外赠送+20%' },
        { level: 5, expNeeded: 114514, perks: '购买点数额外赠送+30%' },
        { level: 6, expNeeded: 'MAX', perks: '扣除点数100%返还' }
      ],
      creditRules: [
        { grade: 'S', scoreRange: '85-100', effects: '一切正常，享受所有服务。' },
        { grade: 'A', scoreRange: '70-84', effects: '计时扣费上升20%，失去夜场预约资格。' },
        { grade: 'B', scoreRange: '60-69', effects: '计时扣费上升50%，失去夜场预约资格。' },
        { grade: 'C', scoreRange: '<60', effects: '无法入店，请联系管理员提升信用。' },
      ]
    },
  
  })