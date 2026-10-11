import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSourceLink, sourceLinkSearch, validSourceRects, createReadingHistory } from '../shared/source-navigation.mjs';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';

const id=randomUUID(),captureId=randomUUID(),sha='b'.repeat(64);
const source={documentId:id,page:3,pdfSha256:sha,captureId};

test('source links preserve physical page and identities without trusting URL geometry',()=>{
  const search=sourceLinkSearch(source,'embedded=1&readerSession=kept');
  assert.deepEqual(readSourceLink(search),{...source,annotationId:null,invalid:false});
  assert.equal(new URLSearchParams(search).get('readerSession'),'kept');
  assert.deepEqual(readSourceLink(`document=${id}&page=2`),{documentId:id,page:2,pdfSha256:null,captureId:null,annotationId:null,invalid:false});
  assert.equal(readSourceLink('').invalid,false);
  for(const [version,parameter] of [['7','capture'],['8','annotation']]){
    const valid=id.slice(0,14)+version+id.slice(15);
    assert.equal(readSourceLink(`document=${id}&page=3&pdfSha256=${sha}&${parameter}=${valid}`).invalid,false);
  }
  for(const version of ['0','9']){
    const invalid=id.slice(0,14)+version+id.slice(15);
    assert.equal(readSourceLink(`document=${id}&page=3&pdfSha256=${sha}&capture=${invalid}`).invalid,true);
  }
  for(const query of [
    `document=${id}&page=1e2`,`document=${id}&page=01`,`document=${id}&page=0`,`document=${id}&page=9007199254740992`,
    `page=2`,`document=wrong&page=2`,`${search}&page=3`,`${search}&capture=${captureId}`,
    `document=${id}&page=3&capture=${captureId}`,`${search}&annotation=${randomUUID()}`,
    `document=${id}&page=3&pdfSha256=invalid`,`${search}&pdfSha256=${sha}`,
  ])assert.equal(readSourceLink(query).invalid,true,query);
  assert.equal(Object.hasOwn(readSourceLink(`${search}&rects=untrusted`),'rects'),false);
});

test('normalized source rectangles reject zero, nonfinite, out-of-page or excessive geometry',()=>{
  assert.equal(validSourceRects([{x:.1,y:.2,width:.3,height:.4}]),true);
  for(const rects of [[],null,[null],[{x:0,y:0,width:0,height:1}],[{x:-.1,y:0,width:.2,height:.2}],
    [{x:.8,y:0,width:.3,height:.2}],[{x:0,y:0,width:Infinity,height:.2}],Array(201).fill({x:0,y:0,width:1,height:1})])assert.equal(validSourceRects(rects),false);
});

test('reading history deduplicates repeats, keeps focus identity, truncates forward branches and bounds memory',()=>{
  const history=createReadingHistory(3),a={documentId:id,page:1},b={...a,page:2},c={...source};
  history.visit(a);history.visit(b);history.visit(b);
  assert.equal(history.snapshot().length,2);
  history.visit(c);assert.equal(history.destination(-1).page,2);
  history.visit(b,{historyIndex:1});assert.equal(history.snapshot().forward,true);
  history.visit({...b,page:5});assert.equal(history.snapshot().forward,false);
  assert.equal(history.destination(-1).page,2);
  history.visit({...b,page:6},{replace:true});assert.equal(history.snapshot().length,3);
  history.visit(c);assert.equal(history.snapshot().length,3);
  assert.throws(()=>history.visit({...a,page:999},{historyIndex:0}),/历史已变化/);
  const before=history.current();c.page=999;assert.equal(before.page,3,'History owns a snapshot, not a mutable reference');
});

test('scrolling after going back discards the forward branch but an unchanged target preserves it',()=>{
  const history=createReadingHistory(),targets=[1,3,5].map(page=>({documentId:id,page,pdfSha256:sha}));
  for(const target of targets)history.visit(target);
  history.visit(targets[1],{historyIndex:1});
  history.visit({...targets[1]},{replace:true});
  assert.equal(history.snapshot().forward,true,'An unchanged scroll sample is not a new route');
  history.visit({...targets[1],page:4},{replace:true});
  assert.deepEqual(history.snapshot(),{back:true,forward:false,index:1,length:2});
  assert.equal(history.destination(-1).page,1);
  assert.equal(history.destination(1),null);
  history.visit(targets[0],{historyIndex:0});
  assert.equal(history.destination(1).page,4,'Forward now follows the new reading route');
});

test('acknowledged annotation deletion clears every matching history identity without losing pages or the cursor',()=>{
  const annotationId=randomUUID(),otherId=randomUUID(),history=createReadingHistory();
  const annotation={documentId:id,page:4,pdfSha256:sha,annotationId,verifySource:true,find:''};
  const targets=[source,annotation,{documentId:id,page:5},annotation,{...annotation,documentId:otherId}];
  for(const target of targets)history.visit(target);
  history.visit(annotation,{historyIndex:1});
  const before=history.snapshot();
  assert.deepEqual(history.forgetAnnotation(id,annotationId),before);
  assert.deepEqual(history.current(),{documentId:id,page:4,pdfSha256:sha,verifySource:true,find:''});
  assert.equal(history.destination(-1).captureId,captureId,'Unrelated capture identities survive');
  assert.equal(history.destination(2).annotationId,undefined,'Older and newer matching entries are cleared');
  assert.equal(history.destination(3).annotationId,annotationId,'Another document is not changed');
  assert.equal(annotation.annotationId,annotationId,'Caller snapshots are not mutated');
  assert.throws(()=>history.visit(annotation,{historyIndex:1}),/历史已变化/,'An in-flight old history target cannot restore the deleted identity');
});

test('capture return resolves only intact manifests and original PDF identities',async t=>{
  const root=await mkdtemp(join(tmpdir(),'paperdesk-source-api-')),vaultDir=join(root,'vault'),dataDir=join(root,'cache');
  await mkdir(join(vaultDir,'.obsidian'),{recursive:true});
  const runtime=createApp({vaultDir,dataDir});await runtime.ready;
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const request=(path,body)=>fetch(`${base}${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const bytes=bookmarkedPdf(),pdfPath=join(vaultDir,'source.pdf');await writeFile(pdfPath,bytes);
  const opened=await request('/vault/pdfs/open',{path:'source.pdf'});assert.equal(opened.status,201);
  const doc=(await opened.json()).document;
  const payload={requestId:randomUUID(),documentId:doc.id,page:3,rects:[{x:.1,y:.2,width:.3,height:.4}],quote:'Synthetic source only',comment:'A local return point'};
  const exported=await request('/integrations/knowledge/export',payload);assert.equal(exported.status,201);
  const folder=join(vaultDir,(await exported.json()).relativePath),manifestFile=join(folder,'manifest.json'),original=await readFile(manifestFile,'utf8');
  const route=`/integrations/knowledge/capture/${payload.requestId}`;
  const result=await request(route);assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{id:payload.requestId,documentId:doc.id,pdfSha256:createHash('sha256').update(bytes).digest('hex'),page:3,rects:payload.rects});
  assert.equal((await request(`/integrations/knowledge/capture/${randomUUID()}`)).status,404);
  assert.equal((await request('/integrations/knowledge/capture/invalid')).status,400);
  const manifest=JSON.parse(original);
  for(const patch of [
    value=>value.source.pdfSha256='0'.repeat(64),value=>value.id=randomUUID(),value=>value.source.page=999,
    value=>value.source.rects[0].x=.99,value=>value.source.quote='changed quote',value=>value.source.documentId=randomUUID(),
    value=>value.schema='unknown/v2',value=>value.createdAt='invalid',value=>value.image={file:'../../source.pdf',mime:'image/png',sha256:sha},
  ]){const changed=structuredClone(manifest);patch(changed);await writeFile(manifestFile,JSON.stringify(changed));assert.equal((await request(route)).status,409);}
  await writeFile(manifestFile,original);await writeFile(pdfPath,Buffer.concat([bytes,Buffer.from('\n% changed original')]));
  assert.equal((await request(route)).status,409);
  await writeFile(pdfPath,bytes);assert.equal((await request(route)).status,200);
  assert.equal(await readFile(manifestFile,'utf8'),original,'Source return never rewrites a capture');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB3sAAAAASUVORK5CYII=','base64');
  const imagePayload={...payload,requestId:randomUUID(),quote:'',image:png.toString('base64')};
  const imageExport=await request('/integrations/knowledge/export',imagePayload);assert.equal(imageExport.status,201);
  const imageFolder=join(vaultDir,(await imageExport.json()).relativePath),imageRoute=`/integrations/knowledge/capture/${imagePayload.requestId}`;
  assert.equal((await request(imageRoute)).status,200);
  await writeFile(join(imageFolder,'selection.png'),'truncated sync');assert.equal((await request(imageRoute)).status,409);
});
