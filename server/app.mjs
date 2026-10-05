import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, existsSync } from 'node:fs';
import { chmod, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractToc } from './toc.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const pdfPackageDir = path.join(rootDir, 'node_modules/pdfjs-dist');
const MAX_PAGES = 2000;
const MAX_TEXT = 20_000_000;
const COLORS = new Set(['yellow', 'green', 'pink']);

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
    notesEn: row.notes_en, lastPage: row.last_page,
  };
}

function serializeAnnotation(row) {
  return {
    id: row.id, documentId: row.document_id, page: row.page,
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

async function parsePdf(filePath) {
  let task;
  try {
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
export function createApp({ dataDir = process.env.PAPERDESK_DATA_DIR || path.join(rootDir, 'data') } = {}) {
  dataDir = path.resolve(dataDir);
  const pdfDir = path.join(dataDir, 'pdfs');
  mkdirSync(pdfDir, { recursive: true, mode: 0o700 });
  const incomingDir = path.join(pdfDir, '.incoming');
  mkdirSync(incomingDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'paperdesk.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
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
      rects TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS annotations_document ON annotations(document_id, page);
    PRAGMA user_version = 1;
  `);
  const app = express();
  app.disable('x-powered-by');
  app.use(localRequestOnly);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
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
    const pending = importQueue.then(work);
    importQueue = pending.catch(() => {});
    return pending;
  }
  const findDocument = db.prepare('SELECT * FROM documents WHERE id = ?');
  const findHash = db.prepare('SELECT * FROM documents WHERE sha256 = ?');
  const findAnnotation = db.prepare('SELECT * FROM annotations WHERE id = ? AND document_id = ?');
  const findAnnotations = db.prepare('SELECT * FROM annotations WHERE document_id = ? ORDER BY page, created_at, id');
  const touchDocument = db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?');
  const tocCache = new Map();
  function documentToc(doc) {
    if (tocCache.has(doc.id)) {
      const cached = tocCache.get(doc.id);
      tocCache.delete(doc.id);
      tocCache.set(doc.id, cached);
      return cached;
    }
    const pending = (async () => {
      try {
        return await extractToc(pathToFileURL(path.join(pdfDir, `${doc.id}.pdf`)), { getPageTexts: () => db.prepare('SELECT page, text FROM pages WHERE document_id = ? ORDER BY page').all(doc.id) });
      } catch {
        throw new HttpError(422, '暂时无法读取这份 PDF 的目录，请检查原始文件后重试。');
      }
    })();
    tocCache.set(doc.id, pending);
    if (tocCache.size > 8) tocCache.delete(tocCache.keys().next().value);
    void pending.catch(() => { if (tocCache.get(doc.id) === pending) tocCache.delete(doc.id); });
    return pending;
  }
  function documentOr404(id) {
    const row = findDocument.get(id);
    if (!row) throw new HttpError(404, '没有找到这篇文献。');
    return row;
  }
  function annotationOr404(id, documentId) {
    const row = findAnnotation.get(id, documentId);
    if (!row) throw new HttpError(404, '没有找到这条批注。');
    return row;
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
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
        const id = randomUUID();
        const filename = originalFilename(req.file.originalname);
        const title = parsed.title || filename.replace(/\.pdf$/i, '').slice(0, 500) || '未命名文献';
        const now = new Date().toISOString();
        const pdfPath = path.join(pdfDir, `${id}.pdf`);
        let transactionOpen = false;
        let moved = false;
        try {
          await rename(temporaryPath, pdfPath);
          moved = true;
          // No await between BEGIN and COMMIT: concurrent requests cannot share a transaction.
          db.exec('BEGIN IMMEDIATE');
          transactionOpen = true;
          db.prepare(`INSERT INTO documents(id, sha256, title, filename, page_count, byte_size,
            created_at, updated_at, text_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, sha256, title, filename, parsed.pages.length, req.file.size, now, now, Number(parsed.textAvailable),
          );
          const insertPage = db.prepare('INSERT INTO pages(document_id, page, text) VALUES (?, ?, ?)');
          parsed.pages.forEach((text, index) => insertPage.run(id, index + 1, text));
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
    // The library may live under .local; only this DB-selected PDF route may
    // traverse a hidden parent directory. Global static routes remain restricted.
    res.sendFile(`${doc.id}.pdf`, { root: pdfDir, dotfiles: 'allow' }, (error) => {
      if (!error || res.headersSent) return;
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        return next(new HttpError(404, '原始 PDF 文件已丢失，请检查本地数据目录。'));
      }
      if (error.status === 416) return next(new HttpError(416, '请求的 PDF 字节范围无效。'));
      next(new HttpError(500, '暂时无法读取原始 PDF，请检查数据目录权限和文件状态后重试。'));
    });
  });
  app.get('/api/documents/:id/toc', async (req, res) => {
    res.json(await documentToc(documentOr404(req.params.id)));
  });
  app.patch('/api/documents/:id', (req, res) => {
    const doc = documentOr404(req.params.id);
    const body = objectBody(req.body, ['title', 'notesZh', 'notesEn', 'lastPage']);
    if (Object.keys(body).length === 0) return res.json({ document: serializeDocument(doc) });
    const title = Object.hasOwn(body, 'title') ? stringValue(body.title, '文献标题', 500, { nonempty: true, trim: true }) : doc.title;
    const zh = Object.hasOwn(body, 'notesZh') ? stringValue(body.notesZh, '中文笔记', 250_000) : doc.notes_zh;
    const en = Object.hasOwn(body, 'notesEn') ? stringValue(body.notesEn, '英文笔记', 250_000) : doc.notes_en;
    const lastPage = Object.hasOwn(body, 'lastPage') ? pageValue(body.lastPage, doc.page_count) : doc.last_page;
    db.prepare('UPDATE documents SET title = ?, notes_zh = ?, notes_en = ?, last_page = ?, updated_at = ? WHERE id = ?')
      .run(title, zh, en, lastPage, new Date().toISOString(), doc.id);
    res.json({ document: serializeDocument(findDocument.get(doc.id)) });
  });
  app.post('/api/documents/:id/annotations', (req, res) => {
    const doc = documentOr404(req.params.id);
    const body = objectBody(req.body, ['page', 'quote', 'comment', 'color', 'rects']);
    const page = pageValue(body.page, doc.page_count);
    const quote = stringValue(body.quote, '选中文字', 50_000, { nonempty: true });
    const comment = stringValue(body.comment, '批注评论', 20_000);
    const color = colorValue(body.color);
    const rects = rectanglesValue(body.rects);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO annotations(id, document_id, page, quote, comment, color, rects, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, doc.id, page, quote, comment, color, JSON.stringify(rects), now, now);
    touchDocument.run(now, doc.id);
    res.status(201).json({ annotation: serializeAnnotation(findAnnotation.get(id, doc.id)) });
  });
  app.patch('/api/documents/:id/annotations/:annotationId', (req, res) => {
    documentOr404(req.params.id);
    const annotation = annotationOr404(req.params.annotationId, req.params.id);
    const body = objectBody(req.body, ['comment', 'color']);
    const comment = Object.hasOwn(body, 'comment') ? stringValue(body.comment, '批注评论', 20_000) : annotation.comment;
    const color = Object.hasOwn(body, 'color') ? colorValue(body.color) : annotation.color;
    const now = new Date().toISOString();
    db.prepare('UPDATE annotations SET comment = ?, color = ?, updated_at = ? WHERE id = ?')
      .run(comment, color, now, annotation.id);
    touchDocument.run(now, req.params.id);
    res.json({ annotation: serializeAnnotation(findAnnotation.get(annotation.id, req.params.id)) });
  });
  app.delete('/api/documents/:id/annotations/:annotationId', (req, res) => {
    documentOr404(req.params.id);
    annotationOr404(req.params.annotationId, req.params.id);
    db.prepare('DELETE FROM annotations WHERE id = ? AND document_id = ?').run(req.params.annotationId, req.params.id);
    touchDocument.run(new Date().toISOString(), req.params.id);
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
      '## 中文笔记', doc.notes_zh || '（暂无中文笔记）',
      '## English notes', doc.notes_en || '(No English notes yet.)',
      '## 阅读批注',
    ];
    if (!annotations.length) parts.push('（暂无批注）');
    annotations.forEach((annotation, index) => {
      parts.push(`### ${index + 1}. 第 ${annotation.page} 页 · ${annotation.color}`);
      parts.push(blockquote(annotation.quote));
      parts.push(annotation.comment ? `评论：\n\n${markdownText(annotation.comment)}` : '（无评论）');
    });
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
    if (existsSync(path.join(distDir, 'index.html'))) res.sendFile(path.join(distDir, 'index.html'));
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
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error('Paperdesk request failed:', error);
    res.status(500).json({ error: '本地读写失败，请检查数据目录权限和剩余磁盘空间后重试。' });
  });
  let closed = false;
  return { app, close() { if (!closed) { tocCache.clear(); db.close(); closed = true; } } };
}
