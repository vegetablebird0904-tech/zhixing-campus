const store=require('./store'),endpoint=require('./endpoint'),lanConfig=require('./lan-config');
let desktopConfig={};try{desktopConfig=require('../data/service-config');}catch{}
function platform(){try{if(wx.getDeviceInfo)return wx.getDeviceInfo().platform||'';if(wx.getSystemInfoSync)return wx.getSystemInfoSync().platform||'';}catch{}return '';}
function onPhone(){return /^(ios|android|ohos|harmony)$/i.test(platform());}
function loopback(value){return /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(value);}
function atLeast(value,required){const actual=String(value||'').split('.').map(Number);for(let i=0;i<required.length;i++){if(!Number.isFinite(actual[i]))return false;if(actual[i]!==required[i])return actual[i]>required[i];}return true;}
function normalizeItems(items){const result=[];for(const value of items||[])try{const parsed=endpoint.normalize(value);if(!result.includes(parsed))result.push(parsed);}catch{}return result;}
function lanEndpoints(){return normalizeItems(lanConfig.endpoints||desktopConfig.endpoints||[]).filter(x=>!loopback(x));}
function generatedEndpoints(){return [...new Set([...normalizeItems(lanConfig.endpoints),...normalizeItems(desktopConfig.endpoints)].filter(x=>!loopback(x)))];}
function deviceEndpoint(value){const options=lanEndpoints(),old=(lanConfig.previousEndpoints||[]).includes(value)||(desktopConfig.previousEndpoints||[]).includes(value),changed=old&&options.length&&!options.includes(value);if((onPhone()&&loopback(value))||changed){if(options.length){store.update({endpoint:options[0],online:true,autoLanEndpoint:options[0]});return options[0];}const e=new Error('电脑局域网地址尚未生成。请在当前项目运行“修复连接并启动.cmd”，手机与电脑连接同一网络后重新编译。');e.code='PHONE_LOOPBACK';throw e;}return value;}
function networkError(detail,address){const raw=String(detail&&detail.errMsg||detail&&detail.message||'request:fail（未返回具体原因）').slice(0,600);let code='NETWORK_ERROR',message='请求未到达服务。请确认电脑服务已启动，并确认手机与电脑处于同一网络。';if(/domain|url not in|合法域名/i.test(raw)){code='DOMAIN_BLOCKED';message='微信拦截了请求域名；开发调试需检查合法域名校验，正式使用需配置HTTPS和request合法域名。';}else if(/timeout|timed out|超时/i.test(raw)){code='NETWORK_TIMEOUT';message='连接超时。先在电脑当前项目运行“修复连接并启动.cmd”，再点击“自动检测并连接”；重新编译后生成真机预览。';}else if(/ssl|tls|certificate|cert_/i.test(raw)){code='TLS_ERROR';message='HTTPS证书校验失败，请检查正式服务证书。';}else if(/refused|reset|connect|unreachable|address/i.test(raw)){code='SERVICE_UNREACHABLE';message='电脑校园服务未启动或IP不可达。运行当前项目中的“修复连接并启动.cmd”，随后重新编译预览。';}const e=new Error(message+'\n当前地址：'+address+'\n微信错误：'+raw);Object.assign(e,{code,endpoint:address,errMsg:raw});return e;}
function publicGet(address,path='/api/health'){return new Promise((resolve,reject)=>wx.request({url:address+path,method:'GET',timeout:2200,header:{Accept:'application/json'},success:r=>r.statusCode===200?resolve(r.data):reject(new Error('HTTP '+r.statusCode)),fail:e=>reject(networkError(e,address))}));}
function descriptors(current){
 const out=[],expected=lanConfig.instanceId||desktopConfig.instanceId||'',fresh=generatedEndpoints(),stale=(lanConfig.previousEndpoints||[]).includes(current)||(desktopConfig.previousEndpoints||[]).includes(current)||(store.read().autoLanEndpoint===current&&!fresh.includes(current));
 function add(url,id,source){try{const value=endpoint.normalize(url),existing=out.find(x=>x.url===value);if(existing){if(!existing.instanceId&&id)existing.instanceId=id;if(source!=='current')existing.generated=true;return;}out.push({url:value,instanceId:id||'',source,generated:source!=='current'});}catch{}}
 if(!stale)add(current,expected,'current');
 for(const url of lanConfig.endpoints||[])add(url,lanConfig.instanceId||expected,'lan-config');
 for(const url of desktopConfig.endpoints||[])add(url,desktopConfig.instanceId||expected,'service-config');
 if(stale)add(current,expected,'stale-current');
 if(!onPhone()){let port='3219';try{port=new URL(current).port||port;}catch{}add('http://127.0.0.1:'+port,expected,'loopback');}
 return out.filter(x=>!onPhone()||!loopback(x.url));
}
async function inspect(candidate){
 const health=await publicGet(candidate.url);
 if(!health||health.app!=='zhixing-campus')throw new Error('地址返回的不是校园服务');
 if(!atLeast(health.version,[1,2,6])||health.authRequired!==true)throw new Error('连接到旧版或不兼容服务（'+String(health.version||'未知版本')+'），请运行当前项目启动器');
 if(candidate.instanceId&&health.instanceId!==candidate.instanceId)throw new Error('服务来自其他解压目录，请运行当前项目目录中的启动器');
 if(onPhone()&&candidate.generated&&!['0.0.0.0','::'].includes(health.listenHost))throw new Error('电脑服务仅监听本机，请运行“修复连接并启动.cmd”');
 const status=await publicGet(candidate.url,'/api/auth/status');
 if(!status||status.app!=='zhixing-campus'||!status.enabled||!status.loginMethods||!status.loginMethods.password)throw new Error('服务账号接口尚未就绪');
 return {endpoint:candidate.url,health,status};
}
function commit(result,saved){
 if(store.read().endpoint!==saved.endpoint)throw new Error('检测期间服务地址发生变化，请重新检测');
 const current=store.read(),account=current.account&&(current.account.endpoint===saved.endpoint||(onPhone()&&loopback(current.account.endpoint)&&generatedEndpoints().includes(result.endpoint)))?Object.assign({},current.account,{endpoint:result.endpoint}):current.account;
 store.update({endpoint:result.endpoint,online:true,autoLanEndpoint:generatedEndpoints().includes(result.endpoint)?result.endpoint:'',account,lastServiceCheck:new Date().toISOString()});
 return result;
}
async function recover(){
 const saved=store.read(),list=descriptors(saved.endpoint);
 const checks=await Promise.all(list.map(async candidate=>{try{return {result:await inspect(candidate)}}catch(error){return {candidate,error};}}));
 const chosen=checks.find(x=>x.result);if(chosen)return commit(chosen.result,saved);
 if(checks.length===1&&checks[0].error)throw checks[0].error;
 const message=checks.map(x=>(x.candidate&&x.candidate.url||'电脑地址')+'：'+x.error.message).join('\n');
 const e=new Error('未检测到当前项目的校园服务。请在当前解压目录运行“修复连接并启动.cmd”，然后重新编译并点击自动检测。\n'+message);e.code='SERVICE_NOT_READY';throw e;
}
let recoveryTask=null;
function autoConnect(){if(recoveryTask)return recoveryTask;const task=recover();recoveryTask=task;task.then(()=>{if(recoveryTask===task)recoveryTask=null;},()=>{if(recoveryTask===task)recoveryTask=null;});return task;}
async function resolveEndpoint(value){
 const normalized=endpoint.normalize(value),knownGenerated=generatedEndpoints().includes(normalized),old=(lanConfig.previousEndpoints||[]).includes(normalized)||(desktopConfig.previousEndpoints||[]).includes(normalized)||store.read().autoLanEndpoint===normalized;
 const shouldDiscover=(onPhone()&&(loopback(normalized)||knownGenerated))||old;
 if(!shouldDiscover){deviceEndpoint(normalized);return normalized;}
 const currentState=store.read(),checkedAt=new Date(currentState.lastServiceCheck||0).getTime();
 if(currentState.online&&currentState.endpoint===normalized&&Date.now()-checkedAt<4000&&(!onPhone()||!loopback(normalized))&&(!currentState.autoLanEndpoint||lanEndpoints().includes(currentState.autoLanEndpoint)))return normalized;
 const saved=store.read(),items=descriptors(normalized);
 if(onPhone()&&!items.length){const e=new Error('手机使用的127.0.0.1只代表手机自身。请在当前电脑项目运行“修复连接并启动.cmd”，重新编译并生成真机预览。');e.code='PHONE_LOOPBACK';throw e;}
 const checks=await Promise.all(items.map(async c=>{try{return {result:await inspect(c)}}catch(error){return {candidate:c,error};}}));
 const chosen=checks.find(x=>x.result);if(chosen)return commit(chosen.result,saved).endpoint;
 const msg=checks.map(x=>(x.candidate&&x.candidate.url||'地址')+'：'+x.error.message).join('\n');
 const e=new Error('当前服务地址不可达。请在电脑本项目运行“修复连接并启动.cmd”，再点击自动检测；电脑换网络后重新编译真机预览。\n'+msg);e.code='SERVICE_NOT_READY';throw e;
}
async function probe(){return recover();}
module.exports={platform,onPhone,loopback,lanEndpoints,deviceEndpoint,deviceCheck:deviceEndpoint,networkError,probe,atLeast,autoConnect,recover,resolveEndpoint,recoveryCandidates:value=>descriptors(value).map(x=>x.url)};

