import { randomUUID } from 'node:crypto';
import { THEME_IDS } from '../shared/library.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Called inside the application's existing migration transaction. ALTER adds
// only nullable metadata; original document, page and annotation values remain.
export function migrateLibrary(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme TEXT NOT NULL CHECK (theme IN ('forest', 'sand', 'slate', 'night'))
    );
  `);
  if (!db.prepare('PRAGMA table_info(documents)').all().some(column => column.name === 'folder_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS documents_folder ON documents(folder_id);
    INSERT INTO library_preferences(id, theme) VALUES (1, 'forest') ON CONFLICT(id) DO NOTHING;
  `);
}

export function registerLibraryApi({ app, db, documentOr404, serializeDocument, transaction, HttpError, objectBody }) {
  const uuid = (value, label) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `请提供有效的${label}标识。`);
    return value.toLowerCase();
  };
  const folderName = value => {
    if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) throw new HttpError(400, '文件夹名称不能包含控制字符。');
    const name = value.trim();
    if (!name || name.length > 80) throw new HttpError(400, '文件夹名称必须为 1 至 80 个字符。');
    return { name, key: name.normalize('NFKC').toLowerCase() };
  };
  const folderQuery = `SELECT f.*, COUNT(d.id) AS document_count FROM folders f
    LEFT JOIN documents d ON d.folder_id = f.id`;
  const findFolder = db.prepare(folderQuery + ' WHERE f.id = ? GROUP BY f.id');
  const serializeFolder = row => ({
    id: row.id, name: row.name, documentCount: row.document_count,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const folderOr404 = id => {
    const row = findFolder.get(id);
    if (!row) throw new HttpError(404, '没有找到这个文件夹。');
    return row;
  };
  const assertUnique = (key, exceptId = null) => {
    const existing = db.prepare('SELECT id FROM folders WHERE name_key = ?').get(key);
    if (existing && existing.id !== exceptId) throw new HttpError(409, '已有同名文件夹，请使用其他名称。');
  };

  app.get('/api/library', (_req, res) => {
    const folders = db.prepare(folderQuery + ' GROUP BY f.id ORDER BY f.name_key, f.id').all().map(serializeFolder);
    res.json({ folders, theme: db.prepare('SELECT theme FROM library_preferences WHERE id = 1').get().theme });
  });
  app.post('/api/folders', (req, res) => {
    const { name, key } = folderName(objectBody(req.body, ['name']).name);
    const folder = transaction(() => {
      assertUnique(key);
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO folders(id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, key, now, now);
      return serializeFolder(folderOr404(id));
    });
    res.status(201).json({ folder });
  });
  app.patch('/api/folders/:id', (req, res) => {
    const id = uuid(req.params.id, '文件夹');
    const { name, key } = folderName(objectBody(req.body, ['name']).name);
    const folder = transaction(() => {
      folderOr404(id); assertUnique(key, id);
      db.prepare('UPDATE folders SET name = ?, name_key = ?, updated_at = ? WHERE id = ?').run(name, key, new Date().toISOString(), id);
      return serializeFolder(folderOr404(id));
    });
    res.json({ folder });
  });
  app.delete('/api/folders/:id', (req, res) => {
    const id = uuid(req.params.id, '文件夹');
    if (req.body !== undefined) objectBody(req.body, []);
    transaction(() => {
      folderOr404(id);
      // The foreign key only removes membership; documents and PDFs survive.
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    });
    res.json({ ok: true });
  });
  app.patch('/api/documents/:id/folder', (req, res) => {
    const id = uuid(req.params.id, '文献');
    const body = objectBody(req.body, ['folderId']);
    const folderId = body.folderId === null ? null : uuid(body.folderId, '文件夹');
    const document = transaction(() => {
      const doc = documentOr404(id);
      if (folderId !== null) folderOr404(folderId);
      if (doc.folder_id !== folderId) {
        db.prepare('UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ?').run(folderId, new Date().toISOString(), id);
      }
      return serializeDocument(documentOr404(id));
    });
    res.json({ document });
  });
  app.patch('/api/library/theme', (req, res) => {
    const { theme } = objectBody(req.body, ['theme']);
    if (!THEME_IDS.includes(theme)) throw new HttpError(400, '请选择森林、暖砂、雾蓝或夜读皮肤。');
    db.prepare('UPDATE library_preferences SET theme = ? WHERE id = 1').run(theme);
    res.json({ theme });
  });
}
