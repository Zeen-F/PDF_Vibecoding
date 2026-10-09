import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalidTitle = value => typeof value !== 'string' || !value.trim() || value.trim() !== value
  || value.length > 200 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);

export function validateEstablishedSchema(db, schemaVersion) {
  if (schemaVersion === 0 && db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count) {
    throw new Error('已有数据库缺少有效格式版本，请恢复完整文献库；没有将已有数据初始化为空库。');
  }
  if (schemaVersion < 4) return;
  const columns = {
    documents: ['id','sha256','title','filename','page_count','byte_size','created_at','updated_at','text_available','notes_zh','notes_en','last_page','folder_id'],
    pages: ['document_id','page','text'], annotations: ['id','document_id','page','quote','comment','color','rects','created_at','updated_at','kind'],
    folders: ['id','name','name_key','created_at','updated_at'], library_preferences: ['id','theme'],
    annotation_requests: ['document_id','request_id','request_hash','annotation_id','created_at'], reading_position_writers: ['document_id','writer_id','sequence','page','updated_at'],
    ...(schemaVersion >= 5 ? { bookmarks: ['id','document_id','page','title','created_at','updated_at'] } : {}),
  };
  for(const [table,required] of Object.entries(columns)) {
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
    if(required.some(column=>!actual.has(column))) throw new Error(`已有文献库缺少完整 ${table} 表，请恢复备份；没有重建空表覆盖旧记录。`);
  }
  if(db.prepare('PRAGMA quick_check').all().some(row=>row.quick_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('已有文献库完整性检查失败，请恢复完整备份；文献库未升级。');
  }
  if(schemaVersion >= 5) {
    const counts = new Map(db.prepare('SELECT id,page_count FROM documents').all().map(row=>[row.id,row.page_count])), pages = new Set();
    for(const row of db.prepare('SELECT * FROM bookmarks').iterate()) {
      const key = `${row.document_id}:${row.page}`;
      if(!UUID.test(row.id) || !UUID.test(row.document_id) || !Number.isSafeInteger(row.page) || row.page<1 || row.page>(counts.get(row.document_id)??0)
        || invalidTitle(row.title) || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string'
        || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at)) || Date.parse(row.updated_at)<Date.parse(row.created_at) || pages.has(key)) {
        throw new Error('已有页面书签记录已损坏，请恢复完整备份；没有用空书签替换旧记录。');
      }
      pages.add(key);
    }
  }
}

export function backupBeforeMigration(db, dataDir, schemaVersion, currentSchema) {
  if (schemaVersion <= 0 || schemaVersion >= currentSchema) return null;
  const root = path.resolve(dataDir);
  const checkDirectory = directory => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('升级前恢复备份目录必须是真实文件夹，不能使用符号链接；文献库未升级。');
  };
  checkDirectory(root);
  let directory = root;
  for (const name of ['recoveries', 'migrations']) {
    directory = path.join(directory,name);
    try { mkdirSync(directory,{mode:0o700}); } catch(error) { if(error.code !== 'EEXIST') throw error; }
    checkDirectory(directory);
  }
  const canonicalDirectory = realpathSync(directory);
  const file = path.join(directory, `schema-${schemaVersion}-${Date.now()}-${randomUUID()}.sqlite`);
  // Reserve an empty file exclusively; VACUUM INTO accepts this owned empty file.
  closeSync(openSync(file,'wx',0o600));
  // VACUUM INTO includes committed WAL content in one consistent SQLite snapshot.
  // It must run before BEGIN/DDL; a failed backup stops migration entirely.
  db.prepare('VACUUM INTO ?').run(file);
  checkDirectory(path.join(root,'recoveries')); checkDirectory(directory);
  if(realpathSync(directory) !== canonicalDirectory || lstatSync(file).isSymbolicLink()) throw new Error('升级前恢复目录发生变化，文献库未升级。');
  const copy = new DatabaseSync(file,{readOnly:true});
  try { if(copy.prepare('PRAGMA quick_check').all().some(row=>row.quick_check !== 'ok')
    || copy.prepare('PRAGMA user_version').get().user_version !== schemaVersion) throw new Error('升级前一致性备份未通过读回检查，文献库未升级。'); }
  finally { copy.close(); }
  // Windows FlushFileBuffers requires a writable handle, even after VACUUM
  // INTO has closed and the snapshot has passed its read-only checks.
  const saved = openSync(file,'r+'); try { fsyncSync(saved); } finally { closeSync(saved); }
  return file;
}

export function migrateBookmarks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page INTEGER NOT NULL CHECK (page >= 1),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(document_id, page)
    );
    CREATE INDEX IF NOT EXISTS bookmarks_document ON bookmarks(document_id, page, id);
  `);
}

export function registerBookmarksApi({ app, db, documentOr404, transaction, HttpError, objectBody, uuidValue, pageValue }) {
  const serialize = row => ({ id: row.id, documentId: row.document_id, page: row.page, title: row.title,
    createdAt: row.created_at, updatedAt: row.updated_at });
  const titleValue = value => {
    if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new HttpError(400, '书签标题必须是单行文本。');
    const title = value.trim();
    if (!title || title.length > 200) throw new HttpError(400, '书签标题必须为 1 至 200 个字符。');
    return title;
  };
  const versionValue = value => {
    if (typeof value !== 'string' || value.length > 100 || /[\p{Cc}\p{Cf}]/u.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new HttpError(400, '请提供读取到的书签更新时间。');
    }
    return value;
  };
  const find = db.prepare('SELECT * FROM bookmarks WHERE id = ?');
  const findPage = db.prepare('SELECT * FROM bookmarks WHERE document_id = ? AND page = ?');
  const checkOwner = (row, documentId) => {
    if (row && row.document_id !== documentId) throw new HttpError(404, '没有找到这篇文献中的页面书签。');
  };
  const conflict = () => { throw new HttpError(409, '页面书签已在其他窗口更新，请刷新书签后重试；本次操作未覆盖新内容。'); };
  app.get('/api/documents/:id/bookmarks', (req, res) => {
    const id = uuidValue(req.params.id, '文献'); documentOr404(id);
    res.json({ bookmarks: db.prepare('SELECT * FROM bookmarks WHERE document_id = ? ORDER BY page, id').all(id).map(serialize) });
  });
  app.post('/api/documents/:id/bookmarks', (req, res) => {
    const id = uuidValue(req.params.id, '文献'), body = objectBody(req.body, ['page', 'title']);
    const result = transaction(() => {
      const doc = documentOr404(id), page = pageValue(body.page, doc.page_count);
      const title = Object.hasOwn(body, 'title') ? titleValue(body.title) : `第 ${page} 页`;
      const existing = findPage.get(id, page);
      if (existing) return { bookmark: serialize(existing), duplicate: true };
      const bookmarkId = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO bookmarks(id,document_id,page,title,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(bookmarkId,id,page,title,now,now);
      return { bookmark: serialize(find.get(bookmarkId)), duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json({ bookmark: result.bookmark });
  });
  app.patch('/api/documents/:id/bookmarks/:bookmarkId', (req, res) => {
    const id = uuidValue(req.params.id, '文献'), bookmarkId = uuidValue(req.params.bookmarkId, '书签');
    const body = objectBody(req.body, ['title', 'expectedUpdatedAt']), title = titleValue(body.title), expected = versionValue(body.expectedUpdatedAt);
    const bookmark = transaction(() => {
      documentOr404(id); const row = find.get(bookmarkId); checkOwner(row,id);
      if (!row) throw new HttpError(404, '没有找到这个页面书签。');
      // A retried successful rename can be acknowledged without rewriting it.
      if (row.title === title) return serialize(row);
      if (row.updated_at !== expected) conflict();
      const milliseconds = Math.max(Date.now(), Date.parse(row.updated_at) + 1);
      if (!Number.isFinite(milliseconds) || milliseconds > 8_640_000_000_000_000) conflict();
      db.prepare('UPDATE bookmarks SET title = ?, updated_at = ? WHERE id = ?').run(title,new Date(milliseconds).toISOString(),bookmarkId);
      return serialize(find.get(bookmarkId));
    });
    res.json({ bookmark });
  });
  app.delete('/api/documents/:id/bookmarks/:bookmarkId', (req, res) => {
    const id = uuidValue(req.params.id, '文献'), bookmarkId = uuidValue(req.params.bookmarkId, '书签');
    const expected = versionValue(objectBody(req.body, ['expectedUpdatedAt']).expectedUpdatedAt);
    transaction(() => {
      documentOr404(id); const row = find.get(bookmarkId); checkOwner(row,id);
      if (!row) return;
      if (row.updated_at !== expected) conflict();
      db.prepare('DELETE FROM bookmarks WHERE id = ?').run(bookmarkId);
    });
    res.json({ ok: true });
  });
}
