'use strict';
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process'),control=require('./control'),{version}=require('../package.json');
const signature="' zhixing-campus-autostart-v1";
function startupPath(env=process.env){if(!env.APPDATA)throw new Error('未找到当前Windows用户启动目录');return path.join(env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','智行校园服务.vbs');}
function pausePath(c){return path.join(c.data,'service-paused');}
function quote(value){return '"'+String(value).replace(/"/g,'""')+'"';}
function script(c,executable=process.execPath){const command='"'+executable+'" "'+path.join(__dirname,'persistent.js')+'" supervise --logon';return signature+'\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run '+quote(command)+', 0, False\r\n';}
async function install(c,options={}){
 if(process.platform!=='win32'&&!options.file)throw new Error('自动启动仅适用于Windows');
 if(process.env.NODE_ENV==='production')throw new Error('正式服务器请使用部署环境的进程管理服务');
 const file=options.file||startupPath();
 try{const raw=await fs.readFile(file),old=raw[0]===255&&raw[1]===254?raw.subarray(2).toString('utf16le'):raw.toString('utf8');if(!old.startsWith(signature))throw new Error('同名启动项不是校园服务创建的，已保留');}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.mkdir(path.dirname(file),{recursive:true});
 // WSH reads Unicode reliably with a UTF-16LE BOM, including Chinese paths.
 await fs.writeFile(file,Buffer.concat([Buffer.from([255,254]),Buffer.from(script(c),'utf16le')]));
 await fs.mkdir(c.data,{recursive:true});await fs.rm(pausePath(c),{force:true});
 return file;
}
async function uninstall(c,options={}){
 const file=options.file||startupPath();
 try{const raw=await fs.readFile(file),text=raw[0]===255&&raw[1]===254?raw.subarray(2).toString('utf16le'):raw.toString('utf8');if(!text.startsWith(signature))throw new Error('不是校园服务启动项，未删除');await fs.rm(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.mkdir(c.data,{recursive:true});await fs.writeFile(pausePath(c),'paused');
}
async function tick(c){
 if(sync.existsSync(pausePath(c)))return {paused:true};
 const health=await control.health(c),endpoints=control.lanEndpoints(c.port);
 if(health&&health.instanceId===c.instanceId&&health.version===version&&['0.0.0.0','::'].includes(health.listenHost)){
  let previous={};try{previous=JSON.parse(await fs.readFile(path.join(c.data,'connection-state.json'),'utf8'));}catch{}
  if(JSON.stringify(previous.endpoints)!==JSON.stringify(endpoints)){
   await control.writeLanConfig(c.root,endpoints,c.lanConfigFile,{instanceId:c.instanceId,serviceConfigFile:c.serviceConfigFile});
   await fs.writeFile(path.join(c.data,'connection-state.json'),JSON.stringify({endpoints}));
  }
  return health;
 }
 return control.start(c,{mode:'lan',browser:false,repair:true});
}
function spawnSupervisor(c){
 const log=path.join(c.data,'logs','supervisor.log');sync.mkdirSync(path.dirname(log),{recursive:true});const fd=sync.openSync(log,'a');
 try{const child=spawn(process.execPath,[path.join(__dirname,'persistent.js'),'supervise'],{cwd:c.root,detached:true,windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,PORT:String(c.port),...(c.dataRoot?{CAMPUS_DATA_DIR:c.dataRoot}:{}),CAMPUS_LAN_CONFIG_FILE:c.lanConfigFile,CAMPUS_SERVICE_CONFIG_FILE:c.serviceConfigFile}});child.on('error',e=>{sync.appendFileSync(log,e.message+'\n');});child.unref();}finally{sync.closeSync(fd);}
}
async function supervise(c,logon=false){
 if(logon)await fs.rm(pausePath(c),{force:true});
 // A per-project named pipe prevents duplicate watchdogs, including rapid double clicks.
 const guard=net.createServer();
 try{await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen('\\\\.\\pipe\\zhixing-supervisor-'+c.instanceId,resolve);});}catch(e){if(e.code==='EADDRINUSE')return;throw e;}
 const execute=async()=>{try{await tick(c);}catch(e){console.error(new Date().toISOString()+' '+e.message);}};
 await execute();const timer=setInterval(()=>{if(sync.existsSync(pausePath(c))){clearInterval(timer);guard.close();return;}if(execute.busy)return;execute.busy=true;execute().finally(()=>{execute.busy=false;});},10000);
}
async function main(args=process.argv.slice(2)){
 const c=control.config(),action=args[0]||'enable';
 if(action==='enable'){const file=await install(c);await control.start(c,{mode:'lan',repair:true,browser:!args.includes('--no-browser')});spawnSupervisor(c);console.log('已启用当前Windows用户登录后自动启动及异常恢复：'+file);return;}
 if(action==='disable'){await uninstall(c);console.log('已取消自动启动；当前服务可用停止脚本关闭。');return;}
 if(action==='supervise')return supervise(c,args.includes('--logon'));
 throw new Error('用法：persistent.js enable | disable | supervise');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={startupPath,pausePath,script,install,uninstall,tick,supervise,spawnSupervisor};
