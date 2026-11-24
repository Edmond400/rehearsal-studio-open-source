import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {join,resolve} from 'node:path';

// This test is exclusively for the local Wrangler Worker and synthetic D1.
// Never modify this guard to accept a remote Cloudflare host.
const origin=new URL(process.env.STUDIO_TEST_ORIGIN??'http://127.0.0.1:8794');
assert(['127.0.0.1','localhost'].includes(origin.hostname),'Scale acceptance must use loopback');
const {chromium}=await import(process.env.STUDIO_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1280,height:844}});
const page=await context.newPage();
page.setDefaultTimeout(60000);
const errors=[];
const fetchedSlidePaths=new Set();
page.on('pageerror',e=>errors.push(e.message));
page.on('request',request=>{
 try{
  const path=new URL(request.url()).pathname;
  if(/^\/api\/rehearsal\/(?:edit\/)?slides\/[^/]+$/.test(path))fetchedSlidePaths.add(path);
 }catch{}
});
const screenshots=resolve(process.env.STUDIO_V15_SCREENSHOTS??'/tmp/rehearsal-v15-evidence');
await mkdir(screenshots,{recursive:true});

async function api(path,options={}) {
 return page.evaluate(async ({path,options})=>{
  const response=await fetch(path,options);
  const body=await response.text();
  return {status:response.status,body};
 },{path,options});
}
async function draft(id){
 const reply=await api('/api/rehearsal/edit/draft',{headers:{'X-Studio-Project':id}});
 assert.equal(reply.status,200,'Read synthetic draft: '+reply.body.slice(0,300));
 return JSON.parse(reply.body).project;
}
try {
 await page.goto(origin.href);
 // Create through the actual challenge endpoint, using a locally computed
 // 16-bit proof to avoid costly UI hashing during this 200-slide stress run.
 const challenge=await api('/api/projects/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(challenge.status,200,'Synthetic challenge failed: '+challenge.body.slice(0,300));
 const nonce=JSON.parse(challenge.body).nonce;
 let solution='';
 for(let i=0;i<3000000;i++){
  const digest=createHash('sha256').update(nonce+':'+i).digest();
  if(digest[0]===0&&digest[1]===0){solution=String(i);break}
 }
 assert(solution,'Synthetic creation proof not found');
 const body=JSON.stringify({title:'V15 200页500片段压力验收',seconds:900,code:'0426',admin_password:'12345678',visibility:'unlisted',challenge:nonce,solution,request_id:randomBytes(32).toString('hex')});
 let created;
 for(let attempt=0;attempt<3;attempt++){
  created=await api('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body});
  if(created.status===201)break;
  const proxy503=created.status===503&&created.body.startsWith('Your worker restarted mid-request.');
  assert(proxy503&&attempt<2,'Project creation HTTP '+created.status+': '+created.body.slice(0,250));
 }
 const id=JSON.parse(created.body).project_id;
 assert.match(id,/^[a-zA-Z0-9_-]+$/);
 const png=await readFile(resolve('tests/fixtures/rehearsal-reading/slide1.png'));
 const encoded=png.toString('base64');
 const slides=[];
 const uploadStart=performance.now();
 // Five modest concurrent uploads per batch minimize local SQLite contention.
 // A failed POST aborts: uploaded files have no idempotent retry guarantee.
 for(let batch=0;batch<40;batch++){
  const received=await page.evaluate(async({id,encoded})=>{
   const bytes=Uint8Array.from(atob(encoded),x=>x.charCodeAt(0));
   return Promise.all(Array.from({length:5},async()=>{
    const reply=await fetch('/api/rehearsal/edit/slides',{method:'POST',
     headers:{'X-Studio-Project':id,'Content-Type':'image/png'},body:bytes,
     signal:AbortSignal.timeout(30000)});
    const body=await reply.text();
    if(reply.status!==200)throw Error('Synthetic slide HTTP '+reply.status+': '+body.slice(0,220));
    return JSON.parse(body);
   }));
  },{id,encoded});
  slides.push(...received);
  if(batch===0 || batch%5===4)
   console.log(JSON.stringify({status:'SCALE-UPLOAD-PROGRESS',uploaded:slides.length,elapsedMs:Math.round(performance.now()-uploadStart)}));
  if(performance.now()-uploadStart>240000)throw new Error('200-slide local upload exceeded 240 seconds; actual bottleneck must be investigated');
 }
 assert.equal(slides.length,200);
 assert.equal(new Set(slides.map(s=>s.id)).size,200);
 const old=await draft(id);
 const memberId='scale-member';
 const document={
  revision:old.revision,title:old.title,theme:old.theme,status:'draft',publishedAt:null,
  members:[{id:memberId,name:'合成演讲人',enabled:true}],
  blocks:Array.from({length:500},(_,i)=>({
   id:'block-'+i,paragraphId:'para-'+i,text:'第'+(i+1)+'段独立讲稿。这里验证二百页PPT与五百片段的交叉对应关系。',
   memberId,nonspoken:false,slideIndex:i%200,paragraphEnd:true
  })),
  slides:slides.map((slide,pageIndex)=>({id:slide.id,mime:slide.mime,bytes:slide.bytes,pageIndex})),
  config:old.config,overrides:{}
 };
 const save=await api('/api/rehearsal/edit/draft',{
  method:'POST',headers:{'X-Studio-Project':id,'Content-Type':'application/json'},
  body:JSON.stringify({base_revision:old.revision,mutation_id:randomUUID(),document})
 });
 assert.equal(save.status,200,'Synthetic 200/500 draft save: '+save.body.slice(0,450));
 const revision=JSON.parse(save.body).project.revision;
 const persisted=await draft(id);
 assert.equal(persisted.slides.length,200);
 assert.equal(persisted.blocks.length,500);
 const renderStart=performance.now();
 await page.goto(new URL('/p/'+id,origin).href);
 await page.getByLabel('项目密码或管理员密码').fill('12345678');
 await page.getByRole('button',{name:'验证并进入'}).click();
 await page.getByRole('button',{name:'材料与编排'}).click();
 await page.locator('.rh-mapping-thumbs .rh-slide-thumb').nth(199).waitFor();
 await page.locator('.rh-full-script [data-block-id]').nth(499).waitFor();
 const renderMs=Math.round(performance.now()-renderStart);
 assert(renderMs<45000,'200/500 browser render exceeded 45 seconds');
 assert.equal(await page.locator('.rh-mapping-thumbs .rh-slide-thumb').count(),200);
 assert.equal(await page.locator('.rh-full-script [data-block-id]').count(),500);
 const lazyImages=await page.locator('.rh-mapping-thumbs img').count();
 assert(lazyImages<200,'All 200 thumbnails loaded eagerly');
 const initialSlideDownloads=fetchedSlidePaths.size;
 assert(initialSlideDownloads<80,'Long saved-page gallery initiated too many offscreen image downloads: '+initialSlideDownloads);
 await page.getByRole('button',{name:'查看PPT第200页'}).click();
 await page.locator('.rh-linked-active').first().waitFor();
 assert.equal(await page.locator('.rh-linked-active').count(),2,'Slide 200 must highlight both mapped script segments');
 assert.equal((await draft(id)).revision,revision,'Read-only selection unexpectedly wrote draft');
 await page.screenshot({path:join(screenshots,'scale-200-500-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'200-page mobile horizontal overflow');
 assert.equal(await page.locator('.rh-mapping-thumbs .rh-slide-thumb').count(),200);
 await page.screenshot({path:join(screenshots,'scale-200-500-mobile.png')});
 assert.deepEqual(errors,[],'Scale browser runtime errors');
 console.log(JSON.stringify({status:'PASS',test:'200 slides / 500 blocks actual browser',project:id,
  uploadMs:Math.round(performance.now()-uploadStart),renderMs,lazyImages,initialSlideDownloads,
  slideCount:200,blockCount:500,changedByReadOnly:false}));
}finally{await browser.close()}
