import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { libraryIdentity } from '../shared/service-identity.mjs';
import { getVaultConfig } from '../server/vault-config.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createVaultStore } from '../server/vault-store.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { legacyVaultMarkdown } from './fixtures/vault-legacy.mjs';

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
  const request = (url,method='GET',body,headers={}) => fetch(`http://127.0.0.1:${server.address().port}/api${url}`,{
    method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body),
  });
  const defaultPdfPath = '文献/课程资料/阅读 示例 # 1.pdf';
  return {root,vaultDir,dataDir,request,start,stop,
    defaultPdfPath,
    async importPdf(bytes=sample,filename='外部 阅读 # 1.pdf') {
      const form=new FormData();form.append('file',new Blob([bytes]),filename);
      return fetch(`http://127.0.0.1:${server.address().port}/api/documents`,{method:'POST',body:form});
    },
    async upload(relativePath=defaultPdfPath,bytes=sample) {
      const file=path.join(vaultDir,...relativePath.split('/'));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
      const response=await request('/vault/pdfs/open','POST',{path:relativePath});assert.equal(response.status,201,await response.clone().text());return(await response.json()).document;
    },
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
  const pdf=await readFile(path.join(h.vaultDir,...h.defaultPdfPath.split('/')));assert.equal(hash(pdf),hash(sample));
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),{code:'ENOENT'},'No PDF copy folder was created');
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
  const conflict=await response.json();assert.equal(conflict.code,'NOTES_VERSION_CONFLICT');assert.equal(conflict.conflictPreserved,true);
  assert.equal(await readFile(h.notePath(doc.id),'utf8'),external);
  const conflictDir=path.join(h.vaultDir,'Paperdesk','Notes','Conflicts');
  const files=await readdir(conflictDir);assert.equal(files.length,1);assert.ok((await readFile(path.join(conflictDir,files[0]),'utf8')).includes('Paperdesk 未保存的草稿'));
  response=await h.request(endpoint,'PATCH',{notesZh:'合并后的理解',expectedNotesRevision:current.notesRevision});assert.equal(response.status,200);
  const valid=await readFile(h.notePath(doc.id),'utf8');assert.ok(valid.includes('aliases: [我的精读笔记]'));assert.ok(valid.includes('合并后的理解'));
  const corrupt=valid.replace('paperdesk-state:v1','paperdesk-state:broken');await writeFile(h.notePath(doc.id),corrupt);
  response=await h.request(endpoint);assert.equal(response.status,409);
  const corruptedResponse=await response.json();assert.equal(corruptedResponse.code,undefined);assert.equal(corruptedResponse.conflictPreserved,undefined);
  assert.equal(await readFile(h.notePath(doc.id),'utf8'),corrupt);
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
  response=await h.request(`${endpoint}/notes/append`,'POST',{...body,requestId:randomUUID()});assert.equal(response.status,409);
  const stale=await response.json();assert.equal(stale.code,'NOTES_VERSION_CONFLICT');assert.equal(stale.conflictPreserved,undefined);
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','Notes','Conflicts')),{code:'ENOENT'},'Plugin stale append has not archived a draft');
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

test('external edits to generated annotation text fail safely; editable body remains bidirectional',async t=>{
  const h=await harness(t),doc=await h.upload(),endpoint=`/documents/${doc.id}`;
  let response=await h.request(`${endpoint}/annotations`,'POST',{page:1,quote:'可见引文',comment:'正式批注评论',color:'yellow',rects:[{x:.1,y:.1,width:.2,height:.04}]});
  assert.equal(response.status,201);
  const original=await readFile(h.notePath(doc.id),'utf8'),changed=original.replace('正式批注评论','外部手改批注');
  await writeFile(h.notePath(doc.id),changed);
  for(const [route,method,body]of [[endpoint,'GET'],[endpoint,'PATCH',{notesZh:'本机未保存草稿',expectedNotesRevision:doc.notesRevision}],['/storage/refresh','POST']]){
    response=await h.request(route,method,body);assert.equal(response.status,409);
    const failure=await response.json();assert.equal(failure.code,undefined);assert.equal(failure.conflictPreserved,undefined);assert.match(failure.error,/笔记正文/);
    assert.equal(await readFile(h.notePath(doc.id),'utf8'),changed);
  }
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','Notes','Conflicts')),{code:'ENOENT'});
  const bodyEdited=original.replace('\n\n<!-- paperdesk-generated:start:v1 -->','Obsidian 可编辑正文\n\n<!-- paperdesk-generated:start:v1 -->');
  await writeFile(h.notePath(doc.id),bodyEdited);
  response=await h.request(endpoint);assert.equal(response.status,200);const current=(await response.json()).document;
  assert.equal(current.notesZh,'Obsidian 可编辑正文');
  response=await h.request(endpoint,'PATCH',{notesZh:'Paperdesk 继续编辑正文',expectedNotesRevision:current.notesRevision});assert.equal(response.status,200);
  assert.ok((await readFile(h.notePath(doc.id),'utf8')).includes('Paperdesk 继续编辑正文'));
});

test('a failed conflict archive returns saving failure without code or false preservation acknowledgement',async t=>{
  const h=await harness(t),doc=await h.upload(),endpoint=`/documents/${doc.id}`;
  const original=await readFile(h.notePath(doc.id),'utf8'),changed=original.replace('\n\n<!-- paperdesk-generated:start:v1 -->','外部最新正文\n\n<!-- paperdesk-generated:start:v1 -->');
  await writeFile(h.notePath(doc.id),changed);
  const conflicts=path.join(h.vaultDir,'Paperdesk','Notes','Conflicts');await writeFile(conflicts,'ordinary file blocks archival');
  const response=await h.request(endpoint,'PATCH',{notesZh:'需要保留的本机草稿',expectedNotesRevision:doc.notesRevision});assert.equal(response.status,409);
  const failure=await response.json();assert.equal(failure.code,undefined);assert.equal(failure.conflictPreserved,undefined);
  assert.ok(!JSON.stringify(failure).includes(h.root));
  assert.equal(await readFile(conflicts,'utf8'),'ordinary file blocks archival');assert.equal(await readFile(h.notePath(doc.id),'utf8'),changed);
});

test('Library.md deletion blocks refresh and writes and never resets existing metadata',async t=>{
  const h=await harness(t),doc=await h.upload();
  let response=await h.request('/folders','POST',{name:'保存的分类'});const {folder}=await response.json();
  assert.equal((await h.request(`/documents/${doc.id}/folder`,'PATCH',{folderId:folder.id})).status,200);
  assert.equal((await h.request('/library/theme','PATCH',{theme:'night'})).status,200);
  const libraryPath=path.join(h.vaultDir,'Paperdesk','Library.md'),original=await readFile(libraryPath,'utf8');await rm(libraryPath);
  for(const [route,method,body]of [['/storage/refresh','POST'],['/library','GET'],['/library/theme','PATCH',{theme:'forest'}]]){
    response=await h.request(route,method,body);assert.equal(response.status,409);
    const failure=await response.json();assert.equal(failure.code,undefined);assert.equal(failure.conflictPreserved,undefined);assert.match(failure.error,/Library\.md/);
    await assert.rejects(readFile(libraryPath),{code:'ENOENT'});
  }
  await writeFile(libraryPath,original);
  const restored=await(await h.request('/library')).json();assert.equal(restored.theme,'night');assert.equal(restored.folders[0].id,folder.id);
  assert.equal((await(await h.request(`/documents/${doc.id}`)).json()).document.folderId,folder.id);
});

test('an established empty vault with removed Library.md cannot be default-initialized by a restarted app',async t=>{
  const h=await harness(t),libraryPath=path.join(h.vaultDir,'Paperdesk','Library.md');
  await h.stop();await rm(libraryPath);
  await assert.rejects(h.start(),error=>error.status===409&&!error.code&&!error.conflictPreserved&&/Library\.md/.test(error.message));
  await assert.rejects(readFile(libraryPath),{code:'ENOENT'});
  assert.equal(await readFile(path.join(h.dataDir,'vault-library-established'),'utf8'),'1\n');
});

test('original nested PDF selection renders file/TOC/plugin PNG without making copies and duplicate selections retain one set of annotations',async t=>{
  const h=await harness(t),relative=h.defaultPdfPath,file=path.join(h.vaultDir,...relative.split('/'));
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,sample);
  let response=await h.request('/vault/pdfs');assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{files:[{path:relative,name:path.posix.basename(relative),byteSize:sample.length,documentId:null}],truncated:false});
  assert.deepEqual((await(await h.request('/documents')).json()).documents,[],'Listing a PDF cannot add it to the index');
  response=await h.request('/vault/pdfs/open','POST',{path:relative});assert.equal(response.status,201);
  const{document:doc,duplicate}=await response.json();assert.equal(duplicate,false);
  let current=(await(await h.request(`/documents/${doc.id}`)).json()).document;
  response=await h.request(`/documents/${doc.id}`,'PATCH',{notesZh:'保存在独立Markdown的阅读笔记',expectedNotesRevision:current.notesRevision});assert.equal(response.status,200);
  response=await h.request(`/documents/${doc.id}/annotations`,'POST',{page:1,quote:'原位阅读引文',comment:'保持来源位置',color:'yellow',rects:[{x:.1,y:.2,width:.3,height:.04}],requestId:randomUUID()});assert.equal(response.status,201);
  const annotation=(await response.json()).annotation;
  response=await h.request(`/documents/${doc.id}/file`);assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(sample));
  const partial=await h.request(`/documents/${doc.id}/file`,'GET',undefined,{Range:'bytes=0-15'});
  assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),sample.subarray(0,16));
  response=await h.request(`/documents/${doc.id}/toc`);assert.equal(response.status,200);assert.ok(Array.isArray((await response.json()).entries));
  response=await h.request(`/documents/${doc.id}/reader-page?page=1&width=600`);assert.equal(response.status,200,await response.clone().text());
  const rendered=await response.json();assert.equal(rendered.documentId,doc.id);assert.equal(rendered.mimeType,'image/png');assert.equal(rendered.width,600);assert.ok(rendered.image.startsWith('iVBOR'));
  response=await h.request('/vault/pdfs/open','POST',{path:relative});assert.equal(response.status,200);assert.equal((await response.json()).document.id,doc.id);
  const alias='另一个已有目录/相同原文.pdf';await mkdir(path.dirname(path.join(h.vaultDir,alias)),{recursive:true});await writeFile(path.join(h.vaultDir,alias),sample);
  response=await h.request('/vault/pdfs/open','POST',{path:alias});assert.equal(response.status,200);assert.equal((await response.json()).duplicate,true);
  const stored=(await(await h.request(`/documents/${doc.id}`)).json());assert.deepEqual(stored.annotations,[annotation]);assert.equal(stored.document.notesZh,'保存在独立Markdown的阅读笔记');
  const store=createVaultStore({vaultDir:h.vaultDir,recoveryDir:path.join(h.dataDir,'recoveries','originals')});assert.deepEqual(store.readDocument(doc.id).pdfSource,{kind:'vault',path:relative});
  assert.equal(hash(await readFile(file)),hash(sample));assert.equal(hash(await readFile(path.join(h.vaultDir,alias))),hash(sample));
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),{code:'ENOENT'});
  const listed=(await(await h.request('/vault/pdfs')).json()).files;assert.equal(listed.find(item=>item.path===relative).documentId,doc.id);assert.equal(listed.find(item=>item.path===alias).documentId,null);
  const note=await readFile(h.notePath(doc.id),'utf8');assert.ok(note.includes('paperdesk_format: 3'));assert.ok(note.includes('%20%23%201.pdf#page=1'));
  await h.stop();for(const name of ['paperdesk.sqlite','paperdesk.sqlite-wal','paperdesk.sqlite-shm'])await rm(path.join(h.dataDir,name),{force:true});await h.start();
  current=(await(await h.request(`/documents/${doc.id}`)).json()).document;assert.equal(current.notesZh,stored.document.notesZh);
  assert.deepEqual((await(await h.request(`/documents/${doc.id}`)).json()).annotations,[annotation]);
  response=await h.request(`/documents/${doc.id}/file`);assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(sample));
});

test('selection rejects traversal, symlinks, hidden and malformed source files',async t=>{
  const h=await harness(t),outside=path.join(h.root,'outside.pdf');await writeFile(outside,sample);await symlink(outside,path.join(h.vaultDir,'linked.pdf'));
  const outsideDir=path.join(h.root,'outside-dir');await mkdir(outsideDir);await writeFile(path.join(outsideDir,'source.pdf'),sample);await symlink(outsideDir,path.join(h.vaultDir,'linked-dir'));
  await writeFile(path.join(h.vaultDir,'.hidden.pdf'),sample);await writeFile(path.join(h.vaultDir,'invalid.pdf'),'invalid PDF bytes');
  for(const relative of ['../outside.pdf',outside,'C:/outside.pdf','linked.pdf','linked-dir/source.pdf','.hidden.pdf','.obsidian/secret.pdf','dir//x.pdf','dir\\x.pdf','invalid.pdf','missing.pdf']){
    const response=await h.request('/vault/pdfs/open','POST',{path:relative});assert.equal(response.status,409,relative);
    const failure=await response.json();assert.equal(failure.conflictPreserved,undefined);assert.ok(!JSON.stringify(failure).includes(h.root));
  }
  assert.equal(hash(await readFile(outside)),hash(sample));assert.deepEqual((await(await h.request('/documents')).json()).documents,[]);
  const listed=(await(await h.request('/vault/pdfs')).json()).files;assert.deepEqual(listed.map(item=>item.path),['invalid.pdf']);
  const response=await h.request('/documents','POST');assert.equal(response.status,400);assert.match((await response.json()).error,/请选择一个 PDF/);
  const cache=await readdir(h.dataDir,{recursive:true});assert.ok(!cache.some(item=>item.endsWith('.pdf')),'Failed opening cannot leave parsed PDF snapshots');
});

test('a missing or replaced original PDF stops reads and writes without touching formal notes and annotations',async t=>{
  const h=await harness(t),doc=await h.upload(),file=path.join(h.vaultDir,...h.defaultPdfPath.split('/')),note=await readFile(h.notePath(doc.id),'utf8');
  const changed=Buffer.from(sample);changed[changed.length-1]^=1;await writeFile(file,changed);
  for(const [route,method,body]of [[`/documents/${doc.id}/file`,'GET'],[`/documents/${doc.id}/reader-page?page=1&width=600`,'GET'],[`/documents/${doc.id}`,'PATCH',{notesZh:'本机草稿',expectedNotesRevision:doc.notesRevision}]]){
    const response=await h.request(route,method,body);assert.equal(response.status,409);assert.equal((await response.json()).conflictPreserved,undefined);
    assert.equal(await readFile(h.notePath(doc.id),'utf8'),note);
  }
  assert.equal(hash(await readFile(file)),hash(changed),'Refused reads cannot restore or overwrite the original PDF');
  await rm(file);assert.equal((await h.request(`/documents/${doc.id}/toc`)).status,409);assert.equal(await readFile(h.notePath(doc.id),'utf8'),note);
});

test('legacy version 1 documents continue to open from their historical PDF folder and upgrade formal state on edits',async t=>{
  const h=await harness(t),store=createVaultStore({vaultDir:h.vaultDir,recoveryDir:path.join(h.dataDir,'recoveries','originals')}),id=randomUUID(),now=new Date().toISOString();
  await mkdir(store.pdfDir,{recursive:true});await writeFile(store.pdfPath(id),sample);
  store.writeDocument({document:{id,sha256:hash(sample),title:'Legacy',filename:'legacy.pdf',page_count:2,byte_size:sample.length,created_at:now,updated_at:now,text_available:1,notes_zh:'旧版正文',notes_en:'',last_page:1,folder_id:null},annotations:[]},null);
  await writeFile(store.notePath(id),legacyVaultMarkdown(await readFile(store.notePath(id),'utf8'),1));
  let response=await h.request(`/documents/${id}`);assert.equal(response.status,200);const doc=(await response.json()).document;
  response=await h.request(`/documents/${id}`,'PATCH',{notesZh:'兼容旧版编辑',expectedNotesRevision:doc.notesRevision});assert.equal(response.status,200);
  assert.equal(store.readDocument(id).pdfSource,undefined);assert.ok((await readFile(store.notePath(id),'utf8')).includes('paperdesk_format: 1'));
  assert.match(await readFile(store.notePath(id),'utf8'),/"version":3/);
  response=await h.request(`/documents/${id}/file`);assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(sample));
});

test('ordinary library mode rejects the two vault selection endpoints and keeps upload and file reading unchanged',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'paperdesk-library-selection-')),runtime=createApp({dataDir:root});await runtime.ready;
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/vault/pdfs`)).status,400);
  assert.equal((await fetch(`${base}/api/vault/pdfs/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'file.pdf'})})).status,400);
  const form=new FormData();form.append('file',new Blob([sample]),'ordinary.pdf');let response=await fetch(`${base}/api/documents`,{method:'POST',body:form});assert.equal(response.status,201);const{document}=await response.json();
  response=await fetch(`${base}/api/documents/${document.id}/file`);assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(sample));
  const db=new DatabaseSync(path.join(root,'paperdesk.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,CURRENT_SCHEMA);db.close();
});

test('external uploads create formal managed PDF copies and coexist with original-selected records after cache rebuilding',async t=>{
  const h=await harness(t),outside=path.join(h.root,'external original.pdf');await writeFile(outside,sample);
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),{code:'ENOENT'});
  let response=await h.importPdf(await readFile(outside));assert.equal(response.status,201,await response.clone().text());
  const imported=(await response.json()).document,managed=path.join(h.vaultDir,'Paperdesk','PDFs',`${imported.id}.pdf`);
  assert.equal(hash(await readFile(outside)),hash(sample));assert.equal(hash(await readFile(managed)),hash(sample));
  let current=(await(await h.request(`/documents/${imported.id}`)).json()).document;
  assert.equal((await h.request(`/documents/${imported.id}`,'PATCH',{notesZh:'外部导入后的正式笔记',expectedNotesRevision:current.notesRevision})).status,200);
  assert.equal((await h.request(`/documents/${imported.id}/annotations`,'POST',{page:1,quote:'正式副本引文',comment:'导入批注',color:'green',rects:[{x:.1,y:.2,width:.3,height:.04}],requestId:randomUUID()})).status,201);
  const store=createVaultStore({vaultDir:h.vaultDir,recoveryDir:path.join(h.dataDir,'recoveries','originals')});
  const record=store.readDocument(imported.id);assert.equal(record.pdfSource,undefined);assert.equal(record.annotations.length,1);assert.equal(record.document.notes_zh,'外部导入后的正式笔记');
  assert.match(await readFile(h.notePath(imported.id),'utf8'),/paperdesk_format: 3/);
  const modified=Buffer.concat([sample,Buffer.from('\n% distinct original-selected PDF\n')]),selected=await h.upload('原始资料/原位 # 2.pdf',modified),original=path.join(h.vaultDir,'原始资料','原位 # 2.pdf');
  assert.deepEqual(store.readDocument(selected.id).pdfSource,{kind:'vault',path:'原始资料/原位 # 2.pdf'});
  const listed=(await(await h.request('/vault/pdfs')).json()).files;
  assert.equal(listed.find(file=>file.path===`Paperdesk/PDFs/${imported.id}.pdf`).documentId,imported.id);
  assert.equal(listed.find(file=>file.path==='原始资料/原位 # 2.pdf').documentId,selected.id);
  const noteBytes=await readFile(h.notePath(imported.id)),selectedNote=await readFile(h.notePath(selected.id));
  await h.stop();for(const name of ['paperdesk.sqlite','paperdesk.sqlite-wal','paperdesk.sqlite-shm'])await rm(path.join(h.dataDir,name),{force:true});await h.start();
  const docs=(await(await h.request('/documents')).json()).documents;assert.equal(docs.length,2);assert.equal(docs.find(doc=>doc.id===imported.id).notesZh,'外部导入后的正式笔记');
  for(const doc of [imported,selected]) {
    response=await h.request(`/documents/${doc.id}/file`);assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),doc.id===imported.id?hash(sample):hash(modified));
    response=await h.request(`/documents/${doc.id}/toc`);assert.equal(response.status,200);
    response=await h.request(`/documents/${doc.id}/reader-page?page=1&width=600`);assert.equal(response.status,200);assert.ok((await response.json()).image.startsWith('iVBOR'));
  }
  assert.deepEqual(await readFile(h.notePath(imported.id)),noteBytes);assert.deepEqual(await readFile(h.notePath(selected.id)),selectedNote);
  assert.equal(hash(await readFile(original)),hash(modified));assert.equal(hash(await readFile(outside)),hash(sample));
  assert.deepEqual(await readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),[`${imported.id}.pdf`]);
  assert.deepEqual(await readdir(path.join(h.dataDir,'.incoming')),[]);
});

test('uploaded and selected sources deduplicate across both formats without creating extra files or annotations',async t=>{
  const h=await harness(t),selected=await h.upload();
  assert.equal((await h.request(`/documents/${selected.id}/annotations`,'POST',{page:1,quote:'保留已有批注',comment:'仅一次',color:'yellow',rects:[{x:.1,y:.2,width:.2,height:.03}],requestId:randomUUID()})).status,201);
  const before=await readFile(h.notePath(selected.id));
  for(let count=0;count<2;count++){
    const response=await h.importPdf();assert.equal(response.status,200);const result=await response.json();assert.equal(result.duplicate,true);assert.equal(result.document.id,selected.id);
  }
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),{code:'ENOENT'},'A duplicate of an original-selected document must not even create the managed folder');
  assert.deepEqual(await readFile(h.notePath(selected.id)),before);assert.equal((await(await h.request(`/documents/${selected.id}`)).json()).annotations.length,1);
  const distinct=Buffer.concat([sample,Buffer.from('\n% upload distinct\n')]);let response=await h.importPdf(distinct,'different.pdf');assert.equal(response.status,201);const imported=(await response.json()).document;
  response=await h.importPdf(distinct,'duplicate.pdf');assert.equal(response.status,200);assert.equal((await response.json()).document.id,imported.id);
  response=await h.request('/vault/pdfs/open','POST',{path:`Paperdesk/PDFs/${imported.id}.pdf`});assert.equal(response.status,200);assert.equal((await response.json()).document.id,imported.id);
  const alias='原始资料/导入副本同内容.pdf',file=path.join(h.vaultDir,...alias.split('/'));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,distinct);
  response=await h.request('/vault/pdfs/open','POST',{path:alias});assert.equal(response.status,200);assert.equal((await response.json()).document.id,imported.id);
  assert.deepEqual(await readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),[`${imported.id}.pdf`]);assert.equal(hash(await readFile(file)),hash(distinct));
  assert.equal((await(await h.request('/documents')).json()).documents.length,2);assert.deepEqual(await readdir(path.join(h.dataDir,'.incoming')),[]);
});

test('invalid uploads and SQL failures leave no formal document, note, orphan PDF or incoming temporary file',async t=>{
  const h=await harness(t);
  for(const bytes of [Buffer.from('not a PDF'),Buffer.from('%PDF-1.7\nnot parseable')]) {
    const response=await h.importPdf(bytes);assert.equal(response.status,400,await response.clone().text());
  }
  await assert.rejects(readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),{code:'ENOENT'});
  const db=new DatabaseSync(path.join(h.dataDir,'paperdesk.sqlite'));
  db.exec("CREATE TRIGGER fail_import_page BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT,'isolated import failure'); END;");
  let response=await h.importPdf();assert.equal(response.status,500);assert.ok(!JSON.stringify(await response.json()).includes(h.root));
  assert.deepEqual(await readdir(path.join(h.vaultDir,'Paperdesk','PDFs')),[]);assert.deepEqual(await readdir(path.join(h.vaultDir,'Paperdesk','Notes')),[]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,0);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages').get().count,0);
  const recoveries=await readdir(path.join(h.dataDir,'recoveries','originals'));assert.equal(recoveries.length,1);assert.equal(hash(await readFile(path.join(h.dataDir,'recoveries','originals',recoveries[0]))),hash(sample));
  db.exec('DROP TRIGGER fail_import_page');db.close();
  assert.deepEqual(await readdir(path.join(h.dataDir,'.incoming')),[]);
  await h.stop();await h.start();assert.deepEqual((await(await h.request('/documents')).json()).documents,[]);
  response=await h.importPdf();assert.equal(response.status,201,await response.clone().text());
});

test('a linked managed PDF folder refuses new uploads without writing to the link target',async t=>{
  const h=await harness(t),target=path.join(h.root,'external-managed');await mkdir(target);await symlink(target,path.join(h.vaultDir,'Paperdesk','PDFs'));
  const response=await h.importPdf();assert.equal(response.status,409);assert.equal((await response.json()).conflictPreserved,undefined);
  assert.deepEqual(await readdir(target),[]);assert.deepEqual(await readdir(path.join(h.vaultDir,'Paperdesk','Notes')),[]);assert.deepEqual(await readdir(path.join(h.dataDir,'.incoming')),[]);
});

test('page bookmarks on legacy managed and original sources survive body, annotations, position and folder saves then full cache rebuilding',async t=>{
  const h=await harness(t),original=await h.upload(),different=Buffer.concat([sample,Buffer.from('\n% managed legacy bookmark PDF\n')]);
  let response=await h.importPdf(different);assert.equal(response.status,201);const managed=(await response.json()).document;
  for(const [doc,version] of [[original,2],[managed,1]])await writeFile(h.notePath(doc.id),legacyVaultMarkdown(await readFile(h.notePath(doc.id),'utf8'),version));
  const all=new Map();
  for(const doc of [original,managed]){
    const route=`/documents/${doc.id}`,before=(await(await h.request(route)).json()).document;
    response=await h.request(`${route}/bookmarks`);assert.deepEqual(await response.json(),{bookmarks:[]});
    response=await h.request(`${route}/bookmarks`,'POST',{page:2,title:`复查 ${doc.id.slice(0,8)}`});assert.equal(response.status,201);const bookmark=(await response.json()).bookmark;all.set(doc.id,bookmark);
    response=await h.request(route,'PATCH',{notesZh:'Paperdesk 阅读正文',expectedNotesRevision:before.notesRevision});assert.equal(response.status,200);
    const note=await readFile(h.notePath(doc.id),'utf8');assert.match(note,/"version":3/);assert.ok(note.includes(`paperdesk_format: ${doc.id===original.id?2:1}`));
    await writeFile(h.notePath(doc.id),note.replace('Paperdesk 阅读正文','Obsidian双向编辑正文').replace('---\n','---\naliases: [个人页面导航]\n'));
    response=await h.request(route,'PATCH',{lastPage:2,positionWriterId:randomUUID(),positionSequence:1});assert.equal(response.status,200);
    response=await h.request(`${route}/annotations`,'POST',{page:2,quote:'书签同页引文',comment:'正常批注',color:'green',rects:[{x:.1,y:.2,width:.3,height:.04}],requestId:randomUUID()});assert.equal(response.status,201);
    response=await h.request(`${route}/bookmarks`);assert.deepEqual((await response.json()).bookmarks,[bookmark]);
  }
  response=await h.request('/folders','POST',{name:'个人书签测试'});assert.equal(response.status,201);const{folder}=await response.json();
  for(const doc of [original,managed])assert.equal((await h.request(`/documents/${doc.id}/folder`,'PATCH',{folderId:folder.id})).status,200);
  assert.equal((await h.request(`/folders/${folder.id}`,'DELETE')).status,200);
  const originalFile=path.join(h.vaultDir,...h.defaultPdfPath.split('/')),managedFile=path.join(h.vaultDir,'Paperdesk','PDFs',`${managed.id}.pdf`);
  const bytes=new Map(await Promise.all([original,managed].map(async doc=>[doc.id,await readFile(h.notePath(doc.id))])));
  await h.stop();for(const name of ['paperdesk.sqlite','paperdesk.sqlite-wal','paperdesk.sqlite-shm'])await rm(path.join(h.dataDir,name),{force:true});await h.start();
  for(const doc of [original,managed]){
    response=await h.request(`/documents/${doc.id}/bookmarks`);assert.equal(response.status,200);assert.deepEqual((await response.json()).bookmarks,[all.get(doc.id)]);
    const restored=(await(await h.request(`/documents/${doc.id}`)).json());assert.equal(restored.document.notesZh,'Obsidian双向编辑正文');assert.equal(restored.document.lastPage,2);assert.equal(restored.document.folderId,null);assert.equal(restored.annotations.length,1);
    assert.deepEqual(await readFile(h.notePath(doc.id)),bytes.get(doc.id));
  }
  assert.equal(hash(await readFile(originalFile)),hash(sample));assert.equal(hash(await readFile(managedFile)),hash(different));
  const bookmark=all.get(original.id),note=await readFile(h.notePath(original.id),'utf8'),changed=note.replace(`· ${bookmark.title}`,`· Obsidian外部手改书签`);assert.notEqual(changed,note);await writeFile(h.notePath(original.id),changed);
  response=await h.request(`/documents/${original.id}/bookmarks/${bookmark.id}`,'PATCH',{title:'Paperdesk本机草稿',expectedUpdatedAt:bookmark.updatedAt});assert.equal(response.status,409);const failure=await response.json();assert.equal(failure.code,undefined);assert.equal(failure.conflictPreserved,undefined);assert.equal(await readFile(h.notePath(original.id),'utf8'),changed);
});
