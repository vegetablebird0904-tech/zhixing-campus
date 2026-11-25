function distance(a,b){const rad=Math.PI/180;const dlat=(a.latitude-b.latitude)*rad;const dlon=(a.longitude-b.longitude)*rad;const x=Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlon/2)**2;return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
function nearest(c,p){let best=null,d=Infinity;Object.keys(c.nodes).forEach(id=>{const n=c.nodes[id];const dist=distance(p,{longitude:n[0],latitude:n[1]});if(dist<d){d=dist;best=id;}});return {id:best,distance:d};}
function inCampus(c,p){const b=c.bounds;return p.longitude>=b[0]&&p.longitude<=b[2]&&p.latitude>=b[1]&&p.latitude<=b[3];}
function locate(){return new Promise((resolve,reject)=>wx.getLocation({type:'wgs84',success:resolve,fail:()=>reject(new Error('未获得定位权限；可在地图上选点或从地点列表选择'))}));}
module.exports={distance,nearest,inCampus,locate};
