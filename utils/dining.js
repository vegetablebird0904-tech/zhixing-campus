const campus=require('../data/campus').west,traffic=require('./traffic'),search=require('./search'),geo=require('./geo'),router=require('./router'),schedule=require('./schedule');
const periods={breakfast:{label:'早餐',start:6.5,end:9.5,time:'07:30'},lunch:{label:'午餐',start:10.5,end:13.5,time:'12:00'},dinner:{label:'晚餐',start:16.5,end:19.5,time:'18:00'}};
let routeDraft=null;
function currentMeal(date=new Date()){const h=date.getHours()+date.getMinutes()/60;return h<10?'breakfast':h<15?'lunch':'dinner';}
function restaurants(){return campus.pois.filter(p=>/餐厅|食堂/.test(p.name)).map(p=>Object.assign({},p,{name:search.clean(p.name)}));}
function recommend(date=new Date(),period='auto',inputs,origin=null,mode='walk'){
 const d=new Date(date),meal=periods[period]?period:currentMeal(d),selected=periods[meal],data=inputs||traffic.context();
 const hour=d.getHours()+d.getMinutes()/60,inMeal=hour>=selected.start&&hour<=selected.end,lesson=schedule.impact(data.courses||[],d,data.semesterStart),weather=traffic.weatherAt(data.weather,d);
 const hasOrigin=!!(origin&&Number.isFinite(origin.latitude)&&Number.isFinite(origin.longitude)&&geo.inCampus(campus,origin));
 const travelMode=['walk','bike','car'].includes(mode)?mode:'walk',modeLabel={walk:'步行',bike:'骑行',car:'驾车'}[travelMode];
 const rows=restaurants().map(poi=>{
  const around=campus.edges.map(edge=>{const a=campus.nodes[edge.a],b=campus.nodes[edge.b];return {edge,meters:geo.distance(poi,{longitude:(a[0]+b[0])/2,latitude:(a[1]+b[1])/2})};}).sort((a,b)=>a.meters-b.meters);
  const near=around.filter(x=>x.meters<=120).slice(0,30);if(!near.length&&around[0])near.push(around[0]);
  const index=Math.round(near.reduce((n,x)=>n+traffic.intensity(x.edge,d,0,data),0)/Math.max(1,near.length)*100),status=index>72?'拥堵':index>45?'缓行':'畅行';
  let route=null,unavailable=false;
  if(hasOrigin){try{route=router.route(campus,origin,poi,travelMode,'fast',d,data.events||[],{},data)[0];}catch{unavailable=true;}}
  const reasons=[];
  if(route)reasons.push('从'+origin.name+'出发，校内路网约'+route.length+'米，'+modeLabel+'约'+route.minutes+'分钟');
  else reasons.push(unavailable?'当前路网没有连接该出行方式的路线，请更换方式或起点':'尚未选择出发地，本次只比较餐厅周边通行情况');
  reasons.push('周边道路预测指数'+index+'/100（'+status+'）'+(index<=45?'，到达路径相对顺畅':index>72?'，建议避开拥堵时段':'，建议预留通行时间'));
  reasons.push(inMeal?selected.label+'时段，已计入该时段的通行高峰变化':'所选时间不在'+selected.label+'参考时段内，请核对用餐时间');
  if(lesson.count)reasons.push('课表有'+lesson.count+'条课程临近上下课，已计入出行波动');
  if(weather&&(/雨|雪/.test(weather.description||'')||Number(weather.precipitation)>0))reasons.push('该时段有雨雪天气，已计入通行影响');
  return {id:poi.id,name:poi.name,longitude:poi.longitude,latitude:poi.latitude,node:poi.node,roadIndex:index,status,reasons,travelMinutes:route?route.minutes:null,length:route?route.length:null,unavailable,score:route?route.minutes+index*.025:hasOrigin?1e9:index};
 }).sort((a,b)=>a.score-b.score||a.name.localeCompare(b.name));
 const candidates=rows.filter(r=>!r.unavailable),best=candidates[0];
 rows.forEach(r=>{r.recommended=!!best&&r.id===best.id;});
 const rationale=hasOrigin?'按路网通行时间优先、周边拥堵预测辅助排序':'按餐厅周边道路拥堵预测排序；选择出发地后可比较到达时间';
 return {period:selected.label,periodId:meal,at:d.toISOString(),restaurants:rows,hasOrigin,modeLabel,rationale,
  summary:best?'建议优先考虑'+best.name+(best.travelMinutes?'，'+modeLabel+'约'+best.travelMinutes+'分钟':'，周边预测指数'+best.roadIndex):'所选方式暂无可用路线，请调整出发地或出行方式',
  inputsText:[lesson.count?'课表临近出行时段已参与':(data.courses||[]).length?'所选时间未临近课表上下课':'未导入课表',weather?'该时段天气已参与':'该时段无可用天气'].join(' · '),
  limitation:'建议依据通行预测，暂未接入食堂窗口排队及营业状态；实际取餐时间以现场为准。'};
}
function setRouteDraft(value){routeDraft=value;}
function takeRouteDraft(){const value=routeDraft;routeDraft=null;return value;}
module.exports={periods,currentMeal,restaurants,recommend,setRouteDraft,takeRouteDraft};

