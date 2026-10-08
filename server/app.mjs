import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, existsSync } from 'node:fs';
import { chmod, copyFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractToc } from './toc.mjs';
import { mergeNotes, MAX_NOTE_LENGTH } from '../shared/notes.mjs';
import { notesRevision, revisionValue, registerPluginApi } from './plugin-api.mjs';
import { createReaderRenderer, readerPageQuery, readerPageText, ReaderRenderError } from './reader-render.mjs';
import { migrateLibrary, registerLibraryApi } from './library.mjs';
import { backupBeforeMigration, migrateBookmarks, registerBookmarksApi, validateEstablishedSchema } from './bookmarks.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { registerTranslationApi } from './translation.mjs';
import { getVaultConfig } from './vault-config.mjs';
import { createVaultStore } from './vault-store.mjs';
import { createVaultIndex } from './vault-index.mjs';
import { listVaultPdfs } from './vault-pdfs.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const pdfPackageDir = path.join(rootDir, 'node_modules/pdfjs-dist');
const MAX_PAGES = 2000;
const MAX_TEXT = 20_000_000;
const COLORS = new Set(['yellow', 'green', 'pink']);
const ANNOTATION_KINDS = new Set(['text', 'region']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRY_RETENTION_MS = 30 * 86400_000;
const MAX_RETRY_RECORDS = 10_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function objectBody(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求内容必须是 JSON 对象。');
  }
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) throw new HttpError(400, `不支持的字段：${key}`);
  }
  return body;
}

function stringValue(value, label, max, { nonempty = false, trim = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new HttpError(400, `${label}必须是最多 ${max.toLocaleString('en-US')} 个字符的文本。`);
  }
  const result = trim ? value.trim() : value;
  if (nonempty && !result.trim()) throw new HttpError(400, `${label}不能为空。`);
  return result;
}

function pageValue(value, count) {
  if (!Number.isInteger(value) || value < 1 || value > count) {
    throw new HttpError(400, `页码必须是 1 至 ${count} 的整数。`);
  }
  return value;
}

function colorValue(value) {
  if (!COLORS.has(value)) throw new HttpError(400, '高亮颜色必须是 yellow、green 或 pink。');
  return value;
}

function uuidValue(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `请提供有效的${label} UUID。`);
  return value.toLowerCase();
}

function positionSequenceValue(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, '阅读位置序号必须是正安全整数。');
  return value;
}

function annotationKind(value) {
  if (!ANNOTATION_KINDS.has(value)) throw new HttpError(400, '批注类型必须是 text 或 region。');
  return value;
}

function rectanglesValue(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new HttpError(400, '批注需要 1 至 200 个高亮区域。');
  }
  return value.map((rect) => {
    objectBody(rect, ['x', 'y', 'width', 'height']);
    const { x, y, width, height } = rect;
    if (![x, y, width, height].every(Number.isFinite)
      || x < 0 || y < 0 || width <= 0 || height <= 0
      || x > 1 || y > 1 || width > 1 || height > 1
      || x + width > 1 || y + height > 1) {
      throw new HttpError(400, '高亮区域必须位于页面内，并使用 0 至 1 的有限数值。');
    }
    return { x, y, width, height };
  });
}

function originalFilename(input) {
  let name = input;
  // Multipart filenames from browsers commonly arrive as UTF-8 bytes decoded as Latin-1.
  if ([...name].every((char) => char.codePointAt(0) <= 255)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd')) name = decoded;
  }
  return name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512) || 'paper.pdf';
}

function serializeDocument(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, filename: row.filename,
    pageCount: row.page_count, byteSize: row.byte_size,
    createdAt: row.created_at, updatedAt: row.updated_at,
    textAvailable: Boolean(row.text_available), notesZh: row.notes_zh,
    notesEn: row.notes_en, lastPage: row.last_page, notesRevision: notesRevision(row), folderId: row.folder_id,
  };
}

function serializeAnnotation(row) {
  return {
    id: row.id, documentId: row.document_id, page: row.page, kind: row.kind,
    quote: row.quote, comment: row.comment, color: row.color,
    rects: JSON.parse(row.rects), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function extractText(items) {
  let text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    // PDF.js includes explicit and geometry-derived spaces in its text items.
    // A new item can merely indicate a font/style change within the same word.
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text;
}

async function parsePdf(filePath, { expectedSha256, snapshotDir } = {}) {
  let task, snapshot;
  try {
    if (expectedSha256) {
      mkdirSync(snapshotDir,{recursive:true,mode:0o700});
      snapshot = path.join(snapshotDir,`${randomUUID()}.pdf`);
      await copyFile(filePath,snapshot); await chmod(snapshot,0o600);
      if (await hashUpload(snapshot) !== expectedSha256) throw new HttpError(409,'PDF 在读取期间发生修改，请重新刷新仓库。');
      filePath = snapshot;
    }
    task = getDocument({
      url: pathToFileURL(filePath).href, disableStream: true, disableAutoFetch: true, isEvalSupported: false,
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      cMapUrl: `${path.join(pdfPackageDir, 'cmaps')}${path.sep}`, cMapPacked: true,
      standardFontDataUrl: `${path.join(pdfPackageDir, 'standard_fonts')}${path.sep}`,
      wasmUrl: `${path.join(pdfPackageDir, 'wasm')}${path.sep}`,
      stopAtErrors: true, verbosity: 0,
    });
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES) throw new HttpError(413, `单篇文献最多支持 ${MAX_PAGES} 页。`);
    if (await pdf.getPermissions() !== null) {
      throw new HttpError(400, '暂不支持加密 PDF，请先在本机解除密码或限制，再重新导入。');
    }
    const metadata = await pdf.getMetadata();
    const candidateTitle = metadata.info?.Title;
    const title = typeof candidateTitle === 'string' ? candidateTitle.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500) : '';
    const pages = [];
    let totalLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = extractText(content.items);
        totalLength += text.length;
        if (totalLength > MAX_TEXT) throw new HttpError(413, 'PDF 文本超过 2,000 万字符，请拆分后导入。');
        pages.push(text);
      } finally { page.cleanup(); }
    }
    return { title, pages, textAvailable: pages.some((text) => text.trim().length > 0) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.name === 'PasswordException') {
      throw new HttpError(400, '暂不支持加密 PDF，请先在本机解除密码或限制，再重新导入。');
    }
    throw new HttpError(400, '无法读取这个 PDF，文件可能已损坏或不是有效的 PDF。');
  } finally {
    if (task) await task.destroy().catch(() => {});
    if (snapshot) await unlink(snapshot).catch(() => {});
  }
}

async function hashUpload(filePath) {
  const hash = createHash('sha256');
  const header = Buffer.alloc(1024);
  let headerLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    if (headerLength < header.length) {
      headerLength += chunk.copy(header, headerLength, 0, Math.min(chunk.length, header.length - headerLength));
    }
  }
  if (!header.subarray(0, headerLength).includes(Buffer.from('%PDF-'))) throw new HttpError(400, '请选择有效的 PDF 文件。');
  return hash.digest('hex');
}

function localRequestOnly(req, res, next) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(host)) {
    return res.status(403).json({ error: '此工具只接受本机访问。' });
  }
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      const port = origin.port || '80';
      if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
        || ![String(req.socket.localPort), '5173'].includes(port)) throw new Error('foreign origin');
    } catch {
      return res.status(403).json({ error: '已阻止来自其他网站的本地数据请求。' });
    }
  }
  next();
}

function markdownText(text) { return text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&'); }
function blockquote(text) { return text.split(/\r?\n/).map((line) => `> ${markdownText(line)}`).join('\n'); }
function searchText(text) {
  // A visual line wrap must not split a phrase. CJK wraps need no added word space.
  return text.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\t ]*\r?\n[\t ]*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1')
    .replace(/\s+/g, ' ').trim();
}
function snippet(text, needle) {
  const normalized = searchText(text);
  const position = normalized.toLowerCase().indexOf(needle);
  const start = Math.max(0, position - 65);
  const end = Math.min(normalized.length, start + 240);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

/** Create a local app with its own persistent database. The caller owns its HTTP server. */
export function createApp({ dataDir, vaultDir = process.env.PAPERDESK_VAULT_DIR, vaultSubdir = process.env.PAPERDESK_VAULT_SUBDIR || 'Paperdesk', translationOptions } = {}) {
  const vaultConfig = vaultDir ? getVaultConfig({ vaultDir, vaultSubdir, dataDir: dataDir || process.env.PAPERDESK_DATA_DIR }) : null;
  dataDir = vaultConfig?.dataDir || dataDir || process.env.PAPERDESK_DATA_DIR || path.join(rootDir, 'data');
  dataDir = path.resolve(dataDir);
  const vaultStore = vaultConfig ? createVaultStore({ vaultDir: vaultConfig.vaultDir, subdir: vaultConfig.vaultSubdir, recoveryDir: path.join(dataDir,'recoveries','originals') }) : null;
  const pdfDir = vaultStore?.pdfDir || path.join(dataDir, 'pdfs');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!vaultStore) mkdirSync(pdfDir, { recursive: true, mode: 0o700 });
  const incomingDir = vaultStore ? path.join(dataDir, '.incoming') : path.join(pdfDir, '.incoming');
  mkdirSync(incomingDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'paperdesk.sqlite'));
  let migrating = false;
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const previousSchema = db.prepare('PRAGMA user_version').get().user_version;
    if (previousSchema > CURRENT_SCHEMA) throw new Error('文献库来自更新版本的 Paperdesk，请使用相应版本打开；未降级数据库。');
    validateEstablishedSchema(db,previousSchema);
    backupBeforeMigration(db,dataDir,previousSchema,CURRENT_SCHEMA);
    db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
    migrating = true;
    // Recheck under the write lock in case another process migrated first.
    if (db.prepare('PRAGMA user_version').get().user_version > CURRENT_SCHEMA) throw new Error('文献库来自更新版本的 Paperdesk，请使用相应版本打开；未降级数据库。');
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        filename TEXT NOT NULL, page_count INTEGER NOT NULL, byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, text_available INTEGER NOT NULL,
        notes_zh TEXT NOT NULL DEFAULT '', notes_en TEXT NOT NULL DEFAULT '', last_page INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS pages (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(document_id, page)
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page INTEGER NOT NULL, quote TEXT NOT NULL, comment TEXT NOT NULL, color TEXT NOT NULL,
        rects TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'region'))
      );
      CREATE INDEX IF NOT EXISTS annotations_document ON annotations(document_id, page);
    `);
    if (!db.prepare('PRAGMA table_info(annotations)').all().some(column => column.name === 'kind')) {
      db.exec("ALTER TABLE annotations ADD COLUMN kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'region'));");
    }
    migrateLibrary(db);
    // Additive retry metadata only; original library rows and PDFs stay intact.
    // Kept in this same migration transaction so a failure restores schema 3.
    db.exec(`
      CREATE TABLE IF NOT EXISTS annotation_requests (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, request_hash TEXT NOT NULL, annotation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(document_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS annotation_requests_expiry ON annotation_requests(created_at);
      CREATE TABLE IF NOT EXISTS reading_position_writers (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        writer_id TEXT NOT NULL, sequence INTEGER NOT NULL, page INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(document_id, writer_id)
      );
      CREATE INDEX IF NOT EXISTS reading_position_writers_expiry ON reading_position_writers(updated_at);
    `);
    migrateBookmarks(db);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA}; COMMIT;`);
    migrating = false;
  } catch (error) {
    if (migrating) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  const app = express();
  const vaultIndex = vaultStore ? createVaultIndex({ db, store: vaultStore, parsePdf, dataDir, HttpError }) : null;
  const ready = vaultIndex ? vaultIndex.initialize() : Promise.resolve();
  // A rejected startup remains observable to both the launcher and HTTP callers.
  void ready.catch(() => {});
  let closed = false;
  let closing;
  function acceptingRequests(_req, _res, next) {
    if (closed) return next(new HttpError(503, '阅读服务正在关闭，请重新启动纸间后重试。'));
    next();
  }
  app.disable('x-powered-by');
  app.use(localRequestOnly);
  app.use(acceptingRequests);
  app.use('/api', async (req, _res, next) => {
    try {
      await ready;
      if (closed) throw new HttpError(503,'阅读服务正在关闭，请重新启动后重试。');
      // A file picker inventory must not parse or automatically index PDF bodies.
      if (vaultIndex && !(req.method === 'GET' && req.path === '/vault/pdfs')) await vaultIndex.refresh();
      next();
    } catch (error) { next(error); }
  });
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Only reader snapshots carry a transient PNG. Keep the existing note limit.
  app.use('/api/reader-sessions', express.json({ limit: '2.5mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(acceptingRequests);
  const upload = multer({
    storage: multer.diskStorage({ destination: incomingDir, filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`) }),
    limits: { files: 1, fields: 0, parts: 1 },
  }).single('file');
  function receiveUpload(req, res, next) {
    upload(req, res, error => {
      if (!error || error instanceof multer.MulterError) return next(error);
      if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO', 'EROFS'].includes(error.code)) {
        return next(new HttpError(500, '无法写入临时 PDF，请检查数据目录权限和剩余磁盘空间后重试。'));
      }
      next(new HttpError(400, '上传内容不完整或格式不正确，请重新选择一个 PDF 文件后重试。'));
    });
  }
  let importQueue = Promise.resolve();
  function queueImport(work) {
    if (closed) return Promise.reject(new HttpError(503, '阅读服务正在关闭，请重新启动纸间后重试。'));
    const pending = importQueue.then(work);
    importQueue = pending.catch(() => {});
    return pending;
  }
  const findDocument = db.prepare('SELECT * FROM documents WHERE id = ?');
  const findHash = db.prepare('SELECT * FROM documents WHERE sha256 = ?');
  const findAnnotation = db.prepare('SELECT * FROM annotations WHERE id = ? AND document_id = ?');
  const findAnnotations = db.prepare('SELECT * FROM annotations WHERE document_id = ? ORDER BY page, created_at, id');
  const touchDocument = db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?');
  const readerRenderer = createReaderRenderer();
  const tocCache = new Map();
  const pendingToc = new Set();
  function documentPdfPath(doc) {
    if (!vaultStore) return path.join(pdfDir, `${doc.id}.pdf`);
    const record = vaultStore.readDocument(doc.id);
    if (!record) throw new HttpError(409, '文献笔记文件缺失，请恢复原文件后重试；原 PDF 未被移动。');
    return record.pdfPath;
  }
  function documentToc(doc) {
    if (closed) return Promise.reject(new HttpError(503, '阅读服务正在关闭，请重新启动纸间后重试。'));
    const key = `${doc.id}:${doc.sha256}`;
    if (tocCache.has(key)) {
      const cached = tocCache.get(key);
      tocCache.delete(key);
      tocCache.set(key, cached);
      return cached;
    }
    const pending = (async () => {
      const source = vaultStore ? vaultStore.readPdfSnapshot(doc.id, doc.sha256) : pathToFileURL(documentPdfPath(doc));
      try {
        return await extractToc(source, { getPageTexts: () => db.prepare('SELECT page, text FROM pages WHERE document_id = ? ORDER BY page').all(doc.id) });
      } catch {
        throw new HttpError(422, '暂时无法读取这份 PDF 的目录，请检查原始文件后重试。');
      }
    })();
    // Cache eviction must not make a still-running task invisible to close().
    pendingToc.add(pending);
    void pending.then(() => pendingToc.delete(pending), () => pendingToc.delete(pending));
    tocCache.set(key, pending);
    if (tocCache.size > 8) tocCache.delete(tocCache.keys().next().value);
    void pending.catch(() => { if (tocCache.get(key) === pending) tocCache.delete(key); });
    return pending;
  }
  function documentOr404(id) {
    if (vaultIndex && !vaultIndex.insideTransaction) vaultIndex.syncKnown();
    const row = findDocument.get(id);
    if (!row) throw new HttpError(404, '没有找到这篇文献。');
    return row;
  }
  function annotationOr404(id, documentId) {
    const row = findAnnotation.get(id, documentId);
    if (!row) throw new HttpError(404, '没有找到这条批注。');
    return row;
  }
  function transaction(work) {
    if (vaultIndex) return vaultIndex.transaction(work);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const pluginApi = registerPluginApi({
    app, db, dataDir: vaultConfig?.libraryDir || dataDir, documentOr404, serializeDocument, transaction,
    HttpError, objectBody, stringValue, pageValue, rectanglesValue,
  });
  registerLibraryApi({ app, db, documentOr404, serializeDocument, transaction, HttpError, objectBody });
  registerBookmarksApi({ app, db, documentOr404, transaction, HttpError, objectBody, uuidValue, pageValue });
  const translationApi = registerTranslationApi({ app, dataDir, HttpError, options: translationOptions });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/storage', (_req,res) => res.json({ mode: vaultStore ? 'vault' : 'library',
    vaultName: vaultConfig ? path.basename(vaultConfig.vaultDir) : null, subdir: vaultConfig?.vaultSubdir || null,
    documentCount: db.prepare('SELECT COUNT(*) AS count FROM documents').get().count }));
  app.post('/api/storage/refresh', async (_req,res) => { if (vaultIndex) await vaultIndex.refresh(); res.json({ ok: true }); });
  app.get('/api/vault/pdfs', (_req, res) => {
    if (!vaultStore) throw new HttpError(400, '当前使用独立文献库，请先连接 Obsidian 仓库。');
    res.json(listVaultPdfs({ vaultDir: vaultStore.vaultDir, documents: vaultIndex.pdfReferences() }));
  });
  app.post('/api/vault/pdfs/open', async (req, res) => {
    if (!vaultStore) throw new HttpError(400, '当前使用独立文献库，请先连接 Obsidian 仓库。');
    const body = objectBody(req.body, ['path']);
    const requestedSource = { kind: 'vault', path: body.path };
    const result = await queueImport(async () => {
      const source = vaultStore.inspectPdfSource(requestedSource);
      const existing = findHash.get(source.sha256);
      if (existing) return { document: serializeDocument(existing), duplicate: true };
      const parsed = await parsePdf(source.pdfPath, { expectedSha256: source.sha256, snapshotDir: path.join(dataDir, '.parse-snapshots') });
      const current = vaultStore.inspectPdfSource(requestedSource);
      if (current.sha256 !== source.sha256 || current.byteSize !== source.byteSize) throw new HttpError(409,
        '原 PDF 在打开期间发生修改，请先核对原文件再重新选择；原文件未被移动或改写。');
      await vaultIndex.refresh();
      const duplicate = findHash.get(source.sha256);
      if (duplicate) return { document: serializeDocument(duplicate), duplicate: true };
      const id = randomUUID(), filename = originalFilename(path.posix.basename(requestedSource.path));
      const title = parsed.title || filename.replace(/\.pdf$/i, '').slice(0, 500) || '未命名文献';
      const now = new Date().toISOString();
      vaultIndex.commitImported(id,requestedSource, () => {
        db.prepare(`INSERT INTO documents(id,sha256,title,filename,page_count,byte_size,created_at,updated_at,text_available)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(id,source.sha256,title,filename,parsed.pages.length,source.byteSize,now,now,Number(parsed.textAvailable));
        const insertPage = db.prepare('INSERT INTO pages(document_id,page,text) VALUES (?,?,?)');
        parsed.pages.forEach((text,index) => insertPage.run(id,index+1,text));
      });
      return { document: serializeDocument(findDocument.get(id)), duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.get('/api/documents/:id/vault-note', (req,res) => {
    documentOr404(req.params.id);
    if (!vaultStore) throw new HttpError(400,'当前使用独立文献库，请先连接 Obsidian 仓库。');
    res.json({ uri: `obsidian://open?path=${encodeURIComponent(vaultStore.notePath(req.params.id))}` });
  });
  app.post('/api/documents/:id/vault-conflict', (req,res) => {
    documentOr404(req.params.id);
    if (!vaultIndex) throw new HttpError(400,'当前未连接 Obsidian 仓库。');
    const { text } = objectBody(req.body,['text']);
    vaultIndex.preserveConflict(req.params.id,stringValue(text,'冲突笔记',MAX_NOTE_LENGTH));
    res.json({ preserved: true });
  });
  app.get('/api/documents', (_req, res) => {
    res.json({ documents: db.prepare('SELECT * FROM documents ORDER BY updated_at DESC, id').all().map(serializeDocument) });
  });
  app.post('/api/documents', receiveUpload, async (req, res) => {
    if (!req.file) throw new HttpError(400, '请选择一个 PDF 文件。');
    const temporaryPath = req.file.path;
    let result;
    try {
      result = await queueImport(async () => {
        await chmod(temporaryPath, 0o600);
        const sha256 = await hashUpload(temporaryPath);
        const duplicate = findHash.get(sha256);
        if (duplicate) return { document: serializeDocument(duplicate), duplicate: true };
        // One parser per app runtime; large concurrent uploads wait on disk.
        const parsed = await parsePdf(temporaryPath);
        if (vaultIndex) {
          await vaultIndex.refresh();
          const currentDuplicate = findHash.get(sha256);
          if (currentDuplicate) return { document: serializeDocument(currentDuplicate), duplicate: true };
        }
        const id = randomUUID();
        const filename = originalFilename(req.file.originalname);
        const title = parsed.title || filename.replace(/\.pdf$/i, '').slice(0, 500) || '未命名文献';
        const now = new Date().toISOString();
        const insertImported = () => {
          db.prepare(`INSERT INTO documents(id, sha256, title, filename, page_count, byte_size,
            created_at, updated_at, text_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, sha256, title, filename, parsed.pages.length, req.file.size, now, now, Number(parsed.textAvailable),
          );
          const insertPage = db.prepare('INSERT INTO pages(document_id, page, text) VALUES (?, ?, ?)');
          parsed.pages.forEach((text, index) => insertPage.run(id, index + 1, text));
        };
        if (vaultStore) {
          // Uploads are copied across volumes into an exclusive managed file;
          // selected version-2 originals never enter this cleanup path.
          const imported = vaultStore.importPdf(id,temporaryPath,sha256,req.file.size);
          try { vaultIndex.commitImported(id,undefined,insertImported); }
          catch (error) {
            if (!existsSync(vaultStore.notePath(id))) {
              try { vaultStore.discardImportedPdf(imported); }
              catch { throw new HttpError(409,'PDF 导入未完成，本次副本无法自动恢复。请核对知识库文件与库外恢复资料；外部原文件未被改写。'); }
            }
            const committedDuplicate = findHash.get(sha256);
            if (committedDuplicate) return { document: serializeDocument(committedDuplicate), duplicate: true };
            throw error;
          }
          return { document: serializeDocument(findDocument.get(id)), duplicate: false };
        }
        const pdfPath = path.join(pdfDir, `${id}.pdf`);
        let transactionOpen = false;
        let moved = false;
        try {
          await rename(temporaryPath, pdfPath);
          moved = true;
          // No await between BEGIN and COMMIT: concurrent requests cannot share a transaction.
          db.exec('BEGIN IMMEDIATE');
          transactionOpen = true;
          insertImported();
          db.exec('COMMIT');
          transactionOpen = false;
        } catch (error) {
          if (transactionOpen) db.exec('ROLLBACK');
          if (moved) await unlink(pdfPath).catch(() => {});
          const committedDuplicate = findHash.get(sha256);
          if (committedDuplicate) return { document: serializeDocument(committedDuplicate), duplicate: true };
          throw error;
        }
        return { document: serializeDocument(findDocument.get(id)), duplicate: false };
      });
    } finally {
      await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') console.error('Cannot remove temporary PDF:', error.message); });
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.get('/api/documents/:id', (req, res) => {
    res.json({ document: serializeDocument(documentOr404(req.params.id)), annotations: findAnnotations.all(req.params.id).map(serializeAnnotation) });
  });
  app.get('/api/documents/:id/file', (req, res, next) => {
    const doc = documentOr404(req.params.id);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="paper.pdf"');
    if (vaultStore) {
      const buffer = vaultStore.readPdfSnapshot(doc.id, doc.sha256);
      res.setHeader('Accept-Ranges', 'bytes');
      const ranges = req.headers.range ? req.range(buffer.length, { combine: true }) : undefined;
      if (ranges === -1) { res.setHeader('Content-Range', `bytes */${buffer.length}`); return next(new HttpError(416,'请求的 PDF 字节范围无效。')); }
      if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
        const { start, end } = ranges[0]; res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
        return res.status(206).send(buffer.subarray(start,end+1));
      }
      return res.send(buffer);
    }
    // The library may live under .local; only this DB-selected PDF route may
    // traverse a hidden parent directory. Global static routes remain restricted.
    res.sendFile(documentPdfPath(doc), { dotfiles: 'allow' }, (error) => {
      if (!error || res.headersSent) return;
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        return next(new HttpError(vaultStore ? 409 : 404, '原始 PDF 文件已丢失，请检查本地数据目录。'));
      }
      if (error.status === 416) return next(new HttpError(416, '请求的 PDF 字节范围无效。'));
      next(new HttpError(500, '暂时无法读取原始 PDF，请检查数据目录权限和文件状态后重试。'));
    });
  });
  app.get('/api/documents/:id/toc', async (req, res) => {
    res.json(await documentToc(documentOr404(req.params.id)));
  });
  app.get('/api/documents/:id/reader-page', async (req, res) => {
    const doc = documentOr404(req.params.id);
    try {
      const { page, width } = readerPageQuery(req.query, doc.page_count);
      const text = db.prepare('SELECT text FROM pages WHERE document_id = ? AND page = ?').get(doc.id, page)?.text ?? '';
      const source = vaultStore ? vaultStore.readPdfSnapshot(doc.id, doc.sha256) : documentPdfPath(doc);
      const rendered = await readerRenderer.render(source, page, width);
      res.json({ documentId: doc.id, page, ...rendered, ...readerPageText(text) });
    } catch (error) {
      if (error instanceof ReaderRenderError) throw new HttpError(error.status, error.message);
      throw error;
    }
  });
  app.patch('/api/documents/:id', (req, res) => {
    const body = objectBody(req.body, ['title', 'notesZh', 'notesEn', 'lastPage', 'expectedNotesRevision', 'positionWriterId', 'positionSequence']);
    if (Object.hasOwn(body, 'expectedNotesRevision')) revisionValue(body.expectedNotesRevision, HttpError);
    const sequencedPosition = Object.hasOwn(body, 'positionWriterId') || Object.hasOwn(body, 'positionSequence');
    let writerId, sequence, positionStale = false, positionReplayed = false;
    if (sequencedPosition) {
      if (!Object.hasOwn(body, 'lastPage') || Object.keys(body).some(key => !['lastPage', 'positionWriterId', 'positionSequence'].includes(key))) {
        throw new HttpError(400, '带序号的阅读位置请求只能包含 lastPage、positionWriterId 和 positionSequence。');
      }
      writerId = uuidValue(body.positionWriterId, '阅读窗口');
      sequence = positionSequenceValue(body.positionSequence);
    }
    const document = transaction(() => {
      const doc = documentOr404(req.params.id);
      if (!Object.keys(body).some(key => key !== 'expectedNotesRevision')) return serializeDocument(doc);
      const changesNotes = Object.hasOwn(body, 'notesZh') || Object.hasOwn(body, 'notesEn');
      if (vaultIndex && changesNotes && !Object.hasOwn(body,'expectedNotesRevision')) throw new HttpError(400,'保存到 Obsidian 仓库需要笔记版本，请先读取当前笔记后重试。');
      if (vaultIndex && Object.hasOwn(body,'notesEn') && body.notesEn !== '') throw new HttpError(400,'Obsidian 仓库使用统一 Markdown 正文，请把内容保存到 notesZh，并将 notesEn 留空。');
      if (changesNotes && Object.hasOwn(body, 'expectedNotesRevision') && body.expectedNotesRevision !== notesRevision(doc)) {
        const conflict = new HttpError(409, '笔记已在其他窗口或插件中更新，请先读取最新笔记再合并保存。');
        conflict.code = 'NOTES_VERSION_CONFLICT';
        if (vaultIndex) {
          vaultIndex.preserveConflict(doc.id, mergeNotes(
            Object.hasOwn(body,'notesZh') ? stringValue(body.notesZh,'笔记',MAX_NOTE_LENGTH) : doc.notes_zh,
            Object.hasOwn(body,'notesEn') ? stringValue(body.notesEn,'英文笔记',250_000) : doc.notes_en));
          conflict.conflictPreserved = true;
        }
        throw conflict;
      }
      const title = Object.hasOwn(body, 'title') ? stringValue(body.title, '文献标题', 500, { nonempty: true, trim: true }) : doc.title;
      const zh = Object.hasOwn(body, 'notesZh') ? stringValue(body.notesZh, '笔记', MAX_NOTE_LENGTH) : doc.notes_zh;
      const en = Object.hasOwn(body, 'notesEn') ? stringValue(body.notesEn, '英文笔记', 250_000) : doc.notes_en;
      if (changesNotes && mergeNotes(zh, en).length > MAX_NOTE_LENGTH) throw new HttpError(400, `笔记内容最多 ${MAX_NOTE_LENGTH.toLocaleString('en-US')} 个字符。`);
      const lastPage = Object.hasOwn(body, 'lastPage') ? pageValue(body.lastPage, doc.page_count) : doc.last_page;
      if (sequencedPosition) {
        const now = Date.now();
        db.prepare('DELETE FROM reading_position_writers WHERE updated_at <= ?').run(now - RETRY_RETENTION_MS);
        const writer = db.prepare('SELECT sequence, page FROM reading_position_writers WHERE document_id = ? AND writer_id = ?').get(doc.id, writerId);
        if (writer && sequence <= writer.sequence) {
          if (sequence === writer.sequence && lastPage !== writer.page) throw new HttpError(409, '同一阅读位置序号不能用于不同页码。');
          positionStale = sequence < writer.sequence;
          positionReplayed = !positionStale;
          return serializeDocument(doc);
        }
        if (!writer && db.prepare('SELECT COUNT(*) AS count FROM reading_position_writers').get().count >= MAX_RETRY_RECORDS) {
          throw new HttpError(429, '阅读位置保护记录已达到上限，请稍后重试；本次位置未保存。');
        }
        db.prepare(`INSERT INTO reading_position_writers(document_id, writer_id, sequence, page, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(document_id, writer_id) DO UPDATE SET sequence = excluded.sequence, page = excluded.page, updated_at = excluded.updated_at`)
          .run(doc.id, writerId, sequence, lastPage, now);
      }
      db.prepare('UPDATE documents SET title = ?, notes_zh = ?, notes_en = ?, last_page = ?, updated_at = ? WHERE id = ?')
        .run(title, zh, en, lastPage, new Date().toISOString(), doc.id);
      return serializeDocument(findDocument.get(doc.id));
    });
    res.json(sequencedPosition ? { document, positionStale, positionReplayed } : { document });
  });
  app.post('/api/documents/:id/annotations', (req, res) => {
    const body = objectBody(req.body, ['page', 'kind', 'quote', 'comment', 'color', 'rects', 'requestId']);
    const requestId = Object.hasOwn(body, 'requestId') ? uuidValue(body.requestId, '批注请求') : null;
    const kind = Object.hasOwn(body, 'kind') ? annotationKind(body.kind) : 'text';
    const quote = kind === 'region' && !Object.hasOwn(body, 'quote') ? '' : stringValue(body.quote, '选中文字', 50_000, { nonempty: kind === 'text' });
    if (kind === 'region' && quote !== '') throw new HttpError(400, '区域批注不包含选中文字，请省略 quote 或传入空字符串。');
    const comment = Object.hasOwn(body, 'comment') ? stringValue(body.comment, '批注评论', 20_000) : '';
    const color = colorValue(body.color);
    const rects = rectanglesValue(body.rects);
    if (kind === 'region' && rects.length !== 1) throw new HttpError(400, '区域批注必须包含恰好一个页面内的矩形区域。');
    const result = transaction(() => {
      const doc = documentOr404(req.params.id);
      const page = pageValue(body.page, doc.page_count);
      const requestHash = createHash('sha256').update(JSON.stringify({ page, kind, quote, comment, color, rects })).digest('hex');
      const timestamp = Date.now();
      if (requestId) {
        db.prepare('DELETE FROM annotation_requests WHERE created_at <= ?').run(timestamp - RETRY_RETENTION_MS);
        const prior = db.prepare('SELECT request_hash, annotation_id FROM annotation_requests WHERE document_id = ? AND request_id = ?').get(doc.id, requestId);
        if (prior) {
          if (prior.request_hash !== requestHash) throw new HttpError(409, '此批注请求标识已用于不同内容，请先核对原请求结果。');
          const saved = findAnnotation.get(prior.annotation_id, doc.id);
          if (!saved) throw new HttpError(409, '此请求创建的批注已被删除，请核对后重新创建批注。');
          return { annotation: serializeAnnotation(saved), replayed: true };
        }
        if (db.prepare('SELECT COUNT(*) AS count FROM annotation_requests').get().count >= MAX_RETRY_RECORDS) {
          throw new HttpError(429, '批注重试保护记录已达到上限，请稍后重试；本次批注未创建。');
        }
      }
      const id = randomUUID(), now = new Date(timestamp).toISOString();
      db.prepare(`INSERT INTO annotations(id, document_id, page, kind, quote, comment, color, rects, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, doc.id, page, kind, quote, comment, color, JSON.stringify(rects), now, now);
      touchDocument.run(now, doc.id);
      if (requestId) db.prepare('INSERT INTO annotation_requests(document_id, request_id, request_hash, annotation_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(doc.id, requestId, requestHash, id, timestamp);
      return { annotation: serializeAnnotation(findAnnotation.get(id, doc.id)), replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  app.patch('/api/documents/:id/annotations/:annotationId', (req, res) => {
    const body = objectBody(req.body, ['comment', 'color', 'expectedAnnotationUpdatedAt']);
    const expected = Object.hasOwn(body, 'expectedAnnotationUpdatedAt') ? stringValue(body.expectedAnnotationUpdatedAt, '批注版本', 100, { nonempty: true }) : null;
    const annotation = transaction(() => {
      documentOr404(req.params.id);
      const saved = annotationOr404(req.params.annotationId, req.params.id);
      const comment = Object.hasOwn(body, 'comment') ? stringValue(body.comment, '批注评论', 20_000) : saved.comment;
      const color = Object.hasOwn(body, 'color') ? colorValue(body.color) : saved.color;
      if (comment === saved.comment && color === saved.color) return serializeAnnotation(saved);
      if (expected !== null && expected !== saved.updated_at) throw new HttpError(409, '批注已在其他窗口更新，请先读取最新评论再合并保存。');
      // updatedAt is also the edit token; even two same-millisecond writes differ.
      const prior = Date.parse(saved.updated_at);
      const now = new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString();
      db.prepare('UPDATE annotations SET comment = ?, color = ?, updated_at = ? WHERE id = ?')
        .run(comment, color, now, saved.id);
      touchDocument.run(now, req.params.id);
      return serializeAnnotation(findAnnotation.get(saved.id, req.params.id));
    });
    res.json({ annotation });
  });
  app.delete('/api/documents/:id/annotations/:annotationId', (req, res) => {
    transaction(() => {
      documentOr404(req.params.id);
      annotationOr404(req.params.annotationId, req.params.id);
      db.prepare('DELETE FROM annotations WHERE id = ? AND document_id = ?').run(req.params.annotationId, req.params.id);
      touchDocument.run(new Date().toISOString(), req.params.id);
    });
    res.json({ ok: true });
  });

  app.get('/api/search', (req, res) => {
    const query = req.query.q ?? '';
    const needle = searchText(stringValue(query, '搜索内容', 500)).toLowerCase();
    if (!needle) return res.json({ results: [] });
    const results = [];
    const documents = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC, id').all();
    const pages = db.prepare('SELECT page, text FROM pages WHERE document_id = ? ORDER BY page');
    const add = (doc, page, source, text) => {
      const searchable = searchText(text);
      if (results.length < 100 && searchable.toLowerCase().includes(needle)) {
        results.push({ documentId: doc.id, title: doc.title, page, snippet: snippet(searchable, needle), source });
      }
    };
    for (const doc of documents) {
      add(doc, 1, 'title', doc.title);
      for (const page of pages.iterate(doc.id)) {
        add(doc, page.page, 'text', page.text);
        if (results.length === 100) break;
      }
      add(doc, 1, 'notes', `${doc.notes_zh}\n${doc.notes_en}`);
      for (const annotation of findAnnotations.iterate(doc.id)) {
        add(doc, annotation.page, 'annotation', `${annotation.quote}\n${annotation.comment}`);
        if (results.length === 100) break;
      }
      if (results.length === 100) break;
    }
    res.json({ results });
  });
  app.get('/api/documents/:id/export', (req, res) => {
    const doc = documentOr404(req.params.id);
    const annotations = findAnnotations.all(doc.id);
    const parts = [
      `# ${markdownText(doc.title.replace(/[\r\n]+/g, ' '))}`,
      `原始文件：${markdownText(doc.filename)}  \n页数：${doc.page_count}  \n导出时间：${new Date().toISOString()}`,
      '## 笔记', mergeNotes(doc.notes_zh, doc.notes_en) || '（暂无笔记）',
      '## 阅读批注',
    ];
    if (!annotations.length) parts.push('（暂无批注）');
    annotations.forEach((annotation, index) => {
      if (annotation.kind === 'region') {
        const rect = JSON.parse(annotation.rects)[0];
        parts.push(`### ${index + 1}. 第 ${annotation.page} 页 · 区域批注 · ${annotation.color}`);
        parts.push(`区域坐标（归一化 0–1）：x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height}`);
      } else {
        parts.push(`### ${index + 1}. 第 ${annotation.page} 页 · ${annotation.color}`);
        parts.push(blockquote(annotation.quote));
      }
      parts.push(annotation.comment ? `评论：\n\n${markdownText(annotation.comment)}` : '（无评论）');
    });
    const bookmarks = db.prepare('SELECT page,title FROM bookmarks WHERE document_id = ? ORDER BY page,id').all(doc.id);
    if (bookmarks.length) parts.push('## 页面书签', ...bookmarks.map(bookmark => `- PDF 第 ${bookmark.page} 页 · ${markdownText(bookmark.title)}`));
    const safeTitle = doc.title.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').slice(0, 100) || 'paper';
    const downloadName = encodeURIComponent(`${safeTitle}.md`).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `attachment; filename="paperdesk-${doc.id}.md"; filename*=UTF-8''${downloadName}`);
    res.type('text/markdown; charset=utf-8').send(`${parts.join('\n\n')}\n`);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: '没有找到这个接口。' }));
  app.use('/examples', express.static(path.join(rootDir, 'public/examples'), { dotfiles: 'deny', index: false }));
  const distDir = path.join(rootDir, 'dist');
  app.use(express.static(distDir, { dotfiles: 'deny', index: false }));
  app.get('/', (_req, res, next) => {
    if (existsSync(path.join(distDir, 'index.html'))) res.sendFile('index.html', { root: distDir });
    else next(new HttpError(503, '界面尚未构建，请先运行 npm run build，或使用开发启动方式。'));
  });
  app.use((_req, res) => res.status(404).json({ error: '没有找到这个资源。' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: '请仅上传一个 PDF，文件字段名应为 file，不要附加其他文件或字段。' });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大，请缩短笔记或批注。' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'JSON 格式不正确。' });
    if (error instanceof HttpError || (error.name === 'VaultError' && error.status === 409)) {
      const payload = { error: error.message };
      if (['NOTES_VERSION_CONFLICT', 'VAULT_FILE_CONFLICT'].includes(error.code)) {
        payload.code = error.code;
        if (error.conflictPreserved === true) payload.conflictPreserved = true;
      }
      return res.status(error.status).json(payload);
    }
    console.error('Paperdesk request failed:', error);
    res.status(500).json({ error: '本地读写失败，请检查数据目录权限和剩余磁盘空间后重试。' });
  });
  return {
    app, ready,
    close() {
      if (closing) return closing;
      closed = true;
      pluginApi.close();
      closing = (async () => {
        try {
          // Forced HTTP disconnection does not cancel asynchronous PDF work.
          // Keep SQLite open until every admitted import and TOC task settles.
          const [resources] = await Promise.all([
            Promise.allSettled([
              Promise.resolve().then(() => translationApi.close()),
              Promise.resolve().then(() => readerRenderer.close()),
            ]),
            Promise.allSettled([ready, vaultIndex?.settle(), importQueue, ...pendingToc]),
          ]);
          const failures = resources.filter(result => result.status === 'rejected');
          if (failures.length) throw new AggregateError(failures.map(result => result.reason), '本机阅读资源未能完整关闭。');
        } finally {
          tocCache.clear();
          db.close();
        }
      })();
      return closing;
    },
  };
}
