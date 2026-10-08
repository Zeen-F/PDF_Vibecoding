import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DOCUMENT_FIELDS = ['id', 'sha256', 'title', 'filename', 'page_count', 'byte_size', 'created_at', 'updated_at', 'text_available', 'notes_zh', 'notes_en', 'last_page', 'folder_id'];

/** SQLite is a projection; all successful mutations also commit authoritative files. */
export function createVaultIndex({ db, store, parsePdf, dataDir, HttpError }) {
  let insideTransaction = false, pendingRefresh;
  const tokens = new Map();
  const pdfSources = new Map();
  let libraryToken = null;
  // This local marker carries no library contents. It distinguishes an empty
  // established vault with a removed Library.md from a genuinely new vault.
  const establishedMarker = path.join(dataDir, 'vault-library-established');
  let libraryEstablished = existsSync(establishedMarker)
    || db.prepare('SELECT COUNT(*) AS count FROM documents').get().count > 0
    || db.prepare('SELECT COUNT(*) AS count FROM folders').get().count > 0
    || db.prepare('SELECT theme FROM library_preferences WHERE id=1').get().theme !== 'forest';
  function markEstablished() {
    libraryEstablished = true;
    if (!existsSync(establishedMarker)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      try { writeFileSync(establishedMarker, '1\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  function readLibrary() {
    const library = store.readLibrary();
    if (library.token === null && libraryEstablished) throw new HttpError(409,
      '已建立的 Obsidian 仓库缺少 Library.md，请恢复原文件后再刷新或保存；原分类和皮肤未被替换。');
    if (library.token !== null) markEstablished();
    return library;
  }
  const allDocuments = () => db.prepare('SELECT * FROM documents ORDER BY id').all();
  const snapshot = id => ({
    document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id),
    annotations: db.prepare('SELECT * FROM annotations WHERE document_id = ? ORDER BY id').all(id),
    annotationRequests: db.prepare('SELECT * FROM annotation_requests WHERE document_id = ? ORDER BY request_id').all(id),
    positionWriters: db.prepare('SELECT * FROM reading_position_writers WHERE document_id = ? ORDER BY writer_id').all(id),
    bookmarks: db.prepare('SELECT * FROM bookmarks WHERE document_id = ? ORDER BY page, id').all(id),
    ...(pdfSources.has(id) ? { pdfSource: { ...pdfSources.get(id) } } : {}),
  });
  const libraryState = () => ({ folders: db.prepare('SELECT * FROM folders ORDER BY id').all(), theme: db.prepare('SELECT theme FROM library_preferences WHERE id = 1').get().theme });
  const comparable = record => JSON.stringify({ document: Object.fromEntries(DOCUMENT_FIELDS.map(key => [key, record.document[key] ?? null])),
    annotations: [...record.annotations].sort((a,b) => a.id.localeCompare(b.id)),
    annotationRequests: [...record.annotationRequests].sort((a,b) => a.request_id.localeCompare(b.request_id)),
    positionWriters: [...record.positionWriters].sort((a,b) => a.writer_id.localeCompare(b.writer_id)),
    bookmarks: [...(record.bookmarks ?? [])].sort((a,b) => a.page-b.page || a.id.localeCompare(b.id)), pdfSource: record.pdfSource ?? null });
  function applyLibrary(state) {
    const ids = new Set(state.folders.map(folder => folder.id));
    for (const old of db.prepare('SELECT id FROM folders').all()) if (!ids.has(old.id)) db.prepare('DELETE FROM folders WHERE id = ?').run(old.id);
    for (const f of state.folders) db.prepare(`INSERT INTO folders(id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,created_at=excluded.created_at,updated_at=excluded.updated_at`)
      .run(f.id, f.name, f.name_key, f.created_at, f.updated_at);
    db.prepare('UPDATE library_preferences SET theme = ? WHERE id = 1').run(state.theme);
  }
  function applyRecord(record) {
    const doc = record.document;
    if (doc.folder_id && !db.prepare('SELECT id FROM folders WHERE id = ?').get(doc.folder_id)) throw new HttpError(409, '文献分类与仓库目录记录不一致，请恢复 Library.md 后重试。');
    db.prepare(`INSERT INTO documents(${DOCUMENT_FIELDS.join(',')}) VALUES (${DOCUMENT_FIELDS.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${DOCUMENT_FIELDS.slice(1).map(field => `${field}=excluded.${field}`).join(',')}`)
      .run(...DOCUMENT_FIELDS.map(field => doc[field] ?? null));
    for (const table of ['annotations', 'annotation_requests', 'reading_position_writers', 'bookmarks']) db.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(doc.id);
    for (const a of record.annotations) db.prepare(`INSERT INTO annotations(id,document_id,page,kind,quote,comment,color,rects,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(a.id,a.document_id,a.page,a.kind,a.quote,a.comment,a.color,a.rects,a.created_at,a.updated_at);
    for (const r of record.annotationRequests) db.prepare('INSERT INTO annotation_requests(document_id,request_id,request_hash,annotation_id,created_at) VALUES (?,?,?,?,?)')
      .run(r.document_id,r.request_id,r.request_hash,r.annotation_id,r.created_at);
    for (const w of record.positionWriters) db.prepare('INSERT INTO reading_position_writers(document_id,writer_id,sequence,page,updated_at) VALUES (?,?,?,?,?)')
      .run(w.document_id,w.writer_id,w.sequence,w.page,w.updated_at);
    for (const b of record.bookmarks ?? []) db.prepare('INSERT INTO bookmarks(id,document_id,page,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(b.id,b.document_id,b.page,b.title,b.created_at,b.updated_at);
    tokens.set(doc.id, record.token);
    if (record.pdfSource) pdfSources.set(doc.id, { ...record.pdfSource });
    else pdfSources.delete(doc.id);
  }
  function records() {
    const all = store.readAll();
    const ids = new Set(all.map(record => record.document.id));
    for (const doc of allDocuments()) if (!ids.has(doc.id)) throw new HttpError(409, '仓库中的笔记文件已移动或丢失。请恢复原文件；Paperdesk 保留了最后有效的索引和草稿。');
    return all;
  }
  function syncKnown() {
    if (insideTransaction) return;
    const library = readLibrary();
    const all = records();
    db.exec('BEGIN IMMEDIATE');
    try {
      applyLibrary(library.state);
      for (const record of all) {
        if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(record.document.id)) throw new HttpError(409, '仓库有新文献，请先刷新仓库。');
        if (tokens.get(record.document.id) !== record.token) applyRecord(record);
      }
      db.exec('COMMIT'); libraryToken = library.token; return { all, library };
    } catch (error) { db.exec('ROLLBACK'); tokens.clear(); throw error; }
  }
  async function refresh() {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
      const library = readLibrary();
      const all = records();
      const parsed = new Map();
      for (const record of all) {
        const doc = record.document;
        const cached = db.prepare('SELECT sha256 FROM documents WHERE id = ?').get(doc.id);
        const pages = db.prepare('SELECT COUNT(*) AS count FROM pages WHERE document_id = ?').get(doc.id).count;
        if (!cached || cached.sha256 !== doc.sha256 || pages !== doc.page_count) {
          const pdf = await parsePdf(record.pdfPath,{ expectedSha256: doc.sha256, snapshotDir: path.join(dataDir,'.indexing') });
          if (pdf.pages.length !== doc.page_count) throw new HttpError(409, '仓库记录的页数与原始 PDF 不一致，请恢复匹配的文件。');
          parsed.set(doc.id, { pdf, sha256: doc.sha256, pageCount: doc.page_count });
        }
      }
      // Parsing yields: re-read files so a concurrent Obsidian edit is never rolled back.
      const latest = records();
      for (const record of latest) {
        const parsedSource = parsed.get(record.document.id);
        const cached = db.prepare('SELECT sha256 FROM documents WHERE id = ?').get(record.document.id);
        const pageCount = db.prepare('SELECT COUNT(*) AS count FROM pages WHERE document_id = ?').get(record.document.id).count;
        if (parsedSource ? parsedSource.sha256 !== record.document.sha256 || parsedSource.pageCount !== record.document.page_count
          : !cached || cached.sha256 !== record.document.sha256 || pageCount !== record.document.page_count) {
          throw new HttpError(409, 'PDF 在索引期间发生修改，请重新刷新仓库；未使用旧正文覆盖新索引。');
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const projectedLibrary = readLibrary();
        applyLibrary(projectedLibrary.state);
        for (const record of latest) {
          applyRecord(record);
          const pdf = parsed.get(record.document.id)?.pdf;
          if (pdf) {
            db.prepare('DELETE FROM pages WHERE document_id = ?').run(record.document.id);
            const insert = db.prepare('INSERT INTO pages(document_id,page,text) VALUES (?,?,?)');
            pdf.pages.forEach((text,index) => insert.run(record.document.id,index+1,text));
          }
        }
        db.exec('COMMIT'); libraryToken = projectedLibrary.token;
      } catch (error) { db.exec('ROLLBACK'); tokens.clear(); throw error; }
    })().finally(() => { pendingRefresh = undefined; });
    return pendingRefresh;
  }
  function transaction(work) {
    // Use exactly the bytes projected into SQLite. Re-reading only a token here
    // would authorize overwriting an external edit not seen by the version check.
    const baseline = syncKnown();
    const before = new Map(baseline.all.map(record => [record.document.id,record]));
    const previousLibrary = baseline.library;
    const written = [];
    let writtenLibrary, proposedChanges = [];
    db.exec('BEGIN IMMEDIATE'); insideTransaction = true;
    try {
      const result = work();
      const changes = allDocuments().map(doc => snapshot(doc.id)).filter(record => !before.has(record.document.id)
        || comparable(record) !== comparable(before.get(record.document.id)));
      proposedChanges = changes;
      const nextLibrary = libraryState();
      if (changes.length || JSON.stringify(nextLibrary) !== JSON.stringify(previousLibrary.state)) {
        const recovery = path.join(dataDir, 'recoveries'); mkdirSync(recovery, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(recovery, `${randomUUID()}.json`), JSON.stringify({ before: changes.map(record => before.get(record.document.id)).filter(Boolean), library: previousLibrary, proposed: changes, proposedLibrary: nextLibrary }), { flag: 'wx', mode: 0o600 });
      }
      for (const record of changes) {
        const saved = store.writeDocument(record, before.get(record.document.id)?.token ?? null);
        written.push({ previous: before.get(record.document.id), saved }); tokens.set(record.document.id,saved.token);
      }
      if (JSON.stringify(nextLibrary) !== JSON.stringify(previousLibrary.state)) {
        writtenLibrary = store.writeLibrary(nextLibrary,previousLibrary.token); libraryToken = writtenLibrary.token;
      }
      db.exec('COMMIT'); return result;
    } catch (error) {
      db.exec('ROLLBACK');
      const recoveryErrors = [];
      let archived = 0;
      if (error.code === 'VAULT_FILE_CONFLICT') for (const proposed of proposedChanges) {
        const previous = before.get(proposed.document.id);
        if (previous && proposed.document.notes_zh !== previous.document.notes_zh) {
          try { store.writeConflict(proposed.document.id,proposed.document.notes_zh); archived++; } catch (failure) { recoveryErrors.push(failure); }
        }
      }
      // Roll back only our versions; an independent edit always wins and is retained.
      for (const entry of written.reverse()) if (entry.previous) {
        try { store.writeDocument(entry.previous,entry.saved.token); } catch (failure) { recoveryErrors.push(failure); }
      }
      if (writtenLibrary) try { store.writeLibrary(previousLibrary.state,writtenLibrary.token); } catch (failure) { recoveryErrors.push(failure); }
      tokens.clear();
      if (recoveryErrors.length) throw new HttpError(409, '仓库保存未完成，冲突归档或恢复没有全部通过检查。请保留本机草稿，刷新并核对原文件后重试。');
      if (archived) error.conflictPreserved = true;
      throw error;
    } finally { insideTransaction = false; }
  }
  function persistImported(id, pdfSource) {
    const saved = store.writeDocument({ ...snapshot(id), ...(pdfSource ? { pdfSource } : {}) },null);
    tokens.set(id,saved.token);
    if (saved.pdfSource) pdfSources.set(id,{...saved.pdfSource});
    return saved;
  }
  function commitImported(id, pdfSource, work) {
    let saved;
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      // Keep the proposed formal record outside the vault before changing files.
      const recovery = path.join(dataDir, 'recoveries'); mkdirSync(recovery, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(recovery, `import-${randomUUID()}.json`), JSON.stringify({
        proposed: { ...snapshot(id), ...(pdfSource ? { pdfSource } : {}) },
      }), { flag: 'wx', mode: 0o600 });
      saved = persistImported(id,pdfSource);
      db.exec('COMMIT');
      return saved;
    } catch (error) {
      db.exec('ROLLBACK'); tokens.delete(id); pdfSources.delete(id);
      if (saved) {
        try { store.discardNewDocument(saved); }
        catch { throw new HttpError(409,'导入未完成，新笔记已发生外部修改或无法恢复。请核对知识库文件与库外恢复资料；原 PDF 未被改写。'); }
      }
      throw error;
    }
  }
  return { refresh, syncKnown, transaction, snapshot, settle: () => pendingRefresh || Promise.resolve(), get insideTransaction() { return insideTransaction; },
    async initialize() {
      const library = readLibrary();
      if (library.token === null) { store.writeLibrary(library.state,null); markEstablished(); }
      await refresh();
    },
    persistImported, commitImported,
    pdfReferences() { return allDocuments().map(doc => ({ id: doc.id,
      path: pdfSources.get(doc.id)?.path || path.relative(store.vaultDir,store.pdfPath(doc.id)).split(path.sep).join('/') })); },
    preserveConflict(id,notes) { return store.writeConflict(id,notes); },
  };
}
