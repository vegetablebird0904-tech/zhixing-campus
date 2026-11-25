const {intensity,context,prepare}=require('./traffic');
const {nearest,distance}=require('./geo');
function route(c,from,to,mode='walk',preference='fast',depart=new Date(),events=[],memory={},providedInputs){
 const inputs=prepare(Object.assign({},providedInputs||context(),{events}),depart,c),speed={walk:1.25,bike:3.6,car:5.5}[mode];
 if(!speed||!['fast','quiet','safe'].includes(preference)||!Number.isFinite(depart.getTime()))throw new Error('出行方式、偏好或时间无效');
 const a=from.node||nearest(c,from).id,b=to.node||nearest(c,to).id;
 if(!a||!b)throw new Error('附近暂无可用道路');
 const blocked=new Set(Object.keys(inputs._incidents.edges).filter(id=>inputs._incidents.edges[id].blocked));
 const graph={};
 c.edges.forEach(e=>{
  if(blocked.has(e.id)||(mode==='car'&&!e.car)||(mode==='bike'&&!e.bike))return;
  (graph[e.a]||(graph[e.a]=[])).push({to:e.b,e});
  if(!graph[e.b])graph[e.b]=[];
  if(mode!=='car'||!e.oneway)(graph[e.b]||(graph[e.b]=[])).push({to:e.a,e});
 });
 if(mode==='car'&&(!graph[a]||!graph[b]))throw new Error('所选地点未连接可驾车道路，请改用步行或重新选点');
 const key=[from.id||from.node,to.id||to.node,mode].join('|');
 const history=(memory.history||[]).filter(h=>h.key===key&&Array.isArray(h.edges));
 const savedRoute=memory.selectedFavorite&&memory.selectedFavorite.key===key?memory.selectedFavorite:null;
 const favoriteEdges=new Set((memory.roadFavorites||[]).map(e=>e.id));
 const scoresForEdge=new Map(c.edges.map(e=>[e.id,intensity(e,depart,0,inputs)]));
 const outputs=[],seen=new Set();
 function build(edges,nodes,strategy){
  const signature=edges.map(e=>e.id).join(',');
  const saved=history.filter(h=>h.edges.join(',')===signature);
  const habitCount=saved.reduce((n,h)=>n+(Number(h.count)||1),0);
  const seconds=edges.reduce((n,e)=>n+e.length/speed*(1+scoresForEdge.get(e.id)*(mode==='walk'?.28:1.5)),0);
  if(seen.has(signature)){const existing=outputs.find(r=>r.edges.join(',')===signature);if(existing)existing.habitCount=habitCount;return;}
  seen.add(signature);
  outputs.push({strategy,label:{fast:'更快',quiet:'少拥堵',safe:'更安全',familiar:'常用路线',favorite:'偏好路段',saved:'收藏路线'}[strategy],
   segments:edges.map(e=>({id:e.id,name:e.name,length:Math.round(e.length),minutes:Math.max(1,Math.ceil(e.length/speed/60)),index:Math.round(scoresForEdge.get(e.id)*100),car:e.car,kind:e.kind,incidentReasons:inputs._incidents.edges[e.id]?inputs._incidents.edges[e.id].reasons:[]})),
   edges:edges.map(e=>e.id),points:nodes.map(n=>c.nodes[n]),length:Math.round(edges.reduce((s,e)=>s+e.length,0)),minutes:Math.max(1,Math.ceil(seconds/60)),seconds,
   roads:[...new Set(edges.map(e=>e.name))].join(' → '),habitCount,favoriteRoadCount:edges.filter(e=>favoriteEdges.has(e.id)).length,
   incidentCount:inputs._incidents.items.length,incidentNotice:inputs._incidents.items.length?'已考虑'+inputs._incidents.items.length+'处未处理事件；异常路段避让或增加通行耗时':'',
   congestion:Math.round(edges.reduce((s,e)=>s+scoresForEdge.get(e.id),0)/Math.max(1,edges.length)*100)});
 }
 const strategies=[preference,...['fast','quiet','safe'].filter(p=>p!==preference),...(favoriteEdges.size?['favorite']:[])];
 for(const strategy of strategies){
  const scores={[a]:0},prev={},visited=new Set();let heap=[[0,a]];
  function push(item){heap.push(item);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(heap[p][0]<=item[0])break;heap[i]=heap[p];i=p;}heap[i]=item;}
  function pop(){const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][0]<heap[j][0])j++;if(heap[j][0]>=last[0])break;heap[i]=heap[j];i=j;}heap[i]=last;}return first;}
  while(heap.length){
   const [cost,u]=pop();if(visited.has(u))continue;visited.add(u);if(u===b)break;
   (graph[u]||[]).forEach(({to:v,e})=>{
    const congestion=scoresForEdge.get(e.id),travel=e.length/speed*(1+congestion*(mode==='walk'?.28:1.5));
    const weight=travel*(strategy==='quiet'?1+congestion*3:strategy==='safe'?1+e.risk*3:strategy==='favorite'&&favoriteEdges.has(e.id)?.9:1);
    const next=cost+weight;
    if(scores[v]===undefined||next<scores[v]){scores[v]=next;prev[v]={u,e};push([next,v]);}
   });
  }
  if(a!==b&&!prev[b])continue;
  let cur=b,edges=[],nodes=[b];
  while(cur!==a){const p=prev[cur];if(!p)break;edges.unshift(p.e);cur=p.u;nodes.unshift(cur);}
  build(edges,nodes,strategy);
 }
 // Restore the saved geometry only if every edge remains usable in order.
 function restore(h,strategy){
  let cur=a,edges=[],nodes=[a];
  for(const id of h.edges||[]){const next=(graph[cur]||[]).find(x=>x.e.id===id);if(!next||nodes.includes(next.to))return false;edges.push(next.e);cur=next.to;nodes.push(cur);}
  if(cur!==b||!edges.length)return false;
  build(edges,nodes,strategy);const found=outputs.find(r=>r.edges.join(',')===h.edges.join(','));
  if(strategy==='saved'&&found){found.savedRoute=true;found.label='收藏路线';}
  return true;
 }
 for(const h of history.slice().sort((x,y)=>(y.count||1)-(x.count||1)).slice(0,5))restore(h,'familiar');
 const restored=savedRoute?restore(savedRoute,'saved'):false;
 if(savedRoute&&!restored)outputs.forEach(r=>{r.savedRouteUnavailable=true;r.savedRouteWarning='收藏路线存在封路、道路变化或当前方式限制，已为你重新规划可通行路线';});
 if(!outputs.length)throw new Error('所选地点间暂无连通路线，可更换地点或出行方式');
 const fastest=Math.min(...outputs.map(r=>r.seconds));
 outputs.forEach(r=>{r.memoryRecommended=!!r.habitCount&&r.seconds<=fastest*1.3+60;r.memoryReason=r.habitCount?'你已选择这条路线'+r.habitCount+'次'+(r.memoryRecommended?'，当前可通行，优先推荐':'，本次耗时较长，建议比较其他路线'):r.favoriteRoadCount?'经过'+r.favoriteRoadCount+'个已收藏路段':'';});
 outputs.sort((x,y)=>Number(!!y.savedRoute)-Number(!!x.savedRoute)||Number(y.memoryRecommended)-Number(x.memoryRecommended)||(y.memoryRecommended?(y.habitCount-x.habitCount):0)||Number(y.strategy===preference)-Number(x.strategy===preference)||x.seconds-y.seconds);
 return outputs.slice(0,3);
}
module.exports={route};

