import assert from 'node:assert/strict';

export async function testDirectory({db,req,ok,publicProject,hiddenProject,pid,pass}){
 const id=publicProject.project_id,hidden=hiddenProject.project_id;
 const first=await ok(await req('/directory',undefined,'',{web:true}));
 assert.deepEqual(first.projects.map(p=>p.id),[id]);
 assert.deepEqual(Object.keys(first.projects[0]).sort(),['duration_seconds','id','status','title','updated_at']);
 assert.equal(first.projects[0].duration_seconds,120);
 for(const query of ['V14 隐藏样本','旧项目']){
  assert.deepEqual((await ok(await req('/directory?q='+encodeURIComponent(query)))).projects,[]);
 }
 assert.equal((await req('/'+id+'/edit',undefined,'',{web:true})).status,401);
 assert.equal((await req('/'+hidden+'/audio/unknown',undefined,'',{web:true})).status,401);
 assert.equal((await req('/directory?q=%25')).status,400);
 assert.equal((await req('/directory?limit=21')).status,400);
 assert.equal((await req('/directory?cursor=invalid')).status,400);
 assert.equal((await req('/directory?q='+encodeURIComponent("x' OR 1=1 --"))).status,200);
 await ok(await req('/'+id+'/owner/visibility',{password:pass,visibility:'unlisted'},publicProject.session_token));
 assert.deepEqual((await ok(await req('/directory'))).projects,[]);
 await ok(await req('/'+id+'/owner/visibility',{password:pass,visibility:'public'},publicProject.session_token));
 await ok(await req('/'+id+'/owner/archive',{password:pass,archived:true},publicProject.session_token));
 assert.deepEqual((await ok(await req('/directory'))).projects,[]);
 await ok(await req('/'+id+'/owner/archive',{password:pass,archived:false},publicProject.session_token));
 // Same timestamps exercise the secondary ID cursor, independent of wall time.
 await db.prepare("UPDATE rehearsal_projects SET updated_at='2026-11-04T00:00:00.000Z' WHERE id IN (?,?)").bind(id,hidden).run();
 await ok(await req('/'+hidden+'/owner/visibility',{password:pass,visibility:'public'},hiddenProject.session_token));
 const a=await ok(await req('/directory?limit=1&q=V14'));
 assert.equal(a.projects.length,1);assert(a.next_cursor);
 const b=await ok(await req('/directory?limit=1&q=V14&cursor='+a.next_cursor));
 assert.equal(b.next_cursor,null);assert.deepEqual([a.projects[0].id,b.projects[0].id],[id,hidden].sort().reverse());
 assert.equal((await req('/directory?q=other&cursor='+a.next_cursor)).status,400);
 assert(!(await ok(await req('/directory'))).projects.some(p=>p.id===pid));
}
