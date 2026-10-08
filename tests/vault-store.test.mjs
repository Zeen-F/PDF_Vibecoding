import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createVaultStore, validateVaultDirectory } from '../server/vault-store.mjs';
import { extractToc } from '../server/toc.mjs';
import { createReaderRenderer } from '../server/reader-render.mjs';
import { MAX_NOTE_LENGTH, mergeNotes } from '../shared/notes.mjs';

const sample = readFileSync(new URL('../public/examples/reading-demo.pdf', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const instant = '2026-10-08T00:00:00.000Z';
const status409 = error => error.status === 409 && Boolean(error.message);

function setup(t, options = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'paperdesk-vault-store-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const vault = path.join(base, 'vault'), recoveryDir = path.join(base, 'recovery');
  mkdirSync(vault); mkdirSync(path.join(vault, '.obsidian'));
  const store = createVaultStore({ vaultDir: vault, recoveryDir, ...options });
  mkdirSync(store.pdfDir,{recursive:true}); // Legacy fixtures explicitly provision their historical PDF folder.
  const id = randomUUID();
  const document = { id, sha256: sha256(sample), title: '隔离资料：Paperdesk 联动测试', filename: 'reading-demo.pdf',
    page_count: 4, byte_size: sample.length, created_at: instant, updated_at: instant, text_available: 1,
    notes_zh: '# 阅读笔记\n\n中文、English 与公式 $g_m/I_D$\n\n', notes_en: '', last_page: 2, folder_id: null };
  writeFileSync(store.pdfPath(id), sample);
  const annotation = { id: randomUUID(), document_id: id, page: 2, kind: 'text', quote: 'First line\nSecond line → 中文',
    comment: '需要核对边界条件。', color: 'yellow', rects: JSON.stringify([{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]),
    created_at: instant, updated_at: instant };
  const region = { ...annotation, id: randomUUID(), page: 4, kind: 'region', quote: '', color: 'green',
    rects: JSON.stringify([{ x: 0.2, y: 0.3, width: 0.4, height: 0.1 }]) };
  const request = { document_id: id, request_id: randomUUID(), request_hash: sha256('request'), annotation_id: annotation.id, created_at: Date.parse(instant) };
  const writer = { document_id: id, writer_id: randomUUID(), sequence: 7, page: 2, updated_at: Date.parse(instant) };
  const payload = { document, annotations: [annotation, region], annotationRequests: [request], positionWriters: [writer] };
  return { base, vault, recoveryDir, store, id, payload };
}
function rewriteState(file, change) {
  const source = readFileSync(file, 'utf8');
  const next = source.replace(/(<!-- paperdesk-state:v1\n)([^\n]*)(\n-->)/, (_all, start, serialized, end) => {
    const state = JSON.parse(serialized); change(state);
    return start + JSON.stringify(state).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') + end;
  });
  assert.notEqual(next, source); writeFileSync(file, next);
  return next;
}

test('PDF, Markdown notes, text and region geometry, request ledger and writer sequence roundtrip without database files', t => {
  const { store, payload, recoveryDir } = setup(t);
  const saved = store.writeDocument(payload, null);
  assert.deepEqual(saved.document, payload.document);
  assert.deepEqual(saved.annotations, payload.annotations);
  assert.deepEqual(saved.annotationRequests, payload.annotationRequests);
  assert.deepEqual(saved.positionWriters, payload.positionWriters);
  assert.equal(saved.token, sha256(readFileSync(saved.notePath)));
  assert.equal(saved.pdfPath, store.pdfPath(saved.document.id));
  assert.deepEqual(store.readAll(), [saved]);
  const markdown = readFileSync(saved.notePath, 'utf8');
  assert.ok(markdown.includes('[PDF 第 2 页](../PDFs/'));
  assert.ok(markdown.includes('> First line\n> Second line → 中文'));
  assert.ok(markdown.includes('区域批注'));
  assert.deepEqual(readdirSync(store.rootDir).sort(), ['Notes', 'PDFs']);
  assert.throws(() => readdirSync(recoveryDir), { code: 'ENOENT' }, 'No recovery folder is needed before any replacement');
});

test('external body edits read back exactly, custom frontmatter survives saves, legacy language fields merge once', t => {
  const { store, payload } = setup(t);
  payload.document.notes_en = 'Legacy English\n';
  const first = store.writeDocument(payload, null);
  assert.equal(first.document.notes_zh, mergeNotes(payload.document.notes_zh, payload.document.notes_en));
  assert.equal(first.document.notes_en, '');
  const file = first.notePath;
  const customProperties = '---\r\npaperdesk_id: "custom property display"\r\ncustom: "a: b"\r\n---\r\n';
  const body = '\n# Obsidian 编辑\r\n\r\n  保留首尾空白与 CRLF。  \n';
  const source = readFileSync(file, 'utf8');
  const generated = source.slice(source.indexOf('\n\n<!-- paperdesk-generated:start:v1 -->'));
  writeFileSync(file, customProperties + body + generated + '尾部也属于正文\n');
  const edited = store.readDocument(payload.document.id);
  assert.equal(edited.document.notes_zh, body + '尾部也属于正文\n');
  assert.notEqual(edited.token, first.token);
  const saved = store.writeDocument(edited, edited.token);
  assert.ok(readFileSync(file, 'utf8').startsWith(customProperties));
  assert.equal(saved.document.notes_zh, body + '尾部也属于正文\n');
});

test('stale or omitted versions never replace an external edit; each conflict copy preserves the complete proposed note', t => {
  const { store, payload, recoveryDir } = setup(t);
  const first = store.writeDocument(payload, null);
  const external = readFileSync(first.notePath, 'utf8').replace('# 阅读笔记', '# Obsidian 最新内容');
  writeFileSync(first.notePath, external);
  const proposal = { ...payload, document: { ...payload.document, notes_zh: '# Paperdesk 尚未保存\n\n' } };
  for (const token of [first.token, null, undefined]) assert.throws(() => store.writeDocument(proposal, token), status409);
  assert.equal(readFileSync(first.notePath, 'utf8'), external);
  const copies = [store.writeConflict(payload.document.id, proposal.document.notes_zh), store.writeConflict(payload.document.id, proposal.document.notes_zh)];
  assert.notEqual(copies[0], copies[1]);
  for (const copy of copies) {
    const source = readFileSync(copy, 'utf8');
    assert.ok(source.includes(`paperdesk_source_id: "${payload.document.id}"`));
    assert.ok(source.endsWith(proposal.document.notes_zh));
  }
  const latest = store.readDocument(payload.document.id);
  const updated = store.writeDocument({ ...latest, document: { ...latest.document, notes_zh: latest.document.notes_zh + '合并后的修改\n' } }, latest.token);
  const backups = readdirSync(recoveryDir);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(recoveryDir, backups[0]), 'utf8'), external);
  assert.notEqual(updated.token, latest.token);
});

test('a new note refuses an existing unmanaged Markdown file and keeps its bytes', t => {
  const { store, payload } = setup(t);
  const file = store.notePath(payload.document.id), original = '# 已有的个人资料\n';
  writeFileSync(file, original);
  assert.throws(() => store.writeDocument(payload, null), status409);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('missing, duplicate, malformed managed sections are rejected before replacing the original', t => {
  const { store, payload } = setup(t);
  const saved = store.writeDocument(payload, null), original = readFileSync(saved.notePath, 'utf8');
  const variants = [
    original.replace('paperdesk-generated:start:v1', 'paperdesk-generated:broken:v1'),
    original + '\n\n<!-- paperdesk-generated:start:v1 -->\n',
    original.replace('<!-- paperdesk-generated:end:v1 -->', ''),
    original.replace('<!-- paperdesk-state:v1\n', '<!-- paperdesk-state:v1\nINVALID'),
    original + '<!-- paperdesk-state:v1\n{}\n-->\n',
    original.replace('---\n', '--- BROKEN\n'),
  ];
  for (const broken of variants) {
    writeFileSync(saved.notePath, broken);
    assert.throws(() => store.readDocument(payload.document.id), status409);
    assert.throws(() => store.writeDocument(payload, sha256(Buffer.from(broken))), status409);
    assert.equal(readFileSync(saved.notePath, 'utf8'), broken);
  }
});

test('invalid UUIDs, types, geometry, lengths, duplicate IDs, retry data and writer bounds reject without writing', t => {
  const { store, payload } = setup(t);
  const changes = [
    p => { p.document.title = ''; }, p => { p.document.page_count = 2001; }, p => { p.document.last_page = 5; },
    p => { p.document.text_available = true; }, p => { p.document.folder_id = '../escape'; },
    p => { p.document.filename = '../source.pdf'; }, p => { p.document.notes_zh = 'x'.repeat(MAX_NOTE_LENGTH + 1); },
    p => { p.annotations[0].rects = JSON.stringify([{ x: 0.9, y: 0, width: 0.2, height: 0.1 }]); },
    p => { p.annotations[0].rects = JSON.stringify([{ x: 0, y: 0, width: 0, height: 0.1 }]); },
    p => { p.annotations[0].rects = JSON.stringify([{ x: 0, y: 0, width: 0.1, height: 0.1, extra: true }]); },
    p => { p.annotations[1].quote = 'region must not contain text'; },
    p => { p.annotations.push(p.annotations[0]); }, p => { p.annotations[0].document_id = randomUUID(); },
    p => { p.annotationRequests[0].request_hash = 'invalid'; },
    p => { p.positionWriters[0].sequence = Number.MAX_SAFE_INTEGER + 1; },
    p => { p.document.notes_zh = '<!-- paperdesk-state:v1\n'; },
  ];
  for (const change of changes) {
    const modified = structuredClone(payload); change(modified);
    assert.throws(() => store.writeDocument(modified, null), status409);
    assert.equal(store.readDocument(payload.document.id), null);
  }
});

test('externally corrupted metadata IDs or bounds never become indexed records', t => {
  const { store, payload } = setup(t);
  const saved = store.writeDocument(payload, null), original = readFileSync(saved.notePath, 'utf8');
  for (const change of [state => { state.document.id = randomUUID(); }, state => { state.annotations[0].page = 99; },
    state => { state.positionWriters[0].page = 99; }, state => { state.version = 2; }]) {
    writeFileSync(saved.notePath, original); rewriteState(saved.notePath, change);
    assert.throws(() => store.readAll(), status409);
  }
});

test('PDF existence, size, hash and symlink integrity are verified, including changes after cached reads', t => {
  const { store, payload, base } = setup(t);
  const saved = store.writeDocument(payload, null), file = saved.pdfPath;
  const modified = Buffer.from(sample); modified[modified.length - 1] ^= 1;
  writeFileSync(file, modified);
  assert.throws(() => store.readDocument(payload.document.id), status409);
  writeFileSync(file, sample.subarray(0, sample.length - 1));
  assert.throws(() => store.readDocument(payload.document.id), status409);
  unlinkSync(file);
  assert.throws(() => store.readDocument(payload.document.id), status409);
  const external = path.join(base, 'external.pdf'); writeFileSync(external, sample); symlinkSync(external, file);
  assert.throws(() => store.readDocument(payload.document.id), status409);
  assert.deepEqual(readFileSync(external), sample);
});

test('vault validation is read-only and refuses missing markers, marker links, vault links, traversal and linked directories', t => {
  const { base, vault, store } = setup(t);
  const empty = path.join(base, 'empty'); mkdirSync(empty);
  assert.throws(() => validateVaultDirectory(empty), status409);
  assert.deepEqual(readdirSync(empty), []);
  const linked = path.join(base, 'linked-vault'); symlinkSync(vault, linked);
  assert.throws(() => validateVaultDirectory(linked), status409);
  for (const subdir of ['../outside', '/absolute', 'Paperdesk/../outside', '.obsidian', 'Paperdesk\\..\\outside']) {
    assert.throws(() => createVaultStore({ vaultDir: vault, subdir }), status409);
  }
  assert.throws(() => store.pdfPath('../source'), status409);
  assert.throws(() => store.notePath(randomUUID().toUpperCase()), status409);
  const actual = path.join(base, 'actual-folder'); mkdirSync(actual);
  symlinkSync(actual, path.join(vault, 'linked-folder'));
  assert.throws(() => createVaultStore({ vaultDir: vault, subdir: 'linked-folder/Paperdesk' }), status409);
  assert.deepEqual(readdirSync(actual), []);
  rmSync(path.join(vault, '.obsidian'), { recursive: true }); symlinkSync(actual, path.join(vault, '.obsidian'));
  assert.throws(() => validateVaultDirectory(vault), status409);
});

test('linked note and conflict files are rejected without touching their targets', t => {
  const { store, payload, base } = setup(t);
  const target = path.join(base, 'personal.md'); writeFileSync(target, '# 保留个人文件\n');
  const note = store.notePath(payload.document.id); symlinkSync(target, note);
  assert.throws(() => store.readDocument(payload.document.id), status409);
  assert.throws(() => store.writeDocument(payload, null), status409);
  const conflictTarget = path.join(base, 'elsewhere'); mkdirSync(conflictTarget);
  symlinkSync(conflictTarget, path.join(store.rootDir, 'Notes', 'Conflicts'));
  assert.throws(() => store.writeConflict(payload.document.id, 'unsaved'), status409);
  assert.equal(readFileSync(target, 'utf8'), '# 保留个人文件\n');
  assert.deepEqual(readdirSync(conflictTarget), []);
});

test('library folder metadata and theme roundtrip, require CAS and preserve malformed external edits', t => {
  const { store, recoveryDir } = setup(t);
  assert.deepEqual(store.readLibrary(), { state: { folders: [], theme: 'forest' }, token: null });
  const state = { folders: [{ id: randomUUID(), name: 'LDO 论文', name_key: 'ldo 论文', created_at: instant, updated_at: instant }], theme: 'night' };
  const first = store.writeLibrary(state, null);
  assert.deepEqual(first.state, state);
  assert.deepEqual(store.readLibrary(), first);
  assert.throws(() => store.writeLibrary({ ...state, theme: 'sand' }, null), status409);
  const second = store.writeLibrary({ ...state, theme: 'sand' }, first.token);
  assert.equal(second.state.theme, 'sand'); assert.equal(readdirSync(recoveryDir).length, 1);
  const libraryPath = path.join(store.rootDir, 'Library.md'), corrupted = readFileSync(libraryPath, 'utf8').replace('"version":1', '"version":7');
  writeFileSync(libraryPath, corrupted);
  assert.throws(() => store.readLibrary(), status409);
  assert.throws(() => store.writeLibrary(state, sha256(Buffer.from(corrupted))), status409);
  assert.equal(readFileSync(libraryPath, 'utf8'), corrupted);
});

test('reserved folders do not silently import unrelated UUID-less Markdown and temporary files are cleaned', t => {
  const { store, payload } = setup(t);
  const saved = store.writeDocument(payload, null);
  store.writeDocument(saved, saved.token);
  assert.deepEqual(readdirSync(path.dirname(saved.notePath)), [`${payload.document.id}.md`]);
  writeFileSync(path.join(path.dirname(saved.notePath), 'unmanaged.md'), '# unrelated');
  assert.throws(() => store.readAll(), status409);
});

test('recovery directory aliases into the vault are refused before creating any recovery directories', t => {
  const { base, vault } = setup(t);
  const alias = path.join(base, 'recovery-alias'); symlinkSync(vault, alias);
  assert.throws(() => createVaultStore({ vaultDir: vault, recoveryDir: path.join(alias, 'must-not-create') }), status409);
  assert.equal(readdirSync(vault).includes('must-not-create'), false);
  assert.throws(() => createVaultStore({ vaultDir: vault, recoveryDir: vault }), status409);
});

test('cross-document annotation IDs and duplicate PDF hashes cannot rebuild an inconsistent SQL index', t => {
  const { store, payload } = setup(t);
  const first = store.writeDocument(payload, null);
  const copy = structuredClone(payload), secondId = randomUUID();
  copy.document.id = secondId;
  for (const rows of [copy.annotations, copy.annotationRequests, copy.positionWriters]) for (const row of rows) row.document_id = secondId;
  writeFileSync(store.pdfPath(secondId), sample);
  store.writeDocument(copy, null);
  assert.throws(() => store.readAll(), status409);
  const different = Buffer.from(sample); different[different.length - 1] ^= 1;
  writeFileSync(store.pdfPath(secondId), different);
  const secondFile = store.notePath(secondId);
  rewriteState(secondFile, state => { state.document.sha256 = sha256(different); });
  assert.throws(() => store.readAll(), status409);
  assert.deepEqual(store.readDocument(payload.document.id), first);
});

test('visible generated annotation edits are refused without changing alpha.1 rendering or the original bytes', t => {
  const { store, payload } = setup(t);
  const saved = store.writeDocument(payload, null), original = readFileSync(saved.notePath, 'utf8');
  for (const changed of [
    original.replace('需要核对边界条件。', '在 Obsidian 手改的批注评论'),
    original.replace('> First line', '> 手改引文'),
    original.replace('## Paperdesk 批注\n', '## Paperdesk 批注\n\n额外的个人推导\n'),
  ]) {
    writeFileSync(saved.notePath, changed);
    for (const action of [() => store.readDocument(payload.document.id), () => store.writeDocument(payload, sha256(Buffer.from(changed)))]) {
      assert.throws(action, error => error.status === 409 && !error.code && !error.conflictPreserved && /移到笔记正文/.test(error.message));
    }
    assert.equal(readFileSync(saved.notePath, 'utf8'), changed);
  }
  writeFileSync(saved.notePath, original);
  assert.deepEqual(store.readDocument(payload.document.id), saved, 'The pre-rule generated format remains valid byte for byte');
  const bodyEdited = original.replace('# 阅读笔记', '# Obsidian 正文可以编辑');
  writeFileSync(saved.notePath, bodyEdited);
  const current = store.readDocument(payload.document.id);
  assert.ok(current.document.notes_zh.startsWith('# Obsidian 正文可以编辑'));
  const updated = store.writeDocument({ ...current, document: { ...current.document, notes_zh: current.document.notes_zh + 'Paperdesk 继续编辑\n' } }, current.token);
  assert.ok(updated.document.notes_zh.endsWith('Paperdesk 继续编辑\n'));
});

test('Library.md deletion after establishment blocks reads and writes without recreating default metadata', t => {
  const { store, payload, vault, recoveryDir } = setup(t);
  const state = { folders: [], theme: 'night' };
  store.writeLibrary(state, null);
  const saved = store.writeDocument(payload, null), before = readFileSync(saved.notePath, 'utf8');
  const library = path.join(store.rootDir, 'Library.md'); unlinkSync(library);
  for (const action of [() => store.readLibrary(), () => store.writeLibrary({ folders: [], theme: 'forest' }, null),
    () => store.writeDocument(payload, saved.token)]) {
    assert.throws(action, error => error.status === 409 && !error.code && !error.conflictPreserved && /Library\.md/.test(error.message));
  }
  assert.equal(readFileSync(saved.notePath, 'utf8'), before);
  assert.throws(() => readFileSync(library), { code: 'ENOENT' });
  const reopened = createVaultStore({ vaultDir: vault, recoveryDir });
  assert.throws(() => reopened.readLibrary(), status409);
  assert.throws(() => readFileSync(library), { code: 'ENOENT' });
});

test('version 2 keeps a nested original PDF in place, encodes page links, preserves source on edits and refuses changed bytes',t=>{
  const{store,payload}=setup(t),relative='文献/电路图 # 1/中文 阅读.pdf';
  const source=path.join(store.vaultDir,...relative.split('/'));mkdirSync(path.dirname(source),{recursive:true});writeFileSync(source,sample);
  unlinkSync(store.pdfPath(payload.document.id));
  payload.pdfSource={kind:'vault',path:relative};
  const saved=store.writeDocument(payload,null);assert.deepEqual(saved.pdfSource,payload.pdfSource);assert.equal(saved.pdfPath,source);
  let markdown=readFileSync(saved.notePath,'utf8');assert.ok(markdown.includes('paperdesk_format: 2'));
  const relativeLink='../../%E6%96%87%E7%8C%AE/%E7%94%B5%E8%B7%AF%E5%9B%BE%20%23%201/%E4%B8%AD%E6%96%87%20%E9%98%85%E8%AF%BB.pdf';
  assert.ok(markdown.includes(`pdf: "${relativeLink}"`));assert.ok(markdown.includes(`(${relativeLink}#page=2)`));
  const updated=store.writeDocument({...saved,document:{...saved.document,notes_zh:'继续编辑正文'}},saved.token);
  assert.deepEqual(updated.pdfSource,payload.pdfSource);assert.equal(updated.document.notes_zh,'继续编辑正文');
  assert.deepEqual(readdirSync(store.pdfDir),[]);assert.equal(sha256(readFileSync(source)),payload.document.sha256);
  markdown=readFileSync(updated.notePath,'utf8');writeFileSync(source,Buffer.concat([sample,Buffer.from('\n% changed\n')]));
  assert.throws(()=>store.readDocument(payload.document.id),status409);
  assert.throws(()=>store.writeDocument(updated,updated.token),status409);
  assert.equal(readFileSync(updated.notePath,'utf8'),markdown);
  unlinkSync(source);assert.throws(()=>store.readDocument(payload.document.id),status409);
});

test('version 2 PDF references reject traversal, absolute, hidden, malformed and symlink paths',t=>{
  const{store,payload,base}=setup(t);
  const badPaths=['../outside.pdf','/absolute.pdf','C:/outside.pdf','dir//file.pdf','dir/../file.pdf','dir\\file.pdf',
    '.obsidian/file.pdf','dir/.private/file.pdf','.hidden.pdf','directory/file.txt','dir/\u0000file.pdf'];
  for(const relative of badPaths)assert.throws(()=>store.writeDocument({...payload,pdfSource:{kind:'vault',path:relative}},null),status409);
  assert.throws(()=>store.writeDocument({...payload,pdfSource:{kind:'outside',path:'file.pdf'}},null),status409);
  assert.throws(()=>store.writeDocument({...payload,pdfSource:{kind:'vault',path:'file.pdf',extra:true}},null),status409);
  const outside=path.join(base,'outside.pdf');writeFileSync(outside,sample);symlinkSync(outside,path.join(store.vaultDir,'linked.pdf'));
  assert.throws(()=>store.inspectPdfSource({kind:'vault',path:'linked.pdf'}),status409);
  const directory=path.join(base,'outside-dir');mkdirSync(directory);writeFileSync(path.join(directory,'inside.pdf'),sample);symlinkSync(directory,path.join(store.vaultDir,'linked-directory'));
  assert.throws(()=>store.inspectPdfSource({kind:'vault',path:'linked-directory/inside.pdf'}),status409);
  assert.equal(store.readDocument(payload.document.id),null);assert.equal(sha256(readFileSync(outside)),sha256(sample));
});

test('a hash-verified PDF buffer continues to render TOC and PNG after the source path changes, without retained copies',async t=>{
  const{store,payload}=setup(t),relative='原始资料/快照 # PDF.pdf',source=path.join(store.vaultDir,...relative.split('/'));
  mkdirSync(path.dirname(source),{recursive:true});writeFileSync(source,sample);unlinkSync(store.pdfPath(payload.document.id));
  payload.document.page_count=2;payload.annotations=[];payload.pdfSource={kind:'vault',path:relative};
  const saved=store.writeDocument(payload,null),note=readFileSync(saved.notePath,'utf8');
  const buffer=store.readPdfSnapshot(payload.document.id,payload.document.sha256);assert.equal(sha256(buffer),payload.document.sha256);
  unlinkSync(source);
  const toc=await extractToc(buffer);assert.ok(Array.isArray(toc.entries));
  const renderer=createReaderRenderer();t.after(()=>renderer.close());
  const image=await renderer.render(buffer,1,600);assert.equal(image.mimeType,'image/png');assert.equal(image.width,600);assert.ok(image.image.startsWith('iVBOR'));
  assert.deepEqual(readdirSync(store.pdfDir),[]);assert.equal(readFileSync(saved.notePath,'utf8'),note);
});

test('snapshot acquisition rejects an original file replacement between buffer reading and final identity verification',t=>{
  const{store,payload}=setup(t),source=store.pdfPath(payload.document.id);
  const saved=store.writeDocument(payload,null),note=readFileSync(saved.notePath,'utf8'),identity=fs.statSync(source);
  const originalRead=fs.readFileSync;let replaced=false;
  const hook=t.mock.method(fs,'readFileSync',function(...args){
    const bytes=originalRead.apply(this,args);
    if(typeof args[0]==='number'&&!replaced){
      const stat=fs.fstatSync(args[0]);
      if(stat.dev===identity.dev&&stat.ino===identity.ino){
        replaced=true;fs.renameSync(source,`${source}.old`);fs.writeFileSync(source,Buffer.concat([sample,Buffer.from('\n% replaced\n')]));
      }
    }
    return bytes;
  });
  syncBuiltinESMExports();
  try{assert.throws(()=>store.readPdfSnapshot(payload.document.id,payload.document.sha256),error=>error.status===409&&error.code==='VAULT_FILE_CONFLICT');}
  finally{hook.mock.restore();syncBuiltinESMExports();}
  assert.equal(replaced,true,'The test must execute the replacement while the original descriptor is open');
  assert.equal(readFileSync(saved.notePath,'utf8'),note);assert.equal(sha256(readFileSync(`${source}.old`)),payload.document.sha256);
});

test('legacy UUID PDF remnants still prevent blank initialization after metadata and cache loss',t=>{
  const{store,payload,vault,recoveryDir}=setup(t);
  const reopened=createVaultStore({vaultDir:vault,recoveryDir});
  assert.throws(()=>reopened.readLibrary(),error=>error.status===409&&/Library\.md/.test(error.message));
  assert.equal(sha256(readFileSync(store.pdfPath(payload.document.id))),payload.document.sha256);
});
