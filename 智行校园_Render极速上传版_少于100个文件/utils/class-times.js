const academic=require('../data/academic'),schedule=require('./schedule');
function validate(input){
 if(!Array.isArray(input)||!input.length||input.length>16)throw new Error('节次时间表无效');
 const found=new Set();let previousEnd=-1;
 return input.map(item=>{
  const n=Number(item.period),c=schedule.normalize({name:'节次',weekday:1,start:item.start,end:item.end},0);
  if(!Number.isInteger(n)||n<1||n>16||found.has(n)||schedule.minutes(c.start)<previousEnd)throw new Error('节次须按顺序设置且时间不能重叠');
  found.add(n);previousEnd=schedule.minutes(c.end);return {period:n,start:c.start,end:c.end};
 });
}
function remap(courses,times){
 const table=new Map(validate(times).map(t=>[t.period,t]));
 return courses.map(c=>{
  if(!c.periods?.length)return c;
  const first=table.get(c.periods[0]),last=table.get(c.periods[c.periods.length-1]);
  if(!first||!last)throw new Error('时间表缺少已导入课程的节次');
  return {...c,start:first.start,end:last.end,timeSource:'自定义节次时间'};
 });
}
function weeksLabel(weeks){
 if(!weeks?.length)return '每周';
 const ranges=[];let start=weeks[0],end=start;
 for(let i=1;i<=weeks.length;i++){if(i<weeks.length&&weeks[i]===end+1){end=weeks[i];continue;}ranges.push(start===end?String(start):start+'—'+end);start=weeks[i];end=start;}
 return '第'+ranges.join('、')+'周';
}
module.exports={validate,remap,weeksLabel,defaults:academic.periods};
