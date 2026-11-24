import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile,mkdir,mkdtemp,writeFile,copyFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[dirname(require.resolve('wrangler/package.json'))]}));
const browserModule=process.env.STUDIO_PLAYWRIGHT_MODULE??'playwright';
const {chromium}=await import(browserModule);
const output=resolve(process.env.STUDIO_PPTX_EVIDENCE??await mkdtemp(join(tmpdir(),'studio-pptx-evidence-')));
const fixtures=join(output,'fixtures');
await mkdir(fixtures,{recursive:true});
const inputs=process.argv.slice(2);
if(inputs.length){
 for(const [i,path] of inputs.entries()){
  assert.equal(path.toLowerCase().endsWith('.pptx'),true,'Input must be a PPTX');
  await copyFile(resolve(path),join(fixtures,'input-'+(i+1)+'.pptx'));
 }
}else execFileSync('python',['tests/generate-pptx-render-fixtures.py',fixtures],{stdio:'inherit'});
const app=await build({stdin:{contents:`
 import {renderPptxPreviews} from './lib/rehearsal/pptx-preview';
 window.renderDeck=async (name,cancelAfter=0)=>{
  const input=await (await fetch('/fixtures/'+name)).blob();
  const start=performance.now(),controller=new AbortController();
  let first=0,bytes=0,peakHeap=0;const pages=[];
  try{
   const result=await renderPptxPreviews(input,{signal:controller.signal,onPage:async (p,i)=>{
    if(i===0)first=performance.now()-start;
    bytes+=p.image?.size??0;
    peakHeap=Math.max(peakHeap,performance.memory?.usedJSHeapSize??0);
    const url=p.image?await new Promise(done=>{const r=new FileReader();r.onload=()=>done(r.result);r.readAsDataURL(p.image)}):null;
    pages.push({...p,image:undefined,url});
    if(cancelAfter&&i+1===cancelAfter)controller.abort();
   }});
   return {name,sourceBytes:input.size,previewBytes:bytes,peakHeap,firstMs:Math.round(first),elapsedMs:Math.round(performance.now()-start),expandedBytes:result.expandedBytes,pages};
  }catch(error){return {name,error:error.name+': '+error.message,pages};}
 };
 `,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false,target:'es2022',plugins:[{name:'test-worker-url',setup(build){
 build.onResolve({filter:/\?worker$/},args=>({path:args.path,namespace:'test-worker'}));
 build.onLoad({filter:/.*/,namespace:'test-worker'},()=>({contents:"export default class { constructor(){ return new Worker('/pptx-preview.worker.js',{type:'module'}); } }"}));
}}]});
const worker=await build({entryPoints:['lib/rehearsal/pptx-preview.worker.ts'],bundle:true,format:'esm',write:false,target:'es2022'});
const server=createServer(async (req,res)=>{
 try{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<meta charset="utf-8"><script type="module" src="/app.js"></script>');return;}
  if(req.url==='/app.js'||req.url==='/pptx-preview.worker.js'){res.setHeader('Content-Type','text/javascript');res.end((req.url==='/app.js'?app:worker).outputFiles[0].text);return;}
  if(/^\/fixtures\/[a-z\d-]+\.pptx$/.test(req.url)){res.end(await readFile(join(fixtures,req.url.split('/').at(-1))));return;}
  res.writeHead(404).end();
 }catch{res.writeHead(500).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.STUDIO_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-precise-memory-info']});
try{
 const page=await browser.newPage();
 const unexpected=[];
 await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():(unexpected.push(r.request().url()),r.abort()));
 page.on('pageerror',error=>console.error('browser error',error.message));
 await page.goto(origin);await page.waitForFunction(()=>typeof window.renderDeck==='function');
 if(inputs.length){
  const results=[];
  for(const [i,path] of inputs.entries()){
   const name='input-'+(i+1);
   const data=await page.evaluate(name=>window.renderDeck(name+'.pptx'),name);
   const pages=[];
   for(const [j,{url,...pageResult}] of data.pages.entries()){
    const bytes=url?Buffer.from(url.split(',')[1],'base64'):null;
    if(bytes)await writeFile(join(output,name+'-'+(j+1)+'.jpg'),bytes);
    pages.push({...pageResult,bytes:bytes?.length??0});
   }
   results.push({...data,name:basename(path),pages});
   console.log(name,JSON.stringify({pages:pages.length,rendered:pages.filter(p=>p.bytes).length,firstMs:data.firstMs,elapsedMs:data.elapsedMs,error:data.error}));
  }
  assert.deepEqual(unexpected,[]);
  await writeFile(join(output,'browser-results.json'),JSON.stringify({browser:browser.version(),results},null,2));
 }else{
 const manifest=JSON.parse(await readFile(join(fixtures,'manifest.json'),'utf8')),results=[];
 for(const expected of manifest){
  const data=await page.evaluate(name=>window.renderDeck(name),expected.name);
  const failed=data.pages.filter(p=>!p.url);
  console.log(expected.name, data.pages.length, data.firstMs, data.elapsedMs, data.previewBytes, failed.map(p=>p.error));
  for(const [i,p] of data.pages.entries())if(p.url){
   assert(Math.abs(p.width/p.height-expected.ratio)<.01,'page ratio');
   assert(p.url.startsWith('data:image/jpeg;base64,'));
   const body=Buffer.from(p.url.split(',')[1],'base64');
   assert(body.length>3000,'nonempty preview');
   await writeFile(join(output,expected.name.replace('.pptx','')+'-'+(i+1)+'.jpg'),body);
  }
  const heap=await page.evaluate(()=>performance.memory?.usedJSHeapSize??null);
  results.push({...data,heap,pages:data.pages.map(({url,...p},i)=>({...p,bytes:url?Buffer.from(url.split(',')[1],'base64').length:0,expected:expected.pages[i]}))});
 }
 const rejected=await page.evaluate(()=>window.renderDeck('unsupported-ole.pptx'));
 assert(rejected.pages[0].url);
 assert.match(rejected.pages[1].error,/嵌入对象/);
 assert(!rejected.pages[1].url);
 const mixed=await page.evaluate(()=>window.renderDeck('mixed-charts.pptx'));
 assert(mixed.pages[0].url,'An unsupported chart must not block supported charts on other pages');
 assert.match(mixed.pages[1].error,/超出本次验证范围的图表/);
 assert(!mixed.pages[1].url);
 const canceled=await page.evaluate(()=>window.renderDeck('deck-01.pptx',1));
 assert.match(canceled.error,/AbortError/);
 assert.equal(canceled.pages.length,1);
 assert.deepEqual(unexpected,[]);
 const reordered=await page.evaluate(()=>window.renderDeck('reordered.pptx'));
 assert.deepEqual(reordered.pages.map(p=>p.sourceId),['257','256']);
 assert(reordered.pages.every(p=>p.url));
 const large=await page.evaluate(()=>window.renderDeck('expanded-limit.pptx'));
 assert.match(large.error,/解压预算/);
 assert.equal(large.pages.length,0);
 assert(results[0].pages[0].warnings.some(w=>w.includes('PPT Fixture Unavailable Font')));
 await writeFile(join(output,'browser-results.json'),JSON.stringify({browser:browser.version(),results,rejected:rejected.pages[1].error,mixedChart:[!!mixed.pages[0].url,mixed.pages[1].error],canceled:canceled.error,expanded:large.error,reorder:reordered.pages.map(p=>p.sourceId)},null,2));
 assert(results.every((r,i)=>!r.error&&r.pages.length===manifest[i].pages.length&&r.pages.every(p=>p.bytes>0)), 'baseline decks must render every page');
 }
 console.log('Evidence directory:',output);
}finally{await browser.close();server.close();}
