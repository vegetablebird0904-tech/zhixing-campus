'use strict';
const schedule=require('../utils/schedule');
const grid=require('./timetable-grid');
const education=require('../utils/education');
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/[\u200b-\u200f\uFEFF]/g,'').trim();
const compact=s=>clean(s).replace(/\s+/g,'');
const weekdays={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7};

function expand(table){
 const rows=[];
 for(let y=0;y<table.rows.length;y++){
  rows[y]||=[];let x=0;
  for(const cell of table.rows[y]){
   while(rows[y][x])x++;
   const c={...cell,id:y+':'+x};
   const rs=Math.max(1,Math.min(30,Number(cell.rowSpan)||1));
   const cs=Math.max(1,Math.min(20,Number(cell.colSpan)||1));
   for(let dy=0;dy<rs;dy++){
    rows[y+dy]||=[];
    for(let dx=0;dx<cs;dx++)rows[y+dy][x+dx]=c;
   }
   x+=cs;
  }
 }
 return rows;
}

function parseCell(text,day,times){
 const value=compact(text);
 const anchors=[...value.matchAll(/[(（]?(\d{1,2}(?:[-—－~～,，、]\d{1,2})*)节[)）]?/g)];
 if(!anchors.length)throw new Error('缺少明确节次');
 if(anchors.length>1){
  const chunks=clean(text).split(/\n\s*\n|[-─━=]{3,}/).filter(s=>/节/.test(s));
  if(chunks.length!==anchors.length)throw new Error('同一格包含多门课程且无法区分，请使用PDF导入');
  return chunks.flatMap(chunk=>parseCell(chunk,day,times));
 }
 const anchor=anchors[0];
 const name=value.slice(0,anchor.index).replace(/^[\s/;；]+/,'').replace(/[☆★○●◎◷◴◵◶⏰🕒]+$/gu,'').trim();
 if(!name||/[/:：]/.test(name))throw new Error('无法确定课程名称');
 const body=value.slice(anchor.index+anchor[0].length);
 const week=body.match(/(?:^|\/)([^/]*\d[^/]*周[^/]*)/);
 if(!week)throw new Error(name+'缺少教学周');
 const periods=grid.list(anchor[1].replace(/－/g,'-'),16);
 if(periods.some((n,j)=>j&&n!==periods[j-1]+1))throw new Error(name+'的节次不连续');
 const first=times.get(periods[0]),last=times.get(periods.at(-1));
 if(!first||!last)throw new Error(name+'缺少节次作息时间');
 const field=pattern=>(body.match(new RegExp('(?:^|/)(?:'+pattern+')[:：]([^/]+)'))||[])[1]||'';
 return [schedule.normalize({name,weekday:day,start:first.start,end:last.end,
  weeks:grid.weekList(week[1]),periods,teacher:field('教师|老师'),
  location:field('场地|教室|地点'),timeSource:'网页节次与当前作息表'},0)];
}

function parseSnapshot(snapshot,options={}){
 if(!snapshot||!Array.isArray(snapshot.tables))throw new Error('页面尚未包含课程表');
 const courses=[],errors=[],seen=new Set(),times=grid.periodTable(options.periodTimes);
 for(let ti=0;ti<snapshot.tables.length;ti++){
  const rows=expand(snapshot.tables[ti]);let columns=null;
  for(const row of rows){
   const days=row.map((c,i)=>{
    const m=compact(c&&c.text).match(/^(?:星期|周)([一二三四五六日天])$/);
    return m?{index:i,day:weekdays[m[1]]}:null;
   }).filter(Boolean);
   if(days.length>=5){columns=days;continue;}
   if(!columns)continue;
   for(const {index,day} of columns){
    const cell=row[index];
    if(!cell)continue;
    const key=ti+':'+day+':'+cell.id;
    if(seen.has(key))continue;
    seen.add(key);
    const value=compact(cell.text);
    if(!value||/^[-—\s]+$/.test(value))continue;
    if(/其他课程|备注|打印时间|时间段|^节次$/.test(value))continue;
    const blocks=Array.isArray(cell.blocks)&&cell.blocks.length>1?cell.blocks:[cell.text];
    for(const block of blocks){
     try{courses.push(...parseCell(block,day,times));}
     catch(error){errors.push('周'+day+'：'+error.message);}
    }
   }
  }
 }
 if(errors.length)throw new Error('未完整识别课表：'+errors.slice(0,4).join('；')+'。请使用“表格”视图重试或使用PDF导入');
 if(!courses.length)throw new Error('尚未找到可识别的周课表。请登录后进入“个人课表查询”，选择“表格”视图，再点击识别');
 const unique=[...new Map(courses.map(c=>[[c.name,c.weekday,c.start,c.end,c.weeks.join(','),c.location].join('|'),c])).values()];
 unique.forEach((c,i)=>{c.id='web-course-'+i;});
 const semester=education.termKey(snapshot.semesterText||'');
 return {courses:unique,semester,periodTimes:[...times.values()],unscheduled:[],
  warnings:semester?[]:['页面未标明学期，请在确认前核对所选学期。']};
}

// Executed in an isolated world only after local consent and explicit capture.
// Read rendered timetable text, never input values, cookies, tokens or scripts.
function collectPage(){
 const text=String(document.body&&document.body.innerText||'');
 const semesterText=(text.match(/\d{4}\s*[-—]\s*\d{4}\s*(?:学年)?\s*(?:第\s*[12一二]\s*学期|[-—]\s*[12])/g)||[]).slice(0,5).join(' ');
 const looksLikeTable=t=>/星期\s*[一二三四五六日]|周\s*[一二三四五六日]/.test(t.innerText||'')&&/节|课程/.test(t.innerText||'');
 const candidates=Array.from(document.querySelectorAll('table')).filter(looksLikeTable);
 const hasCourse=e=>/\d+\s*节/.test(e.innerText||'')&&/\d+\s*周/.test(e.innerText||'');
 const tables=candidates.filter(t=>!candidates.some(other=>other!==t&&t.contains(other))).slice(0,8).map(t=>({
  rows:Array.from(t.rows).slice(0,100).map(r=>Array.from(r.cells).slice(0,16).map(c=>{
   const candidates=Array.from(c.querySelectorAll('div,section,li')).filter(hasCourse);
   const blocks=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other))).slice(0,30).map(e=>(e.innerText||'').slice(0,12000));
   return {text:(c.innerText||'').slice(0,12000),rowSpan:c.rowSpan,colSpan:c.colSpan,...(blocks.length>1?{blocks}:{})};
  }))
 }));
 return {semesterText,tables};
}

module.exports={parseSnapshot,parseCell,collectPage,expand};

