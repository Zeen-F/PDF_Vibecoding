// This is a disposable search projection. Documents, pages and annotations stay
// authoritative; pure-SQL dirty triggers also tolerate writes from older builds.
const VERSION = 2;
const TABLES = ['search_meta', 'search_dirty', 'search_entries', 'search_fts'];
const INDEXES = ['search_entries_document', 'search_entries_order', 'search_documents_order'];
const SOURCE_TRIGGERS = [
  'search_documents_insert', 'search_documents_title', 'search_documents_notes', 'search_documents_delete',
  'search_pages_insert', 'search_pages_update', 'search_pages_delete',
  'search_annotations_insert', 'search_annotations_update', 'search_annotations_delete',
];
const ENTRY_TRIGGERS = ['search_entries_insert', 'search_entries_update', 'search_entries_delete'];

export function searchText(text) {
  // Match the reader's literal search: CJK line wraps join without a space.
  return text.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\t ]*\r?\n[\t ]*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1')
    .replace(/\s+/g, ' ').trim();
}

export function searchSnippet(normalized, needle) {
  const position = normalized.toLowerCase().indexOf(needle);
  const start = Math.max(0, position - 65), end = Math.min(normalized.length, start + 240);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

function install(db) {
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all().map(row => row.name));
  if ([...TABLES, ...INDEXES, ...SOURCE_TRIGGERS, ...ENTRY_TRIGGERS].every(name => existing.has(name))
    && db.prepare('SELECT version FROM search_meta WHERE id=1').get()?.version === VERSION) return;
  // Only cache objects are replaced, transactionally. No library schema bump or
  // original record/PDF rewrite is needed, and older builds can still open it.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of [...SOURCE_TRIGGERS, ...ENTRY_TRIGGERS]) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for (const name of [...TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${name}`);
    db.exec(`
      CREATE TABLE search_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
      INSERT INTO search_meta VALUES (1,${VERSION});
      CREATE TABLE search_dirty (document_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(document_id,source,source_id));
      CREATE TABLE search_entries (
        id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, page INTEGER NOT NULL,
        source TEXT NOT NULL, source_id TEXT NOT NULL, source_order INTEGER NOT NULL,
        created_at TEXT NOT NULL, body TEXT NOT NULL, folded TEXT NOT NULL,
        UNIQUE(document_id,source,source_id)
      );
      CREATE INDEX search_entries_document ON search_entries(document_id);
      CREATE INDEX search_entries_order ON search_entries(document_id,source_order,page,created_at,source_id);
      CREATE INDEX IF NOT EXISTS search_documents_order ON documents(updated_at DESC,id);
      CREATE VIRTUAL TABLE search_fts USING fts5(folded, content='search_entries', content_rowid='id', tokenize='trigram case_sensitive 1');
      CREATE TRIGGER search_entries_insert AFTER INSERT ON search_entries BEGIN
        INSERT INTO search_fts(rowid,folded) VALUES(new.id,new.folded);
      END;
      CREATE TRIGGER search_entries_delete AFTER DELETE ON search_entries BEGIN
        INSERT INTO search_fts(search_fts,rowid,folded) VALUES('delete',old.id,old.folded);
      END;
      CREATE TRIGGER search_entries_update AFTER UPDATE ON search_entries BEGIN
        INSERT INTO search_fts(search_fts,rowid,folded) VALUES('delete',old.id,old.folded);
        INSERT INTO search_fts(rowid,folded) VALUES(new.id,new.folded);
      END;
      CREATE TRIGGER search_documents_insert AFTER INSERT ON documents BEGIN
        INSERT INTO search_dirty VALUES(new.id,'document','') ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER search_documents_title AFTER UPDATE OF title ON documents WHEN old.title IS NOT new.title BEGIN
        INSERT INTO search_dirty VALUES(new.id,'title','') ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER search_documents_notes AFTER UPDATE OF notes_zh,notes_en ON documents
      WHEN old.notes_zh IS NOT new.notes_zh OR old.notes_en IS NOT new.notes_en BEGIN
        INSERT INTO search_dirty VALUES(new.id,'notes','') ON CONFLICT DO NOTHING;
      END;
      CREATE TRIGGER search_documents_delete AFTER DELETE ON documents BEGIN
        INSERT INTO search_dirty VALUES(old.id,'document','') ON CONFLICT DO NOTHING;
      END;
    `);
    for (const table of ['pages', 'annotations']) {
      const source = table === 'pages' ? 'text' : 'annotation', key = table === 'pages' ? 'page' : 'id';
      db.exec(`
        CREATE TRIGGER search_${table}_insert AFTER INSERT ON ${table} BEGIN
          INSERT INTO search_dirty VALUES(new.document_id,'${source}',CAST(new.${key} AS TEXT)) ON CONFLICT DO NOTHING;
        END;
        CREATE TRIGGER search_${table}_delete AFTER DELETE ON ${table} BEGIN
          INSERT INTO search_dirty VALUES(old.document_id,'${source}',CAST(old.${key} AS TEXT)) ON CONFLICT DO NOTHING;
        END;
        CREATE TRIGGER search_${table}_update AFTER UPDATE ON ${table} BEGIN
          INSERT INTO search_dirty VALUES(old.document_id,'${source}',CAST(old.${key} AS TEXT)) ON CONFLICT DO NOTHING;
          INSERT INTO search_dirty VALUES(new.document_id,'${source}',CAST(new.${key} AS TEXT)) ON CONFLICT DO NOTHING;
        END;
      `);
    }
    db.exec("INSERT INTO search_dirty SELECT id,'document','' FROM documents; COMMIT");
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createSearchIndex(db) {
  install(db);
  const dirty = db.prepare("SELECT document_id,source,source_id FROM search_dirty ORDER BY document_id,source='document' DESC,source,source_id");
  const pending = db.prepare('SELECT 1 FROM search_dirty LIMIT 1');
  const document = db.prepare('SELECT id,title,notes_zh,notes_en FROM documents WHERE id=?');
  const pages = db.prepare('SELECT page,text FROM pages WHERE document_id=? ORDER BY page');
  const annotations = db.prepare('SELECT id,page,quote,comment,created_at FROM annotations WHERE document_id=? ORDER BY page,created_at,id');
  const remove = db.prepare('DELETE FROM search_entries WHERE document_id=?');
  const clean = db.prepare('DELETE FROM search_dirty WHERE document_id=?');
  const removeEntry = db.prepare('DELETE FROM search_entries WHERE document_id=? AND source=? AND source_id=?');
  const findPage = db.prepare('SELECT page,text FROM pages WHERE document_id=? AND page=?');
  const findAnnotation = db.prepare('SELECT id,page,quote,comment,created_at FROM annotations WHERE document_id=? AND id=?');
  const insert = db.prepare(`INSERT INTO search_entries(document_id,page,source,source_id,source_order,created_at,body,folded) VALUES(?,?,?,?,?,?,?,?)`);
  function add(id, page, source, sourceId, order, createdAt, text) {
    const body = searchText(text);
    if (body) insert.run(id, page, source, sourceId, order, createdAt, body, body.toLowerCase());
  }
  function drain() {
    const rebuilt = new Set(), cleaned = new Set();
    for (const { document_id: id, source, source_id: key } of dirty.all()) {
      if (rebuilt.has(id)) continue;
      cleaned.add(id);
      if (source === 'document') { remove.run(id); rebuilt.add(id); }
      else removeEntry.run(id, source, key);
      const doc = document.get(id);
      if (!doc) continue;
      if (source === 'document' || source === 'title') add(id, 1, 'title', '', 0, '', doc.title);
      if (source === 'document') {
        for (const row of pages.iterate(id)) add(id, row.page, 'text', String(row.page), 1, '', row.text);
      } else if (source === 'text') {
        const row = findPage.get(id, Number(key));
        if (row) add(id, row.page, 'text', key, 1, '', row.text);
      }
      if (source === 'document' || source === 'notes') add(id, 1, 'notes', '', 2, '', `${doc.notes_zh}\n${doc.notes_en}`);
      if (source === 'document') {
        for (const row of annotations.iterate(id)) add(id, row.page, 'annotation', row.id, 3, row.created_at, `${row.quote}\n${row.comment}`);
      } else if (source === 'annotation') {
        const row = findAnnotation.get(id, key);
        if (row) add(id, row.page, 'annotation', row.id, 3, row.created_at, `${row.quote}\n${row.comment}`);
      }
    }
    for (const id of cleaned) clean.run(id);
  }
  function sync() {
    if (!pending.get()) return;
    db.exec('BEGIN IMMEDIATE');
    try { drain(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function rebuild() {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Repair postings before entry-delete triggers run; an interrupted/manual
      // cache edit can otherwise make a second FTS delete report corruption.
      db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild');");
      db.exec("DELETE FROM search_entries; DELETE FROM search_dirty; INSERT INTO search_dirty SELECT id,'document','' FROM documents;");
      drain();
      // Rebuild the inverted index too, recovering a damaged/missing posting.
      db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild'); COMMIT;");
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const columns = `e.document_id,d.title,d.sha256,e.page,e.source,e.source_id,e.body,a.rects`;
  const joins = `JOIN documents d ON d.id=e.document_id LEFT JOIN annotations a ON e.source='annotation' AND a.id=e.source_id AND a.document_id=e.document_id`;
  // Keep the established ordering (recent document, title/pages/notes/annotations)
  // and cap the returned rows in SQLite, including the 1–2 character fallback.
  const order = `ORDER BY d.updated_at DESC,d.id,e.source_order,e.page,e.created_at,e.source_id LIMIT 100`;
  const indexed = db.prepare(`SELECT ${columns} FROM search_fts JOIN search_entries e ON e.id=search_fts.rowid ${joins}
    WHERE search_fts MATCH ? AND instr(e.folded,?)>0 ${order}`);
  const short = db.prepare(`SELECT ${columns} FROM search_entries e ${joins} WHERE instr(e.folded,?)>0 ${order}`);
  const cardinality = db.prepare('SELECT rowid FROM search_fts WHERE search_fts MATCH ? LIMIT 101');
  // Very common terms used to finish after the first 100 pages. Preserve that
  // fast path with a bounded recent prefix, rather than sorting every FTS hit.
  // If it is insufficient, the regular indexed query still searches all rows.
  const recent = db.prepare(`WITH recent AS MATERIALIZED (
    SELECT e.id FROM documents d INDEXED BY search_documents_order
    CROSS JOIN search_entries e INDEXED BY search_entries_order ON e.document_id=d.id
    ORDER BY d.updated_at DESC,d.id,e.source_order,e.page,e.created_at,e.source_id LIMIT 256
  ) SELECT ${columns} FROM recent r JOIN search_entries e ON e.id=r.id ${joins} WHERE instr(e.folded,?)>0 ${order}`);
  function search(query) {
    const needle = searchText(query).toLowerCase();
    if (!needle) return [];
    sync();
    // Trigrams cannot represent fewer than three Unicode characters. instr is
    // literal (%, _, quotes and FTS operators never become query syntax).
    let rows;
    if ([...needle].length >= 3) {
      const phrase = `"${needle.replaceAll('"', '""')}"`;
      if (cardinality.all(phrase).length > 100) rows = recent.all(needle);
      if (rows?.length !== 100) rows = indexed.all(phrase, needle);
    } else {
      rows = recent.all(needle);
      if (rows.length !== 100) rows = short.all(needle);
    }
    return rows.map(row => ({
      documentId: row.document_id, title: row.title, pdfSha256: row.sha256,
      page: row.page, snippet: searchSnippet(row.body, needle), source: row.source,
      ...(row.source === 'annotation' ? { annotationId: row.source_id, rects: JSON.parse(row.rects) } : {}),
    }));
  }
  return { search, sync, rebuild };
}
