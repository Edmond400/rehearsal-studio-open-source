import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const url=process.env.STUDIO_TEST_ORIGIN??'http://127.0.0.1:8794';
const origin=new URL(url);
assert(['127.0.0.1','localhost'].includes(origin.hostname),'Refuse non-loopback browser test');
const {chromium}=await import(process.env.STUDIO_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',dialog=>void dialog.accept());
page.setDefaultTimeout(30000);
const screenshots=resolve(process.env.STUDIO_V15_SCREENSHOTS??'/tmp/rehearsal-v15-evidence');
await mkdir(screenshots,{recursive:true});
const btn=name=>page.getByRole('button',{name,exact:true});
const wait=ms=>new Promise(done=>setTimeout(done,ms));
async function current(id){
 return page.evaluate(async id=>{
  const response=await fetch('/api/rehearsal/edit/draft',{headers:{'X-Studio-Project':id}});
  if(!response.ok)throw Error('draft HTTP '+response.status);
  return (await response.json()).project;
 },id);
}
async function until(fn,predicate,description){
 for(let i=0;i<80;i++){const value=await fn();if(predicate(value))return value;await wait(250);}
 throw new Error('Timed out: '+description);
}
async function brush(){
 const area=page.getByLabel('全文分工区域');
 await area.evaluate(node=>{
  const first=node.querySelector('[data-block-id]');
  if(!first)throw Error('No script block');
  const range=document.createRange();range.selectNodeContents(first);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
 });
}
try{
 await page.goto(origin.href);
 await btn('创建汇报').click();
 await page.getByLabel('汇报名称').fill('V15合成浏览器验收');
 await page.getByLabel('四位项目密码').fill('0426');
 await page.getByLabel('管理员密码',{exact:true}).fill('12345678');
 // A known Wrangler local-dev proxy race can return a synthetic 503 without
 // delivering POST to the Worker. Re-submit through the app's idempotent
 // CreationAttempt, but ONLY for that exact proxy error, and at most twice.
 // All genuine service 503s and persistent proxy failures remain hard failures.
 let creationResponse,localProxyRetries=0;
 for(let attempt=0;attempt<3;attempt++){
  const responseReady=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects'&&r.request().method()==='POST',{timeout:90000});
  await btn('创建并进入').click();
  creationResponse=await responseReady;
  if(creationResponse.status()===201)break;
  const details=(await creationResponse.text()).slice(0,300);
  const localProxyDrop=creationResponse.status()===503&&details.startsWith('Your worker restarted mid-request.');
  if(localProxyDrop&&attempt<2){
   localProxyRetries++;
   console.warn('Wrangler local proxy dropped synthetic POST; retry '+localProxyRetries+'/2 using the same idempotent create request.');
   continue;
  }
  throw new Error('Synthetic project creation HTTP '+creationResponse.status()+': '+details);
 }
 assert.equal(creationResponse?.status(),201,'Synthetic project was not created');
 const id=(await creationResponse.json()).project_id;
 assert.match(id,/^[a-zA-Z0-9_-]+$/);
 await page.getByLabel('汇报标题').waitFor();
 const draftAlias=await page.evaluate(async projectId=>{
  const response=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/edit/draft');
  return {status:response.status,id:(await response.json()).project?.id};
 },id);
 assert.deepEqual(draftAlias,{status:200,id},'built Worker must pass the browser session and URL project through legacy draft routing');
 assert(await page.getByRole('navigation',{name:'工作步骤'}).count());
 const originLink=page.getByRole('link',{name:/艺68班级服务站/}).first();
 assert.equal(await originLink.getAttribute('href'),'https://class.example.invalid');
 assert.equal(await originLink.getAttribute('target'),'_blank');
 assert.match(await originLink.getAttribute('rel')||'',/noopener/);
 // Observe an actual new tab without requesting or modifying the original
 // Yi68 site: intercept its navigation inside the isolated test browser.
 await context.route('https://class.example.invalid/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>isolated origin test</title>'}));
 const originalPage=page.url(),popupReady=page.waitForEvent('popup',{timeout:15000});
 await originLink.click();
 const popup=await popupReady;
 assert.equal(new URL(popup.url()).origin,'https://class.example.invalid','Yi68 link must open the original site in a new tab');
 await popup.close();
 assert.equal(page.url(),originalPage,'Yi68 external link must not navigate the draft editor');
 const initial=await current(id);
 assert.equal(initial.blocks.length,0);
 // File and paste are exclusive; a blank uploaded file must never replace content.
 const upload=page.getByLabel('选择讲稿文件');
 await upload.setInputFiles({name:'blank.txt',mimeType:'text/plain',buffer:Buffer.from(' \n  ')});
 await page.getByText(/讲稿为空；原有内容未被替换/).waitFor();
 assert.equal((await current(id)).blocks.length,0);
 await btn('直接粘贴文字').click();
 assert.equal(await page.getByLabel('选择讲稿文件').count(),0);
 await page.getByLabel('原稿文字').fill('第一段讲稿。\n第二段讲稿。');
 await btn('提取自然段').click();
 await page.getByText('已保存到草稿',{exact:true}).waitFor();
 const draft=await current(id);
 assert.equal(draft.blocks.length,2);
 assert.match(draft.blocks[0].text,/第一段/);
 await page.getByLabel('原稿文字').fill('   ');
 assert(await btn('提取自然段').isDisabled());
 assert.equal((await current(id)).blocks.length,2);
 // Member punctuation parsing and stable membership in a real browser.
 await page.getByLabel(/批量添加组员/).fill('测试甲，测试乙;测试甲、 测试丙');
 await page.getByText(/重名已跳过：测试甲/).waitFor();
 await btn('添加到小组名册').click();
 await btn('立即同步').click();
 assert.equal((await until(()=>current(id),p=>p.members.length===3,'three saved members')).members.length,3);
 await page.getByText('高级导入静态 PDF 或图片').click();
 await page.getByLabel('选择 PDF 或图片').setInputFiles([
  resolve('tests/fixtures/rehearsal-reading/slide1.png'),
  resolve('tests/fixtures/rehearsal-reading/slide2.png')
 ]);
 await page.getByText(/已提取 2 页/).waitFor();
 await btn('立即同步').click();
 await until(()=>current(id),p=>p.slides.length===2,'two saved slides');
 const two=await current(id),oldFirst=two.slides[0].id;
 const thumbs=page.locator('.rh-thumbnails > div');
 await thumbs.first().getByRole('button',{name:'后移'}).click();
 await btn('立即同步').click();
 const rearranged=await until(()=>current(id),p=>p.slides[1]?.id===oldFirst,'stable slide reorder');
 assert.equal(rearranged.slides[1].pageIndex,1);
 await btn('撤销上次重排').click();
 await btn('立即同步').click();
 await until(()=>current(id),p=>p.slides[0]?.id===oldFirst,'slide reorder undo');
 await btn('分配演讲人').click();
 await btn('测试甲').click();
 await brush();
 await btn('关联 PPT').click();
 await btn('PPT第1页').click();
 await brush();
 await btn('立即同步').click();
 await until(()=>current(id),p=>p.blocks.some(b=>b.memberId&&b.slideIndex===0),'independent mapping');
 await btn('查看关联').click();
 await page.getByRole('button',{name:'查看PPT第1页'}).click();
 assert(await page.locator('.rh-linked-active').count()>0);
 await page.screenshot({path:join(screenshots,'desktop-1280.png'),fullPage:true});
 // Settings are in the side drawer and do not navigate away from the editor.
 await btn('项目设置').click();
 await page.getByRole('dialog',{name:'项目设置'}).waitFor();
 await page.getByRole('dialog',{name:'项目设置'}).getByRole('button',{name:'关闭'}).click();
 // Check viewport breakpoints with the actual saved synthetic project.
 for(const width of [1440,1280,1024,768,390,375]){
  await page.setViewportSize({width,height:844});
  // Let the 150 ms responsive side-panel transition fully settle before visual
  // evidence and overflow assertions. Earlier captures showed mid-flight panels.
  await page.waitForTimeout(250);
  await page.evaluate(()=>window.scrollTo(0,0));
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
  assert.equal(overflow,false,'viewport horizontal overflow at '+width+'px');
  if(width<=390){
   const autosave=await page.locator('.rh-workspace-content .rh-toolbar>span').first().boundingBox();
   assert(autosave&&autosave.width>=200,'autosave status collapsed to a narrow column at '+width+'px');
  }
  await page.screenshot({path:join(screenshots,'viewport-'+width+'.png')});
 }
 await page.setViewportSize({width:390,height:844});
 await btn('☰ 项目导航').click();
 assert(await page.getByRole('navigation',{name:'工作步骤'}).isVisible());
 await page.waitForTimeout(250);
 await page.screenshot({path:join(screenshots,'mobile-390.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile horizontal overflow');
 // Test a real malformed DOCX through the browser parser, not just a unit mock:
 // the existing draft must be preserved even though the upload fails.
 await page.setViewportSize({width:1280,height:844});
 await btn('上传 DOCX/TXT').click();
 await page.getByLabel('选择讲稿文件').setInputFiles({name:'invalid.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('not-a-zip')});
 await page.getByText('失败可重试',{exact:true}).waitFor();
 assert.equal((await current(id)).blocks.length,2,'failed DOCX must not overwrite the saved draft');

 // The right-click/more-menu removal must deactivate a referenced member
 // without changing the stable ID or invalidating the already saved block.
 const memberBefore=(await current(id)).members.find(m=>m.name==='测试甲');
 assert(memberBefore?.enabled);
 await page.getByRole('button',{name:'更多组员操作：测试甲'}).click();
 await page.getByRole('menuitem',{name:'从小组移除'}).click();
 await btn('立即同步').click();
 const afterRemoval=await until(()=>current(id),p=>p.members.some(m=>m.id===memberBefore.id&&!m.enabled),'referenced member disabled, not erased');
 assert.equal(afterRemoval.blocks.some(b=>b.memberId===memberBefore.id),true,'historical mapping survives safe member removal');

 // Rotate the administrator password in the actual settings drawer, log out,
 // reject the previous password and re-enter using the replacement password.
 await btn('项目设置').click();
 const settings=page.getByRole('dialog',{name:'项目设置'});
 await settings.getByRole('button',{name:'修改管理员密码',exact:true}).click();
 await settings.getByLabel('当前管理员密码').fill('12345678');
 await settings.getByLabel('新管理员密码').fill('87654321');
 await settings.getByRole('button',{name:'确认修改管理员密码'}).click();
 await settings.getByText('设置已更新。',{exact:true}).waitFor();
 await settings.getByRole('button',{name:'关闭'}).click();
 await btn('退出汇报').click();
 await btn('创建汇报').waitFor();
 await page.goto(new URL('/p/'+id,origin).href);
 await page.getByLabel('项目密码或管理员密码').fill('12345678');
 await btn('验证并进入').click();
 await page.getByRole('alert').getByText(/项目或凭证不正确/).waitFor();
 await page.getByLabel('项目密码或管理员密码').fill('87654321');
 await btn('验证并进入').click();
 await page.getByRole('navigation',{name:'工作步骤'}).waitFor();
 assert(await page.getByRole('button',{name:'材料与编排'}).count()>0,'new administrator password grants workspace access');

 assert.deepEqual(errors,[],'browser runtime errors');
 console.log(JSON.stringify({status:'PASS',project:id,localProxyRetries,slides:2,members:3,blocks:draft.blocks.length,
  checks:['numeric creation','exclusive import','blank guards','malformed DOCX preserves draft','server save','member separators','referenced member safe removal','password rotation and re-login','slide move/undo','independent script mapping','linked highlights','Yi68 origin opens a separate tab without leaving editor','management drawer','mobile navigation','mobile overflow'],screenshots}));
}finally{await browser.close()}
