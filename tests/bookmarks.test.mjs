import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { backupBeforeMigration } from '../server/bookmarks.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { notesRevision } from '../server/plugin-api.mjs';

const sample=await readFile(new URL('../public/examples/reading-demo.pdf',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,vault=false) {
  const root=await mkdtemp(path.join(tmpdir(),'paperdesk-bookmarks-')),dataDir=path.join(root,'cache'),vaultDir=vault?path.join(root,'vault'):undefined;
  if(vault)await mkdir(path.join(vaultDir,'.obsidian'),{recursive:true});
  let runtime,server;
  const start=async()=>{runtime=createApp({dataDir,vaultDir});await runtime.ready;server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');};
  const stop=async()=>{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));if(runtime)await runtime.close();runtime=server=null;};
  await start();t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  const request=(route,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}/api${route}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const json=async(route,method='GET',body,status=200)=>{const response=await request(route,method,body);assert.equal(response.status,status,await response.clone().text());return response.json();};
  const upload=async(bytes=sample)=>{const form=new FormData();form.append('file',new Blob([bytes]),'isolated.pdf');const response=await fetch(`http://127.0.0.1:${server.address().port}/api/documents`,{method:'POST',body:form});assert.equal(response.status,201,await response.clone().text());return(await response.json()).document;};
  const database=work=>{const db=new DatabaseSync(path.join(dataDir,'paperdesk.sqlite'));try{return work(db);}finally{db.close();}};
  return{root,dataDir,vaultDir,request,json,upload,database,start,stop,
    pdfPath:id=>path.join(vaultDir||dataDir,vault?'Paperdesk/PDFs':'pdfs',`${id}.pdf`),
    notePath:id=>path.join(vaultDir,'Paperdesk','Notes',`${id}.md`)};
}

for(const vault of [false,true]) {
  const label=vault?'vault':'library';
  test(`${label} bookmark CRUD deduplicates pages, preserves titles on retries and uses monotonic CAS without changing PDF or extracted text`,async t=>{
    const h=await fixture(t,vault),doc=await h.upload(),route=`/documents/${doc.id}/bookmarks`;
    const pages=h.database(db=>db.prepare('SELECT * FROM pages ORDER BY page').all());
    const notes=await h.json(`/documents/${doc.id}`,'PATCH',{notesZh:'正文保持不变',expectedNotesRevision:doc.notesRevision});
    assert.deepEqual(await h.json(route),{bookmarks:[]});
    const emptyExport=await(await h.request(`/documents/${doc.id}/export`)).text();assert.ok(!emptyExport.includes('## 页面书签'));
    const second=(await h.json(route,'POST',{page:2,title:'  待复查的推导  '},201)).bookmark;
    const first=(await h.json(route,'POST',{page:1},201)).bookmark;assert.equal(first.title,'第 1 页');assert.equal(second.title,'待复查的推导');
    assert.deepEqual((await h.json(route)).bookmarks,[first,second]);
    assert.deepEqual((await h.json(route,'POST',{page:2,title:'不能覆盖原标题'})).bookmark,second);
    const hook=t.mock.method(Date,'now',()=>Date.parse(second.updatedAt)-10_000);
    let renamed;try{renamed=(await h.json(`${route}/${second.id}`,'PATCH',{title:' 新的标签 ',expectedUpdatedAt:second.updatedAt})).bookmark;}finally{hook.mock.restore();}
    assert.equal(renamed.title,'新的标签');assert.ok(Date.parse(renamed.updatedAt)>Date.parse(second.updatedAt));assert.equal(renamed.createdAt,second.createdAt);
    assert.deepEqual((await h.json(`${route}/${second.id}`,'PATCH',{title:'新的标签',expectedUpdatedAt:second.updatedAt})).bookmark,renamed,'A lost-response retry must not bump the version');
    assert.equal((await h.request(`${route}/${second.id}`,'PATCH',{title:'stale overwrite',expectedUpdatedAt:second.updatedAt})).status,409);
    assert.equal((await h.request(`${route}/${second.id}`,'DELETE',{expectedUpdatedAt:second.updatedAt})).status,409);
    assert.deepEqual((await h.json(route)).bookmarks,[first,renamed]);
    assert.deepEqual(await h.json(`${route}/${second.id}`,'DELETE',{expectedUpdatedAt:renamed.updatedAt}),{ok:true});
    assert.deepEqual(await h.json(`${route}/${second.id}`,'DELETE',{expectedUpdatedAt:renamed.updatedAt}),{ok:true});
    assert.deepEqual((await h.json(route)).bookmarks,[first]);
    await h.json(`${route}/${first.id}`,'PATCH',{title:'[关键] *页面* #1',expectedUpdatedAt:first.updatedAt});
    const exported=await(await h.request(`/documents/${doc.id}/export`)).text();assert.ok(exported.includes('## 页面书签\n\n- PDF 第 1 页 · \\[关键\\] \\*页面\\* \\#1'));
    const updatedFirst=(await h.json(route)).bookmarks[0];
    assert.equal((await h.json(`/documents/${doc.id}`)).document.notesRevision,notes.document.notesRevision);
    assert.deepEqual(h.database(db=>db.prepare('SELECT * FROM pages ORDER BY page').all()),pages);assert.equal(hash(await readFile(h.pdfPath(doc.id))),hash(sample));
    await h.stop();await h.start();assert.deepEqual((await h.json(route)).bookmarks,[updatedFirst]);
    if(vault){const md=await readFile(h.notePath(doc.id),'utf8');assert.match(md,/"version":3/);assert.match(md,/## 页面书签/);assert.match(md,/#page=1\) · \[关键\] \*页面\* #1/);}
  });

  test(`${label} bookmarks reject malformed ids, pages, titles, body keys and foreign records before mutation`,async t=>{
    const h=await fixture(t,vault),doc=await h.upload(),other=await h.upload(Buffer.concat([sample,Buffer.from('\n% another document\n')])),route=`/documents/${doc.id}/bookmarks`;
    for(const body of [{},{page:0},{page:3},{page:1.5},{page:'1'},{page:1,title:''},{page:1,title:'   '},{page:1,title:'x'.repeat(201)},{page:1,title:'line\nline'},{page:1,title:'line\u2028line'},{page:1,title:'line\u0000line'},{page:1,unknown:true}])assert.equal((await h.request(route,'POST',body)).status,400,JSON.stringify(body));
    const bookmark=(await h.json(route,'POST',{page:1,title:'唯一书签'},201)).bookmark;
    for(const body of [{title:'new'},{title:'new',expectedUpdatedAt:'invalid'},{title:'\rnew',expectedUpdatedAt:bookmark.updatedAt},{title:'new',expectedUpdatedAt:bookmark.updatedAt,page:2}])assert.equal((await h.request(`${route}/${bookmark.id}`,'PATCH',body)).status,400);
    assert.equal((await h.request(`${route}/${bookmark.id}`,'DELETE',{})).status,400);
    assert.equal((await h.request(`${route}/${bookmark.id}`,'DELETE',{expectedUpdatedAt:bookmark.updatedAt,force:true})).status,400);
    const foreign=`/documents/${other.id}/bookmarks/${bookmark.id}`;
    assert.equal((await h.request(foreign,'PATCH',{title:'foreign',expectedUpdatedAt:bookmark.updatedAt})).status,404);
    assert.equal((await h.request(foreign,'DELETE',{expectedUpdatedAt:bookmark.updatedAt})).status,404);
    assert.equal((await h.request('/documents/invalid/bookmarks')).status,400);
    assert.equal((await h.request(`${route}/invalid`,'DELETE',{expectedUpdatedAt:bookmark.updatedAt})).status,400);
    assert.equal((await h.request(`/documents/${randomUUID()}/bookmarks`)).status,404);
    assert.equal((await h.request(`/documents/${randomUUID()}/bookmarks/${randomUUID()}`,'DELETE',{expectedUpdatedAt:bookmark.updatedAt})).status,404);
    assert.deepEqual((await h.json(route)).bookmarks,[bookmark]);assert.deepEqual((await h.json(`/documents/${other.id}/bookmarks`)).bookmarks,[]);
  });

  test(`${label} failed bookmark writes roll back all rows and leave formal notes and original PDFs unchanged`,async t=>{
    const h=await fixture(t,vault),doc=await h.upload(),route=`/documents/${doc.id}/bookmarks`,bookmark=(await h.json(route,'POST',{page:1},201)).bookmark;
    const note=vault?await readFile(h.notePath(doc.id)):undefined;
    for(const [event,method,body,url] of [['INSERT','POST',{page:2},route],['UPDATE','PATCH',{title:'failure',expectedUpdatedAt:bookmark.updatedAt},`${route}/${bookmark.id}`],['DELETE','DELETE',{expectedUpdatedAt:bookmark.updatedAt},`${route}/${bookmark.id}`]]) {
      h.database(db=>db.exec(`CREATE TRIGGER reject_bookmark BEFORE ${event} ON bookmarks BEGIN SELECT RAISE(ABORT,'isolated bookmark failure'); END;`));
      assert.equal((await h.request(url,method,body)).status,500);h.database(db=>db.exec('DROP TRIGGER reject_bookmark'));
      assert.deepEqual((await h.json(route)).bookmarks,[bookmark]);if(vault)assert.deepEqual(await readFile(h.notePath(doc.id)),note);
    }
    assert.equal(hash(await readFile(h.pdfPath(doc.id))),hash(sample));
    h.database(db=>{db.exec('PRAGMA foreign_keys=ON');db.prepare('DELETE FROM documents WHERE id=?').run(doc.id);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bookmarks').get().count,0);});
  });
}

test('schema 4 migration backs up committed WAL rows consistently and preserves every old row, PDF and notes revision',async t=>{
  const h=await fixture(t),doc=await h.upload();await h.json(`/documents/${doc.id}`,'PATCH',{notesZh:'旧正式笔记',notesEn:'old English',lastPage:2});
  await h.json(`/documents/${doc.id}/annotations`,'POST',{page:1,quote:'old quote',comment:'old comment',color:'yellow',rects:[{x:.1,y:.2,width:.2,height:.03}],requestId:randomUUID()},201);
  await h.stop();h.database(db=>db.exec('DROP TABLE bookmarks;PRAGMA user_version=4;'));
  const capture=db=>Object.fromEntries(['documents','pages','annotations','annotation_requests','reading_position_writers','folders','library_preferences'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before=h.database(capture),revision=notesRevision(before.documents[0]);await h.start();
  assert.deepEqual(h.database(capture),before);assert.equal(h.database(db=>db.prepare('PRAGMA user_version').get().user_version),5);assert.equal((await h.json(`/documents/${doc.id}`)).document.notesRevision,revision);
  const directory=path.join(h.dataDir,'recoveries','migrations'),files=await readdir(directory);assert.equal(files.length,1);
  const backup=new DatabaseSync(path.join(directory,files[0]),{readOnly:true});try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(capture(backup),before);assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(),[]);}finally{backup.close();}
  assert.equal(hash(await readFile(h.pdfPath(doc.id))),hash(sample));await h.stop();await h.start();assert.deepEqual(await readdir(directory),files,'Current-schema restart must not create another migration backup');
});

test('VACUUM INTO backup includes committed data still in an active WAL and remains independent of later writes',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'paperdesk-bookmark-wal-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const db=new DatabaseSync(path.join(root,'source.sqlite'));try{db.exec('PRAGMA journal_mode=WAL;CREATE TABLE entries(value TEXT);PRAGMA user_version=4;');db.prepare('INSERT INTO entries VALUES(?)').run('committed WAL row');
    const file=backupBeforeMigration(db,root,4,CURRENT_SCHEMA);db.prepare('INSERT INTO entries VALUES(?)').run('later row');const copy=new DatabaseSync(file,{readOnly:true});try{assert.deepEqual(copy.prepare('SELECT value FROM entries').all().map(row=>row.value),['committed WAL row']);assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{copy.close();}
  }finally{db.close();}
});

test('failed schema 5 DDL rolls back the source structure and retains a readable pre-migration backup; future and empty libraries are not backed up',async t=>{
  const h=await fixture(t),doc=await h.upload();await h.stop();
  h.database(db=>db.exec('DROP TABLE bookmarks;CREATE TABLE bookmarks(incompatible TEXT);PRAGMA user_version=4;'));
  const snapshot=h.database(db=>db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());assert.throws(()=>createApp({dataDir:h.dataDir}),/document_id/);
  h.database(db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),snapshot);});
  const directory=path.join(h.dataDir,'recoveries','migrations'),backups=await readdir(directory);assert.equal(backups.length,1);
  const backup=new DatabaseSync(path.join(directory,backups[0]),{readOnly:true});try{assert.deepEqual(backup.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),snapshot);assert.equal(backup.prepare('SELECT id FROM documents').get().id,doc.id);}finally{backup.close();}
  h.database(db=>db.exec(`PRAGMA user_version=${CURRENT_SCHEMA+1};`));assert.throws(()=>createApp({dataDir:h.dataDir}),/更新版本/);assert.deepEqual(await readdir(directory),backups);
  assert.equal(hash(await readFile(h.pdfPath(doc.id))),hash(sample));
  const empty=await fixture(t);await assert.rejects(readdir(path.join(empty.dataDir,'recoveries','migrations')),{code:'ENOENT'});
});

test('migration backups refuse recovery parent links and occupied directories before DDL and do not write into a vault',async t=>{
  for(const kind of ['recoveries-link','migrations-link','occupied']) {
    const h=await fixture(t),doc=await h.upload();await h.stop();h.database(db=>db.exec('DROP TABLE bookmarks;PRAGMA user_version=4;'));
    const vault=path.join(h.root,'protected-vault');await mkdir(path.join(vault,'.obsidian'),{recursive:true});await writeFile(path.join(vault,'keep.md'),'untouched vault note');
    if(kind==='recoveries-link')await symlink(vault,path.join(h.dataDir,'recoveries'));
    if(kind==='migrations-link'){await mkdir(path.join(h.dataDir,'recoveries'));await symlink(vault,path.join(h.dataDir,'recoveries','migrations'));}
    if(kind==='occupied')await writeFile(path.join(h.dataDir,'recoveries'),'ordinary existing file');
    const before=h.database(db=>db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
    assert.throws(()=>createApp({dataDir:h.dataDir}),/真实文件夹|符号链接/);
    assert.deepEqual(await readdir(vault),['.obsidian','keep.md']);assert.equal(await readFile(path.join(vault,'keep.md'),'utf8'),'untouched vault note');
    h.database(db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),before);assert.equal(db.prepare('SELECT id FROM documents').get().id,doc.id);});
    assert.equal(hash(await readFile(h.pdfPath(doc.id))),hash(sample));
  }
});

test('established schema 5 tables and damaged zero-version databases are rejected instead of silently creating empty records',async t=>{
  const h=await fixture(t),doc=await h.upload();await h.json(`/documents/${doc.id}/bookmarks`,'POST',{page:1,title:'原书签'},201);await h.stop();h.database(db=>db.exec('DROP TABLE bookmarks;'));
  const schema=h.database(db=>db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());assert.throws(()=>createApp({dataDir:h.dataDir}),/缺少完整 bookmarks 表/);
  assert.deepEqual(h.database(db=>db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()),schema);assert.equal(h.database(db=>db.prepare('PRAGMA user_version').get().user_version),5);
  await assert.rejects(readdir(path.join(h.dataDir,'recoveries','migrations')),{code:'ENOENT'});
  const broken=await mkdtemp(path.join(tmpdir(),'paperdesk-zero-version-'));t.after(()=>rm(broken,{recursive:true,force:true}));const db=new DatabaseSync(path.join(broken,'paperdesk.sqlite'));db.exec("CREATE TABLE private_data(value TEXT);INSERT INTO private_data VALUES('preserve');");db.close();
  assert.throws(()=>createApp({dataDir:broken}),/缺少有效格式版本/);const check=new DatabaseSync(path.join(broken,'paperdesk.sqlite'),{readOnly:true});try{assert.equal(check.prepare('SELECT value FROM private_data').get().value,'preserve');assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['private_data']);}finally{check.close();}
});
