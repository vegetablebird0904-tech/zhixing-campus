'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const blank=()=>({routeHistory:[],preferenceUsage:{},routeFavorites:[],placeFavorites:[],roadFavorites:[]});
async function openPreferences(file){
  await fs.mkdir(path.dirname(file),{recursive:true});
  let data={users:{}};
  try{data=JSON.parse(await fs.readFile(file,'utf8'));if(!data||typeof data.users!=='object')throw new Error('invalid preferences');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  let queue=Promise.resolve();
  const write=transform=>{const job=queue.then(async()=>{const next=await transform(data),tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(next,null,2),{flag:'wx'});await fs.rename(tmp,file);data=next;return next;}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}});queue=job.catch(()=>{});return job;};
  return {get:id=>data.users[id]||blank(),save:(id,value)=>write(state=>({...state,users:{...state.users,[id]:value}}))};
}
module.exports={openPreferences};
