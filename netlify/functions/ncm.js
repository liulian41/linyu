/* netlify/functions/ncm.js
   网易云代理（Netlify Function）
   路由：/ncm/<接口名> ，例如 /ncm/song_url_v1?id=287398&level=exhigh
   只放行下面白名单里的接口与参数，Cookie 只用于本次请求。
*/
const NCM = require('NeteaseCloudMusicApi');

const ALLOW = {
  login_status: [],
  login_qr_key: [],
  login_qr_create: ['key', 'qrimg'],
  login_qr_check: ['key'],
  user_playlist: ['uid', 'limit', 'offset'],
  playlist_track_all: ['id', 'limit', 'offset'],
  song_url_v1: ['id', 'level'],
  song_url: ['id', 'br'],
  lyric: ['id'],
  like: ['id', 'like']
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const reply = (statusCode, obj) => ({
  statusCode,
  headers: CORS,
  body: typeof obj === 'string' ? obj : JSON.stringify(obj)
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // 改写后 event.path 可能是 /.netlify/functions/ncm/xxx，也可能是原始 /ncm/xxx
  const raw = String(event.headers && (event.headers['x-original-url'] || event.headers['X-Original-Url']) || event.path || '');
  const m = raw.match(/\/ncm\/([A-Za-z0-9_]+)/);
  let fn = m ? m[1] : '';
  if (!fn && /\/health(\?|$)/.test(raw)) fn = 'health';

  if (fn === 'health') return reply(200, { ok: true, service: '传讯 · 网易云代理（Netlify）', now: Date.now() });
  if (!ALLOW[fn]) return reply(404, { ok: false, error: 'unknown endpoint', fn });

  const q = event.queryStringParameters || {};
  const params = {};
  ALLOW[fn].forEach(k => { if (typeof q[k] !== 'undefined') params[k] = q[k]; });
  if (q.cookie && q.cookie.indexOf('MUSIC_U=') > -1) params.cookie = q.cookie;
  params.timestamp = Date.now();

  try {
    const r = await NCM[fn](params);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    if (r.status === 301 || r.status === 302) {
      return reply(200, JSON.stringify({ code: 200, data: r.body }));
    }
    return reply(r.status || 200, body);
  } catch (e) {
    const msg = (e && e.body && (e.body.msg || e.body.message)) || (e && e.message) || '请求网易云失败';
    return reply(502, { ok: false, error: String(msg), fn });
  }
};
