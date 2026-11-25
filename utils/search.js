const campus = require('../data/campus').west;
const { nearest } = require('./geo');
function clean(name) { return String(name || '').replace(/山东理工大学|山东理工|（西校区）|\(西校区\)|西校区/g, '').replace(/^[·\s(（]+|[)）\s]+$/g, '').trim(); }
function normalize(text) { return clean(text).toLowerCase().replace(/[\s号第楼栋·()（）-]/g, '').replace(/一/g,'1').replace(/二/g,'2').replace(/三/g,'3').replace(/四/g,'4').replace(/五/g,'5').replace(/六/g,'6').replace(/七/g,'7').replace(/八/g,'8').replace(/九/g,'9'); }
function aliases(name) {
 const list=[name];if(/图书馆|逸夫/.test(name))list.push('图书馆','图书','逸夫楼','library');
 const num=name.match(/(\d+)号教学楼/);if(num)list.push(num[1]+'教',num[1]+'号楼','教学'+num[1]);
 if(/餐|食堂/.test(name))list.push('食堂','餐厅');if(/体育场/.test(name))list.push('操场','运动场');
 if(/南门/.test(name))list.push('南门');if(/北门/.test(name))list.push('北门');return list;
}
const places=campus.pois.map(p=>Object.assign({},p,{name:clean(p.name),aliases:aliases(p.name)}));
function search(query,limit=12) {
 const q=normalize(query);if(!q)return [];const teaching=q.match(/^(\d+)教(?:学)?$/);
 const coordinates=String(query).match(/^\s*(\d{2}\.\d+)\s*[,，]\s*(\d{3}\.\d+)\s*$/);
 if(coordinates){const p={latitude:Number(coordinates[1]),longitude:Number(coordinates[2]),name:'坐标位置'};return [Object.assign(p,{node:nearest(campus,p).id,id:'coordinates'})];}
 return places.filter(p=>!teaching||new RegExp('^'+teaching[1]+'号教学楼').test(p.name)).map(p=>{const n=normalize(p.name),labels=p.aliases.map(normalize);let score=n===q?100:n.startsWith(q)?80:n.includes(q)?65:labels.some(a=>a===q)?85:labels.some(a=>a.includes(q))?55:0;
  if(!score){let found=0;for(const ch of q)if(n.includes(ch))found++;if(found===q.length)score=35;}
  return {p,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.p.name.length-b.p.name.length).slice(0,limit).map(x=>x.p);
}
function resolve(query) {const hits=search(query);if(!hits.length)throw new Error('未找到“'+query+'”，请试试楼号、图书馆、食堂等关键词');if(hits.length===1||normalize(hits[0].name)===normalize(query)||normalize(hits[0].aliases[0])===normalize(query))return hits[0];return null;}
module.exports={clean,normalize,search,resolve,places};
