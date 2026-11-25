'use strict';
const geo=require('./geo');
const closures=['临时封路','施工','交通事故','积水'];
function active(event,date=new Date(),campusId='west'){
 if(!event||['processed','resolved'].includes(event.status)||![campusId,campusId==='east'?'东校区':'西校区',undefined].includes(event.campus))return false;
 const at=new Date(date).getTime(),start=Date.parse(event.createdAt),end=Date.parse(event.expiresAt);
 return (!Number.isFinite(start)||start<=at)&&(!Number.isFinite(end)||end>at);
}
function position(event,campus){
 const p=event.location&&typeof event.location==='object'?event.location:event;
 if(Number.isFinite(p.latitude)&&Number.isFinite(p.longitude))return {latitude:p.latitude,longitude:p.longitude};
 const e=campus.edges.find(x=>x.id===event.edgeId);
 if(e){const a=campus.nodes[e.a],b=campus.nodes[e.b];return {longitude:(a[0]+b[0])/2,latitude:(a[1]+b[1])/2};}
 return null;
}
function segmentDistance(point,a,b){
 const m=111195,k=Math.cos(point.latitude*Math.PI/180),ax=(a[0]-point.longitude)*m*k,ay=(a[1]-point.latitude)*m,bx=(b[0]-point.longitude)*m*k,by=(b[1]-point.latitude)*m;
 const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
 return Math.hypot(ax+t*dx,ay+t*dy);
}
function nearestEdge(campus,point){
 let edge=null,distance=Infinity;
 for(const e of campus.edges){const d=segmentDistance(point,campus.nodes[e.a],campus.nodes[e.b]);if(d<distance){edge=e;distance=d;}}
 return {edge,distance};
}
function build(campus,events=[],date=new Date()){
 const edges={},items=[];
 for(const event of events){
  if(!active(event,date,campus.id))continue;
  const p=position(event,campus);if(!p||campus.bounds&&!geo.inCampus(campus,p))continue;
  const closest=nearestEdge(campus,p),explicit=campus.edges.find(e=>e.id===event.edgeId),primary=explicit||closest.distance<=90&&closest.edge;
  const blocked=closures.includes(event.type),affected=[];
  if(primary)for(const e of campus.edges){
   const d=segmentDistance(p,campus.nodes[e.a],campus.nodes[e.b]),direct=e.id===primary.id;
   if(!direct&&d>60)continue;
   const penalty=direct?(blocked?.55:.30):.18*(1-d/60),value=edges[e.id]||(edges[e.id]={blocked:false,penalty:0,eventIds:[],reasons:[]});
   // A closure reported at an intersection affects each connected segment touching that point.
   value.blocked=value.blocked||blocked&&(direct||d<=12);value.penalty=Math.min(.85,value.penalty+penalty);value.eventIds.push(event.remoteId||event.id);value.reasons.push(event.type||'道路异常');affected.push(e.id);
  }
  const name=typeof event.location==='string'?event.location:event.location&&event.location.name||'地图选点';
  items.push({id:event.remoteId||event.id,localId:event.id,type:event.type||'道路异常',description:event.description||'',locationName:name,latitude:p.latitude,longitude:p.longitude,edgeId:primary?primary.id:'',affectedEdges:affected,blocked:!!primary&&blocked,status:event.status,reason:!primary?'地点距离道路较远，暂仅标记，尚未纳入路段评估':blocked?'关联路段暂时避让，周边道路增加通行压力':'关联路段增加拥堵与通行耗时',statusText:event.status==='processing'?'处理中':'待核实'});
 }
 return {edges,items};
}
module.exports={active,position,segmentDistance,nearestEdge,build,closures};
