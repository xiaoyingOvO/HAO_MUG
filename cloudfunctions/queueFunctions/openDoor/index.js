const cloud = require('wx-server-sdk');
const CryptoJS = require("crypto-js");
const rp = require("request-promise");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const door_remote_url = "http://openapi.andudu.net/door-yard/remote-cmd";
const yard_sn = "7298146819056336896";
const door_guid = "65ad000020105820";
const cmd_type = "open";
const key = "f0234ec135e3a77d0af4661c5c3ad6c6";

const db = cloud.database();
const db_door_log = "door_log";

exports.main = async (event, context) => {
  // 获取openid
  const wxContext = cloud.getWXContext();
  var openid = wxContext != null && 'OPENID' in wxContext ? 
    wxContext.OPENID : event.params.openid;
  if ('params' in event && 'openid' in event.params){
    openid = event.params.openid
  }
  console.log('openid: ' + openid);

  // 获取当前时间戳
  const now = new Date();
  const timestamp = now.getTime().toString();

  // 拼接用于加密的字段
  let params = {
      "yard_sn": yard_sn,
      "door_guid": door_guid,
      "cmd_type": cmd_type,
      "timestamp": timestamp
  };
  params = Object.fromEntries(
      Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]))
  );
  console.log(params);

  // 加密字段化为http请求参数格式
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
      searchParams.append(key, value);
  }
  console.log(searchParams.toString());

  const queryString = `${searchParams.toString()}&key=${key}`;
  console.log(queryString); 
  const sign = CryptoJS.MD5(queryString).toString();
  // const sign = crypto.createHash('md5').update(queryString, 'utf8').digest('hex');

  let res = "";
  await rp({
    uri: door_remote_url,
    method: 'POST',
    body: {
      yard_sn: yard_sn,
      door_guid: door_guid,
      cmd_type: cmd_type,
      timestamp: timestamp,
      sign: sign,
    },
    json: true
  })
  .then(tmp_res => {
    res = tmp_res;
    console.log(tmp_res);
  })
  .catch(error => {
    console.log(error);
  });

  if (res.code != 200) {
    return {
      success: false
    }
  }

  // 记录开门
  await db.collection(db_door_log)
    .add({
      data: {
        openid: openid,
        time: now,
      }
    })
    .then(res => {
      console.log(res);
    })
    .catch(console.error);

  return {
    success: true
  }
}