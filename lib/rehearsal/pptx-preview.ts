/// <reference types="vite/client" />
import {MAX_R2_DECK_BYTES} from './media-transfer';
import PreviewWorker from './pptx-preview.worker?worker';
import {strFromU8,unzipSync} from 'fflate';
import {pptxSlideOrder} from './pptx';
import type {Presentation,Slide} from '@web-ppt/core';

const MiB=1024*1024;
export const MAX_PPTX_BYTES=MAX_R2_DECK_BYTES;
const IMAGE_LIMIT=220*1024;
const CJK=/[\u2e80-\u9fff\uf900-\ufaff]/u;
const fallbackFonts=['Noto Sans CJK SC','Noto Sans SC','Microsoft YaHei','PingFang SC','Droid Sans Fallback','sans-serif'];

export type PreviewPage={path:string;sourceId:string;warnings:string[];error?:string;image?:Blob;width?:number;height?:number};
type SourcePage={path:string;sourceId:string;reasons:string[];warnings:string[];hasText:boolean;hasPicture:boolean;hasChart:boolean;hasTable:boolean};
export type PreviewInspection={pages:SourcePage[];expandedBytes:number};
const externalMedia=/<(?:\w+:)?Relationship\b(?=[^>]*\bTargetMode=["']External["'])(?![^>]*\/hyperlink["'])[^>]*>/i;

export function inspectPreviewPackage(data:Uint8Array):PreviewInspection {
 if(data.length>MAX_PPTX_BYTES)throw new Error('原始 PPTX 不能超过 50 MiB。');
 const order=pptxSlideOrder(data);
 let expandedBytes=0,xmlBytes=0,entries=0;
 const relevant=unzipSync(data,{filter:file=>{
  expandedBytes+=file.originalSize;
  if(++entries>6000||file.originalSize>32*MiB||expandedBytes>96*MiB)throw new Error('PPTX 解压预算超限，请压缩图片或拆分文件。');
  const needed=/^ppt\/(?:slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.rels|(?:slideLayouts|slideMasters|charts)\/_rels\/[^/]+\.rels|charts\/[^/]+\.xml)$/.test(file.name);
  if(needed){
   xmlBytes+=file.originalSize;
   if(xmlBytes>10*MiB)throw new Error('PPTX 页面结构过大，请拆分文件。');
  }
  return needed;
 }});
 const sharedExternal=Object.entries(relevant).some(([key,value])=>!key.startsWith('ppt/slides/')&&key.endsWith('.rels')&&externalMedia.test(strFromU8(value)));
 const advancedChart=/<(?:\w+:)?(?:surfaceChart|surface3DChart|bubbleChart|radarChart|stockChart|ofPieChart|pie3DChart|bar3DChart|area3DChart|line3DChart)\b/i;
 const advancedChartParts=new Set(Object.entries(relevant).filter(([path,value])=>
  path.startsWith('ppt/charts/')&&path.endsWith('.xml')&&advancedChart.test(strFromU8(value))).map(([path])=>path));
 const ids=new Set<string>();
 const pages=order.map(({path,id})=>{
  if(!/^\d{1,10}$/.test(id)||ids.has(id))throw new Error('PPTX 页面身份重复或无效。');
  ids.add(id);
  const source=relevant[path];
  if(!source)throw new Error('PPTX 缺少声明的页面文件。');
  const xml=strFromU8(source),rels=strFromU8(relevant[path.replace('/slides/','/slides/_rels/')+'.rels']??new Uint8Array());
  if(/<!DOCTYPE|<!ENTITY/i.test(xml+rels))throw new Error('PPTX 含不受支持的 XML 声明。');
  const reasons:string[]=[],warnings:string[]=[];
  if(sharedExternal||externalMedia.test(rels))reasons.push('包含外部媒体或数据链接');
  if(/<(?:\w+:)?(?:oleObj|control|videoFile|audioFile|relIds|oMath|oMathPara|model3d)\b/i.test(xml))reasons.push('包含嵌入对象、媒体、公式、三维模型或 SmartArt');
  const chartLinks=[...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*\bType\s*=\s*["'][^"']+\/chart(?:Ex)?["'][^>]*>/gi)];
  const unsupportedChart=chartLinks.some(([relationship])=>{
   if(/\/chartEx["']/i.test(relationship))return true;
   const target=/\bTarget\s*=\s*(["'])(.*?)\1/.exec(relationship)?.[2];
   if(!target)return true;
   try{return advancedChartParts.has(new URL(target,'https://pptx.invalid/'+path).pathname.slice(1));}
   catch{return true;}
  });
  if(unsupportedChart)reasons.push('包含超出本次验证范围的图表');
  if(/<(?:\w+:)?(?:timing|transition)\b/i.test(xml))warnings.push('动画或切换已按静态页面处理');
  return {path,sourceId:id,reasons,warnings,hasText:/<(?:\w+:)?t(?:\s[^>]*)?>[^<\s]/i.test(xml),
   hasPicture:/<(?:\w+:)?pic\b/i.test(xml),hasChart:chartLinks.length>0,hasTable:/<(?:\w+:)?tbl\b/i.test(xml)};
 });
 return {pages,expandedBytes};
}

function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('操作已取消','AbortError');}
function parsePresentation(worker:Worker,data:Uint8Array,signal?:AbortSignal) {
 checkAbort(signal);
 return new Promise<Presentation>((resolve,reject)=>{
  const finish=(error?:Error,presentation?:Presentation)=>{
   clearTimeout(timer);
   signal?.removeEventListener('abort',abort);
   worker.onmessage=null;
   worker.onerror=null;
   if(error)reject(error);
   else resolve(presentation!);
  };
  const abort=()=>finish(new DOMException('操作已取消','AbortError'));
  const fail=()=>finish(new Error('浏览器渲染进程已中断。请重试或拆分 PPTX。'));
  const timer=setTimeout(fail,60000);
  signal?.addEventListener('abort',abort,{once:true});
  worker.onerror=fail;
  worker.onmessage=({data})=>data.error?finish(new Error(data.error)):finish(undefined,data.presentation);
  const bytes=new Uint8Array(data).buffer;
  worker.postMessage(bytes,[bytes]);
 });
}

const rasterSource=/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z0-9+/=]+$/i;
const svgNamespace='http://www.w3.org/2000/svg';
const allowedElements=new Set('svg defs g path rect circle ellipse line polyline polygon text tspan textPath image a title desc clipPath mask linearGradient radialGradient stop pattern marker filter feBlend feColorMatrix feComponentTransfer feComposite feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feOffset feMorphology'.split(' '));
function blobData(blob:Blob):Promise<string>{
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error('嵌入图片读取失败。'));
  reader.onload=()=>resolve(String(reader.result));
  reader.readAsDataURL(blob);
 });
}
async function safeSvg(markup:string) {
 if(markup.length>24*MiB||/<!DOCTYPE|<!ENTITY/i.test(markup))throw new Error('页面 SVG 超出安全预算。');
 const xml=new DOMParser().parseFromString(markup,'image/svg+xml');
 if(xml.documentElement.namespaceURI!==svgNamespace||xml.querySelector('parsererror'))throw new Error('渲染器返回无效 SVG。');
 const embedded=new Map<string,string>();
 let imageBytes=0;
 for(const node of Array.from(xml.documentElement.querySelectorAll('*')).concat(xml.documentElement)){
  if(node.localName==='style'){node.remove();continue;}
  if(node.namespaceURI!==svgNamespace||!allowedElements.has(node.localName))throw new Error('页面包含无法安全光栅化的对象。');
  for(const attr of Array.from(node.attributes)){
   const {localName,value}=attr;
   if(/^on/i.test(localName)||localName==='base'){node.removeAttributeNode(attr);continue;}
   if(localName==='href'||localName==='src'){
    if(node.localName==='a'){node.removeAttributeNode(attr);continue;}
    if(node.localName==='image'){
     if(value.startsWith('blob:'+location.origin+'/')){
      let cached=embedded.get(value);
      if(!cached){
       const response=await fetch(value),blob=await response.blob();
       imageBytes+=blob.size;
       if(!response.ok||imageBytes>16*MiB)throw new Error('本页嵌入图片超过渲染预算。');
       cached=await blobData(blob);embedded.set(value,cached);
      }
      if(!rasterSource.test(cached))throw new Error('需要手动修复的矢量或特殊图片格式。');
      attr.value=cached;
     }else if(!rasterSource.test(value))throw new Error('页面包含外部或不支持的图片资源。');
     continue;
    }
    if(!/^#[A-Za-z0-9_.:-]+$/.test(value))throw new Error('页面引用了外部资源。');
   }
   if(localName==='style'&&/[@\\]|(?:expression|behavior|-moz-binding)\s*[:(]/i.test(value))throw new Error('页面样式超出安全渲染范围。');
   if(/url\s*\(/i.test(value)&&/url\s*\(/i.test(value.replace(/url\(\s*['"]?#[A-Za-z0-9_.:-]+['"]?\s*\)/gi,'')))throw new Error('页面样式包含外部资源。');
  }
 }
 return xml;
}

function availableCjk(ctx:CanvasRenderingContext2D){
 ctx.canvas.width=44;ctx.canvas.height=44;
 const glyph=(char:string)=>{
  ctx.clearRect(0,0,44,44);ctx.font='32px '+fallbackFonts.map(x=>x==='sans-serif'?x:'"'+x+'"').join(',');
  ctx.fillText(char,2,36);return ctx.getImageData(0,0,44,44).data;
 };
 const a=glyph('清'),b=glyph('田');
 return a.some((v,i)=>v!==b[i]);
}
function setFonts(slide:Slide,ctx:CanvasRenderingContext2D){
 const missing=new Set<string>();
 const tested=new Map<string,boolean>();
 let cjk=false;
 const hasFont=(font:string)=>{
  if(tested.has(font))return tested.get(font)!;
  const fontName=font.replace(/["<>\\]/g,''),token='MmiI09Ww';
  const test=(generic:string)=>{
   ctx.font='24px '+generic;const fallback=ctx.measureText(token).width;
   ctx.font='24px "'+fontName+'",'+generic;return fallback!==ctx.measureText(token).width;
  };
  const available=/^(sans-serif|serif|monospace|system-ui)$/i.test(font)||test('monospace')||test('serif');
  tested.set(font,available);return available;
 };
 function walk(value:unknown){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(walk);return;}
  const run=value as {text?:string;fonts?:string[]};
  if(typeof run.text==='string'&&Array.isArray(run.fonts)){
   cjk ||= CJK.test(run.text);
   const fonts=run.fonts.filter(font=>typeof font==='string'&&font.length<128&&!/[;<>\\]/.test(font));
   if(fonts[0]&&!hasFont(fonts[0]))missing.add(fonts[0]);
   run.fonts=[...new Set([...fonts,...fallbackFonts])];
  }
  Object.values(value).forEach(walk);
 }
 walk(slide.elements);
 return {cjk,missing};
}

async function rasterize(xml:Document,w:number,h:number,signal?:AbortSignal) {
 const ratio=Math.min(1.75,1440/Math.max(w,h));
 const width=Math.round(w*ratio),height=Math.round(h*ratio);
 if(width<100||height<100||width*height>2.1e6)throw new Error('预览尺寸超出浏览器可安全处理的范围。');
 const root=xml.documentElement;
 root.setAttribute('width',String(width));root.setAttribute('height',String(height));
 const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(xml)],{type:'image/svg+xml'}));
 const canvas=document.createElement('canvas');
 try {
  const img=new Image();img.src=url;await img.decode();checkAbort(signal);
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('浏览器无法分配页面画布。');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.drawImage(img,0,0,width,height);
  for(const quality of [.9,.8,.68,.56]){
   const image=await new Promise<Blob|null>(done=>canvas.toBlob(done,'image/jpeg',quality));
   if(image&&image.type==='image/jpeg'&&image.size<=IMAGE_LIMIT)return {image,width,height};
  }
  throw new Error('页面图片压缩后仍过大，请修复此页。');
 } finally {URL.revokeObjectURL(url);canvas.width=0;canvas.height=0;}
}

export async function renderPptxPreviews(file:Blob,options:{
 signal?:AbortSignal;cached?:ReadonlyMap<string,PreviewPage>;onPage:(page:PreviewPage,index:number,total:number)=>void|Promise<void>
}){
 const {signal,onPage,cached}=options;
 checkAbort(signal);
 if(file.size>MAX_PPTX_BYTES)throw new Error('原始 PPTX 不能超过 50 MiB。');
 const data=new Uint8Array(await file.arrayBuffer()),inspection=inspectPreviewPackage(data);
 const pages:PreviewPage[]=[];
 const worker=new PreviewWorker();
 let presentation:Presentation|undefined;
 try{
  presentation=await parsePresentation(worker,data,signal);
  if(presentation.slides.length!==inspection.pages.length||presentation.slides.some((s,i)=>s.editInfo?.origin.part!==inspection.pages[i].path))throw new Error('渲染器读取的页数与原始 PPTX 不一致。');
  if(!Number.isFinite(presentation.width)||!Number.isFinite(presentation.height)||presentation.width<=0||presentation.height<=0)throw new Error('PPTX 页面尺寸无效。');
  const {renderSlideToSvg}=await import('@web-ppt/core');
  const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  if(!ctx)throw new Error('此浏览器无法创建预览画布。');
  const hasCjk=availableCjk(ctx);
  for(const [i,source] of inspection.pages.entries()){
   checkAbort(signal);
   const {path,sourceId}=source;
   const previous=cached?.get(path);
   let page:PreviewPage={path,sourceId,warnings:[...source.warnings]};
   if(previous?.image&&previous.sourceId===sourceId)page=previous;
   else if(source.reasons.length)page.error=source.reasons.join('、')+'，请核对后替换此页预览。';
   else try{
    const slide=presentation.slides[i];
    const fonts=setFonts(slide,ctx);
    if(fonts.cjk&&!hasCjk)throw new Error('浏览器缺少可用的中文字体，请在支持中文字体的设备重试或修复此页。');
    if(fonts.missing.size)page.warnings.push('已替换字体：'+[...fonts.missing].slice(0,5).join('、')+'。请核对换行。');
    const xml=await safeSvg(renderSlideToSvg({...presentation,embeddedFonts:undefined},slide,{textMode:'svg',idPrefix:'studio-ppt'}));
    if(source.hasText&&!xml.querySelector('text')||source.hasPicture&&!xml.querySelector('image')||
      source.hasTable&&xml.querySelectorAll('text').length<3||source.hasChart&&(xml.querySelectorAll('text').length<4||[...xml.querySelectorAll('text')].some(n=>n.textContent?.trim()==='图表')))throw new Error('预览可能缺失原始文字、图片、表格或图表，请修复此页。');
    Object.assign(page,await rasterize(xml,presentation.width,presentation.height,signal));
   }catch(error){
    checkAbort(signal);page.error=(error as Error).message;
   }
   pages.push(page);await onPage(page,i,inspection.pages.length);
   await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  return {pages,expandedBytes:inspection.expandedBytes};
 }finally{presentation?.dispose?.();worker.terminate();}
}
