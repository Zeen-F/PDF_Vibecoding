import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { libraryIdentity } from '../shared/service-identity.mjs';
import { getVaultConfig } from '../server/vault-config.mjs';

const sample = await readFile(new URL('../public/examples/reading-demo.pdf',import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(),'paperdesk-vault-api-'));
  let vaultDir = path.join(root,'知识库'); const dataDir = path.join(root,'cache');
  await mkdir(path.join(vaultDir,'.obsidian'),{recursive:true});
  vaultDir = await realpath(vaultDir);
  let app,server;
  const start = async () => {
    app = createApp({vaultDir,dataDir}); await app.ready;
    server = app.app.listen(0,'127.0.0.1'); await once(server,'listening');
  };
  const stop = async () => {
    server?.closeAllConnections(); if(server) await new Promise(resolve=>server.close(resolve));
    if(app) await app.close(); server=app=null;
  };
  await start();
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  const request = (url,method='GET',body) => fetch(`http://127.0.0.1:${server.address().port}/api${url}`,{
    method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
  });
  return {root,vaultDir,dataDir,request,start,stop,
    async upload() {const form=new FormData();form.append('file',new Blob([sample]),'阅读示例.pdf');const response=await fetch(`http://127.0.0.1:${server.address().port}/api/documents`,{method:'POST',body:form});assert.equal(response.status,201,await response.clone().text());return(await response.json()).document;},
    notePath(id){return path.join(vaultDir,'Paperdesk','Notes',`${id}.md`);},
  };
}

test('vault files are authoritative; notes, geometry, classifications, retry and position protection survive index deletion',async t=>{
  const h=await harness(t),doc=await h.upload(),endpoint=`/documents/${doc.id}`;
  assert.deepEqual(await(await h.request('/storage')).json(),{mode:'vault',vaultName:'知识库',subdir:'Paperdesk',documentCount:1});
  const identity=await(await h.request('/plugin/status')).json();
  assert.equal(identity.libraryId,libraryIdentity(path.join(h.vaultDir,'Paperdesk')));
  const notes='## 我在 Obsidian 中的理解\n\n$g_m=2I_D/V_{OV}$\n';
  let response=await h.request(endpoint,'PATCH',{notesZh:notes,notesEn:'',expectedNotesRevision:doc.notesRevision});
  assert.equal(response.status,200,await response.clone().text());
  let current=(await response.json()).document;
  const file=await readFile(h.notePath(doc.id),'utf8');assert.ok(file.includes(notes));
  const pdf=await readFile(path.join(h.vaultDir,'Paperdesk','PDFs',`${doc.id}.pdf`));assert.equal(hash(pdf),hash(sample));
  const requestId=randomUUID(),annotationBody={page:1,kind:'region',rects:[{x:.12,y:.14,width:.3,height:.2}],color:'green',comment:'图表证据，不做OCR',requestId};
  response=await h.request(`${endpoint}/annotations`,'POST',annotationBody);assert.equal(response.status,201,await response.clone().text());
  const annotation=(await response.json()).annotation;
  response=await h.request('/folders','POST',{name:'模拟电路'});assert.equal(response.status,201);const folder=(await response.json()).folder;
  assert.equal((await h.request(`${endpoint}/folder`,'PATCH',{folderId:folder.id})).status,200);
  assert.equal((await h.request('/library/theme','PATCH',{theme:'night'})).status,200);
  const writerId=randomUUID();assert.equal((await h.request(endpoint,'PATCH',{lastPage:2,positionWriterId:writerId,positionSequence:2})).status,200);
  const noteUri=await(await h.request(`${endpoint}/vault-note`)).json();assert.equal(new URL(noteUri.uri).searchParams.get('path'),h.notePath(doc.id));
  // Removing just the stopped index cannot remove formal notes/annotations or local credentials.
  await h.stop();
  await writeFile(path.join(h.dataDir,'keep-local-secret.txt'),'local-only-secret');
  for(const name of ['paperdesk.sqlite','paperdesk.sqlite-wal','paperdesk.sqlite-shm'])await rm(path.join(h.dataDir,name),{force:true});
  await h.start();
  current=(await(await h.request(endpoint)).json()).document;assert.equal(current.notesZh,notes);assert.equal(current.lastPage,2);assert.equal(current.folderId,folder.id);
  assert.equal((await(await h.request('/library')).json()).theme,'night');
  const restored=(await(await h.request(endpoint)).json()).annotations;assert.deepEqual(restored,[annotation]);
  response=await h.request(`${endpoint}/annotations`,'POST',annotationBody);assert.equal(response.status,200);assert.equal((await response.json()).annotation.id,annotation.id);
  response=await h.request(endpoint,'PATCH',{lastPage:1,positionWriterId:writerId,positionSequence:1});assert.equal(response.status,200);assert.equal((await response.json()).positionStale,true);
  assert.equal((await(await h.request('/search?q=Reading')).json()).results.some(result=>result.source==='text'),true);
  assert.equal(await readFile(path.join(h.dataDir,'keep-local-secret.txt'),'utf8'),'local-only-secret');
  const names=await readdir(path.join(h.vaultDir,'Paperdesk'),{recursive:true});assert.ok(!names.some(name=>/sqlite|\.incoming|recoveries/.test(name)));
});

test('external Markdown edits read back, stale saves preserve both, and corrupt/missing notes are not treated as empty',async t=>{
  const h=await harness(t),doc=await h.upload(),endpoint=`/documents/${doc.id}`;
  let response=await h.request(endpoint,'PATCH',{notesZh:'初始正文',expectedNotesRevision:doc.notesRevision});assert.equal(response.status,200);
  const old=(await response.json()).document;
  const original=await readFile(h.notePath(doc.id),'utf8');
  const external=original.replace('初始正文','Obsidian 外部修改').replace('---\n','---\naliases: [我的精读笔记]\n');
  await writeFile(h.notePath(doc.id),external);
  const current=(await(await h.request(endpoint)).json()).document;assert.equal(current.notesZh,'Obsidian 外部修改');assert.notEqual(current.notesRevision,old.notesRevision);
  response=await h.request(endpoint,'PATCH',{notesZh:'Paperdesk 未保存的草稿',expectedNotesRevision:old.notesRevision});assert.equal(response.status,409);
  assert.equal(await readFile(h.notePath(doc.id),'utf8'),external);
  const conflictDir=path.join(h.vaultDir,'Paperdesk','Notes','Conflicts');
  const files=await readdir(conflictDir);assert.equal(files.length,1);assert.ok((await readFile(path.join(conflictDir,files[0]),'utf8')).includes('Paperdesk 未保存的草稿'));
  response=await h.request(endpoint,'PATCH',{notesZh:'合并后的理解',expectedNotesRevision:current.notesRevision});assert.equal(response.status,200);
  const valid=await readFile(h.notePath(doc.id),'utf8');assert.ok(valid.includes('aliases: [我的精读笔记]'));assert.ok(valid.includes('合并后的理解'));
  const corrupt=valid.replace('paperdesk-state:v1','paperdesk-state:broken');await writeFile(h.notePath(doc.id),corrupt);
  response=await h.request(endpoint);assert.equal(response.status,409);assert.equal(await readFile(h.notePath(doc.id),'utf8'),corrupt);
  await writeFile(h.notePath(doc.id),valid);assert.equal((await h.request(endpoint)).status,200);
  await rm(h.notePath(doc.id));assert.equal((await h.request(endpoint)).status,409);
  await writeFile(h.notePath(doc.id),valid);assert.equal((await h.request(endpoint)).status,200);
  assert.equal((await h.request(endpoint,'PATCH',{notesZh:'无版本覆盖'})).status,400);
});

test('plugin append commits the same Markdown and folder removal is reflected in formal metadata',async t=>{
  const h=await harness(t),doc=await h.upload(),endpoint=`/documents/${doc.id}`;
  const body={text:'从当前对话明确记录的内容',expectedNotesRevision:doc.notesRevision,requestId:randomUUID(),page:1};
  let response=await h.request(`${endpoint}/notes/append`,'POST',body);assert.equal(response.status,200,await response.clone().text());
  assert.ok((await readFile(h.notePath(doc.id),'utf8')).includes(body.text));
  response=await h.request('/folders','POST',{name:'临时分类'});const {folder}=await response.json();
  assert.equal((await h.request(`${endpoint}/folder`,'PATCH',{folderId:folder.id})).status,200);
  assert.equal((await h.request(`/folders/${folder.id}`,'DELETE')).status,200);
  await h.stop();for(const name of ['paperdesk.sqlite','paperdesk.sqlite-wal','paperdesk.sqlite-shm'])await rm(path.join(h.dataDir,name),{force:true});await h.start();
  assert.equal((await(await h.request(endpoint)).json()).document.folderId,null);assert.equal((await(await h.request('/library')).json()).folders.length,0);
});

test('cache configuration cannot place database or credentials inside a vault',async t=>{
  const h=await harness(t);
  assert.throws(()=>getVaultConfig({vaultDir:h.vaultDir,dataDir:path.join(h.vaultDir,'cache')}),/之外/);
  assert.throws(()=>getVaultConfig({vaultDir:path.join(h.root,'missing')}),/ENOENT/);
  assert.throws(()=>getVaultConfig({vaultDir:h.vaultDir,vaultSubdir:'..'}));
});
