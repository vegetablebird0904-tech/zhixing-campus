function time(s){const d=new Date(s);if(isNaN(d.getTime()))return s||'';const pad=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());}
function event(e){return Object.assign({},e,{timeText:time(e.createdAt),statusText:e.status==='processed'?'已处理':e.status==='processing'?'处理中':'未处理',campusName:e.campus==='east'?'东校区':'西校区',progress:(e.progress||[]).map(p=>Object.assign({},p,{timeText:time(p.at)}))});}
module.exports={time,event};
