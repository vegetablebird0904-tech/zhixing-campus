const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
class ExtensionError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function body(req, limit) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new ExtensionError(415, '请使用JSON请求');
  const parts = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new ExtensionError(413, '图片或请求过大'); parts.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(parts)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new ExtensionError(400, 'JSON格式不正确'); }
}
function extension(options = {}) {
  const root = options.uploadDir || path.join(__dirname, 'storage', 'photos');
  const fetcher = options.fetcher || globalThis.fetch;
  const appid = options.appid || process.env.WECHAT_APP_ID;
  const secret = options.secret || process.env.WECHAT_APP_SECRET;
  const sessions = new Map();
  const auth=options.auth, signingKey=crypto.randomBytes(32);
  const nameOf=url=>{ try { const name=new URL(url,'http://localhost').pathname.slice(8); return /^[0-9a-f-]{36}\.(png|jpg)$/.test(name)?name:null; } catch { return null; } };
  const base=req=>(options.publicBaseUrl||process.env.PUBLIC_BASE_URL||((req.socket.encrypted?'https://':'http://')+req.headers.host)).replace(/\/$/,'');
  const signature=(name,expires)=>crypto.createHmac('sha256',signingKey).update(name+':'+expires).digest('base64url');
  const signed=(url,req)=>{const name=nameOf(url);if(!name)return url;const expires=Date.now()+10*60000;return base(req)+'/photos/'+name+'?expires='+expires+'&signature='+signature(name,expires);};
  const handle = async function handle(req, res, pathname, send) {
    if (!['/api/photos', '/api/auth/wechat'].includes(pathname) && !pathname.startsWith('/photos/')) return false;
    try {
      if (pathname === '/api/photos') {
        if (req.method !== 'POST') throw new ExtensionError(405, '请使用POST上传照片');
        const input = await body(req, 3 * 1024 * 1024);
        if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new ExtensionError(400, '图片数据无效');
        const image = Buffer.from(input.data, 'base64');
        if (image.length > 2 * 1024 * 1024) throw new ExtensionError(413, '单张照片请压缩至2MB以内');
        let ext;
        if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ext = 'png';
        else if (image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255) ext = 'jpg';
        else throw new ExtensionError(400, '仅支持PNG/JPEG图片');
        const name = crypto.randomUUID() + '.' + ext;
        await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, name), image, { flag: 'wx' });
        if(auth&&auth.enabled)await fs.writeFile(path.join(root,name+'.meta.json'),JSON.stringify({ownerId:req.user.id,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
        send(201, { path: '/photos/' + name, ...(auth&&auth.enabled?{url:signed('/photos/'+name,req)}:{}) }); return true;
      }
      if (pathname.startsWith('/photos/')) {
        if (req.method !== 'GET') throw new ExtensionError(405, '请使用GET读取图片');
        const name = pathname.slice(8);
        if (!/^[0-9a-f-]{36}\.(png|jpg)$/.test(name)) throw new ExtensionError(404, '照片不存在');
        if(auth&&auth.enabled){
          const user=auth.user(req),url=new URL(req.url,'http://localhost'),expires=Number(url.searchParams.get('expires')),given=url.searchParams.get('signature')||'';
          const expected=signature(name,expires),a=Buffer.from(given),b=Buffer.from(expected);
          const valid=expires>Date.now()&&expires<=Date.now()+11*60000&&a.length===b.length&&crypto.timingSafeEqual(a,b);
          if(!valid){if(!user)throw new ExtensionError(401,'请先登录查看照片');const metadata=await fs.readFile(path.join(root,name+'.meta.json'),'utf8').then(JSON.parse).catch(()=>null);if(user.role!=='admin'&&(!metadata||metadata.ownerId!==user.id))throw new ExtensionError(403,'无权访问此照片');}
        }
        let image; try { image = await fs.readFile(path.join(root, name)); } catch { throw new ExtensionError(404, '照片不存在'); }
        res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Content-Length': image.length }); res.end(image); return true;
      }
      if (req.method !== 'POST') throw new ExtensionError(405, '请使用POST登录');
      const input = await body(req, 8192);
      if (typeof input.code !== 'string' || input.code.length > 512 || !input.code) throw new ExtensionError(400, '缺少微信临时登录凭证');
      if (!appid || !secret) throw new ExtensionError(503, '尚未配置微信AppID和AppSecret，请使用本机资料体验，或按说明配置服务端');
      let data;
      try {
        const params = new URLSearchParams({ appid, secret, js_code: input.code, grant_type: 'authorization_code' });
        const result = await fetcher('https://api.weixin.qq.com/sns/jscode2session?' + params, { signal: AbortSignal.timeout(6000) });
        if (!result.ok) throw new Error(); data = await result.json();
      } catch { throw new ExtensionError(502, '微信登录服务暂时不可用'); }
      if (!data.openid || !data.session_key || data.errcode) throw new ExtensionError(401, '微信凭证无效或已过期，请重新登录');
      const userId = crypto.createHash('sha256').update(appid + data.openid).digest('hex');
      const token = crypto.randomBytes(32).toString('hex');
      for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
      if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
      sessions.set(token, { userId, expires: Date.now() + 7200000 });
      // session_key and AppSecret are deliberately never returned or persisted.
      send(200, { authenticated: true, user: { id: userId }, token, expiresIn: 7200, scope: 'local-development' }); return true;
    } catch (error) {
      send(error.status || 500, { error: { code: 'EXTENSION_ERROR', message: error.status ? error.message : '服务暂不可用' } }); return true;
    }
  };
  handle.validatePhotos=async (photos,req)=>{const result=[];for(const url of photos){const name=nameOf(url);if(!name)throw new ExtensionError(400,'请先通过照片接口上传，不能引用外部照片');const meta=await fs.readFile(path.join(root,name+'.meta.json'),'utf8').then(JSON.parse).catch(()=>null);if(!meta||meta.ownerId!==req.user.id)throw new ExtensionError(403,'不能引用其他用户的照片');result.push('/photos/'+name);}return result;};
  handle.serializeEvent=(event,req)=>({...event,photos:(event.photos||[]).map(url=>signed(url,req))});
  return handle;
}
module.exports = { extension };
