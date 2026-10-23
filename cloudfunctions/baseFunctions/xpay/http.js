/**
 * 云函数侧对微信开放接口的最小 HTTP 封装。
 *
 * 为什么必须自己发 HTTP：
 *   - auth.code2Session 官方明确「不支持云调用」，cloud.getWXContext() 也不返回 session_key。
 *     所以只能拿 AppSecret 自己换。
 *   - 虚拟支付的查单接口 /xpay/query_order 同样需要 access_token。
 *
 * access_token 用 stable_token 接口获取，并按实例缓存（提前 5 分钟过期），
 * 避免每次调用都刷 token 触发频率限制。
 */

const https = require('https');

const HOST = 'api.weixin.qq.com';

// 云函数实例内缓存（实例复用期间有效）
let tokenCache = {
  token: '',
  expireAt: 0,
};

function requestJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const options = {
      hostname: HOST,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    };
    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('微信接口返回非 JSON（' + path + '）：' + raw.slice(0, 200)));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('请求微信接口超时（' + path + '）'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 用 wx.login 的 code 换 session_key。
 * 每次拉起支付前都换一次，因为 session_key 会轮换，用旧的会报 -15007。
 */
async function code2Session(appId, appSecret, code) {
  if (!appId || !appSecret) {
    throw new Error('缺少 AppID 或 AppSecret，无法换取 session_key');
  }
  if (!code) {
    throw new Error('缺少登录凭证 code');
  }
  const path = '/sns/jscode2session?appid=' + encodeURIComponent(appId)
    + '&secret=' + encodeURIComponent(appSecret)
    + '&js_code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code';
  const res = await requestJson('GET', path);
  if (!res.session_key) {
    throw new Error('换取 session_key 失败：' + (res.errmsg || JSON.stringify(res)));
  }
  return res.session_key;
}

/**
 * 获取 access_token（stable_token 版本，支持多实例并发）
 */
async function getAccessToken(appId, appSecret, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && tokenCache.token && tokenCache.expireAt > now) {
    return tokenCache.token;
  }
  const res = await requestJson('POST', '/cgi-bin/stable_token', {
    grant_type: 'client_credential',
    appid: appId,
    secret: appSecret,
    force_refresh: !!forceRefresh,
  });
  if (!res.access_token) {
    throw new Error('获取 access_token 失败：' + (res.errmsg || JSON.stringify(res)));
  }
  const expiresIn = Number(res.expires_in) || 7200;
  tokenCache = {
    token: res.access_token,
    // 提前 5 分钟过期，避免边界上拿到失效 token
    expireAt: now + Math.max(60, expiresIn - 300) * 1000,
  };
  return tokenCache.token;
}

module.exports = {
  requestJson,
  code2Session,
  getAccessToken,
};
