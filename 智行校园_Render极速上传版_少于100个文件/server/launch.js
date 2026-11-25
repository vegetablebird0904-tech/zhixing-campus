'use strict';
const {createServer}=require('./index');
const {spawn}=require('node:child_process');
const os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {version}=require('../package.json');
function addresses(port){return [...new Set(Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal).map(n=>'http://'+n.address+':'+port))];}
function openBrowser(url){if(process.env.CAMPUS_NO_BROWSER==='1')return;if(process.platform==='win32')spawn('cmd.exe',['/d','/s','/c','start','""',url],{windowsHide:true,stdio:'ignore'}).unref();else console.log('浏览器访问 '+url);}
function instanceIdentity(root,dataRoot){return crypto.createHash('sha256').update(path.resolve(root).toLowerCase()+'\n'+(dataRoot||'default')).digest('hex').slice(0,24);}
function assertReusable(health,{host,instanceId}){
  if(!health||health.app!=='zhixing-campus')throw new Error('3219或指定端口已被其他程序占用。请检查“诊断服务连接.cmd”，或设置其他PORT。');
  if(health.version!==version)throw new Error('端口正运行旧版服务v'+health.version+'，本次需要v'+version+'。请手动关闭旧版服务窗口，再启动本目录中的启动器；程序不会自动结束其他进程。');
  if(health.instanceId!==instanceId)throw new Error('端口运行的是另一个解压目录或数据目录中的服务。请先关闭那个服务窗口，再启动本目录版本，避免账号写入不同目录。');
  if(host==='0.0.0.0'&&!['0.0.0.0','::'].includes(health.listenHost))throw new Error('当前服务仅监听电脑127.0.0.1，手机无法访问。请先关闭旧服务窗口，再双击“启动手机联调服务.cmd”；不能在只监听本机的服务上直接复用。');
  return true;
}
async function main(){
  const port=Number(process.env.PORT||3219),host=process.env.CAMPUS_HOST||'0.0.0.0';
  const production=process.env.NODE_ENV==='production',publicBaseUrl=process.env.PUBLIC_BASE_URL||'';
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT应为1024-65535');
  if(!['127.0.0.1','0.0.0.0','::1'].includes(host))throw new Error('CAMPUS_HOST请选择127.0.0.1或0.0.0.0');
  if(production&&publicBaseUrl&&new URL(publicBaseUrl).protocol!=='https:')throw new Error('PUBLIC_BASE_URL 必须使用 https://');
  const local='http://127.0.0.1:'+port;
  const dataRoot=process.env.CAMPUS_DATA_DIR?path.resolve(process.env.CAMPUS_DATA_DIR):null;
  const instanceId=instanceIdentity(__dirname,dataRoot);
  let existing;
  try{const r=await fetch(local+'/api/health',{signal:AbortSignal.timeout(1500)});if(r.ok)existing=await r.json();}catch{}
  if(existing){
    assertReusable(existing,{host,instanceId});
    console.log('本目录的v'+version+'服务已在运行，监听：'+existing.listenHost+'。请保留原服务窗口。');
    if(host==='0.0.0.0')for(const a of addresses(port))console.log('手机服务地址：'+a);
    openBrowser((publicBaseUrl||local)+'/admin/');return;
  }
  const server=await createServer({...(dataRoot?{storeFile:path.join(dataRoot,'events.json'),preferencesFile:path.join(dataRoot,'preferences.json'),integrationDir:dataRoot,uploadDir:path.join(dataRoot,'photos'),authDir:path.join(dataRoot,'auth')}:{}),instanceId,managed:process.env.CAMPUS_MANAGED==='1',bootId:crypto.randomUUID(),production,publicBaseUrl,trustProxy:process.env.TRUST_PROXY==='1',registration:process.env.ALLOW_REGISTRATION!=='0'});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  console.log('\n智行校园v'+version+'服务已启动\n电脑管理端：'+(publicBaseUrl||local)+'/admin/\n账号鉴权已启用，普通注册用户不能进入管理端。\n天气、PDF使用普通账号即可，不依赖微信AppSecret。');
  console.log('账号/数据目录：'+(dataRoot||path.join(__dirname,'storage'))+'\n监听：'+host+':'+port);
  if(host==='0.0.0.0'){
    console.log('\n同一Wi-Fi下的其他手机/电脑浏览器可直接访问以下管理端网址：');
    for(const a of addresses(port))console.log('  '+a+'/admin/');
    console.log('小程序服务设置可填写以下地址之一：');
    for(const a of addresses(port))console.log('  '+a);
    console.log('手机127.0.0.1只代表手机自身。HTTP仅用于局域网开发调试；正式使用HTTPS。');
  }else console.log('\n当前只监听电脑本机。真机使用前先关闭本窗口，再双击“启动手机联调服务.cmd”。');
  if(!(process.env.WECHAT_APP_ID&&process.env.WECHAT_APP_SECRET))console.log('\n微信快捷登录未配置：前端将禁用此按钮。请使用账号密码注册/登录，天气与PDF不受影响。');
  try{const code=await fs.readFile(server.auth.bootstrapFile,'utf8');console.log(process.env.CAMPUS_MANAGED==='1'?'\n首次管理员设置码保存在本机文件：'+server.auth.bootstrapFile:'\n首次管理员初始化（仅电脑本机管理页）：\n'+code);}catch{}
  console.log(process.env.CAMPUS_MANAGED==='1'?'后台模式：关闭启动器窗口不会停止服务。请使用“停止校园服务.cmd”。不会修改防火墙。\n':'前台模式：保持此窗口运行；Ctrl+C停止。不会自动修改防火墙或结束旧版进程。\n');
  openBrowser((publicBaseUrl||local)+'/admin/');return server;
}
if(require.main===module)main().catch(error=>{console.error(error.code==='EADDRINUSE'?'端口被占用。请运行“诊断服务连接.cmd”，关闭旧版服务窗口后重试，或修改PORT。':error.message);process.exitCode=1;});
module.exports={main,addresses,assertReusable,instanceIdentity,openBrowser};
