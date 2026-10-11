import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSearchIndex, searchText } from '../server/search-index.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,sha256 TEXT,updated_at TEXT,notes_zh TEXT,notes_en TEXT,last_page INTEGER);
    CREATE TABLE pages(document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,page INTEGER,text TEXT,PRIMARY KEY(document_id,page));
    CREATE TABLE annotations(id TEXT PRIMARY KEY,document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,page INTEGER,quote TEXT,comment TEXT,rects TEXT,created_at TEXT);
  `);
  const document = (id, notes = '', title = 'Synthetic document') => db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?)').run(id,title,'a'.repeat(64),'2026-10-10',notes,'',1);
  const page = (id, number, text) => db.prepare('INSERT INTO pages VALUES(?,?,?)').run(id,number,text);
  const annotation = (id, doc, number, quote, comment = '') => db.prepare('INSERT INTO annotations VALUES(?,?,?,?,?,?,?)').run(id,doc,number,quote,comment,'[{"x":0.1,"y":0.2,"width":0.3,"height":0.1}]','2026-10-10');
  return { db, document, page, annotation };
}

test('trigram search preserves literal multilingual/formula substrings and physical pages', t => {
  const { db, document, page, annotation } = fixture(t);
  document('doc', '中文笔记 gm/Id = 2·ID/Vov\n100% [x_y] "quote" AND OR NOT');
  const texts = [
    'GM/ID gm/Id gm / Id相位\n裕度 can\nexpress C++ a_b a%b *^$ () [] {} "double"\n電\n流 🙂🙃🙂 İİI STRASSE Straße ΩΜΩ éÉÉ',
    '这里是实际 PDF 第二页的相位裕度公式和跨导效率。NOT NEAR OR AND',
  ];
  texts.forEach((text, i) => page('doc', i + 1, text));
  annotation('annotation', 'doc', 2, '跨导 gm/Id', '区域评论，相位裕度');
  const index = createSearchIndex(db);
  const queries = ['gm/Id','GM/ID','gm / Id','相位裕度','相位','相','电流','電流','can express','C++','a_b','a%b','100%','[x_y]','"quote"','"double"','AND','OR','NOT','NEAR','*^$','[]','🙂🙃🙂','İİI','ΩΜΩ','éÉÉ','不存在','', '   '];
  for (const query of queries) {
    const needle = searchText(query).toLowerCase();
    const expected = needle ? texts.flatMap((text, i) => searchText(text).toLowerCase().includes(needle) ? [i + 1] : []) : [];
    assert.deepEqual(index.search(query).filter(r => r.source === 'text').map(r => r.page), expected, query);
  }
  const results = index.search('相位裕度');
  assert.equal(results.find(r => r.source === 'annotation').annotationId, 'annotation');
  assert.deepEqual(results.find(r => r.source === 'annotation').rects, [{ x: .1, y: .2, width: .3, height: .1 }]);
  assert.ok(results.every(r => r.pdfSha256 === 'a'.repeat(64)));
  assert.match(results[0].snippet, /相位裕度/);
});

test('dirty projection follows every source mutation and rollback, without reindexing pages on notes or position edits', t => {
  const { db, document, page, annotation } = fixture(t), index = createSearchIndex(db);
  document('doc', 'note_old', 'title_old'); page('doc', 1, 'page_old'); annotation('a','doc',1,'quote_old','comment_old');
  assert.equal(index.search('_old').length, 4);
  const pageRow = () => db.prepare("SELECT id,body FROM search_entries WHERE source='text'").get();
  const originalPage = pageRow();
  db.prepare('UPDATE documents SET notes_zh=?,title=?,last_page=2 WHERE id=?').run('note_new','title_new','doc');
  assert.equal(index.search('_old').length, 2);
  assert.deepEqual(pageRow(), originalPage);
  assert.equal(index.search('_new').length, 2);
  db.prepare('UPDATE documents SET last_page=3 WHERE id=?').run('doc');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_dirty').get().n, 0);
  db.prepare('UPDATE pages SET page=2,text=? WHERE document_id=?').run('page_new','doc');
  db.prepare('UPDATE annotations SET page=2,quote=?,comment=? WHERE id=?').run('quote_new','comment_new','a');
  assert.equal(index.search('_old').length, 0);
  assert.deepEqual(index.search('_new').map(r => [r.source,r.page]), [['title',1],['text',2],['notes',1],['annotation',2]]);
  db.exec('BEGIN'); db.prepare('UPDATE documents SET notes_zh=?').run('rolledback'); db.exec('ROLLBACK');
  assert.equal(index.search('rolledback').length, 0);
  db.prepare('DELETE FROM annotations WHERE id=?').run('a');
  assert.equal(index.search('quote_new').length, 0);
  db.prepare('DELETE FROM pages WHERE document_id=?').run('doc');
  assert.equal(index.search('page_new').length, 0);
  db.prepare('DELETE FROM documents WHERE id=?').run('doc');
  assert.equal(index.search('_new').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_entries').get().n, 0);
});

test('reopen, explicit rebuild and missing cache recovery preserve authoritative content', t => {
  const { db, document, page } = fixture(t);
  document('doc', '笔记'); page('doc',1,'第一版');
  let index = createSearchIndex(db);
  assert.equal(index.search('第一版').length,1);
  // Raw SQL models another (including older) writer, with no JS function dependency.
  db.prepare('UPDATE pages SET text=?').run('第二版');
  index = createSearchIndex(db);
  assert.equal(index.search('第一版').length,0);
  assert.equal(index.search('第二版').length,1);
  const original = db.prepare('SELECT * FROM documents').all();
  db.exec('DELETE FROM search_entries');
  index.rebuild();
  assert.equal(index.search('第二版').length,1);
  const indexedPage = db.prepare("SELECT id,folded FROM search_entries WHERE source='text'").get();
  db.prepare("INSERT INTO search_fts(search_fts,rowid,folded) VALUES('delete',?,?)").run(indexedPage.id,indexedPage.folded);
  index.rebuild();
  assert.equal(index.search('第二版').length,1,'Explicit rebuild repairs a missing FTS posting before replacing entries');
  db.exec('DROP TABLE search_fts');
  index = createSearchIndex(db);
  assert.equal(index.search('第二版').length,1);
  assert.deepEqual(db.prepare('SELECT * FROM documents').all(), original);
  assert.deepEqual({ ...db.prepare('SELECT * FROM pages').get() }, { document_id:'doc',page:1,text:'第二版' });
});

test('cap and existing result order stay deterministic across source types and documents', t => {
  const { db, document, page, annotation } = fixture(t);
  document('b','term','term'); document('a','term','term');
  for (let i=1;i<=110;i++) page('b',i,'term');
  page('a',12,'term'); page('a',2,'term');
  annotation('z','a',2,'term'); annotation('y','a',2,'term');
  const index = createSearchIndex(db), results = index.search('term');
  assert.equal(results.length,100);
  assert.deepEqual(results.slice(0,6).map(r => [r.documentId,r.source,r.page,r.annotationId]), [
    ['a','title',1,undefined], ['a','text',2,undefined], ['a','text',12,undefined], ['a','notes',1,undefined],
    ['a','annotation',2,'y'], ['a','annotation',2,'z'],
  ]);
  db.prepare('UPDATE documents SET updated_at=? WHERE id=?').run('2026-10-11','b');
  assert.ok(index.search('term').every(r => r.documentId==='b'));
  assert.equal(index.search('e').length,100);
});

test('repeated vault-style UPSERTs cannot override dirty-queue deduplication', t => {
  const { db, document, page } = fixture(t), index = createSearchIndex(db);
  document('doc','first'); page('doc',1,'original'); index.sync();
  const upsert = db.prepare(`INSERT INTO documents(id,title,sha256,updated_at,notes_zh,notes_en,last_page) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes_zh=excluded.notes_zh,notes_en=excluded.notes_en`);
  for (const text of ['second','third','final']) upsert.run('doc',text,'a'.repeat(64),'2026-10-10',text,'',1);
  assert.equal(index.search('final').length,2);
  assert.equal(index.search('second').length,0);
  assert.equal(index.search('original').length,1);
});

test('a high-cardinality query with no recent-prefix hits still searches the entire index', t => {
  const { db, document, page } = fixture(t);
  document('new'); document('old');
  for (let i=1;i<=300;i++) { page('new',i,'irrelevant'); page('old',i,'selective matching'); }
  db.prepare('UPDATE documents SET updated_at=? WHERE id=?').run('2026-10-11','new');
  const index=createSearchIndex(db);
  for (const query of ['selective','ve']) {
    const results=index.search(query);
    assert.equal(results.length,100);
    assert.ok(results.every(r=>r.documentId==='old'));
    assert.deepEqual(results.map(r=>r.page),Array.from({length:100},(_,i)=>i+1));
  }
});
