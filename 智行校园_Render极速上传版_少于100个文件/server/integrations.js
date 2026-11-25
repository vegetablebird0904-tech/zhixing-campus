'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const schedule=require('../utils/schedule'),traffic=require('../utils/traffic'),search=require('../utils/search');
const city='101120301';
const {version}=require('../package.json');
function jsonAssignment(html,name){const start=html.indexOf('var '+name);if(start<0)return null;const equals=html.indexOf('=',start);let begin=html.indexOf('{',equals),depth=0,quoted=false,escaped=false;for(let i=begin;i<html.length;i++){const ch=html[i];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0)return JSON.parse(html.slice(begin,i+1));}return null;}
function chinaWeather(html,now=new Date()){
 const forecast=jsonAssignment(html,'hour3data'),observe=jsonAssignment(html,'observe24h_data');
 if(!forecast||!forecast['1d'])throw new Error('天气页面结构已变化');
 const title=(html.match(/id="hidden_title"[^>]*value="([^"]+)"/)||[])[1]||'';
 const current=observe&&observe.od&&observe.od.od2&&observe.od.od2[0],stamp=observe&&observe.od&&observe.od.od0;
 const observedAt=stamp&&/^\d{12}$/.test(stamp)?stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8)+'T'+stamp.slice(8,10)+':'+stamp.slice(10,12)+':00+08:00':null;
 const base=new Date(now.getTime()+8*3600000),year=base.getUTCFullYear(),month=base.getUTCMonth();
 const raw=[...(forecast['1d']||[]),...(forecast['23d']||[]).flat()];const seen=new Set(),hourly=[];
 for(const item of raw){const columns=item.split(','),time=columns[0].match(/(\d+)日(\d+)时/);if(!time)continue;const day=Number(time[1]),hour=Number(time[2]);let when=new Date(Date.UTC(year,month,day,hour)-8*3600000);if(when-now<-15*86400000)when=new Date(Date.UTC(year,month+1,day,hour)-8*3600000);if(when-now>20*86400000)when=new Date(Date.UTC(year,month-1,day,hour)-8*3600000);if(seen.has(when.toISOString()))continue;seen.add(when.toISOString());const temperature=parseFloat(columns[3]);if(!Number.isFinite(temperature))continue;hourly.push({time:when.toISOString(),temperature,description:columns[2],wind:columns[4]+' '+columns[5],precipitation:/雨|雪/.test(columns[2])?1:0});}
 hourly.sort((a,b)=>new Date(a.time)-new Date(b.time));if(!hourly.length)throw new Error('暂无有效天气预报');
 const nearest=hourly.slice().sort((a,b)=>Math.abs(new Date(a.time)-now)-Math.abs(new Date(b.time)-now))[0];
 const temperature=current&&Number.isFinite(Number(current.od22))?Number(current.od22):nearest.temperature;
 const stale=!observedAt||Math.abs(new Date(observedAt)-now)>12*3600000;
 return {available:true,provider:'中国天气网',source:'weather.com.cn',city:'淄博',cityCode:city,sourceUrl:'https://www.weather.com.cn/weather1d/'+city+'.shtml',fetchedAt:now.toISOString(),observedAt:stale?nearest.time:observedAt,temperature:stale?nearest.temperature:temperature,description:nearest.description,precipitation:nearest.precipitation,hourly,forecastOnly:stale,summary:title};
}
async function readJSON(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function body(req){let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>1024*1024){const e=new Error('导入内容不能超过1MB');e.status=413;throw e;}parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new Error('JSON格式不正确');}}
function normalizeWeather(input){if(!input||typeof input!=='object')throw new Error('天气格式不正确');const items=input.hourly;if(!Array.isArray(items)||!items.length||items.length>500)throw new Error('天气需要1至500条hourly时段记录');const hourly=items.map(r=>{if(!Number.isFinite(new Date(r.time).getTime())||!Number.isFinite(Number(r.temperature))||Number(r.temperature)<-80||Number(r.temperature)>65)throw new Error('天气时间或温度无效');return {time:new Date(r.time).toISOString(),temperature:Number(r.temperature),description:String(r.description||'').slice(0,50),precipitation:Math.max(0,Number(r.precipitation)||0)};}).sort((a,b)=>new Date(a.time)-new Date(b.time));return {available:true,provider:'手动导入',hourly,temperature:hourly[0].temperature,description:hourly[0].description,observedAt:hourly[0].time,fetchedAt:new Date().toISOString()};}
function base64url(value){return Buffer.from(value).toString('base64url');}
function sha256(value){return crypto.createHash('sha256').update(value).digest('base64url');}
function parseEducation(text){let value;try{value=JSON.parse(text);}catch{throw new Error('教务课表接口必须返回JSON');}let courses;if(Array.isArray(value))courses=value;else courses=value.courses||(value.data&&value.data.courses)||(value.result&&value.result.courses)||(Array.isArray(value.data)?value.data:null);if(!Array.isArray(courses))throw new Error('教务课表响应中未找到courses数组');return schedule.parse(JSON.stringify({courses}),'json');}
function integrations(options={}){
 const root=options.integrationDir||path.join(__dirname,'storage'),fetcher=options.fetcher||globalThis.fetch;
 const eduURL=options.eduURL||process.env.EDU_SCHEDULE_URL,eduToken=options.eduToken||process.env.EDU_ACCESS_TOKEN;
 const sso={authorizeURL:options.ssoAuthorizeURL||process.env.SDUT_SSO_AUTHORIZE_URL,tokenURL:options.ssoTokenURL||process.env.SDUT_SSO_TOKEN_URL,clientId:options.ssoClientId||process.env.SDUT_SSO_CLIENT_ID,clientSecret:options.ssoClientSecret||process.env.SDUT_SSO_CLIENT_SECRET,redirectURI:options.ssoRedirectURI||process.env.SDUT_SSO_REDIRECT_URI||'',scope:options.ssoScope||process.env.SDUT_SSO_SCOPE||'openid profile'};
 const states=new Map(),tickets=new Map();let cache=null,pending=null;
 const ssoConfigured=!!(sso.authorizeURL&&sso.tokenURL&&sso.clientId&&sso.redirectURI&&eduURL);
 async function exchange(code,verifier){const response=await fetcher(sso.tokenURL,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:sso.redirectURI,client_id:sso.clientId,code_verifier:verifier,...(sso.clientSecret?{client_secret:sso.clientSecret}:{})}),signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw new Error('统一身份认证授权码交换失败');const data=await response.json();if(!data.access_token)throw new Error('统一身份认证未返回访问令牌');return data.access_token;}
 async function fetchCourses(token){const parsed=new URL(eduURL);if(parsed.protocol!=='https:'&&!(options.allowLocalEducation&&['127.0.0.1','localhost'].includes(parsed.hostname)))throw new Error('课表接口须使用HTTPS');const response=await fetcher(eduURL,{headers:{Accept:'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw new Error(response.status===401?'教务授权已失效':'教务课表接口暂不可用');return parseEducation(await response.text());}
 async function callbackPage(message){const safe=JSON.stringify(message).replace(/</g,'\\u003c');return '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>学校课表授权结果</title><style>body{font:17px/1.8 system-ui;padding:24px;background:#f4f7f0;color:#315344}button{border:0;border-radius:12px;background:#418669;color:white;padding:14px 30px;font:inherit}</style><h2>学校课表授权结果</h2><p id="status"></p><button id="import" disabled>识别导课</button><script src="https://res.wx.qq.com/open/js/jweixin-1.6.0.js"></script><script>const data='+safe+';const status=document.getElementById("status"),button=document.getElementById("import");status.innerText=data.message||"授权完成";if(data.ok&&data.ticket){if(window.wx&&wx.miniProgram){button.disabled=false;button.onclick=()=>{button.disabled=true;wx.miniProgram.postMessage({data});wx.miniProgram.navigateBack({delta:1,fail:()=>{status.innerText="请从小程序内发起授权，再重试";button.disabled=false;}});};}else{status.innerText="已取得授权结果，但微信网页桥接未加载，请检查网络后重试";}}else button.hidden=true;</script></html>';}
 async function getWeather(){if(cache&&Date.now()-cache.at<600000)return cache.data;if(pending)return pending;pending=(async()=>{try{const response=await fetcher('https://www.weather.com.cn/weather1d/'+city+'.shtml',{headers:{'User-Agent':'ZhixingCampus/1.1 personal educational weather reader'},signal:AbortSignal.timeout(6500)});if(!response.ok)throw new Error('上游不可用');const data=chinaWeather(await response.text());cache={at:Date.now(),data};return data;}catch{return {available:false,provider:'中国天气网',message:'天气暂时无法更新，可以导入天气文件或稍后重试',fetchedAt:new Date().toISOString()};}finally{pending=null;}})();return pending;}
 async function inputs(){return readJSON(path.join(root,'planning.json'),{courses:[],weather:null,semesterStart:''});}
 async function save(data){await fs.mkdir(root,{recursive:true});const tmp=path.join(root,'planning-'+Date.now()+'.tmp');await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,path.join(root,'planning.json'));}
 return async(req,res,url,send)=>{
  const p=url.pathname;
  if(!['/api/health','/api/search','/api/integrations/status','/api/integrations/education','/api/integrations/education/sso/status','/api/integrations/education/sso/start','/api/integrations/education/sso/callback','/api/integrations/education/sso/result','/api/weather/china','/api/planning-inputs','/api/forecast','/api/observations'].includes(p))return false;
  try{
   if(p==='/api/health'){send(200,{ok:true,app:'zhixing-campus',version,authRequired:options.authRequired!==false,admin:'/admin/',listenHost:options.getListenHost?options.getListenHost():null,instanceId:options.instanceId||null,pid:process.pid,managed:options.managed===true,bootId:options.bootId||null});return true;}
   if(p==='/api/search'){send(200,{places:search.search(url.searchParams.get('q')||'')});return true;}
   if(p==='/api/integrations/status'){const configured=!!eduURL;send(200,{education:{configured,mode:configured?'authorized-adapter':'file-import',message:configured?'教务接口已配置':'尚未配置授权教务接口，可导入教务系统导出的课表'},weather:{configured:true,provider:'中国天气网',cityCode:city}});return true;}
   if(p==='/api/integrations/education/sso/status'){send(200,{configured:ssoConfigured,provider:'山东理工大学统一身份认证',mode:ssoConfigured?'oauth2-pkce':'configuration-required',message:ssoConfigured?'可通过学校授权页登录后读取课表':'需要学校提供授权地址、令牌地址、客户端ID、回调地址和课表API'});return true;}
   if(p==='/api/integrations/education/sso/start'){
    if(req.method!=='GET')throw new Error('请使用GET');if(!ssoConfigured)throw Object.assign(new Error('学校统一身份认证接口尚未配置，请联系学校信息化部门提供OAuth/CAS授权参数'),{status:503});if(!req.user)throw Object.assign(new Error('请先登录小程序服务账号'),{status:401});
    const state=base64url(crypto.randomBytes(24)),verifier=base64url(crypto.randomBytes(32));states.set(state,{userId:req.user.id,verifier,expires:Date.now()+10*60*1000});const authorize=new URL(sso.authorizeURL);authorize.searchParams.set('response_type','code');authorize.searchParams.set('client_id',sso.clientId);authorize.searchParams.set('redirect_uri',sso.redirectURI);authorize.searchParams.set('scope',sso.scope);authorize.searchParams.set('state',state);authorize.searchParams.set('code_challenge',sha256(verifier));authorize.searchParams.set('code_challenge_method','S256');send(200,{url:authorize.toString(),state,expiresIn:600});return true;
   }
   if(p==='/api/integrations/education/sso/callback'){
    const state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'',record=states.get(state);if(!record||record.expires<Date.now()){res.writeHead(400,{'Content-Type':'text/html; charset=utf-8'});res.end(await callbackPage({ok:false,message:'统一身份认证状态已过期，请返回小程序重新发起登录'}));return true;}states.delete(state);try{if(!code)throw new Error('统一身份认证未返回授权码');const token=await exchange(code,record.verifier),courses=await fetchCourses(token),ticket=base64url(crypto.randomBytes(24));tickets.set(ticket,{userId:record.userId,courses,expires:Date.now()+5*60*1000});res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await callbackPage({ok:true,ticket,message:'授权完成，请返回小程序'}));}catch(error){res.writeHead(502,{'Content-Type':'text/html; charset=utf-8'});res.end(await callbackPage({ok:false,message:error.message||'教务授权失败'}));}return true;
   }
   if(p==='/api/integrations/education/sso/result'){
    if(req.method!=='POST')throw new Error('请使用POST');if(!req.user)throw Object.assign(new Error('请先登录小程序服务账号'),{status:401});const incoming=await body(req),ticket=String(incoming.ticket||''),result=tickets.get(ticket);if(!result||result.expires<Date.now()||result.userId!==req.user.id)throw Object.assign(new Error('授权结果无效或已过期，请重新登录'),{status:401});tickets.delete(ticket);send(200,{courses:result.courses,count:result.courses.length,connected:true});return true;
   }
   if(p==='/api/weather/china'){if(req.method!=='GET')throw new Error('请使用GET');send(200,await getWeather());return true;}
   if(p==='/api/integrations/education'){
    if(req.method!=='POST')throw new Error('请使用POST');
    const incoming=await body(req);
    if(incoming.url!==undefined){
     if(incoming.authorized!==true)throw new Error('需获得校园接口授权才可导入，请先确认授权');
     const adapter=require('./education-request'),target=adapter.authorizedUrl(incoming.url,eduURL),token=incoming.token||'';
     if(typeof token!=='string'||token.length>8192||/[\r\n]/.test(token))throw new Error('授权凭证格式无效');
     const text=await (options.educationRequest||adapter.requestEducation)(target,token),courses=parseEducation(text);
     send(200,{courses,count:courses.length,connected:true});return true;
    }
    if(!eduURL){send(503,{error:{message:'尚未配置学校授权的课表接口，请先导入教务导出的CSV、JSON或ICS课表'}});return true;}
    const parsed=new URL(eduURL);if(parsed.protocol!=='https:'&&!(options.allowLocalEducation&&['127.0.0.1','localhost'].includes(parsed.hostname)))throw new Error('授权教务接口须为HTTPS');
    const token=typeof incoming.token==='string'&&incoming.token?incoming.token:(!req.user||req.user.role==='admin')?eduToken:undefined;if(req.user&&req.user.role!=='admin'&&!token)throw new Error('请提供你自己的教务授权凭证');if(token&&token.length>8192)throw new Error('授权凭证过长');
    const response=await fetcher(eduURL,{headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(8000),redirect:'error'});
    if(!response.ok){send(response.status===401?401:502,{error:{message:response.status===401?'教务授权已失效，请重新授权':'教务接口暂不可用'}});return true;}
    const courses=parseEducation(await response.text());send(200,{courses,count:courses.length,connected:true});return true;
   }
   if(p==='/api/planning-inputs'){
    if(req.method==='GET'){const data=await inputs();send(200,{...data,courseCount:data.courses.length});return true;}
    if(req.method!=='POST')throw new Error('请使用POST导入');const incoming=await body(req),previous=await inputs(),next={...previous};
    if(incoming.courses!==undefined)next.courses=schedule.parse(JSON.stringify(incoming.courses),'json');if(incoming.weather!==undefined)next.weather=normalizeWeather(incoming.weather);if(incoming.semesterStart!==undefined){if(!/^\d{4}-\d{2}-\d{2}$/.test(incoming.semesterStart))throw new Error('开学日期格式无效');next.semesterStart=incoming.semesterStart;}
    await save(next);send(200,{ok:true,courseCount:next.courses.length,weather:!!next.weather});return true;
   }
   if(p==='/api/observations'){
    const file=path.join(root,'observations.json');if(req.method==='GET'){send(200,{observations:await readJSON(file,[])});return true;}
    const incoming=await body(req);if(!Array.isArray(incoming.observations)||incoming.observations.length>5000)throw new Error('观测需为最多5000条记录');const rows=incoming.observations.map(r=>{if(!Number.isFinite(new Date(r.time).getTime())||!Number.isFinite(Number(r.value))||r.value<0||r.value>100)throw new Error('观测时间或指数无效');return {time:new Date(r.time).toISOString(),value:Number(r.value)};});await fs.mkdir(root,{recursive:true});await fs.writeFile(file,JSON.stringify(rows));send(200,{ok:true,count:rows.length});return true;
   }
   const incoming=req.method==='POST'?await body(req):{};const start=new Date(incoming.start||url.searchParams.get('start')||Date.now());if(!Number.isFinite(start.getTime()))throw new Error('预测开始时间无效');const duration=Number(incoming.duration||url.searchParams.get('duration')||120);if(![30,60,120,180].includes(duration))throw new Error('请选择30/60/120/180分钟');const stored=await inputs(),data={...stored,...incoming};if(!data.weather){const weather=await getWeather();if(weather.available)data.weather=weather;}
   data.events=await readJSON(options.storeFile||path.join(root,'events.json'),{events:[]}).then(d=>d.events||[]);
   const forecast=traffic.forecast(start,duration,data);const observations=await readJSON(path.join(root,'observations.json'),[]);const series=forecast.points.map(pt=>{const match=observations.find(o=>Math.abs(new Date(o.time)-new Date(pt.time))<=60000);return {time:pt.time,predicted:pt.value,actual:match?match.value:null};});const pairs=series.filter(p=>p.actual!==null),errors=pairs.map(p=>p.predicted-p.actual);const valid=pairs.filter(p=>p.actual!==0);const metrics=pairs.length?{mae:errors.reduce((s,e)=>s+Math.abs(e),0)/pairs.length,rmse:Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/pairs.length),mape:valid.length?valid.reduce((s,p)=>s+Math.abs((p.predicted-p.actual)/p.actual),0)/valid.length*100:null,samples:pairs.length}:null;
   const snapshot=traffic.snapshot('west',0,start,data);const map=new Map();snapshot.roads.slice().sort((a,b)=>b.value-a.value).forEach(r=>{if(!map.has(r.name))map.set(r.name,{id:r.id,name:search.clean(r.name),index:Math.round(r.value*100),status:r.level===2?'拥堵':r.level===1?'缓行':'畅行',risk:r.value>.65?'高':'低'});});
   send(200,{...forecast,series,metrics,roads:[...map.values()].slice(0,8),summary:{congestionIndex:snapshot.mean,congestedRoads:snapshot.roads.filter(r=>r.level===2).length,highRiskRoads:snapshot.roads.filter(r=>r.value>.65).length},mapRoads:snapshot.roads.map(r=>({id:r.id,value:r.value,color:r.color})),factors:snapshot.factors,weather:data.weather||null,generatedAt:new Date().toISOString(),observations:pairs.length});return true;
  }catch(e){send(e.status||400,{error:{message:e.message||'请求处理失败'}});return true;}
 };
}
module.exports={integrations,chinaWeather,jsonAssignment,normalizeWeather};
