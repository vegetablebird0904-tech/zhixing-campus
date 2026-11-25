
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getDocument} from './vendor/pdfjs/legacy/build/pdf.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
function rowsOf(items,page){const rows=[];for(const item of items){if(typeof item.str!=='string'||!item.str.trim())continue;const x=item.transform[4],y=item.transform[5],height=Math.abs(item.height)||10;let row=rows.find(r=>Math.abs(r.y-y)<Math.max(2,height*.25));if(!row){row={y,page,items:[]};rows.push(row);}row.items.push({x,width:item.width||0,height,text:item.str});}rows.sort((a,b)=>b.y-a.y);return rows.map(r=>{r.items.sort((a,b)=>a.x-b.x);let text='',last=null;for(const item of r.items){const gap=last?item.x-last.x-last.width:0;text+=(last?(gap>Math.max(4,item.height*.5)?'\t':''):'')+item.text;last=item;}return {page:r.page,y:r.y,text,items:r.items};});}
process.once('message',async workerData=>{
let task,doc,result;
try{
 task=getDocument({data:new Uint8Array(workerData),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWasm:false,cMapUrl:path.join(here,'vendor/pdfjs/cmaps').replace(/\\/g,'/')+'/',cMapPacked:true,standardFontDataUrl:path.join(here,'vendor/pdfjs/standard_fonts').replace(/\\/g,'/')+'/',enableXfa:false,verbosity:0});
 doc=await task.promise;if(doc.numPages>20)throw new Error('PDF最多20页，请拆分后导入');let rows=[],chars=0;
 for(let number=1;number<=doc.numPages;number++){const page=await doc.getPage(number),content=await page.getTextContent();if(content.items.length>60000)throw new Error('PDF单页内容过于复杂');const viewport=page.getViewport({scale:1});const items=content.items.map(item=>{if(!item.transform)return item;const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);return {...item,transform:[...item.transform.slice(0,4),x,viewport.height-y]};});const extracted=rowsOf(items,number);chars+=extracted.reduce((s,r)=>s+r.text.length,0);if(chars>400000)throw new Error('PDF文字超过导入上限');rows.push(...extracted);page.cleanup();}
 const text=rows.map(r=>r.text).join('\n');if(text.replace(/\s/g,'').length<8)throw new Error('此PDF没有可提取的文字，可能是扫描件；请先OCR转成可搜索PDF或CSV再导入');result={ok:true,pages:doc.numPages,rows,text};
}catch(error){result={ok:false,error:error.name==='PasswordException'?'PDF已加密，请先解密后导入':error.message||'PDF解析失败'};}finally{try{if(doc)await doc.destroy();else if(task)await task.destroy();}catch{result={ok:false,error:'PDF资源释放异常，请重试或更换文件'};}}
process.send(result,()=>{if(process.connected)process.disconnect();});
});
