import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mergeNotes, MAX_NOTE_LENGTH } from '../shared/notes.mjs';
import { libraryIdentity, LAUNCHER_PROTOCOL, PRODUCT_VERSION, SERVICE_API_VERSION } from '../shared/service-identity.mjs';

const SESSION_TTL = 30_000;
const REQUEST_TTL = 10 * 60_000;
const MAX_SESSIONS = 8;
const MAX_REQUESTS = 512;
const MAX_PREVIEW_LENGTH = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function notesRevision(row) {
  return createHash('sha256').update(JSON.stringify([row.notes_zh, row.notes_en])).digest('hex');
}

export function revisionValue(value, HttpError) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HttpError(400, '请提供有效的笔记版本号。');
  }
  return value;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// Validate the transient image itself, not just a claimed MIME type. Limit
// decompression separately so a tiny compressed image cannot exhaust memory.
function validPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8, header, palette = false, ended = false, dataEnded = false;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!typeBytes.every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) return false;
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)
      || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    const chunk = bytes.subarray(offset + 8, end - 4);
    if (!header && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (header || length !== 13) return false;
      header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] };
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!header.width || !header.height || !depths[header.color]?.includes(header.depth)
        || chunk[10] !== 0 || chunk[11] !== 0 || header.interlace > 1) return false;
    } else if (type === 'PLTE') {
      if (palette || imageData.length || !length || length % 3 || length > 768
        || [0, 4].includes(header.color) || (header.color === 3 && length / 3 > 2 ** header.depth)) return false;
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (header.color === 3 && !palette)) return false;
      imageData.push(chunk);
    } else if (type === 'IEND') {
      if (length || !imageData.length || end !== bytes.length) return false;
      ended = true;
      break;
    } else {
      if (type[0] === type[0].toUpperCase()) return false;
      if (imageData.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) return false;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x) / dx));
    const height = Math.max(0, Math.ceil((header.height - y) / dy));
    return { height: width ? height : 0, stride: 1 + Math.ceil(width * channels * header.depth / 8) };
  });
  const expectedLength = rows.reduce((total, row) => total + row.height * row.stride, 0);
  if (!Number.isSafeInteger(expectedLength) || expectedLength > 64 * 1024 * 1024) return false;
  try {
    const raw = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength + 1 });
    if (raw.length !== expectedLength) return false;
    let start = 0;
    for (const { height, stride } of rows) {
      for (let row = 0; row < height; row++, start += stride) if (raw[start] > 4) return false;
    }
    return true;
  } catch { return false; }
}

export function registerPluginApi({ app, db, dataDir, documentOr404, serializeDocument, transaction, HttpError, objectBody, stringValue, pageValue, rectanglesValue }) {
  const instanceId = randomUUID();
  const libraryId = libraryIdentity(dataDir);
  const sessions = new Map();
  const requests = new Map();
  const findPage = db.prepare('SELECT text FROM pages WHERE document_id = ? AND page = ?');
  const saveNotes = db.prepare('UPDATE documents SET notes_zh = ?, notes_en = ?, updated_at = ? WHERE id = ?');

  function uuidValue(value, label) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label}必须是有效的 UUID。`);
    return value.toLowerCase();
  }
  function prune() {
    const now = Date.now();
    for (const [key, session] of sessions) if (now - session.updatedAtMs >= SESSION_TTL) sessions.delete(key);
    for (const [key, request] of requests) if (now - request.createdAt >= REQUEST_TTL) requests.delete(key);
  }
  function selectionValue(selection) {
    if (selection === null) return null;
    const body = objectBody(selection, ['kind', 'text', 'rects', 'preview']);
    if (!['text', 'region'].includes(body.kind)) throw new HttpError(400, '选区类型必须是 text 或 region。');
    const text = stringValue(body.text, '选区文字', 50_000, { nonempty: body.kind === 'text' });
    // Plain page-text excerpts in a native component have no PDF geometry.
    // Only transient text context may omit rectangles; saved annotations keep
    // their existing geometry validation and regions still require one box.
    const rects = body.kind === 'text' && Array.isArray(body.rects) && body.rects.length === 0
      ? [] : rectanglesValue(body.rects);
    if (body.kind === 'region' && (text !== '' || rects.length !== 1)) throw new HttpError(400, '区域选区必须没有引文，且只包含一个矩形。');
    const result = { kind: body.kind, text, rects };
    if (Object.hasOwn(body, 'preview')) {
      const preview = body.preview;
      const prefix = 'data:image/png;base64,';
      if (typeof preview !== 'string' || preview.length > MAX_PREVIEW_LENGTH || !preview.startsWith(prefix)) {
        throw new HttpError(400, '选区预览必须是最多 2 MiB 的 PNG data URL。');
      }
      const base64 = preview.slice(prefix.length);
      if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new HttpError(400, '选区预览不是有效的 PNG。');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64 || !validPng(bytes)) throw new HttpError(400, '选区预览不是有效的 PNG，或解码后的图片过大。');
      result.preview = preview;
    }
    return result;
  }
  function summary(session) {
    return { sessionId: session.sessionId, documentId: session.documentId, page: session.page, updatedAt: session.updatedAt };
  }

  app.get('/api/plugin/status', (_req, res) => res.json({ service: 'paperdesk', apiVersion: SERVICE_API_VERSION, instanceId, libraryId, productVersion: PRODUCT_VERSION, launcherProtocol: LAUNCHER_PROTOCOL }));
  app.get('/api/documents/:id/pages/:page', (req, res) => {
    const doc = documentOr404(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.page)) throw new HttpError(400, '页码必须是正整数。');
    const page = pageValue(Number(req.params.page), doc.page_count);
    const text = findPage.get(doc.id, page)?.text ?? '';
    res.json({ documentId: doc.id, page, text, textAvailable: Boolean(text.trim()) });
  });
  app.post('/api/reader-sessions/:sessionId', (req, res) => {
    const sessionId = uuidValue(req.params.sessionId, '阅读会话 ID');
    const body = objectBody(req.body, ['documentId', 'page', 'selection', 'notesDirty', 'visible']);
    const doc = documentOr404(uuidValue(body.documentId, '文献 ID'));
    const page = pageValue(body.page, doc.page_count);
    if (typeof body.notesDirty !== 'boolean' || typeof body.visible !== 'boolean') throw new HttpError(400, 'notesDirty 和 visible 必须是布尔值。');
    const selection = selectionValue(body.selection);
    prune();
    if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) throw new HttpError(429, '最多同时连接 8 个阅读会话，请关闭其他窗口后重试。');
    const updatedAtMs = Date.now();
    const session = { sessionId, documentId: doc.id, page, selection, notesDirty: body.notesDirty, visible: body.visible, updatedAtMs, updatedAt: new Date(updatedAtMs).toISOString() };
    sessions.set(sessionId, session);
    res.json({ session: summary(session), document: serializeDocument(doc) });
  });
  app.delete('/api/reader-sessions/:sessionId', (req, res) => {
    const sessionId = uuidValue(req.params.sessionId, '阅读会话 ID');
    prune();
    sessions.delete(sessionId);
    res.json({ ok: true });
  });
  app.get('/api/reader-context', (req, res) => {
    prune();
    let session;
    if (Object.hasOwn(req.query, 'sessionId')) {
      session = sessions.get(uuidValue(req.query.sessionId, '阅读会话 ID'));
      if (!session?.visible) throw new HttpError(404, '这个阅读会话已关闭、隐藏或过期，请回到纸间后重试。');
    } else {
      const active = [...sessions.values()].filter(item => item.visible);
      if (active.length > 1) {
        return res.status(409).json({
          error: '存在多个活动阅读窗口，请指定 sessionId 后重试。',
          sessions: active.map(item => ({ ...summary(item), title: documentOr404(item.documentId).title })),
        });
      }
      session = active[0];
      if (!session) throw new HttpError(404, '没有活动阅读会话，请在纸间打开文献后重试。');
    }
    const doc = documentOr404(session.documentId);
    res.json({ ...summary(session), title: doc.title, selection: session.selection, notesDirty: session.notesDirty, notesRevision: notesRevision(doc) });
  });
  app.post('/api/documents/:id/notes/append', (req, res) => {
    const body = objectBody(req.body, ['text', 'expectedNotesRevision', 'page', 'requestId']);
    const text = stringValue(body.text, '追加笔记', MAX_NOTE_LENGTH, { nonempty: true });
    const expectedNotesRevision = revisionValue(body.expectedNotesRevision, HttpError);
    const requestId = uuidValue(body.requestId, '请求 ID');
    const initialDoc = documentOr404(req.params.id);
    const page = Object.hasOwn(body, 'page') ? pageValue(body.page, initialDoc.page_count) : null;
    const fingerprint = createHash('sha256').update(JSON.stringify([initialDoc.id, text, expectedNotesRevision, page])).digest('hex');
    prune();
    const previous = requests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(409, '这个请求 ID 已用于不同的笔记追加，请使用新的请求 ID。');
      return res.json({ document: serializeDocument(documentOr404(req.params.id)), appended: false, requestId });
    }
    if (requests.size >= MAX_REQUESTS) throw new HttpError(429, '近期笔记追加请求过多，请稍后重试。');
    const document = transaction(() => {
      const doc = documentOr404(req.params.id);
      if ([...sessions.values()].some(session => session.documentId === doc.id && session.notesDirty)) {
        throw new HttpError(409, '纸间中还有未保存的笔记，请先在阅读窗口保存后重试。');
      }
      if (expectedNotesRevision !== notesRevision(doc)) throw new HttpError(409, '笔记已更新，请读取最新笔记并核对后重试。');
      const old = mergeNotes(doc.notes_zh, doc.notes_en);
      const addition = page === null ? text : `### 第 ${page} 页\n\n${text}`;
      const combined = old ? `${old}\n\n${addition}` : addition;
      if (combined.length > MAX_NOTE_LENGTH) throw new HttpError(400, `追加后笔记超过 ${MAX_NOTE_LENGTH.toLocaleString('en-US')} 个字符，请缩短内容。`);
      saveNotes.run(combined, '', new Date().toISOString(), doc.id);
      return serializeDocument(documentOr404(doc.id));
    });
    requests.set(requestId, { fingerprint, createdAt: Date.now() });
    res.json({ document, appended: true, requestId });
  });
  return { close() { sessions.clear(); requests.clear(); } };
}
