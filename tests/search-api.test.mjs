import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

test('indexed API searches updated notes/annotations, rebuilds locally and preserves PDF identity across restart', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paperdesk-search-api-'));
  let runtime, server, base;
  async function start() {
    runtime = createApp({ dataDir }); await runtime.ready;
    server = runtime.app.listen(0,'127.0.0.1'); await once(server,'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close();
  }
  t.after(async () => { await stop(); await rm(dataDir,{recursive:true,force:true}); });
  await start();
  const request = (url,method,body,headers={}) => fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const search = async q => { const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`); assert.equal(res.status,200); return (await res.json()).results; };
  const bytes = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
  const form = new FormData(); form.append('file',new Blob([bytes],{type:'application/pdf'}),'synthetic.pdf');
  const imported = await fetch(`${base}/api/documents`,{method:'POST',body:form}); assert.equal(imported.status,201);
  const { document } = await imported.json(), endpoint = `/api/documents/${document.id}`;
  assert.match(document.pdfSha256,/^[a-f0-9]{64}$/);
  assert.ok((await search('相位裕度')).some(r => r.page===2&&r.source==='text'));
  assert.equal((await request(endpoint,'PATCH',{notesZh:'GM/ID 中文短词 电流 100% _literal_ "quoted"',notesEn:''})).status,200);
  for (const q of ['gm/id','电流','100%','_literal_','"quoted"']) assert.ok((await search(q)).some(r => r.source==='notes'));
  const response = await request(endpoint+'/annotations','POST',{page:2,kind:'region',quote:'',comment:'gm/Id区域',color:'yellow',rects:[{x:.1,y:.2,width:.3,height:.2}]});
  assert.equal(response.status,201);
  const { annotation } = await response.json(), result = (await search('区域')).find(r => r.source==='annotation');
  assert.equal(result.annotationId,annotation.id); assert.equal(result.pdfSha256,document.pdfSha256); assert.deepEqual(result.rects,annotation.rects);
  assert.equal((await request(endpoint+'/annotations/'+annotation.id,'PATCH',{comment:'新区域'})).status,200);
  assert.equal((await search('gm/Id区域')).length,0);
  const before = await search('新区域');
  assert.equal((await request('/api/search/rebuild','POST',{}, {Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request('/api/search/rebuild','POST',{force:true})).status,400);
  assert.equal((await request('/api/search/rebuild','POST',{})).status,200);
  assert.deepEqual(await search('新区域'),before);
  await stop(); await start();
  assert.deepEqual(await search('新区域'),before);
  assert.deepEqual(Buffer.from(await (await fetch(base+endpoint+'/file')).arrayBuffer()),bytes);
  assert.equal((await request(endpoint+'/annotations/'+annotation.id,'DELETE')).status,200);
  assert.equal((await search('新区域')).length,0);
});
