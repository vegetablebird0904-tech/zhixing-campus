'use strict';
const crypto=require('node:crypto'),{jsonBody,loopback,failure}=require('./auth'),{launchBrowser}=require('./education-browser'),{parseSnapshot}=require('./education-parser'),{termKey,termLabel}=require('../utils/education');
const portal='https://ehall.sdut.edu.cn/new/ehall.html';
const consentHtml='<!doctype html><html lang="zh"><meta charset="utf-8"><title>校园课表导入授权</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:17px/1.8 system-ui;background:#f3f7f5;color:#283f37;padding:8vh 24px}main{max-width:650px;margin:auto;background:white;padding:32px;border-radius:20px}button{font:inherit;background:#36836a;color:white;border:0;border-radius:12px;padding:14px 22px;cursor:pointer}#status{color:#556c63}</style><main><h1>授权本次课表导入</h1><p>小程序请求读取此专用浏览器中的课程表。确认后进入学校官方页面，由你自行登录并打开“个人课表查询”。</p><p>识别仅在小程序点击“识别当前课表”时发生，读取课表的课程名称、星期、节次、周次和教室。不会读取密码框、浏览器Cookie或其他标签页。此浏览器会话在关闭或超时后清理。</p><button id="approve">我同意，进入学校门户</button><p id="status"></p></main><script src="/education-helper.js"></script></html>';
const consentScript="'use strict';const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);document.querySelector('#approve').onclick=async()=>{const b=document.querySelector('#approve'),s=document.querySelector('#status');b.disabled=true;try{const r=await fetch('/api/education/browser/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});const d=await r.json();if(!r.ok)throw new Error(d.error&&d.error.message||'授权失败');location.assign('https://ehall.sdut.edu.cn/new/ehall.html');}catch(e){s.innerText=e.message;b.disabled=false;}};";
function educationImport(options={}){
 const sessions=new Map();let active=null,starting=false;
 const enabled=options.desktopImportEnabled??(process.platform==='win32'&&options.production!==true&&process.env.NODE_ENV!=='production');
 const factory=options.educationBrowserFactory||launchBrowser;
 async function dispose(s){if(!s)return;sessions.delete(s.id);if(active===s.id)active=null;clearTimeout(s.timer);if(s.browser)await s.browser.close().catch(()=>{});}
 async function cleanup(){await Promise.allSettled([...sessions.values()].map(dispose));}
 const handle=async(req,res,url,send)=>{
  const p=url.pathname;
  if(p==='/education-helper'||p==='/education-helper.js'){
   if(req.method!=='GET')throw failure(405,'请使用GET');if(!loopback(req.socket.remoteAddress))throw failure(403,'课表授权页仅在电脑本机打开');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");res.writeHead(200,{'Content-Type':p.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});const pairing="const approve=document.querySelector('#approve');approve.disabled=true;fetch('/api/education/browser/describe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error&&d.error.message||'请求已过期');const p=document.createElement('p');p.innerText='发起账号：'+d.requester+'；学期：'+d.semester+'；配对码：'+d.pairingCode+'。请核对与小程序相同后再确认。';approve.before(p);approve.disabled=false;}).catch(e=>document.querySelector('#status').innerText=e.message);";res.end(p.endsWith('.js')?consentScript+pairing:consentHtml);return true;
  }
  if(!p.startsWith('/api/education/browser/'))return false;
  if(p.endsWith('/approve')||p.endsWith('/describe')){if(req.method!=='POST')throw failure(405,'请使用POST');if(!loopback(req.socket.remoteAddress))throw failure(403,'请在电脑本机浏览器确认');const input=await jsonBody(req);const s=[...sessions.values()].find(s=>!s.approved&&s.secret===input.token&&s.expires>Date.now());if(!s)throw failure(410,'本次导入请求已过期，请在小程序重新发起');if(p.endsWith('/describe')){send(200,{requester:s.requester,semester:termLabel(s.semester),pairingCode:s.pairingCode});return true;}s.approved=true;s.secret='';send(200,{ok:true});return true;}
  if(!options.auth||!options.auth.enabled)throw failure(401,'网页导课需要启用账号认证');const user=options.auth.requireUser(req);
  if(p.endsWith('/status')&&req.method==='GET'){send(200,{enabled,mode:'desktop-browser',requiresComputer:true});return true;}
  if(!enabled)throw failure(409,'当前服务未启用电脑网页导课。请在Windows电脑运行项目服务，或使用PDF/授权接口导入');
  if(req.method!=='POST')throw failure(405,'请使用POST');const input=await jsonBody(req);
  if(p.endsWith('/start')){
   const semester=termKey(input.semester);if(!semester)throw failure(400,'请选择导入学期');if(active&&sessions.get(active)?.expires<=Date.now())await dispose(sessions.get(active));if(active||starting)throw failure(409,'电脑已有导课窗口，请先结束该次导入，或等待15分钟后重新进入');starting=true;
   try{const id=crypto.randomBytes(24).toString('base64url'),secret=crypto.randomBytes(32).toString('base64url'),base=options.getLocalBase();const s={id,secret,owner:user.id,requester:String(user.name||user.username||'校园用户'),pairingCode:String(crypto.randomInt(100000,1000000)),semester,approved:false,browser:null,expires:Date.now()+15*60000};sessions.set(id,s);active=id;try{s.browser=await factory({consentUrl:base+'/education-helper#'+secret});}catch(error){await dispose(s);throw failure(503,error.message);}s.timer=setTimeout(()=>dispose(s).catch(()=>{}),15*60000);s.timer.unref();send(200,{sessionId:id,semester:termLabel(semester),pairingCode:s.pairingCode,requiresLocalApproval:true,expiresAt:new Date(s.expires).toISOString(),message:'请在电脑新打开的专用浏览器核对配对码并确认授权，自行登录学校门户并打开个人课表，再返回小程序识别'});return true;}finally{starting=false;}
  }
  const s=sessions.get(String(input.sessionId||''));if(!s||s.owner!==user.id||s.expires<=Date.now())throw failure(404,'导课会话不存在、已过期或不属于当前账号');
  if(p.endsWith('/close')){await dispose(s);send(200,{ok:true});return true;}
  if(p.endsWith('/capture')){if(!s.approved)throw failure(409,'请先在电脑新打开的浏览器点击“我同意，进入学校门户”');if(s.capturing)throw failure(409,'正在读取课程，请稍候');s.capturing=true;try{const snapshot=await s.browser.capture();const result=parseSnapshot(snapshot,{periodTimes:input.periodTimes});send(200,{courses:result.courses,count:result.courses.length,metadata:{semester:result.semester,periodTimes:result.periodTimes,unscheduled:result.unscheduled},warnings:result.warnings,selectedSemester:s.semester});return true;}catch(e){throw failure(422,e.message,'TIMETABLE_NOT_READY');}finally{s.capturing=false;}}
  throw failure(404,'导课接口不存在');
 };
 return {handle,cleanup};
}
module.exports={educationImport};
