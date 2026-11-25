
'use strict';
const path=require('node:path'),{fork}=require('node:child_process');
const schedule=require('../utils/schedule'),{jsonBody,failure}=require('./auth');
const grid=require('./timetable-grid');
let active=0;
function extract(buffer){return new Promise((resolve,reject)=>{
 if(active>=2)return reject(failure(503,'PDF解析繁忙，请稍后重试'));
 active++;
 let worker;
 // PDF.js loads native font/canvas helpers. A separate process prevents a native
 // Windows thread-unload fault from terminating the account and weather server.
 try{worker=fork(path.join(__dirname,'pdf-worker.mjs'),[],{
  execPath:process.execPath,execArgv:['--max-old-space-size=256','--stack-size=4096'],
  windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'
 });}catch{active--;reject(failure(503,'PDF解析进程无法启动，请检查运行环境'));return;}
 let result=null,problem=null,finished=false;
 const done=()=>{if(finished)return;finished=true;clearTimeout(timer);active--;problem?reject(problem):resolve(result);};
 const timer=setTimeout(()=>{problem=failure(422,'PDF解析超时，请拆分或简化文件后再导入');worker.kill();},20000);
 worker.once('message',r=>{if(r.ok)result=r;else problem=failure(422,r.error);});
 worker.once('error',()=>{problem=failure(422,'PDF结构不受支持或解析进程无法启动');done();});
 worker.once('exit',code=>{if(!problem&&(code!==0||!result))problem=failure(422,'PDF解析进程异常结束，服务仍可用，请重试或更换文件');done();});
 worker.send(new Uint8Array(buffer),error=>{if(error){problem=failure(422,'PDF无法发送到解析进程');worker.kill();}});
});}
function courseRows(result,options={}){
 const table=grid.parse(result,options);if(table)return table.courses;
 try{return schedule.parse(result.text);}catch{}
 const lines=result.rows.map(r=>r.text.trim()).filter(Boolean),candidates=[];let headers=null;
 for(const line of lines){let columns=line.split(/\t+|\s{2,}/).map(s=>s.trim()).filter(Boolean);if(columns.some(c=>/课程名称|课程|^name$|^course$/i.test(c))&&columns.some(c=>/开始时间|start/i.test(c))){headers=columns;continue;}
  if(headers&&columns.length>=headers.length){const row=Object.fromEntries(headers.map((h,i)=>[h,columns[i]]));try{candidates.push(schedule.normalize(row,candidates.length));continue;}catch{}}
  const times=[...line.matchAll(/(?:^|[^\d])(\d{1,2}:\d{2})/g)];if(times.length<2)continue;const first=times[0],last=times[1],day=line.match(/(?:星期|周)([一二三四五六日天1-7])/),date=(line.match(/\d{4}-\d{2}-\d{2}/)||[])[0];if(!day&&!date)continue;
  const left=line.slice(0,first.index).replace(/\d{4}-\d{2}-\d{2}/,'').replace(/(?:星期|周)[一二三四五六日天1-7]/,'').trim();const rest=line.slice(last.index+last[0].length).replace(/^\s*[-~—至]\s*/,'').trim();const name=left.replace(/\t+/g,' ').trim();if(!name)continue;try{candidates.push(schedule.normalize({name,weekday:day?day[1]:undefined,date,start:first[1],end:last[1],location:rest},candidates.length));}catch{}
 }
 return candidates;
}
function weatherRows(result){try{const data=JSON.parse(result.text);if(Array.isArray(data.hourly))return data;}catch{}
 const hourly=[];for(const row of result.rows){const line=row.text;const iso=line.match(/(\d{4}[-/]\d{2}[-/]\d{2})[T\s\t]+(\d{1,2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?/);if(!iso)continue;const time=iso[1].replace(/\//g,'-')+'T'+iso[2].padStart(5,'0')+':00'+(iso[3]||'+08:00');const rest=line.slice(iso.index+iso[0].length).trim(),temperature=rest.match(/(-?\d+(?:\.\d+)?)\s*(?:°?C|℃|度)?/i);if(!temperature)continue;const after=rest.slice(temperature.index+temperature[0].length).trim(),description=(after.match(/(?:大暴雨|暴雨|大雨|中雨|小雨|阵雨|雷阵雨|雨夹雪|大雪|中雪|小雪|多云|阴|晴|雾|霾)/)||[])[0]||after.split(/[\t,]/)[0]||'';const precip=(after.match(/(?:降水|precipitation)?\s*(\d+(?:\.\d+)?)\s*mm/i)||[])[1];hourly.push({time,temperature:Number(temperature[1]),description,precipitation:precip?Number(precip):0});}
 return hourly.length?{hourly}:null;
}
function preview(result,kind,options={}){let data=null;if(kind==='courses'){
 const table=grid.parse(result,options);
 if(table)return {pages:result.pages,text:result.text,recognized:table.complete&&table.courses.length>0,data:table.complete?{courses:table.courses,unscheduled:table.unscheduled,semester:table.semester,semesterStart:table.semesterStart,periodTimes:table.periodTimes}:null,warnings:table.warnings,format:'weekly-grid'};
 const courses=courseRows(result,options);if(courses.length)data={courses};
 }else if(kind==='weather')data=weatherRows(result);else if(kind==='observations'){try{const parsed=JSON.parse(result.text);if(Array.isArray(parsed.observations))data=parsed;}catch{}}
 return {pages:result.pages,text:result.text,recognized:!!data,data,warnings:[data?'PDF内容已识别，请逐条核对时间、星期和地点后再确认保存':'已提取PDF文字，但无法可靠识别该表格。请在编辑框调整为CSV或JSON再解析。','扫描图片、加密PDF、只有节次而没有实际起止时间的网格课表，需要先OCR或补齐时间；不会猜测课程时刻。']};}
async function handlePdf(req,res,url,send){if(url.pathname!=='/api/import/pdf')return false;try{if(req.method!=='POST')throw failure(405,'请使用POST');const data=await jsonBody(req,12*1024*1024);if(!['courses','weather','observations'].includes(data.kind))throw failure(400,'请选择课表、天气或观测PDF');if(typeof data.data!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.data))throw failure(400,'PDF编码无效');const bytes=Buffer.from(data.data,'base64');if(bytes.length>8*1024*1024)throw failure(413,'PDF不能超过8MB');if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw failure(400,'文件不是有效PDF');const result=await extract(bytes);send(200,preview(result,data.kind,data.kind==='courses'?{periodTimes:data.periodTimes}:{}));}catch(e){send(e.status||422,{error:{message:e.message||'PDF无法解析'}});}return true;}
module.exports={extract,preview,courseRows,weatherRows,handlePdf};
