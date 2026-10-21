const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const db_meta = 'meta'

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid
  console.log('openid: ' + openid)

  let record = await db.collection(db_meta)
  .where({
    key: "notice",
  })
  .get({
    success: function (res) {
      console.log('success!!!')
      return res
    },
    fail: console.error
  })
  console.log(record)

  return {
    success: true,
    data: record.data[0].value,
  }
}