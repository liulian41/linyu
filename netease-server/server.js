// 网易云账号代理服务：只做一层薄封装，把前端需要的接口暴露成 HTTP。
// 启动：npm install && npm start   默认 http://localhost:3000
const express = require('express');
const NCM = require('NeteaseCloudMusicApi');

const PORT = Number(process.env.PORT || 3000);
// 只放行与「登录 / 歌单 / VIP」相关的接口，避免被当成通用代理
const ALLOWED = new Set([
  'login_qr_key',
  'login_qr_create',
  'login_qr_check',
  'login_status',
  'user_detail',
  'user_playlist',
  'playlist_detail',
  'playlist_track_all',
  'vip_info'
]);
// 透传参数白名单，其余参数丢弃，防止调用方篡改内部签名参数
const PARAM_KEYS = ['cookie', 'uid', 'id', 'key', 'qrimg', 'type', 'limit', 'offset', 'timestamp', 'noCookie'];

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'cx-netease', time: Date.now() });
});

app.all('/ncm/:fn', async (req, res) => {
  const fn = req.params.fn;
  if (!ALLOWED.has(fn)) {
    return res.status(404).json({ code: 404, msg: 'endpoint not allowed' });
  }
  const src = Object.assign({}, req.query, req.body || {});
  const params = {};
  PARAM_KEYS.forEach(k => {
    if (src[k] !== undefined && src[k] !== '') params[k] = src[k];
  });
  if (params.timestamp === undefined) params.timestamp = Date.now();
  // 本机/服务器需要走代理时，由服务端配置，不接受前端传入
  const proxy = process.env.NCM_PROXY || process.env.HTTPS_PROXY;
  if (proxy) params.proxy = proxy;

  try {
    const result = await NCM[fn](params);
    res.status(result.status || 200).json(result.body);
  } catch (e) {
    res.status(502).json({ code: 502, msg: String((e && e.message) || e) });
  }
});

app.listen(PORT, () => {
  console.log('传讯 · 网易云代理已启动：http://localhost:' + PORT);
});
