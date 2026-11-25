const store=require('./store');
function request(path,method='GET',data){
 return new Promise((resolve,reject)=>{
  const initial=store.read();if(!initial.online)return reject(new Error('服务尚未启用。请先在电脑运行“修复连接并启动.cmd”，再点击“自动检测并连接”。'));
  (async()=>{
   const connection=require('./connection'),normalizer=require('./endpoint');let address;
   try{address=await connection.resolveEndpoint(normalizer.normalize(initial.endpoint));}
   catch(error){reject(error);return;}
   const state=store.read();if(!state.online){reject(new Error('服务连接已关闭，请重新启用并检测'));return;}
   const account=require('./account').current();
   wx.request({header:{'content-type':'application/json',...(account?{Authorization:'Bearer '+account.token}:{})},url:address+path,method,data,timeout:30000,
    success:r=>{if(r.statusCode>=200&&r.statusCode<300)return resolve(r.data);const detail=r.data&&r.data.error,e=new Error(detail&&detail.message||'服务返回异常（HTTP '+r.statusCode+'）');Object.assign(e,{statusCode:r.statusCode,code:detail&&detail.code||'HTTP_ERROR',endpoint:address});if(r.statusCode===401&&!path.startsWith('/api/auth/')){require('./account').clear();e.message='请先登录校园服务账号';}reject(e);},
    fail:e=>reject(connection.networkError(e,address))});
  })().catch(reject);
 });
}
function normalize(e,local){return Object.assign({},local||{},e,{id:local?local.id:e.id,remoteId:e.id,synced:true,accountId:e.ownerId||(local&&local.accountId)||'',campus:e.campus==='东校区'?'east':'west',location:{name:e.location,latitude:e.latitude,longitude:e.longitude},edgeId:e.edgeId||(local&&local.edgeId)||'',userName:e.reporter,status:e.status==='resolved'?'processed':e.status,progress:(e.history||[]).map(h=>({at:h.at,text:h.progress||h.statusLabel})),photos:local?local.photos:(e.photos||[]),remotePhotos:e.photos||[]});}
async function sync(){let local=store.events();const reporterId=store.read().account?store.read().account.user.id:store.read().deviceId;for(const e of local){if(!e.synced){if(e.accountId&&e.accountId!==reporterId)continue;const remotePhotos=e.remotePhotos||[];for(let i=remotePhotos.length;i<(e.photos||[]).length;i++){const base64=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:e.photos[i],encoding:'base64',success:r=>resolve(r.data),fail:()=>reject(new Error('本机照片无法读取，请检查照片是否已清除'))}));const uploaded=await request('/api/photos','POST',{data:base64});remotePhotos.push(uploaded.url||store.read().endpoint.replace(/\/$/,'')+uploaded.path);store.merge([Object.assign({},e,{remotePhotos:remotePhotos.slice()})]);}const body={clientRequestId:e.id,type:e.type,location:e.location.name,description:e.description,reporter:e.userName,reporterId,campus:e.campus==='east'?'东校区':'西校区',photos:remotePhotos,edgeId:e.edgeId||''};if(typeof e.location.latitude==='number'){body.latitude=e.location.latitude;body.longitude=e.location.longitude;}const r=await request('/api/events','POST',body);store.merge([normalize(r.event,e)]);}}const result=await request('/api/events?reporterId='+encodeURIComponent(reporterId));const current=store.events();store.merge((result.events||[]).map(e=>normalize(e,current.find(l=>l.remoteId===e.id))));return store.events();}
let incidentTask=null;
function refreshIncidents(){if(incidentTask)return incidentTask;const endpoint=store.read().endpoint;const task=request('/api/incidents').then(r=>{if(store.read().endpoint===endpoint)store.update({incidentEvents:r.events||[],incidentEndpoint:endpoint});return store.trafficEvents();});incidentTask=task;task.then(()=>{incidentTask=null;},()=>{incidentTask=null;});return task;}
module.exports={request,sync,normalize,refreshIncidents};

