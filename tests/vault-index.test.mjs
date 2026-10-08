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
