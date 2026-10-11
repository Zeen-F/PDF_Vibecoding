// Reproducible, synthetic-only comparison with the pre-index /api/search scan.
// Run: node scripts/benchmark-search.mjs [page-count, default 8000]
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSearchIndex, searchText, searchSnippet } from '../server/search-index.mjs';

const pageCount = Number(process.argv[2] || 8000);
if (!Number.isSafeInteger(pageCount) || pageCount < 100 || pageCount > 100000) throw new Error('Use 100–100000 synthetic pages.');
const directory = mkdtempSync(path.join(tmpdir(),'paperdesk-search-benchmark-'));
const db = new DatabaseSync(path.join(directory,'synthetic.sqlite'));
try {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,sha256 TEXT,updated_at TEXT,notes_zh TEXT,notes_en TEXT,last_page INTEGER);
    CREATE TABLE pages(document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,page INTEGER,text TEXT,PRIMARY KEY(document_id,page));
    CREATE TABLE annotations(id TEXT PRIMARY KEY,document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,page INTEGER,quote TEXT,comment TEXT,rects TEXT,created_at TEXT);
    BEGIN;
  `);
  const addDoc = db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?)');
  const addPage = db.prepare('INSERT INTO pages VALUES(?,?,?)');
  const addAnnotation = db.prepare('INSERT INTO annotations VALUES(?,?,?,?,?,?,?)');
  let textBytes = 0;
  for (let i=0;i<pageCount;i++) {
    const doc = `document-${String(Math.floor(i/50)).padStart(5,'0')}`, page = i%50+1;
    if (page===1) {
      addDoc.run(doc,`Synthetic paper ${Math.floor(i/50)}`,'a'.repeat(64),`2026-10-10T00:${String(Math.floor(i/50)%60).padStart(2,'0')}:00.000Z`,'Research note explaining control systems.','','1');
      addAnnotation.run(`annotation-${doc}`,doc,2,'Original synthetic quote.','Comment for reproducible search.','[]','2026-10-10');
    }
    const text = (`Synthetic page ${i}. A reproducible reading experiment compares evidence, geometry, signal gain and stability.\n`+
      `This paragraph includes varied sample identifiers ${i*7} and ${i*13}, with ordinary bilingual engineering text. 合成文献用于测试，不含个人资料。\n`).repeat(9)
      + (i%1973===0 ? 'Selective marker GM/ID phase margin 相位裕度电流 [x_y] = 100%.' : '');
    textBytes += Buffer.byteLength(text); addPage.run(doc,page,text);
  }
  db.exec('COMMIT');
  const documents = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC,id');
  const pages = db.prepare('SELECT page,text FROM pages WHERE document_id=? ORDER BY page');
  const annotations = db.prepare('SELECT * FROM annotations WHERE document_id=? ORDER BY page,created_at,id');
  function legacy(query) {
    const needle = searchText(query).toLowerCase(), results=[];
    const add = (doc,page,source,text) => {
      const normalized=searchText(text);
      if(results.length<100 && normalized.toLowerCase().includes(needle)) results.push({documentId:doc.id,title:doc.title,page,snippet:searchSnippet(normalized,needle),source});
    };
    for(const doc of documents.all()) {
      add(doc,1,'title',doc.title);
      for(const row of pages.iterate(doc.id)) {add(doc,row.page,'text',row.text);if(results.length===100)break;}
      add(doc,1,'notes',`${doc.notes_zh}\n${doc.notes_en}`);
      for(const row of annotations.iterate(doc.id)) {add(doc,row.page,'annotation',`${row.quote}\n${row.comment}`);if(results.length===100)break;}
      if(results.length===100)break;
    }
    return results;
  }
  const start=performance.now(), index=createSearchIndex(db); index.sync();
  const buildMs=performance.now()-start;
  const compatible=results=>results.map(({documentId,title,page,snippet,source})=>({documentId,title,page,snippet,source}));
  const measure=work=>{
    work(); work(); const samples=[];
    for(let i=0;i<9;i++){const start=performance.now();work();samples.push(performance.now()-start);}
    return samples.sort((a,b)=>a-b)[4];
  };
  const results=[];
  for(const query of ['gm/Id','相位裕度','电流','missing-marker-xyz','Synthetic']) {
    const before=legacy(query), after=compatible(index.search(query)); assert.deepEqual(after,before,`Result parity for ${query}`);
    const legacyMs=measure(()=>legacy(query)), indexedMs=measure(()=>index.search(query));
    results.push({query,route:[...query].length<3?'short-literal-fallback':'trigram',matches:after.length,legacyMedianMs:+legacyMs.toFixed(3),indexedMedianMs:+indexedMs.toFixed(3),speedup:+(legacyMs/indexedMs).toFixed(2)});
  }
  const editStart=performance.now();
  db.prepare('UPDATE documents SET notes_zh=? WHERE id=?').run('Incremental edited note GM/ID','document-00000'); index.sync();
  const noteRefreshMs=performance.now()-editStart;
  console.log(JSON.stringify({fixture:{documents:Math.ceil(pageCount/50),pages:pageCount,textBytes},indexBuildMs:+buildMs.toFixed(1),noteRefreshMs:+noteRefreshMs.toFixed(3),runs:9,parity:'all exact',results},null,2));
} finally { db.close(); rmSync(directory,{recursive:true,force:true}); }
