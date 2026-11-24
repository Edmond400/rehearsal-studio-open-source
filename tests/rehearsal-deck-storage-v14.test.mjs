import assert from 'node:assert/strict';
import {strToU8,zipSync} from 'fflate';

export async function testDeckStorage({db,ok,hash,request,projectId,preview,cleanup}) {
  // The D1 endpoint reads the two manifest parts. The browser suite renders
  // separate, complete OOXML fixtures through the same API.
  const input=zipSync({
   'ppt/presentation.xml':strToU8('<p:sldIdLst><p:sldId id="256" r:id="one"/><p:sldId id="257" r:id="two"/></p:sldIdLst>'),
   'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="one" Type="schema/slide" Target="slides/slide1.xml"/><Relationship Id="two" Type="schema/slide" Target="slides/slide2.xml"/></Relationships>')
  });
  const send=(path,data,type,sourceId)=>request(path,data,{'Content-Type':type,...(sourceId?{'X-Rehearsal-Metadata':sourceId}:{})});
  const originalType='application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const initial=await ok(await request('/edit/draft'));
  const deck=await ok(await send('/edit/pptx',input,originalType));
  assert.deepEqual(deck.pages,['ppt/slides/slide1.xml','ppt/slides/slide2.xml']);
  assert.deepEqual(deck.sourceIds,['256','257']);
  assert.equal((await ok(await send('/edit/pptx',input,originalType))).id,deck.id);
  const candidate={source:{bytes:input.length,hash:hash(input)},pages:deck.sourceIds.map(sourceId=>({sourceId,bytes:preview.length,hash:hash(preview)}))};
  let preflight=await ok(await request('/edit/preview-budget',candidate));
  assert.equal(preflight.additional,2*preview.length);
  const first=await ok(await send('/edit/preview-page',preview,'image/png',deck.sourceIds[0]));
  assert.equal(first.id,preflight.previewIds[0]);
  assert.equal((await ok(await request('/edit/draft'))).project.revision,initial.project.revision,'partial upload cannot update draft');
  await db.prepare('UPDATE studio_usage SET max_bytes=? WHERE project_id=?').bind(input.length+preview.length,projectId).run();
  preflight=await ok(await request('/edit/preview-budget',candidate));
  assert.equal(preflight.fits,false);
  assert.deepEqual(preflight.existingPreviewIds,[first.id]);
  assert.equal((await send('/edit/preview-page',preview,'image/png',deck.sourceIds[1])).status,409);
  assert.equal((await ok(await request('/edit/draft'))).project.revision,initial.project.revision);
  await db.prepare('UPDATE studio_usage SET max_bytes=62914560 WHERE project_id=?').bind(projectId).run();
  const second=await ok(await send('/edit/preview-page',preview,'image/png',deck.sourceIds[1]));
  assert.notEqual(second.id,first.id,'identical images on distinct source pages retain separate identity');
  preflight=await ok(await request('/edit/preview-budget',candidate));
  assert.equal(preflight.additional,0);
  assert.equal(preflight.siteLimit,180*1024*1024);
  const {id,scriptVersion,deckVersion,algorithmVersion,updatedAt,...doc}=initial.project;
  const saved=await ok(await request('/edit/draft',{base_revision:initial.project.revision,mutation_id:crypto.randomUUID(),document:{...doc,
   sourceDeck:{id:deck.id,pages:deck.pages,bytes:deck.bytes},
   slides:[first,second].map((file,pageIndex)=>({...file,pageIndex,sourceId:deck.sourceIds[pageIndex],sourcePage:deck.pages[pageIndex]}))
  }}));
  assert.equal(saved.project.slides[1].id,second.id);
  const fileRows=await db.prepare('SELECT count(*) n FROM rehearsal_files WHERE project_id=?').bind(projectId).first();
  assert.equal(fileRows.n,3);
  console.log('PASS E4 D1: original page identities, resumable/deduplicated uploads, exact capacity refusal, distinct repeated images and atomic draft application.');
  await db.prepare(`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<60)
   INSERT INTO rehearsal_files SELECT 'preview-expired-'||n,?,'slide','image/png',1,?,'2000-01-01T00:00:00.000Z' FROM slots`).bind(projectId,hash(preview)).run();
  await db.prepare(`INSERT INTO rehearsal_releases(project_id,release_id,release_no,source_draft_revision,snapshot_json,created_at)
   VALUES (?,'retained-release',1,0,?,'2000-01-01T00:00:00.000Z')`).bind(projectId,JSON.stringify({slides:[{id:'preview-expired-1'}]})).run();
  assert.equal((await ok(await cleanup())).removed,59);
  assert.equal((await db.prepare('SELECT count(*) n FROM rehearsal_files WHERE project_id=?').bind(projectId).first()).n,4);
  assert.equal((await ok(await cleanup())).removed,0);
  console.log('PASS E5 D1: bulk staging cleanup removes 59 expired orphans, preserves the release-only file and active staged/draft assets.');
}
