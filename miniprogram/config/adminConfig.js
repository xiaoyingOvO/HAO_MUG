// /miniprogram/config/adminConfig.js

const adminConfig = {
  // 在店用户+强制离店模块
  'current-users': {
    name: '在店用户管理',
    icon: '/images/icons/users-group.png',
    roles: ['admin', 'master'],
    component:'current-users',
    cloudFunctions: {
      load: { name: 'queueFunctions', type: 'getCurrentInStoreInfo' },
      action: { name: 'queueFunctions', type: 'leaveArcadeForce' }
    },
    defaultOptions: {
      instLoad: 'true' // 是否在进入模块时立刻加载列表
    }
  },

  // 用户信息修改模块
  'user-manage': {
    name: '用户信息管理',
    icon: '/images/icons/user-edit.png',
    roles: ['admin', 'master'],
    component:'user-manage',
    cloudFunctions: {
      search: { name: 'baseFunctions', type: 'getUsrInfoByName ' },
      submit: { name: 'baseFunctions', type: 'modifyUsrInfo' }
    }
  },

  // 消息发送模块
  'send-mail': {
    name: '消息与公告发送',
    icon: '/images/icons/send.png',
    roles: ['master', 'admin'],
    component: 'send-mail',
    cloudFunctions: {
      search: { name: 'baseFunctions', type: 'getUsrInfoByName' },
      submit: { name: 'baseFunctions', type: 'sendMail' }
    }
  },

  // 出入店记录查询模块
  'arcade-query': {
    name: '用户出入店查询',
    icon: '/images/icons/in-out.png',
    roles: ['admin', 'master'],
    component: 'arcade-query',
    cloudFunctions: {
      load: { name: 'queueFunctions', type: 'getArcadeInfo' },
    },
    defaultOptions: {
      instLoad: 'true'
      // openid: 'opIRc7Mo0Ux3mgmplErDHOimMbUM'
    }
  },

  // 充值记录查询模块
  'recharge-query': {
    name: '用户充值查询',
    icon: '/images/icons/wallet.png',
    roles: ['admin', 'master'],
    component: 'recharge-query',
    cloudFunctions: {
      load: { name: 'baseFunctions', type: 'getOrderInfo' }
    },
    defaultOptions: {
      instLoad: 'true'
    }
  },

  // 开门记录查询模块
  'door-query': {
    name: '开门记录',
    icon: '/images/icons/door.png',
    roles: ['admin', 'master'],
    component: 'door-query',
    cloudFunctions: {
      load: { name: 'queueFunctions', type: 'getDoorInfo' }
    },
    defaultOptions: {
      instLoad: 'true'
    }
  },

  // 举报处理模块
  'report-processing': {
    name: '举报信息处理',
    icon: '/images/icons/flag.png',
    roles: ['admin', 'master'],
    component: 'report-processing',
    cloudFunctions: {
      load: { name: 'queueFunctions', type: 'getReport' },
      process: { name: 'baseFunctions', type: 'sendMail' }
    },
    defaultOptions: {
      instLoad: 'true'
    }
  },
};

function getAvailableModules(userRole) {
  if (!userRole) return [];
  return Object.entries(adminConfig)
    .filter(([key, config]) => config.roles.includes(userRole))
    .map(([key, config]) => ({ key, ...config}));
}

module.exports = {
  adminConfig,
  getAvailableModules
};