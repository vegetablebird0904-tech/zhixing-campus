'use strict';
// Read-only: never changes firewall rules, accounts or running processes.
const {execFileSync}=require('node:child_process');
const {addresses}=require('./launch');
const {version}=require('../package.json');
async function check(url){
  try{
    const response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(2500)});
    const health=await response.json();
    if(!response.ok||health.app!=='zhixing-campus')throw new Error('不是校园服务或返回异常');
    console.log('  可连接 '+url+' · v'+health.version+' · 监听 '+health.listenHost);
    if(health.version!==version)console.log('  警告：运行的是旧版，请关闭旧窗口，启动本目录v'+version+'。');
    return health;
  }catch(error){console.log('  未连接 '+url+' · '+(error.cause?.code||error.message));return null;}
}
(async()=>{
  const port=Number(process.env.PORT||3219);
  console.log('智行校园v'+version+'连接诊断（仅检查，不修改系统）\n项目目录：'+require('node:path').resolve(__dirname,'..'));
  console.log('\n1. 电脑本机服务');
  const health=await check('http://127.0.0.1:'+port);
  if(health){
    try{const r=await fetch('http://127.0.0.1:'+port+'/api/auth/status',{signal:AbortSignal.timeout(2500)});const status=await r.json();console.log('  账号接口：'+(r.ok&&status.enabled?'已启用':'不兼容')+'；普通注册：'+(status.registration?'开放':'关闭')+'；微信快捷登录：'+(status.loginMethods?.wechat?'已配置':'未配置，请用账号密码，不影响天气/PDF'));}catch{console.log('  账号接口未连通，请确认新版服务。');}
  }else console.log('  后台服务未运行。请在Windows文件资源管理器双击“打开管理端.cmd”或“启动手机联调服务.cmd”，不要只在微信代码编辑器查看脚本。新版后台启动成功后可以关闭启动窗口。');
  console.log('\n2. 电脑局域网地址（手机同Wi-Fi时填写）');
  for(const url of addresses(port))await check(url);
  if(health&&!['0.0.0.0','::'].includes(health.listenHost))console.log('  当前只监听本机：关闭原窗口，再运行手机联调启动器。');
  if(process.platform==='win32'){
    console.log('\n3. 端口监听进程（只读，用PID识别旧版服务窗口）');
    try{const result=execFileSync('netstat.exe',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true});console.log(result.split(/\r?\n/).filter(line=>line.includes(':'+port+' ')).join('\n')||'  此端口没有监听进程');}catch{console.log('  系统未提供netstat输出。');}
  }
  console.log('\n手机127.0.0.1不是电脑。电脑自测通过仍不等于手机可达：请检查同一Wi-Fi、防火墙、AP隔离与微信合法域名/HTTP调试设置。');
  console.log('程序不会自动放行防火墙；请仅按需对可信专用网络开放。正式使用配置HTTPS与合法域名。');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
