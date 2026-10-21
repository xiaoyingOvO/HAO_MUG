const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const db_cmd = db.command;
const db_user = 'user';

// 删除优惠卡云函数入口函数
exports.main = async (event, context) => {
  // 获取基本信息
  const wxContext = cloud.getWXContext();
  const src_openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  const dst_openid = event.params.dst_openid;
  const transfer_point = event.params.transfer_point;
  console.log('src_openid: ' + src_openid +
    '; dst_openid: ' + dst_openid + 
    '; transfer_point: ' + transfer_point);

  // 查询原用户真实点数
  let user_record = await db.collection(db_user)
  .where({
    openid: src_openid
  })
  .field({
    real_point: true
  })
  .get({
    success: function (res) {
      console.log('success!!!');
      return res;
    },
    fail: console.error
  });

  const src_point = user_record.data[0].real_point;
  if (src_point < transfer_point) {
    return {
      success: false,
      errMsg: "用户可转移点数不足！"
    }
  }

  // 扣原用户点数
  let updated = 0;
  await db.collection(db_user)
  .where({
    openid: src_openid
  })
  .update({
    data: {
      real_point: db_cmd.inc(-transfer_point)
    }
  })
  .then(res => {
    updated = res.stats.updated;
    console.log('success!!!');
  });

  if (updated == 0) {
    return {
      success: false,
      errMsg: "点数转移失败，请重试"
    }
  }

  // 增加目标用户点数 
  updated = 0;
  await db.collection(db_user)
  .where({
    openid: dst_openid
  })
  .update({
    data: {
      real_point: db_cmd.inc(transfer_point)
    }
  })
  .then(res => {
    updated = res.stats.updated;
    console.log('success!!!');
  });

  if (updated == 0) {
    // 回滚扣款
    await db.collection(db_user)
    .where({
      openid: src_openid
    })
    .update({
      data: {
        real_point: db_cmd.inc(transfer_point)
      }
    })
    .then(res => {
      updated = res.stats.updated;
      console.log('success!!!');
    });

    return {
      success: false,
      errMsg: "目标用户不存在或点数转移失败，请重试"
    }
  }

  return {
    success: true,
    data: {
      real_point: src_point - transfer_point,
      transfer_point: transfer_point
    }
  };
}
