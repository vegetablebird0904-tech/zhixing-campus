'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { extension } = require('./extensions');
const { integrations } = require('./integrations');
const { openAuth, loopback, failure } = require('./auth');
const os = require('node:os');
const { handlePdf } = require('./pdf');
const { openPreferences } = require('./preferences');
const { educationImport } = require('./education-import');

const TYPES = ['道路拥堵', '施工', '临时封路', '交通事故', '积水'];
const STATUS = { pending: '未处理', processing: '处理中', resolved: '已处理' };
const BODY_LIMIT = 64 * 1024;
class ApiError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const invalid = message => { throw new ApiError(400, 'VALIDATION_ERROR', message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, name, max, required = true) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) invalid(`${name}须为 1–${max} 字文本`);
  return value.trim();
}
function keys(value, allowed) {
  if (!object(value)) invalid('请求体须为 JSON 对象');
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('包含不支持的字段');
}
function coordinate(value, name, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) invalid(`${name}超出范围`);
  return value;
}
function createEvent(input) {
  keys(input, ['type', 'location', 'description', 'reporter', 'reporterId', 'campus', 'photos', 'latitude', 'longitude', 'clientRequestId', 'edgeId']);
  if (!TYPES.includes(input.type)) invalid('请选择有效的事件类型');
  if (input.campus !== undefined && !['东校区', '西校区'].includes(input.campus)) invalid('校区须为东校区或西校区');
  const photos = input.photos ?? [];
  if (!Array.isArray(photos) || photos.length > 3 || photos.some(url => {
    if (typeof url !== 'string' || url.length > 2048) return true;
    try { const parsed = new URL(url); return !['http:', 'https:', 'wxfile:'].includes(parsed.protocol) || !parsed.hostname; } catch { return true; }
  })) invalid('照片最多 3 张，须为有效的 http(s) 或 wxfile 地址');
  const coords = {};
  if (input.latitude !== undefined || input.longitude !== undefined) {
    coords.latitude = coordinate(input.latitude, '纬度', 90);
    coords.longitude = coordinate(input.longitude, '经度', 180);
  }
  let edgeId='';if(input.edgeId!==undefined&&input.edgeId!==''){if(typeof input.edgeId!=='string'||!require('../data/campus').west.edges.some(e=>e.id===input.edgeId))invalid('事件关联路段不存在');edgeId=input.edgeId;}
  if(!edgeId&&typeof coords.latitude==='number'&&(!input.campus||input.campus==='西校区')){const near=require('../utils/incidents').nearestEdge(require('../data/campus').west,coords);if(near.distance<=90)edgeId=near.edge.id;}
  const now = new Date().toISOString();
  return { edgeId, id: randomUUID(), type: input.type, location: string(input.location, '位置', 120),
    description: string(input.description, '描述', 50), reporter: string(input.reporter, '上报用户', 40, false) || '校园用户',
    reporterId: string(input.reporterId, '用户编号', 80, false), clientRequestId: string(input.clientRequestId, '请求编号', 100, false), campus: input.campus || '东校区', photos, ...coords,
    status: 'pending', statusLabel: STATUS.pending, progress: '已收到上报，等待处理', createdAt: now, updatedAt: now,
    history: [{ status: 'pending', statusLabel: STATUS.pending, progress: '已收到上报，等待处理', at: now }] };
}
function patchEvent(event, input) {
  keys(input, ['status', 'progress']);
  if (!Object.keys(input).length) invalid('请提供状态或处理进展');
  if (input.status !== undefined && !Object.hasOwn(STATUS, input.status)) invalid('无效的处理状态');
  const status = input.status ?? event.status;
  const progress = input.progress === undefined ? (status === event.status ? event.progress : STATUS[status]) : string(input.progress, '处理进展', 200);
  const at = new Date().toISOString();
  return { ...event, status, statusLabel: STATUS[status], progress, updatedAt: at,
    history: [...event.history, { status, statusLabel: STATUS[status], progress, at }] };
}

async function openStore(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let state;
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!object(state) || !Array.isArray(state.events) || !state.events.every(e => object(e) && typeof e.id === 'string' && Object.hasOwn(STATUS, e.status) && Array.isArray(e.history))) throw new Error('invalid event store');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取事件存储，原文件已保留: ${error.message}`);
    state = { events: [], updatedAt: null };
  }
  let queue = Promise.resolve();
  return {
    read: () => state,
    write(transform) {
      const operation = queue.then(async () => {
        const next = transform(state);
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' }); await fs.rename(temporary, file); }
        finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        state = next;
        return state;
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json');
  const body = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort); };
    const onError = error => { cleanup(); reject(error); };
    const onAbort = () => onError(new ApiError(400, 'REQUEST_ABORTED', '请求已中断'));
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onData = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        cleanup(); req.resume();
        reject(new ApiError(413, 'BODY_TOO_LARGE', '请求体不能超过 64 KiB'));
      } else chunks.push(chunk);
    };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
  try { return JSON.parse(body); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'JSON 格式无效'); }
}
function traffic(campus, horizon, campusData) {
  const west = campus === 'west';
  const start = new Date(); start.setMinutes(Math.floor(start.getMinutes() / 15) * 15, 0, 0);
  const series = Array.from({ length: 13 }, (_, i) => {
    const actual = Math.round(33 + 34 * Math.sin(i / 12 * Math.PI) + Math.cos(i * 1.3) * 5 + (west ? -6 : 0));
    return { time: new Date(start.getTime() + (i - 12) * 15 * 60000).toISOString(), actual,
      predicted: Math.round(actual + Math.sin(i * 1.7 + horizon) * (horizon / 5 + 2)) };
  });
  const errors = series.map(p => p.predicted - p.actual);
  const round = n => Math.round(n * 100) / 100;
  const metrics = { mae: round(errors.reduce((s, e) => s + Math.abs(e), 0) / series.length),
    rmse: round(Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / series.length)),
    mape: round(series.filter(p => p.actual !== 0).reduce((s, p) => s + Math.abs((p.predicted - p.actual) / p.actual), 0) / series.filter(p => p.actual !== 0).length * 100),
    label: '合成演示误差 · 非真实模型评估' };
  const candidates = campusData?.campuses?.[campus]?.roads ?? campusData?.[campus]?.roads ?? campusData?.[campus]?.edges ?? campusData?.roads;
  const names = Array.isArray(candidates) ? candidates.map(r => typeof r === 'string' ? r : r.name).filter(n => typeof n === 'string') : [];
  const roads = (names.length ? [...new Set(names)].slice(0, 5) : ['图书馆东路', '教学楼南路', '食堂连接道', '体育场北路', '校园主干道']).map((name, i) => {
    const index = [76, 62, 41, 28, 18][i] - (west ? 7 : 0);
    return { id: `${campus}-${i}`, name, index, status: index >= 70 ? '堵塞' : index >= 40 ? '缓行' : '畅行', risk: index >= 60 ? '高' : '低' };
  });
  return { synthetic: true, source: 'synthetic', label: '合成演示数据 · 非实时交通监测', campus, horizon, generatedAt: new Date().toISOString(), series, metrics, roads,
    summary: { congestionIndex: Math.round(roads.reduce((s, r) => s + r.index, 0) / roads.length), congestedRoads: roads.filter(r => r.index >= 70).length, highRiskRoads: roads.filter(r => r.risk === '高').length } };
}
function weatherService(fetcher, timeoutMs) {
  const cache = new Map(); const pending = new Map();
  return async (latitude, longitude) => {
    const key = `${latitude},${longitude}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 600000) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const controller = new AbortController(); let timer;
      try {
        const upstream = (async () => {
          const response = await fetcher(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m,is_day&timezone=Asia%2FShanghai`, { signal: controller.signal });
          if (!response.ok) throw new Error('upstream');
          const data = await response.json(); const current = data.current;
          if (!current || !Number.isFinite(current.temperature_2m) || !Number.isFinite(current.weather_code) || typeof current.time !== 'string') throw new Error('invalid upstream');
          return { available: true, source: 'Open-Meteo', latitude, longitude, observedAt: `${current.time}+08:00`, fetchedAt: new Date().toISOString(), temperature: current.temperature_2m,
            weatherCode: current.weather_code, windSpeed: Number.isFinite(current.wind_speed_10m) ? current.wind_speed_10m : null, isDay: current.is_day === 1,
            units: { temperature: '°C', windSpeed: 'km/h' } };
        })();
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
        const value = await Promise.race([upstream, timeout]);
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { at: Date.now(), value }); return value;
      } catch { return { available: false, source: 'Open-Meteo', message: '天气服务暂不可用，请稍后重试', fetchedAt: new Date().toISOString() }; }
      finally { clearTimeout(timer); }
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
async function staticFile(res, root, name, jsonOnly = false) {
  if (!/^[a-zA-Z0-9_\-\u3400-\u9fff.]+$/.test(name) || name.startsWith('.') || (jsonOnly && path.extname(name) !== '.json')) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
  let realRoot, file, data;
  try {
    realRoot = await fs.realpath(root); file = await fs.realpath(path.join(realRoot, name));
    if (path.dirname(file) !== realRoot) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
    data = await fs.readFile(file);
    if (jsonOnly) JSON.parse(data.toString('utf8'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
    throw error;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
}
async function createServer(options = {}) {
  const store = await openStore(options.storeFile || process.env.CAMPUS_STORE || path.join(__dirname, 'storage', 'events.json'));
  const preferences = await openPreferences(options.preferencesFile || process.env.CAMPUS_PREFERENCES || path.join(__dirname, 'storage', 'preferences.json'));
  const auth = await openAuth(options);
  const education = educationImport({...options, auth, getLocalBase: () => 'http://127.0.0.1:' + server.address().port});
  const handleExtension = extension({...options, auth});
  const handleIntegrations = integrations({...options, auth, getListenHost: () => server.address()?.address});
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  let campusData;
  try { campusData = require(path.join(dataDir, 'campus.js')); } catch { /* Optional shared campus data. */ }
  const weather = weatherService(options.fetcher || globalThis.fetch, options.weatherTimeoutMs ?? 4000);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const origin = req.headers.origin;
    let localOrigin = origin === 'null';
    try { const parsed = new URL(origin); localOrigin ||= ['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.origin === origin; } catch {}
    const declaredOrigin = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '';
    const ownOrigin = 'http://' + req.headers.host;
    const ownSecureOrigin = 'https://' + req.headers.host;
    const allowedOrigins = new Set([...(options.allowedOrigins || []), ...String(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean), declaredOrigin]);
    if (auth.enabled) localOrigin = origin === ownOrigin || origin === ownSecureOrigin || allowedOrigins.has(origin);
    if (origin && localOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Campus-CSRF');
    }
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (origin && !localOrigin) throw new ApiError(403, 'ORIGIN_DENIED', '请求来源不在允许列表');
      if (auth.enabled) {
        const allowAnyHost = options.allowAnyHost === true || process.env.CAMPUS_ALLOW_PUBLIC_HOST === '1' || Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.ZEABUR);
        const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(options.allowedHosts || []), ...String(process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)]);
        Object.values(os.networkInterfaces()).flat().filter(Boolean).forEach(n => hosts.add(n.address));
        if (declaredOrigin) hosts.add(new URL(declaredOrigin).hostname);
        const hostname = new URL('http://' + req.headers.host).hostname;
        const isPublicTunnelHost = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io|onrender\.com|up\.railway\.app|zeabur\.app|cpolar\.top|natappfree\.cc)$/i.test(hostname);
        if (!allowAnyHost && !isPublicTunnelHost && !hosts.has(hostname)) throw failure(403, '服务Host不在允许列表');
        const production = options.production === true || process.env.NODE_ENV === 'production';
        const forwardedHttps = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        if (production && !req.socket.encrypted && !((options.trustProxy || process.env.TRUST_PROXY === '1') && forwardedHttps) && !req.url.startsWith('/api/health')) throw failure(426, '生产服务必须通过HTTPS访问');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { invalid('URL 编码无效'); }
      if (await auth.handle(req, res, url, send)) return;
      if (await education.handle(req, res, url, send)) return;
      auth.guard(req, {pathname});
      if (await handlePdf(req, res, url, send)) return;
      if (await handleExtension(req, res, pathname, send)) return;
      if (await handleIntegrations(req, res, url, send)) return;
      if (pathname === '/api/incidents') {
        if(req.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','请使用GET');
        const events=store.read().events.filter(e=>['西校区','west'].includes(e.campus)).map(e=>({id:e.id,remoteId:e.id,campus:'west',type:e.type,status:e.status==='resolved'?'processed':e.status,description:e.description,location:{name:e.location,latitude:e.latitude,longitude:e.longitude},edgeId:e.edgeId||'',createdAt:e.createdAt,updatedAt:e.updatedAt}));
        return send(200,{events,updatedAt:store.read().updatedAt});
      }
      if (pathname === '/api/events') {
        if (req.method === 'GET') {
          const status = url.searchParams.get('status');
          if (status && ![...Object.keys(STATUS), 'all', 'processed', 'unprocessed'].includes(status)) invalid('无效的事件状态筛选');
          const reporterId = url.searchParams.get('reporterId');
          const state = store.read();
          const events = state.events.filter(e => (!auth.enabled || req.user.role === 'admin' || e.ownerId === req.user.id) && (!status || status === 'all' || e.status === status || (status === 'processed' && e.status === 'resolved') || (status === 'unprocessed' && e.status !== 'resolved')) && (reporterId === null || e.reporterId === reporterId)).slice().reverse();
          return send(200, { events: auth.enabled ? events.map(e => handleExtension.serializeEvent(e, req)) : events, total: events.length, updatedAt: state.updatedAt });
        }
        if (req.method === 'POST') {
          const input = await readBody(req);
          if (auth.enabled) { input.reporterId = req.user.id; input.reporter = req.user.name; }
          let event = createEvent(input);
          if (auth.enabled) { event.ownerId = req.user.id; event.photos = await handleExtension.validatePhotos(event.photos, req); }
          await store.write(state => { const prior = event.clientRequestId && state.events.find(e => e.clientRequestId === event.clientRequestId && e.reporterId === event.reporterId); if (prior) { event = prior; return state; } return { events: [...state.events, event], updatedAt: event.updatedAt }; });
          return send(201, { event: auth.enabled ? handleExtension.serializeEvent(event, req) : event });
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该资源支持 GET 或 POST');
      }
      const match = pathname.match(/^\/api\/events\/([^/]+)$/);
      if (match) {
        if (req.method !== 'PATCH') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该资源支持 PATCH');
        const input = await readBody(req); let result;
        await store.write(state => {
          const event = state.events.find(e => e.id === match[1]);
          if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', '事件不存在');
          result = patchEvent(event, input);
          return { events: state.events.map(e => e.id === event.id ? result : e), updatedAt: result.updatedAt };
        });
        return send(200, { event: auth.enabled ? handleExtension.serializeEvent(result, req) : result });
      }
      if (pathname === '/api/traffic') {
        if (req.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该资源支持 GET');
        const campus = ({ 东校区: 'east', 西校区: 'west' })[url.searchParams.get('campus')] || url.searchParams.get('campus') || 'east';
        const horizon = Number(url.searchParams.get('horizon') ?? '15');
        if (!['east', 'west'].includes(campus) || ![5, 15, 30].includes(horizon)) invalid('校区或预测时长无效');
        return send(200, traffic(campus, horizon, campusData));
      }
      if (pathname === '/api/weather') {
        if (req.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该资源支持 GET');
        const lat = url.searchParams.get('latitude'); const lon = url.searchParams.get('longitude');
        if ((lat === null) !== (lon === null) || lat?.trim() === '' || lon?.trim() === '') invalid('请成对提供有效经纬度');
        const campus = url.searchParams.get('campus') || 'east';
        if (!['east', 'west'].includes(campus)) invalid('校区须为 east 或 west');
        const shared = campusData?.[campus] ?? campusData?.campuses?.[campus];
        const center = shared?.center;
        const hasCenter = Number.isFinite(center?.latitude) && Number.isFinite(center?.longitude);
        const latitude = lat === null ? (hasCenter ? coordinate(center.latitude, '纬度', 90) : 36.8106) : coordinate(Number(lat), '纬度', 90);
        const longitude = lon === null ? (hasCenter ? coordinate(center.longitude, '经度', 180) : 118.0335) : coordinate(Number(lon), '经度', 180);
        const locationLabel = lat !== null ? '指定经纬度' : (hasCenter ? (shared.name || (campus === 'east' ? '东校区' : '西校区')) : '淄博附近 · 示例坐标');
        return send(200, { ...await weather(latitude, longitude), locationLabel });
      }
      if (pathname === '/api/preferences') {
        if (!auth.enabled || !req.user) throw new ApiError(401, 'LOGIN_REQUIRED', '请先登录后同步偏好');
        if (req.method === 'GET') return send(200, { preferences: preferences.get(req.user.id) });
        if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该资源支持 GET 或 POST');
        const input = await readBody(req), allowed = ['routeHistory', 'preferenceUsage', 'routeFavorites', 'placeFavorites', 'roadFavorites'];
        if (Object.keys(input).some(key => !allowed.includes(key))) invalid('偏好数据包含不支持的字段');
        const current = preferences.get(req.user.id), next = { ...current };
        for (const key of allowed) if (input[key] !== undefined) {
          if (key === 'preferenceUsage') { if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key])) invalid('偏好设置格式无效'); next[key] = Object.fromEntries(Object.entries(input[key]).filter(([k, v]) => ['fast', 'quiet', 'safe'].includes(k) && Number.isInteger(v) && v >= 0 && v <= 10000)); }
          else { if (!Array.isArray(input[key]) || input[key].length > 100) invalid('收藏或路线记录数量超出限制'); next[key] = input[key]; }
        }
        await preferences.save(req.user.id, next); return send(200, { ok: true, preferences: next });
      }
      if (req.method === 'GET') {
        if (pathname === '/') { res.writeHead(302, { Location: '/admin/' }); res.end(); return; }
        if (['/admin', '/admin/', '/admin/index.html'].includes(pathname)) {
          if (auth.enabled) {
            const user = auth.user(req);
            if (!user) { res.writeHead(302, {Location: '/admin/login.html'}); res.end(); return; }
            if (user.role !== 'admin') {
              res.writeHead(403, {'Content-Type':'text/html; charset=utf-8'});
              res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无管理权限</title><link rel="stylesheet" href="/admin/styles.css"><body><section class="access-gate"><div class="access-card"><h1>仅限管理员访问</h1><p>普通注册用户不能进入管理端，也不能通过注册取得管理员权限。</p><a href="/admin/login.html">使用管理员账号登录 →</a></div></section></body></html>'); return;
            }
          }
          return await staticFile(res, path.join(__dirname, '..', 'admin'), 'index.html');
        }
        if (pathname.startsWith('/admin/')) {
          const name = pathname.slice(7);
          if (!['app.js', 'styles.css', 'access.js', 'inputs.json', 'login.html', 'login.js'].includes(name)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
          return await staticFile(res, path.join(__dirname, '..', 'admin'), name);
        }
        if (pathname.startsWith('/data/')) return await staticFile(res, dataDir, pathname.slice(6), true);
      }
      throw new ApiError(404, 'NOT_FOUND', '接口或资源不存在');
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof ApiError || error.status ? error.status : 500;
      if (status === 500) console.error('Request failed:', error.message);
      send(status, { error: { code: error.code || 'INTERNAL_ERROR', message: status === 500 ? '服务暂时无法处理请求' : error.message } });
    }
  });
  server.auth = auth;
  server.once('close', () => { education.cleanup().catch(() => {}); });
  return server;
}
if (require.main === module) { require('./launch').main().catch(error => { console.error(error.message); process.exitCode = 1; }); }
module.exports = { createServer, BODY_LIMIT };
