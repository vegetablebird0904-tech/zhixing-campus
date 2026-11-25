'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('./timetable-grid');
function item(x,text,width=64,height=8){return {x,width,height,text};}
function row(page,y,items){return {page,y,items,text:items.map(x=>x.text).join(' ')};}
function fixture(){
 const weekdays=['一','二','三','四','五','六','日'],centers=[133,236.85,340.69,444.54,548.38,652.23,756.08];
 const rows=[row(1,520,weekdays.map((day,i)=>item(centers[i]-18,'星期'+day,36,12)))];
 rows.push(row(1,500,[item(104.08,'高等数学☆'),item(104.08,'(1-2节)1-9周/校区:西校区')]));
 rows.push(row(1,488,[item(104.08,'/场地:15104(西)/教师:王老师')]));
 rows.push(row(1,476,[item(104.08,'/教学班:高等数学')]));
 // The same course continues on page 2 before the next course starts.
 rows.push(row(2,568,[item(104.08,'/考核方式:考试')]));
 rows.push(row(2,550,[item(104.08,'信息安全数学基础☆'),item(104.08,'(3-4节)10-17周/校区:西校区')]));
 rows.push(row(2,538,[item(104.08,'/场地:15102(西)/教师:周老师')]));
 rows.push(row(2,520,[item(207.92,'数据结构☆'),item(207.92,'(5-6节)第9周/校区:西校区/场地:15203(西)')]));
 rows.push(row(2,500,[item(18,'其他课程：体育Ⅴ★赵老师(共18周)/1-18周/无;')]));
 rows.push(row(2,480,[item(18,'☆:讲课 ★:实验')]));
 return {pages:2,text:'2026-2027学年第1学期',rows};
}
test('the supplied rotated weekly timetable grid is recognized by weekday, section, week and location',()=>{
 const result=parse(fixture());assert.ok(result);assert.equal(result.complete,true);assert.equal(result.semester,'2026-2027-1');
 assert.equal(result.semesterStart,'');assert.equal(result.courses.length,3);
 const monday=result.courses.filter(c=>c.weekday===1);assert.equal(monday.length,2);
 assert.deepEqual(monday[0].weeks,[1,2,3,4,5,6,7,8,9]);assert.equal(monday[0].start,'08:00');assert.equal(monday[0].end,'09:40');
 assert.equal(monday[0].location,'15104(西)');assert.equal(monday[0].teacher,'王老师');
 assert.deepEqual(monday[1].weeks,[10,11,12,13,14,15,16,17]);assert.equal(monday[1].start,'10:05');assert.equal(monday[1].end,'11:45');
 assert.deepEqual(result.unscheduled.map(c=>c.name),['体育Ⅴ']);
});
test('invalid timetable timing fails closed rather than importing a partial or guessed schedule',()=>{
 const rows=fixture();rows.rows.find(r=>r.text.includes('(3-4节)')).items[1].text='(3-4节)未知周次/校区:西校区';
 const result=parse(rows);assert.equal(result.complete,false);assert.deepEqual(result.courses,[]);assert.match(result.warnings.join(' '),/教学周/);
});
test('a normal linear course-list PDF keeps the existing text-row parser path',()=>{
 assert.equal(parse({rows:[row(1,1,[item(0,'no weekly columns')])]}),null);
});
