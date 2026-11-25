'use strict';
const https=require('node:https'),dns=require('node:dns/promises'),net=require('node:net');
function publicAddress(value){
 if(net.isIP(value)===4){const n=value.split('.').map(Number);return ![0,10,127].includes(n[0])&&!(n[0]===169&&n[1]===254)&&!(n[0]===172&&n[1]>=16&&n[1]<=31)&&!(n[0]===192&&n[1]===168)&&!(n[0]===100&&n[1]>=64&&n[1]<=127)&&n[0]<224&&!(n[0]===198&&[18,19].includes(n[1]));}
 if(net.isIP(value)===6)return /^2[0-9a-f]{3}:/i.test(value);
 return false;
}
function authorizedUrl(value,configured){
 const validated=require('../utils/education-api').validate(value),url=new URL(validated);
 if(!/^(?:[a-z0-9-]+\.)*sdut\.edu\.cn$/i.test(url.hostname)&&(!configured||validated!==configured))throw new Error('仅支持学校官方授权域名；其他服务地址需由管理员配置并确认授权');
 return url;
}
async function requestEducation(url,token){
 const addresses=await dns.lookup(url.hostname,{all:true});
 if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('接口解析到本机或私有地址，不能读取；请使用学校提供的公网授权课表接口');
 const address=addresses[0];
 return new Promise((resolve,reject)=>{
  const req=https.get(url,{headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})},lookup:(host,options,cb)=>options.all?cb(null,[address]):cb(null,address.address,address.family)},res=>{
   if(res.statusCode!==200){res.resume();reject(new Error(res.statusCode===401||res.statusCode===403?'校园接口未授权或凭证失效，请先获得授权':'课表接口不可用或发生跳转，请填写直接返回课程JSON的接口'));return;}
   const parts=[];let length=0;
   res.on('data',chunk=>{length+=chunk.length;if(length>1024*1024){req.destroy(new Error('课表接口返回内容超过1MB'));return;}parts.push(chunk);});
   res.on('error',reject);res.on('end',()=>resolve(Buffer.concat(parts).toString('utf8')));
  });
  req.setTimeout(10000,()=>req.destroy(new Error('学校课表接口响应超时')));req.on('error',reject);
 });
}
module.exports={authorizedUrl,requestEducation,publicAddress};
