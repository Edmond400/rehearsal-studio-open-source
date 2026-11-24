import assert from 'node:assert/strict';

export async function testReleaseRecordings({db,ok,upload,project,asBody,hash,sendAudio}) {
 let draft=(await ok(await project('/edit/draft'))).project;
 const slides=[];
 for(let pageIndex=0;pageIndex<3;pageIndex++)slides.push({...await ok(await upload()),pageIndex});
 const members=[{id:'speaker-a',name:'甲',enabled:true},{id:'speaker-b',name:'乙',enabled:true}];
 const blocks=members.map((member,i)=>({id:'block-'+i,paragraphId:'block-'+i,text:'示例段落 '+i,memberId:member.id,slideIndex:i,paragraphEnd:true,nonspoken:false}));
 async function publish(document){
  const saved=await ok(await project('/edit/draft',{base_revision:draft.revision,mutation_id:crypto.randomUUID(),document:{...asBody(draft),...document,status:'draft'}}));
  const result=await ok(await project('/edit/publish',{expected_draft_revision:saved.project.revision,mutation_id:crypto.randomUUID()}));
  draft=result.project;
  return {id:result.releaseId,project:result.project};
 }
 const r1=await publish({slides,members,blocks});
 const wave=Buffer.from([0x1a,0x45,0xdf,0xa3,1,2,3,4]);
 const record=(release,i,events=[{t_ms:0,slide_index:i,source:'start'}])=>({
  id:crypto.randomUUID(),releaseId:release.id,memberId:members[i].id,turnId:'turn-block-'+i,
  scriptVersion:release.project.scriptVersion,deckVersion:release.project.deckVersion,algorithmVersion:release.project.algorithmVersion,
  hash:hash(wave),durationMs:1000,mediaDurationMs:1000,clockDurationMs:1000,events
 });
 const events=[{t_ms:0,slide_index:0,source:'start'},{t_ms:400,slide_index:2,source:'manual'}];
 const [a1,a2,a3,a4]=Array.from({length:4},()=>record(r1,0,events));
 const b1=record(r1,1);
 for(const audio of [a1,a2,a3,b1])await ok(await sendAudio(audio,wave));
 const version=async release=>ok(await project('/releases/'+release.id));
 const uid=(await version(r1)).turns[0].uid;
 const choose=(release,recording_id,selection_revision)=>project('/playback/choice',{release_id:release.id,turn_uid:uid,recording_id,selection_revision});
 await ok(await choose(r1,a1.id,0));
 await ok(await sendAudio(a4,wave));assert((await ok(await sendAudio(a4,wave))).retried);
 let view=await version(r1);
 assert.deepEqual(view.recordings.filter(r=>r.turnUid===uid).map(r=>r.id).sort(),[a1.id,a3.id,a4.id].sort());
 assert.equal((await db.prepare('SELECT count(*) n FROM rehearsal_files WHERE id=?').bind(a2.id).first()).n,0);
 assert((await ok(await sendAudio(a2,wave))).retried,'pruned recording retries must not recreate old audio');
 await assert.rejects(db.prepare('DELETE FROM rehearsal_files WHERE id=?').bind(a1.id).run(),/protected/);
 const manifest=await ok(await project('/playback/session',{release_id:r1.id}));
 assert.equal(manifest.recordings[0].id,a1.id);
 assert.equal((await choose(r1,a4.id,0)).status,409);
 await ok(await choose(r1,a4.id,1));
 await assert.rejects(db.prepare('DELETE FROM rehearsal_files WHERE id=?').bind(a1.id).run(),/protected/);
 assert.equal(manifest.recordings[0].id,a1.id);
 await db.prepare('UPDATE rehearsal_recordings SET locked=1 WHERE id=?').bind(a3.id).run();
 assert.equal((await sendAudio(record(r1,0,events),wave)).status,409,'all three candidates are protected');
 assert.equal((await version(r1)).recordings.length,4);
 const foreign=await choose(r1,b1.id,2);
 assert.equal(foreign.status,409,'cannot pin a recording from another turn');
 await ok(await choose(r1,null,2));
 const latest=await ok(await project('/playback/session',{release_id:r1.id}));
 assert.equal(latest.recordings[0].id,a4.id);
 const reordered=[slides[2],slides[1],slides[0]].map((s,pageIndex)=>({...s,pageIndex}));
 const r2=await publish({slides:reordered,blocks:[{...blocks[0],slideIndex:2},{...blocks[1],spokenText:'另一个实际读法'}]});
 view=await version(r2);
 assert.equal(view.turns[0].uid,uid);
 assert(view.recordings.every(r=>r.memberId===members[0].id));
 assert.deepEqual(view.recordings.find(r=>r.id===a1.id).events.map(e=>e.slide_index),[2,0]);
 assert.deepEqual((await version(r1)).recordings.find(r=>r.id===a1.id).events.map(e=>e.slide_index),[0,2]);
 await assert.rejects(db.prepare('DELETE FROM rehearsal_files WHERE id=?').bind(a4.id).run(),/protected/);
 const late=record(r1,1);
 await ok(await sendAudio(late,wave));
 assert((await version(r1)).recordings.some(r=>r.id===late.id));
 assert(!(await version(r2)).recordings.some(r=>r.id===late.id));
 const r3=await publish({slides:[slides[0],slides[1]],blocks:[blocks[0],{...blocks[1],spokenText:'另一个实际读法'}]});
 const removed=await version(r3);
 assert.equal(removed.turns[0].uid,uid);
 assert.equal(removed.turns[0].fingerprint,view.turns[0].fingerprint);
 assert.equal(removed.recordings.filter(r=>r.memberId===members[0].id).length,0,'recording references a removed manually visited slide');
 const r4=await publish({blocks:[blocks[0],{...blocks[1],memberId:members[0].id}]});
 assert.equal((await version(r4)).recordings.length,0,'merged speaker turns cannot reuse an older audio');
 await assert.rejects(db.prepare('UPDATE rehearsal_files SET hash=? WHERE id=?').bind('0'.repeat(64),slides[0].id).run(),/immutable/);
 await assert.rejects(db.prepare('DELETE FROM rehearsal_file_chunks WHERE file_id=?').bind(a1.id).run(),/protected/);
 assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 console.log('PASS E3 D1: fourth upload preserves pin and history, protected-quota rollback, selection CAS, leased manifest, per-turn reuse, reordered event remap, late historical upload, speaker and reading changes.');
}

export async function testLegacyReleaseImport({db,project,ok,upload,hash}) {
 const base=(await ok(await project('/edit/draft'))).project;
 const slide={...await ok(await upload()),pageIndex:0};
 const members=[{id:'pre-v14-speaker',name:'旧项目成员',enabled:true}];
 const blocks=[{id:'legacy-block',paragraphId:'legacy-block',text:'保留历史录音',memberId:members[0].id,slideIndex:0,nonspoken:false,paragraphEnd:true}];
 const snapshot={...base,revision:1,status:'published',scriptVersion:'old-script',deckVersion:'old-deck',slides:[slide],members,blocks};
 const doc=JSON.stringify(snapshot),audio=Buffer.from([0x1a,0x45,0xdf,0xa3,2,4,6]);
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 await db.batch([
  db.prepare("UPDATE rehearsal_projects SET revision=1,status='published',published_json=?,document_json=? WHERE id=?").bind(doc,doc,base.id),
  db.prepare('INSERT INTO rehearsal_versions VALUES (?,?,?,?)').bind(base.id,1,doc,base.updatedAt),
  db.prepare('INSERT INTO rehearsal_members VALUES (?,?,?,1)').bind(members[0].id,base.id,members[0].name),
  ...ids.flatMap((id,index)=>[
   db.prepare("INSERT INTO rehearsal_files VALUES (?,?,'audio','audio/webm',?,?,?)").bind(id,base.id,audio.length,hash(audio),base.updatedAt),
   db.prepare('INSERT INTO rehearsal_file_chunks VALUES (?,0,?)').bind(id,new Uint8Array(audio)),
   db.prepare(`INSERT INTO rehearsal_recordings(id,project_id,member_id,turn_id,script_version,deck_version,algorithm_version,duration_ms,submitted_at,
    predicted_seconds,snapshot_json,events_json,metadata_json,request_hash) VALUES (?,?,?,?,?,?,?,1000,?,1,?,?,?,?)`).bind(
    id,base.id,members[0].id,'turn-legacy-block',snapshot.scriptVersion,snapshot.deckVersion,snapshot.algorithmVersion,base.updatedAt,
    JSON.stringify({slides:[slide],...(index===0?{blocks}:{})}),JSON.stringify([{t_ms:0,slide_index:0,source:'start'}]),'{}','legacy-hash')
  ])
 ]);
 const live=await ok(await project(''));
 assert.match(live.project.releaseId,/^legacy-/);
 assert.deepEqual(live.recordings.map(r=>r.id),[ids[0]]);
 assert.equal((await ok(await project('/releases'))).releases.length,1);
 assert.equal((await ok(await project('/releases'))).releases.length,1,'legacy import is idempotent');
 const preserved=await project('/audio/'+ids[1]);
 assert.equal(preserved.status,200);
 assert.equal(hash(Buffer.from(await preserved.arrayBuffer())),hash(audio));
 await assert.rejects(db.prepare('DELETE FROM rehearsal_files WHERE id=?').bind(ids[1]).run(),/protected/);
 console.log('PASS E3 D1: import existing published snapshot, exact origin binding, repeat import, unresolved legacy audio retained byte for byte.');
}
