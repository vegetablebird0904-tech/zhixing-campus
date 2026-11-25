const pad=n=>String(n).padStart(2,'0');
const weekNames={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7};
function clock(value){const s=String(value||'').trim();if(!/^\d{1,2}:\d{2}$/.test(s))throw new Error('课程时间须为HH:mm');const [h,m]=s.split(':').map(Number);if(h>23||m>59)throw new Error('课程时间超出范围');return pad(h)+':'+pad(m);}
function minutes(s){const a=s.split(':').map(Number);return a[0]*60+a[1];}
function normalize(item,index){
 const name=String(item.name||item.course||item['课程名称']||item['课程']||'').trim();if(!name||name.length>100)throw new Error('第'+(index+1)+'条缺少课程名称');
 const start=clock(item.start||item['开始时间']),end=clock(item.end||item['结束时间']);if(minutes(end)<=minutes(start))throw new Error(name+'的结束时间须晚于开始时间');
 let weekday=item.weekday||item['星期']||item['周几'];if(typeof weekday==='string'){weekday=weekday.replace(/星期|周/g,'');weekday=weekNames[weekday]||Number(weekday);}
 const date=item.date||item['日期']||'';const startDate=item.startDate||'',endDate=item.endDate||'',intervalWeeks=Number(item.intervalWeeks||1);if(!Number.isInteger(intervalWeeks)||intervalWeeks<1||intervalWeeks>26)throw new Error('重复周间隔须为1至26');for(const day of [date,startDate,endDate])if(day&&(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(new Date(day+'T12:00:00+08:00').getTime())))throw new Error('课程日期无效');if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('日期须为YYYY-MM-DD');if(!date&&(!Number.isInteger(Number(weekday))||weekday<1||weekday>7))throw new Error(name+'需要星期1-7或具体日期');
 const students=Number(item.students||item['人数']||1);if(!Number.isFinite(students)||students<1||students>2000)throw new Error('课程人数须为1至2000');
 const weeks=Array.isArray(item.weeks)?item.weeks.map(Number):[];if(weeks.some(n=>!Number.isInteger(n)||n<1||n>52))throw new Error('教学周须为1至52');
 const periods=Array.isArray(item.periods)?item.periods.map(Number):[];
 if(periods.some((p,i)=>!Number.isInteger(p)||p<1||p>16||(i&&p!==periods[i-1]+1)))throw new Error('课程节次无效');
 return {id:item.id||'course-'+index+'-'+name,name,start,end,weekday:Number(weekday)||0,date,location:String(item.location||item['地点']||item['教室']||'').slice(0,100),students,weeks,startDate,endDate,intervalWeeks,
  ...(periods.length?{periods,periodLabel:String(item.periodLabel||('第'+periods.join(',')+'节')).slice(0,60),teacher:String(item.teacher||'').slice(0,60),timeSource:String(item.timeSource||'').slice(0,80)}:{})};
}
function csv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){row.push(cell);cell='';}else if(ch==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=ch;}if(quoted)throw new Error('CSV引号未闭合');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}const headers=(rows.shift()||[]).map(h=>h.trim());return rows.map(r=>Object.fromEntries(headers.map((k,i)=>[k,r[i]||''])));}

function ics(text){
 const entries=[],unfolded=text.replace(/\r?\n[ \t]/g,'');
 const iso=d=>d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
 function decode(value){if(!/^\d{8}T\d{4}/.test(value))throw new Error('日历需要包含开始和结束时间');const year=Number(value.slice(0,4)),month=Number(value.slice(4,6))-1,day=Number(value.slice(6,8)),hour=Number(value.slice(9,11)),minute=Number(value.slice(11,13));let local=new Date(Date.UTC(year,month,day,hour,minute)+(value.endsWith('Z')?8*3600000:0));return {date:iso(local),clock:pad(local.getUTCHours())+':'+pad(local.getUTCMinutes()),weekday:local.getUTCDay()||7};}
 for(const block of unfolded.split('BEGIN:VEVENT').slice(1)){
  const get=key=>{const m=block.match(new RegExp('(?:^|\\n)'+key+'[^:]*:([^\\r\\n]+)'));return m?m[1]:'';};
  if(/(?:^|\n)EXDATE|(?:^|\n)RDATE/.test(block))throw new Error('含例外日期的日历请先转为CSV/JSON具体课程日期');
  const zone=block.match(/DTSTART;TZID=([^:;]+)/);if(zone&&zone[1]!=='Asia/Shanghai')throw new Error('日历请使用Asia/Shanghai或UTC时间');
  const start=decode(get('DTSTART')),end=decode(get('DTEND'));if(start.date!==end.date)throw new Error('跨日课程请拆为具体日期导入');
  const rule=get('RRULE'),entry={name:get('SUMMARY').replace(/\\,/g,','),location:get('LOCATION'),start:start.clock,end:end.clock,weekday:start.weekday,date:rule?'':start.date};
  if(rule){const fields=Object.fromEntries(rule.split(';').map(p=>p.split('=')));const allowed=['FREQ','INTERVAL','BYDAY','UNTIL','COUNT'];if(fields.FREQ!=='WEEKLY'||Object.keys(fields).some(k=>!allowed.includes(k))||(fields.BYDAY&&!['MO','TU','WE','TH','FR','SA','SU'].includes(fields.BYDAY)))throw new Error('当前支持每周单日重复；复杂重复规则请转为CSV/JSON');
   const byDay={MO:1,TU:2,WE:3,TH:4,FR:5,SA:6,SU:7};if(fields.BYDAY&&byDay[fields.BYDAY]!==start.weekday)throw new Error('重复星期与开始日期不一致，请导出具体日期');
   entry.startDate=start.date;entry.intervalWeeks=Number(fields.INTERVAL||1);if(fields.UNTIL){entry.endDate=/^\d{8}$/.test(fields.UNTIL)?fields.UNTIL.slice(0,4)+'-'+fields.UNTIL.slice(4,6)+'-'+fields.UNTIL.slice(6,8):decode(fields.UNTIL).date;}
   if(fields.COUNT){const count=Number(fields.COUNT);if(!Number.isInteger(count)||count<1||count>1000)throw new Error('日历重复次数无效');const stop=iso(new Date(Date.parse(start.date+'T00:00:00Z')+(count-1)*entry.intervalWeeks*7*86400000));if(!entry.endDate||stop<entry.endDate)entry.endDate=stop;}
  }
  entries.push(entry);
 }
 return entries;
}
function parse(text,format){let items;if(typeof text!=='string'||text.length>1024*1024)throw new Error('课表文件须小于1MB');text=text.replace(/^\uFEFF/,'').trim();if(!text)throw new Error('课表内容为空');if(format==='ics'||text.startsWith('BEGIN:VCALENDAR'))items=ics(text);else if(text.startsWith('[')||text.startsWith('{')){const d=JSON.parse(text);items=Array.isArray(d)?d:d.courses;}else items=csv(text);if(!Array.isArray(items)||!items.length)throw new Error('未找到有效课程');if(items.length>500)throw new Error('课表最多500条');return items.map(normalize);}
function active(course,date,semesterStart){const d=date instanceof Date?date:new Date(date);const weekday=d.getDay()||7;const localDay=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());if(course.startDate&&localDay<course.startDate||course.endDate&&localDay>course.endDate)return false;if(course.intervalWeeks>1&&course.startDate){const passed=Math.floor((new Date(localDay+'T12:00:00')-new Date(course.startDate+'T12:00:00'))/604800000);if(passed%course.intervalWeeks!==0)return false;}if(course.date){const day=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());if(course.date!==day)return false;}else if(course.weekday!==weekday)return false;if(course.weeks.length){if(!semesterStart)return false;const week=Math.floor((new Date(d.getFullYear(),d.getMonth(),d.getDate())-new Date(semesterStart+'T00:00:00'))/604800000)+1;if(!course.weeks.includes(week))return false;}return true;}
function impact(courses,date,semesterStart){let value=0,count=0;const minute=date.getHours()*60+date.getMinutes();for(const c of courses||[]){if(!active(c,date,semesterStart))continue;const before=Math.exp(-Math.pow((minute-(minutes(c.start)-10))/8,2));const after=Math.exp(-Math.pow((minute-(minutes(c.end)+4))/10,2));const weight=Math.min(.35,.04+Math.log2(c.students+1)*.035);value+=(before+after)*weight;if(before+after>.1)count++;}return {value:Math.min(.6,value),count};}
module.exports={parse,normalize,active,impact,minutes};
