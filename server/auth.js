
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{promisify}=require('node:util');
const net=require('node:net');
const {version}=require('../package.json');
const scrypt=promisify(crypto.scrypt),TTL=7*86400000;
function failure(status,message,code='AUTH_ERROR'){const error=new Error(message);Object.assign(error,{status,code});return error;}
function digest(text){return crypto.createHash('sha256').update(text).digest('hex');}
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function loopback(ip){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);}
async function jsonBody(req,max=32768){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw failure(415,'请使用JSON请求');let size=0,parts=[];for await(const part of req){size+=part.length;if(size>max)throw failure(413,'请求内容过大');parts.push(part);}try{const d=JSON.parse(Buffer.concat(parts));if(!d||typeof d!=='object'||Array.isArray(d))throw new Error();return d;}catch{throw failure(400,'JSON格式不正确');}}
function username(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_]{4,32}$/.test(value))throw failure(400,'账号为4至32位字母、数字或下划线');return value.toLowerCase();}
function password(value){if(typeof value!=='string'||value.length<12||value.length>128||!/[a-zA-Z]/.test(value)||!/[0-9]/.test(value))throw failure(400,'密码须为12至128位，至少包含字母和数字');return value;}
async function hashed(pass,salt=crypto.randomBytes(16).toString('hex')){const key=await scrypt(pass,salt,64,{N:131072,r:8,p:1,maxmem:192*1024*1024});return {salt,hash:key.toString('hex')};}
function requestIP(req,options){if(options.trustProxy&&loopback(req.socket.remoteAddress)){const forwarded=String(req.headers['x-forwarded-for']||'').split(',').map(s=>s.trim()).filter(Boolean).at(-1);if(forwarded&&net.isIP(forwarded))return forwarded;}return req.socket.remoteAddress;}
function publicUser(u){return {id:u.id,username:u.username,name:u.name,role:u.role,disabled:!!u.disabled,createdAt:u.createdAt};}
async function openAuth(options={}){
 const enabled=options.authRequired!==false,root=options.authDir||path.join(__dirname,'storage','auth'),file=path.join(root,'accounts.json');
 const secure=options.production===true||process.env.NODE_ENV==='production';
 let db={users:[],sessions:[],bootstrapHash:''},queue=Promise.resolve();const rates=new Map();let kdfBusy=0;
 if(enabled){await fs.mkdir(root,{recursive:true});try{db=JSON.parse(await fs.readFile(file,'utf8'));if(!Array.isArray(db.users)||!Array.isArray(db.sessions))throw new Error('账号存储格式异常');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!db.users.some(u=>u.role==='admin')&&!db.bootstrapHash){const code=options.bootstrapToken||crypto.randomBytes(24).toString('base64url');db.bootstrapHash=digest(code);await fs.writeFile(path.join(root,'首次管理员设置码.txt'),'一次性管理员设置码：'+code+'\n请在本机管理端完成管理员初始化。使用后此文件会删除。\n',{mode:0o600});await persist(db);}
 }
 async function persist(next){const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}}
 async function write(transform){const op=queue.then(async()=>{const next=await transform(db);await persist(next);db=next;return next;});queue=op.catch(()=>{});return op;}
 async function audit(action,user,detail=''){await fs.appendFile(path.join(root,'audit.jsonl'),JSON.stringify({at:new Date().toISOString(),action,userId:user&&user.id,detail})+'\n',{mode:0o600});}
 function limit(req,kind,max=12){const now=Date.now(),key=(requestIP(req,options)||'unknown')+':'+kind;let r=rates.get(key);if(!r||now-r.start>600000){r={start:now,count:0};rates.set(key,r);}if(++r.count>max)throw failure(429,'尝试过于频繁，请10分钟后再试','RATE_LIMITED');if(rates.size>5000)for(const [k,v]of rates)if(now-v.start>600000)rates.delete(k);}
 async function kdf(pass,salt){if(kdfBusy>=2)throw failure(503,'登录服务繁忙，请稍后重试');kdfBusy++;try{return await hashed(pass,salt);}finally{kdfBusy--;}}
 function session(req){const bearer=String(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);const cookie=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('campus_session='));const token=bearer?bearer[1]:cookie?cookie.slice(15):'';if(!token)return null;const record=db.sessions.find(s=>s.hash===digest(token)&&s.expires>Date.now());if(!record)return null;const user=db.users.find(u=>u.id===record.userId&&!u.disabled);return user?{record,user,bearer:!!bearer}:null;}
 function cookie(res,token,maxAge=TTL/1000){res.setHeader('Set-Cookie','campus_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+maxAge+(secure?'; Secure':''));}
 async function issue(user,req,res,client){const token=crypto.randomBytes(32).toString('base64url'),record={hash:digest(token),userId:user.id,createdAt:Date.now(),expires:Date.now()+TTL,csrf:crypto.randomBytes(24).toString('base64url')};await write(state=>({...state,sessions:[...state.sessions.filter(s=>s.expires>Date.now()).slice(-5000),record]}));cookie(res,token);return {authenticated:true,user:publicUser(user),expiresAt:new Date(record.expires).toISOString(),expiresIn:TTL/1000,csrf:record.csrf,...(client==='web'?{}:{token})};}
 function requireUser(req,admin=false){if(!enabled)return null;const s=session(req);if(!s)throw failure(401,'请先登录，或登录已过期','LOGIN_REQUIRED');if(admin&&s.user.role!=='admin')throw failure(403,'需要管理员权限','FORBIDDEN');if(!s.bearer&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!equal(req.headers['x-campus-csrf']||'',s.record.csrf))throw failure(403,'请求验证失败，请重新登录','CSRF_ERROR');req.user=s.user;req.authSession=s;return s.user;}
 async function handle(req,res,url,send){const p=url.pathname;if(!p.startsWith('/api/auth/')&&!p.startsWith('/api/admin/users'))return false;
  if(!enabled)return false;
  try{
   if(p==='/api/auth/status'&&req.method==='GET'){const s=session(req);send(200,{app:'zhixing-campus',version,enabled:true,setupNeeded:!db.users.some(u=>u.role==='admin'),setupLocalOnly:true,registration:options.registration!==false,loginMethods:{password:true,wechat:!!((options.appid||process.env.WECHAT_APP_ID)&&(options.secret||process.env.WECHAT_APP_SECRET))},authenticated:!!s,user:s?publicUser(s.user):null,csrf:s?s.record.csrf:null});return true;}
   if(p==='/api/auth/me'&&req.method==='GET'){const u=requireUser(req);send(200,{user:publicUser(u),csrf:req.authSession.record.csrf,expiresAt:new Date(req.authSession.record.expires).toISOString()});return true;}
   if(['/api/auth/login','/api/auth/admin/login','/api/auth/register','/api/auth/bootstrap'].includes(p)){
    if(req.method!=='POST')throw failure(405,'请使用POST');limit(req,p,p.endsWith('register')?5:12);const input=await jsonBody(req);const name=username(input.username),pass=password(input.password);let user;
    if(p.endsWith('/login')){user=db.users.find(u=>u.username===name);const result=await kdf(pass,user?user.salt:'a4f29b6382771951051a92eaff26c731');if(!user||user.disabled||!equal(result.hash,user.hash)){await audit('login_failed',null,digest(name));throw failure(401,'账号或密码不正确','INVALID_CREDENTIALS');}if(p==='/api/auth/admin/login'&&user.role!=='admin'){await audit('admin_login_denied',user);throw failure(403,'该账号是普通用户，不能登录管理端；请联系管理员','ADMIN_REQUIRED');}}
    else{
     if(p.endsWith('/register')&&options.registration===false)throw failure(403,'当前服务未开放自主注册');
     if(p.endsWith('/bootstrap')){if(!loopback(requestIP(req,options)))throw failure(403,'首次管理员初始化只能在电脑本机进行');if(db.users.some(u=>u.role==='admin')||!equal(digest(String(input.setupCode||'')),db.bootstrapHash))throw failure(403,'管理员设置码无效或已使用');}
     if(db.users.length>=10000)throw failure(503,'账号数量达到当前单机配置上限，请联系管理员');const credentials=await kdf(pass);user={id:crypto.randomUUID(),username:name,name:String(input.name||name).trim().slice(0,40)||name,role:p.endsWith('/bootstrap')?'admin':'user',createdAt:new Date().toISOString(),disabled:false,...credentials};
     await write(state=>{if(state.users.some(u=>u.username===name))throw failure(409,'该账号已被使用');if(p.endsWith('/bootstrap')&&(state.users.some(u=>u.role==='admin')||!equal(digest(String(input.setupCode||'')),state.bootstrapHash)))throw failure(403,'管理员初始化已经完成');return {...state,users:[...state.users,user],bootstrapHash:p.endsWith('/bootstrap')?'':state.bootstrapHash};});
     if(user.role==='admin')await fs.rm(path.join(root,'首次管理员设置码.txt'),{force:true});await audit(user.role==='admin'?'admin_bootstrap':'register',user);
    }
    const result=await issue(user,req,res,p==='/api/auth/admin/login'?'web':input.client);await audit('login',user);send(200,result);return true;
   }
   if(p==='/api/auth/wechat'){
    if(req.method!=='POST')throw failure(405,'请使用POST');limit(req,'wechat',15);const input=await jsonBody(req);if(typeof input.code!=='string'||!input.code||input.code.length>512)throw failure(400,'缺少微信临时凭证');const appid=options.appid||process.env.WECHAT_APP_ID,secret=options.secret||process.env.WECHAT_APP_SECRET;if(!appid||!secret)throw failure(409,'未启用微信快捷登录，请使用账号密码注册或登录；天气和PDF不需要AppSecret','WECHAT_NOT_CONFIGURED');let data;
    try{const r=await (options.fetcher||fetch)('https://api.weixin.qq.com/sns/jscode2session?'+new URLSearchParams({appid,secret,js_code:input.code,grant_type:'authorization_code'}),{signal:AbortSignal.timeout(6000)});if(!r.ok)throw new Error();data=await r.json();}catch{throw failure(502,'微信登录服务暂不可用');}
    if(!data.openid||!data.session_key||data.errcode)throw failure(401,'微信登录凭证无效或已过期');const identity=digest(appid+':'+data.openid);let user=db.users.find(u=>u.wechatIdentity===identity);if(!user){user={id:crypto.randomUUID(),username:'wx_'+identity.slice(0,24),name:'微信校园用户',role:'user',createdAt:new Date().toISOString(),disabled:false,wechatIdentity:identity};await write(state=>{const prior=state.users.find(u=>u.wechatIdentity===identity);if(prior){user=prior;return state;}return {...state,users:[...state.users,user]};});}if(user.disabled)throw failure(403,'账号已被停用');send(200,await issue(user,req,res,input.client));return true;
   }
   if(p==='/api/auth/logout'){if(req.method!=='POST')throw failure(405,'请使用POST');requireUser(req);await write(state=>({...state,sessions:state.sessions.filter(s=>s.hash!==req.authSession.record.hash)}));cookie(res,'',0);send(200,{ok:true});return true;}
   if(p==='/api/auth/password'){
    if(req.method!=='POST')throw failure(405,'请使用POST');const user=requireUser(req);limit(req,'password',8);const input=await jsonBody(req);if(!user.hash)throw failure(400,'微信账号没有本地密码，请使用微信登录');const check=await kdf(String(input.oldPassword||''),user.salt);if(!equal(check.hash,user.hash))throw failure(401,'原密码不正确');const next=await kdf(password(input.newPassword));await write(state=>({...state,users:state.users.map(u=>u.id===user.id?{...u,...next}:u),sessions:state.sessions.filter(s=>s.userId!==user.id)}));await audit('password_changed',user);send(200,await issue({...user,...next},req,res,input.client));return true;
   }
   if(p==='/api/admin/users'&&req.method==='GET'){requireUser(req,true);send(200,{users:db.users.map(publicUser)});return true;}
   const match=p.match(/^\/api\/admin\/users\/([^/]+)$/);if(match&&req.method==='PATCH'){const admin=requireUser(req,true),input=await jsonBody(req);if(typeof input.disabled!=='boolean')throw failure(400,'请提供disabled布尔值');if(match[1]===admin.id)throw failure(400,'不能停用当前管理员');if(!db.users.some(u=>u.id===match[1]))throw failure(404,'账号不存在');await write(state=>({...state,users:state.users.map(u=>u.id===match[1]?{...u,disabled:input.disabled}:u),sessions:input.disabled?state.sessions.filter(s=>s.userId!==match[1]):state.sessions}));await audit('account_'+(input.disabled?'disabled':'enabled'),admin,match[1]);send(200,{ok:true});return true;}
   throw failure(404,'账号接口不存在');
  }catch(e){send(e.status||500,{error:{code:e.code||'AUTH_ERROR',message:e.status?e.message:'账号服务暂不可用'}});return true;}
 }
 function guard(req,url){
  if(!enabled)return;
  const p=url.pathname;
  // The dashboard HTML is checked again by the static route. Only login assets are public.
  const publicAsset=['/','/admin','/admin/','/admin/index.html','/admin/login.html','/admin/login.js','/admin/styles.css','/api/health','/data/campus.json','/api/integrations/education/sso/callback'].includes(p);
  if(publicAsset&&['GET','HEAD'].includes(req.method))return;
  if(p.startsWith('/photos/'))return;
  const admin=p.startsWith('/admin/')||p.startsWith('/api/admin/')||p==='/api/planning-inputs'||p==='/api/observations'||p==='/api/traffic'||(p.startsWith('/api/events/')&&req.method==='PATCH');
  requireUser(req,admin);
 }
 return {enabled,handle,guard,requireUser,user:req=>enabled?session(req)?.user:null,bootstrapFile:path.join(root,'首次管理员设置码.txt'),audit};
}
module.exports={openAuth,hashed,digest,equal,loopback,jsonBody,failure};
