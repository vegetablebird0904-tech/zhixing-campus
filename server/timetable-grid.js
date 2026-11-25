'use strict';
const schedule=require('../utils/schedule'),academic=require('../data/academic');
const weekdays={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7};
const sectionPattern=/[（(]\s*([\d\s,，、\-—~～至]+)节\s*[)）]/;
function list(value,max){
 const input=String(value).replace(/第|周|节|[()（）]/g,'').replace(/[—~～至]/g,'-').replace(/[，、]/g,',').replace(/\s/g,'');
 if(!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(input))throw new Error('周次或节次格式不支持：'+value);
 const numbers=[];
 for(const part of input.split(',')){const [a,b=a]=part.split('-').map(Number);if(a<1||b<a||b>max)throw new Error('周次或节次超出范围');for(let n=a;n<=b;n++)numbers.push(n);}
 return [...new Set(numbers)].sort((a,b)=>a-b);
}
function weekList(value){
 const m=String(value).match(/(?:第)?([\d\s,，、\-—~～至]+)周\s*(?:[（(]?([单双])(?:周)?[)）]?)?/);
 if(!m)throw new Error('课程缺少教学周');
 const weeks=list(m[1],52).filter(n=>!m[2]||(m[2]==='单'?n%2===1:n%2===0));
 if(!weeks.length)throw new Error('课程教学周为空');
 return weeks;
}
function periodTable(input){
 const source=input===undefined?academic.periods:input;
 if(!Array.isArray(source)||!source.length||source.length>16)throw new Error('节次时间表无效');
 const table=new Map();let previousEnd=-1;
 for(const item of source){
  const normalized=schedule.normalize({name:'节次',weekday:1,start:item.start,end:item.end},0);
  const period=Number(item.period);
  if(!Number.isInteger(period)||period<1||period>16||table.has(period)||schedule.minutes(normalized.start)<previousEnd)throw new Error('节次时间表重复、顺序错误或时间重叠');
  table.set(period,{period,start:normalized.start,end:normalized.end});previousEnd=schedule.minutes(normalized.end);
 }
 return table;
}
function field(text,key){const match=text.match(new RegExp('(?:^|/)(?:'+key+')[:：]([^/]+)'));return match?match[1].trim():'';}
function cleanName(text){return text.replace(/[☆★○●]/g,'').replace(/\s+/g,'').trim();}
function headerOf(row){
 const entries=(row.items||[]).map(item=>{const m=item.text.replace(/\s/g,'').match(/^(?:星期|周)([一二三四五六日天])$/);return m?{weekday:weekdays[m[1]],center:item.x+item.width/2}:null;}).filter(Boolean).sort((a,b)=>a.center-b.center);
 if(entries.length!==7||new Set(entries.map(x=>x.weekday)).size!==7)return null;
 const spacing=(entries[6].center-entries[0].center)/6;
 if(spacing<=5||entries.some((e,i)=>i&&Math.abs(e.center-entries[i-1].center-spacing)>spacing*.3))return null;
 return {entries,spacing,y:row.y};
}
function unscheduled(rows){
 const first=rows.findIndex(row=>/其他课程[:：]/.test(row.text));
 if(first<0)return [];
 let text='';
 for(const row of rows.slice(first)){
  if(/打印时间|备注[:：]|[☆★○●][:：]/.test(row.text)&&text)break;
  text+=(row.items||[]).map(item=>item.text).join('');
 }
 text=text.replace(/^.*?其他课程[:：]/,'');
 const result=[];
 for(const part of text.split(/[;；]/)){
  const m=part.match(/^(.+?)[☆★○●]([^()（）/]*?)[(（]共\d+周[)）]\/(.+?周)\/([^;；]*)$/);
  if(!m)continue;
  try{result.push({name:cleanName(m[1]),teacher:m[2].trim(),weeks:weekList(m[3]),location:m[4]==='无'?'':m[4],reason:'PDF未安排具体星期和节次，不参与分时预测'});}catch{}
 }
 return result;
}
function parse(result,options={}){
 const rows=result.rows||[];let header=null,found=false;
 const columns=Array.from({length:7},()=>[]),notes=unscheduled(rows);
 for(const row of rows){
  const next=headerOf(row);
  if(next){header=next;found=true;continue;}
  if(!header)continue;
  if(/其他课程[:：]/.test(row.text))break;
  // Do not assign repeated titles, footers or semester/student headers to a weekday.
  if(/打印时间|学号[:：]|学年第|备注[:：]|[☆★○●][:：]/.test(row.text))continue;
  if(row.page===rows.find(r=>headerOf(r))?.page&&row.y>=header.y)continue;
  for(const item of row.items||[]){
   const match=header.entries.reduce((best,e)=>Math.abs(item.x-e.center)<Math.abs(item.x-best.center)?e:best,header.entries[0]);
   if(item.x<header.entries[0].center-header.spacing*.52||item.x>header.entries[6].center+header.spacing*.52)continue;
   columns[match.weekday-1].push({page:row.page,y:row.y,text:item.text,height:item.height||8});
  }
 }
 if(!found)return null;
 const times=periodTable(options.periodTimes),courses=[],errors=[];
 for(let day=0;day<7;day++){
  const lines=columns[day],starts=[];
  for(let i=0;i<lines.length;i++){
   const anchor=lines[i].text.match(sectionPattern);if(!anchor)continue;
   let prefix=lines[i].text.slice(0,anchor.index),begin=i;
   if(!prefix.trim()){
    let cursor=i-1;
    while(cursor>=0&&lines[cursor].page===lines[i].page&&!/[/:：]/.test(lines[cursor].text)&&
      (lines[cursor].height>lines[i].height+.25||/[☆★○●]\s*$/.test(lines[cursor].text))){
     prefix=lines[cursor].text+prefix;begin=cursor;cursor--;
    }
   }
   const name=cleanName(prefix);
   starts.push({index:i,begin,name,sections:anchor[1],rest:lines[i].text.slice(anchor.index+anchor[0].length)});
  }
  for(let i=0;i<starts.length;i++){
   const start=starts[i],next=starts[i+1],body=start.rest+lines.slice(start.index+1,next?next.begin:lines.length).map(l=>l.text).join('');
   try{
    if(!start.name)throw new Error('缺少课程名称');
    const periods=list(start.sections,16),weeks=weekList(body.split('/')[0]),first=times.get(periods[0]),last=times.get(periods.at(-1));
    if(periods.some((p,i)=>i&&p!==periods[i-1]+1))throw new Error('不连续节次请拆为课程');
    if(!first||!last)throw new Error('缺少第'+start.sections+'节的作息时间');
    const course=schedule.normalize({name:start.name,weekday:day+1,start:first.start,end:last.end,weeks,location:field(body,'场地|教室|地点')},courses.length);
    courses.push({...course,periods,periodLabel:'第'+start.sections+'节',teacher:field(body,'教师'),timeSource:options.periodTimes?'自定义节次时间':'校方公布的教学作息时间'});
   }catch(error){errors.push('周'+(day+1)+' '+(start.name||'课程')+'：'+error.message);}
  }
 }
 // An incomplete parse must never silently overwrite the user's saved timetable.
 if(errors.length)return {courses:[],unscheduled:notes,warnings:errors,complete:false};
 if(!courses.length)return null;
 const term=(result.text||'').match(/(\d{4})\s*[-—]\s*(\d{4})学年\s*第?([12一二])学期/);
 const semester=term?term[1]+'-'+term[2]+'-'+({'一':'1','二':'2'}[term[3]]||term[3]):'';
 return {courses,unscheduled:notes,semester,semesterStart:'',periodTimes:[...times.values()],complete:true,
  warnings:['已按星期列识别网格并合并跨页课程；节次按'+(options.periodTimes?'自定义作息':'校方公布的教学作息时间')+'换算，可在课表页调整。',...(notes.length?[notes.length+'门其他课程未排具体时间，已单独保留，不计入分时预测。']:[])]};
}
module.exports={parse,list,weekList,periodTable};
