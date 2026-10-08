import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createVaultStore } from '../server/vault-store.mjs';
import { createVaultIndex } from '../server/vault-index.mjs';

const sample=await readFile(new URL('../public/examples/reading-demo.pdf',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'paperdesk-vault-index-')),vaultDir=path.join(root,'vault'),dataDir=path.join(root,'cache');
  await mkdir(path.join(vaultDir,'.obsidian'),{recursive:true});
  const app=createApp({vaultDir,dataDir});await app.ready;await app.close();
  const db=new DatabaseSync(path.join(dataDir,'paperdesk.sqlite'));db.exec('PRAGMA foreign_keys=ON;');
  const store=createVaultStore({vaultDir,recoveryDir:path.join(dataDir,'recoveries','originals')});
  const createRecord=async(notes='正文 A',bytes=sample,relativeSource)=>{
    const id=randomUUID(),now=new Date().toISOString();
    const file=relativeSource?path.join(store.vaultDir,...relativeSource.split('/')):store.pdfPath(id);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
    return store.writeDocument({document:{id,sha256:hash(bytes),title:'Test',filename:'test.pdf',page_count:2,byte_size:bytes.length,
      created_at:now,updated_at:now,text_available:1,notes_zh:notes,notes_en:'',last_page:1,folder_id:null},annotations:[],
      ...(relativeSource?{pdfSource:{kind:'vault',path:relativeSource}}:{})},null);
  };
  const indexFor=(override={},parsePdf=async()=>({pages:['text A1','text A2']}))=>createVaultIndex({db,store:{...store,...override},dataDir,parsePdf,HttpError});
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
  return{store,db,createRecord,indexFor,root,vaultDir,dataDir};
}

test('a post-read external version is never used to authorize a save based on the previous projected version',async t=>{
  const h=await fixture(t),record=await h.createRecord();let edit=false;
  const index=h.indexFor({readAll(){const records=h.store.readAll();if(edit){edit=false;h.store.writeDocument({...records[0],document:{...records[0].document,notes_zh:'Obsidian 正文 B'}},records[0].token);}return records;}});
  await index.initialize();edit=true;
  assert.throws(()=>index.transaction(()=>{
    assert.equal(h.db.prepare('SELECT notes_zh FROM documents WHERE id=?').get(record.document.id).notes_zh,'正文 A');
    h.db.prepare('UPDATE documents SET notes_zh=? WHERE id=?').run('Paperdesk 草稿 C',record.document.id);
  }),error=>error.status===409&&error.code==='VAULT_FILE_CONFLICT'&&error.conflictPreserved===true);
  assert.equal(h.store.readDocument(record.document.id).document.notes_zh,'Obsidian 正文 B');
  const conflicts=path.join(h.store.rootDir,'Notes','Conflicts'),copies=await readdir(conflicts);
  assert.equal(copies.length,1);assert.ok((await readFile(path.join(conflicts,copies[0]),'utf8')).endsWith('Paperdesk 草稿 C'));
  await index.refresh();assert.equal(h.db.prepare('SELECT notes_zh FROM documents WHERE id=?').get(record.document.id).notes_zh,'Obsidian 正文 B');
});

test('index parsing is bound to PDF checksum and cannot pair old text with a new same-page-count file',async t=>{
  const h=await fixture(t),record=await h.createRecord(),entered=deferred(),release=deferred();let delayed=true;
  const index=h.indexFor({},async(_file,options)=>{assert.equal(typeof options.expectedSha256,'string');if(delayed){entered.resolve();await release.promise;return{pages:['old text 1','old text 2']};}return{pages:['new text 1','new text 2']};});
  const initial=index.initialize();await entered.promise;
  const newPdf=Buffer.concat([sample,Buffer.from('\n% changed authoritative PDF\n')]);await writeFile(h.store.pdfPath(record.document.id),newPdf);
  h.store.writeDocument({...record,document:{...record.document,sha256:hash(newPdf),byte_size:newPdf.length}},record.token);
  release.resolve();await assert.rejects(initial,error=>error.status===409);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,0);
  delayed=false;await index.refresh();
  assert.equal(h.db.prepare('SELECT sha256 FROM documents').get().sha256,hash(newPdf));
  assert.deepEqual(h.db.prepare('SELECT text FROM pages ORDER BY page').all().map(row=>row.text),['new text 1','new text 2']);
});

test('a conflict archive failure cannot prevent already-written documents from being rolled back or claim a preserved copy',async t=>{
  const h=await fixture(t),a=await h.createRecord('first'),b=await h.createRecord('second',Buffer.concat([sample,Buffer.from('\n% distinct file\n')]));let writes=0,fail=false,archiveAttempts=0;
  const index=h.indexFor({writeDocument(record,token){if(fail&&++writes===2){const error=new Error('synthetic concurrent edit');error.status=409;error.code='VAULT_FILE_CONFLICT';throw error;}return h.store.writeDocument(record,token);},writeConflict(){archiveAttempts++;throw new Error('synthetic archive failure');}});
  await index.initialize();fail=true;
  assert.throws(()=>index.transaction(()=>h.db.prepare('UPDATE documents SET notes_zh=?').run('proposed change')),error=>error.status===409&&!error.code&&!error.conflictPreserved);
  assert.equal(archiveAttempts,2,'Both changed notes must attempt real archival before the failure is reported');
  assert.equal(h.store.readDocument(a.document.id).document.notes_zh,'first');assert.equal(h.store.readDocument(b.document.id).document.notes_zh,'second');
  assert.deepEqual(new Set(h.db.prepare('SELECT notes_zh FROM documents').all().map(row=>row.notes_zh)),new Set(['first','second']));
});

test('a malformed generated section during a save preserves bytes without falsely classifying or archiving a conflict',async t=>{
  const h=await fixture(t),record=await h.createRecord(),original=await readFile(record.notePath,'utf8');let edit=false,archives=0;
  const changed=original.replace('## Paperdesk 批注\n','## Paperdesk 批注\n\n外部加到受管区的文字\n');
  const index=h.indexFor({readAll(){const records=h.store.readAll();if(edit){edit=false;writeFileSync(record.notePath,changed);}return records;},
    writeConflict(){archives++;throw new Error('must not archive malformed edits');}});
  await index.initialize();edit=true;
  assert.throws(()=>index.transaction(()=>h.db.prepare('UPDATE documents SET notes_zh=? WHERE id=?').run('unsaved draft',record.document.id)),
    error=>error.status===409&&!error.code&&!error.conflictPreserved);
  assert.equal(archives,0);assert.equal(await readFile(record.notePath,'utf8'),changed);
  assert.equal(h.db.prepare('SELECT notes_zh FROM documents WHERE id=?').get(record.document.id).notes_zh,'正文 A');
});

test('an established empty vault cannot recreate a removed Library.md after restart',async t=>{
  const h=await fixture(t),libraryPath=path.join(h.store.rootDir,'Library.md');
  const index=h.indexFor();await index.initialize();
  assert.equal((await readFile(path.join(h.dataDir,'vault-library-established'),'utf8')),'1\n');
  await rm(libraryPath);
  // No document or folder exists to infer prior use; only the local marker does.
  const reopenedStore=createVaultStore({vaultDir:h.vaultDir,recoveryDir:path.join(h.dataDir,'recoveries','originals')});
  const reopened=h.indexFor(reopenedStore);
  await assert.rejects(reopened.initialize(),error=>error.status===409&&!error.code&&!error.conflictPreserved&&/Library\.md/.test(error.message));
  await assert.rejects(reopened.refresh(),error=>error.status===409);
  assert.throws(()=>reopened.transaction(()=>h.db.prepare("UPDATE library_preferences SET theme='sand'" ).run()),error=>error.status===409);
  await assert.rejects(readFile(libraryPath),{code:'ENOENT'});
  assert.equal(h.db.prepare('SELECT theme FROM library_preferences WHERE id=1').get().theme,'forest');
});

test('the drain promise waits for a later asynchronous index refresh',async t=>{
  const h=await fixture(t),index=h.indexFor();await index.initialize();await h.createRecord();
  const entered=deferred(),release=deferred();
  const slow=h.indexFor({},async()=>{entered.resolve();await release.promise;return{pages:['a','b']};});
  const refresh=slow.refresh();await entered.promise;let drained=false;const drain=slow.settle().then(()=>{drained=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);release.resolve();await refresh;await drain;assert.equal(drained,true);
});

test('source references survive projection, snapshots, normal saves and transaction rollback',async t=>{
  const h=await fixture(t),relative='原始文献/中文 # 阅读.pdf',record=await h.createRecord('正文 A',sample,relative);
  const index=h.indexFor();await index.initialize();
  assert.deepEqual(index.snapshot(record.document.id).pdfSource,{kind:'vault',path:relative});
  index.transaction(()=>h.db.prepare('UPDATE documents SET notes_zh=? WHERE id=?').run('Paperdesk 正文 B',record.document.id));
  let saved=h.store.readDocument(record.document.id);assert.equal(saved.document.notes_zh,'Paperdesk 正文 B');assert.deepEqual(saved.pdfSource,record.pdfSource);
  assert.deepEqual(index.pdfReferences(),[{id:record.document.id,path:relative}]);
  h.db.exec("CREATE TRIGGER reject_notes BEFORE UPDATE OF notes_zh ON documents BEGIN SELECT RAISE(ABORT,'synthetic SQL failure'); END;");
  assert.throws(()=>index.transaction(()=>h.db.prepare('UPDATE documents SET notes_zh=? WHERE id=?').run('must not replace',record.document.id)));
  saved=h.store.readDocument(record.document.id);assert.equal(saved.document.notes_zh,'Paperdesk 正文 B');assert.deepEqual(saved.pdfSource,record.pdfSource);
  assert.equal(hash(await readFile(saved.pdfPath)),record.document.sha256);
  await assert.rejects(readdir(h.store.pdfDir),{code:'ENOENT'},'V2 saves cannot create a legacy copy directory');
});

test('an SQL commit failure removes only the newly created managed note and rolls back its projection, preserving recovery bytes',async t=>{
  const h=await fixture(t),index=h.indexFor();await index.initialize();
  const id=randomUUID(),now=new Date().toISOString(),incoming=path.join(h.root,'incoming.upload');await writeFile(incoming,sample);
  const receipt=h.store.importPdf(id,incoming,hash(sample),sample.length);
  const insert=()=>h.db.prepare(`INSERT INTO documents(id,sha256,title,filename,page_count,byte_size,created_at,updated_at,text_available)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id,hash(sample),'Test','import.pdf',2,sample.length,now,now,1);
  const originalExec=h.db.exec.bind(h.db);let attemptedCommit=false;
  const hook=t.mock.method(h.db,'exec',sql=>{if(sql==='COMMIT'){attemptedCommit=true;throw new Error('isolated commit failure');}return originalExec(sql);});
  try{assert.throws(()=>index.commitImported(id,undefined,insert),/isolated commit failure/);}
  finally{hook.mock.restore();}
  assert.equal(attemptedCommit,true,'The test must reach the commit after writing the note');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,0);assert.deepEqual(index.pdfReferences(),[]);
  await assert.rejects(readFile(h.store.notePath(id)),{code:'ENOENT'});
  h.store.discardImportedPdf(receipt);assert.deepEqual(await readdir(h.store.pdfDir),[]);
  const originals=path.join(h.dataDir,'recoveries','originals'),backups=await readdir(originals);
  assert.equal(backups.filter(name=>name.endsWith('.md')).length,1);assert.equal(backups.filter(name=>name.endsWith('.pdf')).length,1);
  assert.match(await readFile(path.join(originals,backups.find(name=>name.endsWith('.md'))),'utf8'),/paperdesk_format: 3/);
  assert.equal(hash(await readFile(path.join(originals,backups.find(name=>name.endsWith('.pdf'))))),hash(sample));
  await index.refresh();assert.deepEqual(index.pdfReferences(),[]);
});

test('a failed original-source association rolls back its new Markdown while leaving the version 2 PDF in place',async t=>{
  const h=await fixture(t),index=h.indexFor();await index.initialize();
  const id=randomUUID(),now=new Date().toISOString(),relative='nested/原始 PDF.pdf',source=path.join(h.vaultDir,'nested','原始 PDF.pdf');await mkdir(path.dirname(source));await writeFile(source,sample);
  const originalExec=h.db.exec.bind(h.db);let saved=false;
  const hook=t.mock.method(h.db,'exec',sql=>{if(sql==='COMMIT'){saved=true;throw new Error('isolated selected commit failure');}return originalExec(sql);});
  try{assert.throws(()=>index.commitImported(id,{kind:'vault',path:relative},()=>h.db.prepare(`INSERT INTO documents(id,sha256,title,filename,page_count,byte_size,created_at,updated_at,text_available)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id,hash(sample),'Original','original.pdf',2,sample.length,now,now,1)),/isolated selected commit failure/);}
  finally{hook.mock.restore();}
  assert.equal(saved,true);assert.equal(hash(await readFile(source)),hash(sample));await assert.rejects(readFile(h.store.notePath(id)),{code:'ENOENT'});
  assert.deepEqual(index.pdfReferences(),[]);await assert.rejects(readdir(h.store.pdfDir),{code:'ENOENT'});
  await index.refresh();assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,0);
});

test('bookmarks survive refresh and note/position/classification saves without reparsing PDF and failed multi-file commits restore bookmark rows and Markdown',async t=>{
  const h=await fixture(t),record=await h.createRecord(),other=await h.createRecord('另一份正文',Buffer.concat([sample,Buffer.from('\n% second for rollback\n')]));let parses=0;
  const index=h.indexFor({},async()=>{parses++;return{pages:['text1','text2']};});await index.initialize();assert.equal(parses,2);
  const now=new Date().toISOString(),bookmark={id:randomUUID(),document_id:record.document.id,page:2,title:'个人页面',created_at:now,updated_at:now};
  index.transaction(()=>h.db.prepare('INSERT INTO bookmarks(id,document_id,page,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(bookmark.id,bookmark.document_id,bookmark.page,bookmark.title,now,now));
  assert.deepEqual(index.snapshot(record.document.id).bookmarks.map(row=>({...row})),[bookmark]);assert.deepEqual(h.store.readDocument(record.document.id).bookmarks,[bookmark]);
  const folderId=randomUUID();
  index.transaction(()=>{
    h.db.prepare('INSERT INTO folders(id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?)').run(folderId,'学习','学习',now,now);
    h.db.prepare('UPDATE documents SET notes_zh=?,last_page=2,folder_id=? WHERE id=?').run('新的正文',folderId,record.document.id);
  });
  await index.refresh();assert.equal(parses,2);assert.deepEqual(h.store.readDocument(record.document.id).bookmarks,[bookmark]);
  const previous=await readFile(record.notePath),otherPrevious=await readFile(other.notePath);let writes=0;
  const failing=h.indexFor({writeDocument(...args){writes++;if(writes===2)throw Object.assign(new Error('isolated second note failure'),{status:409});return h.store.writeDocument(...args);}});await failing.initialize();
  assert.throws(()=>failing.transaction(()=>{
    h.db.prepare('UPDATE bookmarks SET title=? WHERE id=?').run('必须回滚的标签',bookmark.id);
    h.db.prepare('UPDATE documents SET title=? WHERE id=?').run('触发第二文件',other.document.id);
  }),/isolated second note failure/);
  assert.ok(writes>=2);assert.deepEqual(await readFile(record.notePath),previous);assert.deepEqual(await readFile(other.notePath),otherPrevious);
  assert.equal(h.db.prepare('SELECT title FROM bookmarks WHERE id=?').get(bookmark.id).title,bookmark.title);
  assert.deepEqual(h.store.readDocument(record.document.id).bookmarks,[bookmark]);
});
