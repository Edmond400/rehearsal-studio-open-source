import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {strFromU8,unzipSync,zipSync} from 'fflate';

const origin=new URL(process.env.STUDIO_TEST_ORIGIN??'http://127.0.0.1:8794');
assert.ok(['127.0.0.1','localhost'].includes(origin.hostname),'This test writes to an isolated loopback server only');
const {chromium}=await import(process.env.STUDIO_PLAYWRIGHT_MODULE??'playwright');
const fixtures=process.env.STUDIO_PPTX_FIXTURES??await mkdtemp(join(tmpdir(),'studio-e5-fixtures-'));
if(!process.env.STUDIO_PPTX_FIXTURES)execFileSync('python',['tests/generate-pptx-render-fixtures.py',fixtures]);
const output=process.env.STUDIO_WORKFLOW_SCREENSHOT;
const browser=await chromium.launch({executablePath:process.env.STUDIO_CHROMIUM,args:[
 '--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'
]});
const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone'],isMobile:true,hasTouch:true});
let page;
const interruptedPosts=new Set();
const issues=[];
const projectCode='0042';
const button=name=>page.getByRole('button',{name,exact:true});
const shown=(query)=>query.waitFor({state:'visible',timeout:20000});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function response(path,method='POST'){
 return page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method,{timeout:30000});
}
async function poll(fn,predicate){
 let value;
 for(let i=0;i<50;i++){value=await fn();if(predicate(value))return value;await delay(200);}
 assert.fail('State not reached: '+JSON.stringify(value).slice(0,700));
}
async function open(path){
 page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',error=>issues.push(error.message));
 page.on('dialog',dialog=>dialog.accept());
 await page.goto(new URL(path,origin).href);
}
async function get(path,id){
 return page.evaluate(async ({path,id})=>{
  const response=await fetch(path,{headers:{'X-Studio-Project':id}});
  if(!response.ok)throw Error('GET '+path+' returned '+response.status);
  return response.json();
 },{path,id});
}
async function editor(path){
 await open(path);
 await page.getByLabel('项目密码或管理员密码').fill(projectCode);
 await button('验证并进入').click();
 await button('材料与编排').click();
 await shown(page.getByLabel('汇报标题'));
}
async function brush(){
 await page.getByLabel('全文分工区域').evaluate(container=>{
  const range=document.createRange();range.selectNodeContents(container);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  container.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
 });
}
try{
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin.origin)return route.abort();
  if(request.method()==='POST'&&interruptedPosts.has(url.pathname))return route.abort('internetdisconnected');
  return route.continue();
 });
 await open('/');
 await button('创建汇报').click();
 await page.getByLabel('汇报名称').fill('隔离浏览器工作流');
 await page.getByLabel('四位项目密码').fill(projectCode);
 await page.getByLabel('管理员密码',{exact:true}).fill('Fixture#E5Test2026');
 await page.getByLabel('隐藏汇报，仅通过分享链接加入').check();
 const creation=response('/api/projects');
 await button('创建并进入').click();
 const created=await creation;
 assert.ok(created.ok(),'create: '+await created.text());
 const id=(await created.json()).project_id;
 assert.ok(id);
 const draft=async()=>(await get('/api/rehearsal/edit/draft',id)).project;
 const deckEntries=unzipSync(await readFile(join(fixtures,'deck-02.pptx')));
 const padded=zipSync({...deckEntries,'ppt/media/workflow-padding.bin':[new Uint8Array(320*1024),{level:0}]});
 await page.getByLabel('上传 PPTX',{exact:true}).setInputFiles({name:'deck-02.pptx',
  mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',buffer:Buffer.from(padded)});
 await shown(page.getByText(/全部 3 页已生成/));
 const before=await draft();
 let staged=0;
 const interruptedPart=/\/api\/rehearsal\/uploads\/[^/]+\/1$/;
 await page.route(interruptedPart,route=>route.abort('internetdisconnected'));
 await button('应用全部预览到草稿').click();
 await shown(page.getByRole('alert').filter({hasText:/fetch|网络|上传未完成/i}));
 const midway=await get('/api/rehearsal/edit/draft',id);
 assert.equal(midway.project.revision,before.revision);
 await page.unroute(interruptedPart);
 let partZeroAgain=false;
 const firstPart=/\/api\/rehearsal\/uploads\/[^/]+\/0$/;
 await page.route(firstPart,route=>{partZeroAgain=true;return route.continue();});
 const stage='**/api/rehearsal/edit/preview-page';
 await page.route(stage,route=>++staged===2?route.abort('internetdisconnected'):route.continue());
 await button('应用全部预览到草稿').click();
 await shown(page.getByRole('alert').last());
 assert.equal(staged,2);
 assert.equal((await draft()).revision,before.revision);
 assert.equal((await draft()).slides.length,0);
 await page.close();
 await editor('/p/'+id);
 await button('恢复 deck-02.pptx').click();
 await shown(page.getByText(/全部 3 页已生成/));
 let retried=0;
 await page.route(stage,route=>{retried++;return route.continue();});
 await button('应用全部预览到草稿').click();
 await shown(page.getByText(/全部 3 页已应用/));
 assert.equal(retried,2);
 const saved=await draft();
 assert.equal(saved.slides.length,3);
 assert.deepEqual(saved.slides.map(slide=>slide.sourceId),['256','257','258']);
 assert.ok(saved.sourceDeck.id);
 if(output)await page.screenshot({path:output,fullPage:true});
 assert.equal(partZeroAgain,false);
 console.log('PPTX: interrupted original resumed at its second block; interrupted after one staged page; IndexedDB reopen; two remaining uploads; three ordered pages saved atomically');

 const title=page.getByLabel('汇报标题');
 await title.dispatchEvent('compositionstart',{data:''});
 await title.fill('隔离测试·中文输入组合');
 await delay(3400);
 assert.equal((await draft()).revision,saved.revision);
 await title.dispatchEvent('compositionend',{data:'中文输入组合'});
 const composed=await poll(draft,p=>p.title==='隔离测试·中文输入组合');
 assert.ok(composed.revision>saved.revision);

 interruptedPosts.add('/api/rehearsal/edit/draft');
 await title.fill('隔离测试·恢复草稿');
 await shown(page.getByText(/连接中断/).first());
 await page.close();
 await editor('/p/'+id);
 assert.equal((await draft()).title,composed.title);
 interruptedPosts.delete('/api/rehearsal/edit/draft');
 await button('与当前版本核对并恢复').click();
 await poll(draft,p=>p.title==='隔离测试·恢复草稿');
 console.log('Draft: synthetic composition events delay autosave; offline edit survives tab close in IndexedDB and is saved after explicit recovery');

 await page.getByLabel(/添加组员（/).fill('测试组员');
 await button('添加到小组名册').click();
 await page.getByLabel('或直接粘贴原稿').fill('这是中文汇报工作流的讲稿。下一页展示测试材料。');
 await button('提取自然段，开始分工').click();
 await button('测试组员').click();
 await brush();
 await button('PPT页关联').click();
 await button('PPT第1页').click();
 await brush();
 await button('检查并发布').click();
 await shown(page.getByText('已发布当前草稿。',{exact:true}));
 await button('个人练习').click();
 await button('测试组员').click();
 await button('开始录音').click();
 await shown(button('结束录音'));
 await delay(3000);
 await button('下一页').click();
 await shown(page.getByText('PPT 2 / 3',{exact:true}));
 await button('暂停').click();
 await shown(page.getByText(/已暂停，有效计时停止/));
 await delay(1200);
 await button('继续').click();
 const holdMs=Number(process.env.STUDIO_RECORD_HOLD_MS??120000);
 console.log('MediaRecorder: recording with Chromium fake microphone, page change and pause/resume observed');
 await delay(holdMs);
 await button('结束录音').click();
 await shown(button('直接提交'));
 const dialog=page.getByRole('dialog');
 const recordingRoute='/api/rehearsal/uploads';
 interruptedPosts.add(recordingRoute);
 await button('直接提交').click();
 await shown(dialog.getByRole('alert'));
 interruptedPosts.delete(recordingRoute);
 const upload=page.waitForResponse(r=>/\/api\/rehearsal\/uploads\/[^/]+\/finish$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST',{timeout:30000});
 await button('直接提交').click();
 const uploaded=await upload;
 assert.ok(uploaded.ok(),'audio upload: '+await uploaded.text());
 await shown(page.getByText(/服务端已完整保存本次录音/));
 const memberView=await get('/api/rehearsal',id);
 assert.equal(memberView.recordings.length,1);
 const take=memberView.recordings[0];
 assert.ok(take.durationMs>=holdMs);
 if(holdMs>=120000)assert.ok(take.bytes>512*1024,'Exercise playback of more than one D1 audio chunk');
 assert.deepEqual(take.events.map(event=>event.slide_index),[0,1]);
 await button('全组回放').click();
 let audioRequests=0;
 await page.route('**/api/rehearsal/audio/**',async route=>{
  if(++audioRequests===1)await delay(900);
  await route.continue();
 });
 const session=response('/api/rehearsal/playback/session');
 await button('开始整场回放').click();
 const manifest=await session;
 assert.ok(manifest.ok(),'manifest: '+await manifest.text());
 assert.equal((await manifest.json()).recordings[0].id,take.id);
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('audio')).some(audio=>audio.currentTime>0.2&&!audio.paused),{},{timeout:15000});
 assert.ok(audioRequests>0);
 await shown(page.getByRole('heading',{name:'PPT 第2页 / 3页'}));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const download=page.waitForEvent('download',{timeout:15000});
 await button('一键下载汇报版PPT').click();
 const exported=unzipSync(await readFile(await (await download).path()));
 const original=unzipSync(await readFile(join(fixtures,'deck-02.pptx')));
 for(const slide of saved.slides)assert.deepEqual(exported[slide.sourcePage],original[slide.sourcePage]);
 const notes=Object.entries(exported).filter(([name])=>/^ppt\/notesSlides\/[^/]+\.xml$/.test(name))
  .map(([,bytes])=>strFromU8(bytes)).filter(xml=>xml.includes('测试组员：这是中文汇报工作流的讲稿。'));
 assert.equal(notes.length,1);
 console.log('PPTX export: browser download preserves original slide XML and adds mapped Chinese notes to one slide');
 assert.deepEqual(issues,[]);
 console.log(JSON.stringify({browser:browser.version(),viewport:'390×844 touch simulation',durationMs:take.durationMs,
  audioBytes:take.bytes,slides:take.events.map(event=>event.slide_index),playback:'decoded after delayed audio response; recorded page change replayed',pageErrors:issues}));
}catch(error){
 if(page)console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-4500));
 throw error;
}finally{await browser.close();}
