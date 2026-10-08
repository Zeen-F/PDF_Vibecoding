import { createServer } from 'node:http';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { LAUNCHER_PROTOCOL, PRODUCT_VERSION, SERVICE_API_VERSION, libraryIdentity } from '../shared/service-identity.mjs';

const HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 1500;
const CONNECTION_DRAIN_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORE_COLUMNS = {
  documents: ['id', 'sha256', 'title', 'filename', 'page_count', 'byte_size', 'created_at', 'updated_at', 'text_available', 'notes_zh', 'notes_en', 'last_page'],
  pages: ['document_id', 'page', 'text'],
  annotations: ['id', 'document_id', 'page', 'quote', 'comment', 'color', 'rects', 'created_at', 'updated_at'],
};

function resolvedDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) {
    throw new Error('请提供有效的文献库目录。');
  }
  return path.resolve(dataDir);
}

async function matchingService(baseUrl, libraryId) {
  try {
    const replies = await Promise.all(['/api/plugin/status', '/api/health'].map(async endpoint => {
      const response = await fetch(baseUrl + endpoint, {
        redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok ? response.json() : null;
    }));
    const [status, health] = replies;
    return status?.service === 'paperdesk' && status.apiVersion === SERVICE_API_VERSION
      && status.productVersion === PRODUCT_VERSION && status.launcherProtocol === LAUNCHER_PROTOCOL
      && status.libraryId === libraryId && health?.ok === true;
  } catch {
    return false;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const cleanup = () => { server.off('listening', ready); server.off('error', failed); };
    server.once('listening', ready);
    server.once('error', failed);
    try { server.listen(port, HOST); } catch (error) { failed(error); }
  });
}

async function drainServer(server, sockets) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    // close() first stops accepting connections. Existing requests keep their
    // database until they finish; stalled sockets have a finite deadline.
    const timer = setTimeout(() => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    }, CONNECTION_DRAIN_MS);
    timer.unref();
    server.close(error => {
      clearTimeout(timer);
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

/** Start a loopback service, or connect to the exact healthy library already running. */
export async function startDesktopRuntime({ dataDir, preferredPort = 4317 } = {}) {
  dataDir = resolvedDataDir(dataDir);
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
    throw new Error('本机端口必须是 0 至 65535 的整数。');
  }
  const preferredUrl = `http://${HOST}:${preferredPort}`;
  const libraryId = libraryIdentity(dataDir);
  const reused = () => ({ baseUrl: preferredUrl, dataDir, owned: false, close: async () => {} });
  if (preferredPort && await matchingService(preferredUrl, libraryId)) return reused();

  let application;
  let handler;
  let stopping = false;
  const responses = new Set();
  const sockets = new Set();
  // Reserve the port before opening a database. A bind race therefore cannot
  // create an unnecessary second app or modify an already-running library.
  const server = createServer((request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
    response.once('finish', () => {
      if (stopping) setImmediate(() => server.closeIdleConnections());
    });
    if (handler) return handler(request, response);
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: '纸间正在启动，请稍后重试。' }));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    try { await listen(server, preferredPort); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' || !preferredPort) throw error;
      if (await matchingService(preferredUrl, libraryId)) return reused();
      await listen(server, 0);
    }
    application = createApp({ dataDir });
    handler = application.app;
    const baseUrl = `http://${HOST}:${server.address().port}`;
    let closing;
    return {
      baseUrl, dataDir, owned: true,
      close() {
        if (!closing) closing = (async () => {
          stopping = true;
          for (const response of responses) {
            if (!response.headersSent) response.setHeader('Connection', 'close');
          }
          try { await drainServer(server, sockets); }
          finally { await application.close(); }
        })();
        return closing;
      },
    };
  } catch (error) {
    try { await drainServer(server, sockets); }
    finally { await application?.close(); }
    throw error;
  }
}

function requireColumns(database, table, expected) {
  const definition = database.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table);
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  if (definition?.type !== 'table' || expected.some(column => !columns.has(column))) {
    throw new Error('文献库结构不兼容或不完整，请选择完整的纸间文献库。');
  }
}

/** Inspect an existing, stopped library without creating files or migrating it. */
export async function validateExistingLibrary(rawDataDir) {
  const dataDir = resolvedDataDir(rawDataDir);
  const filename = path.join(dataDir, 'paperdesk.sqlite');
  const pdfDir = path.join(dataDir, 'pdfs');
  let database;
  try {
    const directory = await stat(dataDir);
    const file = await stat(filename);
    if (!directory.isDirectory() || !file.isFile() || file.size < 100) {
      throw new Error('这个目录没有完整的纸间文献库。');
    }
    // SQLite readOnly alone may create WAL/SHM files. Immutable reads avoid
    // those mutations, but cannot include a live WAL, so refuse that case.
    try {
      const wal = await stat(filename + '-wal');
      if (wal.size > 0) throw new Error('文献库仍有未归并的保存记录，请先正常停止原阅读服务，再选择此文献库。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const uri = pathToFileURL(filename);
    uri.searchParams.set('mode', 'ro');
    uri.searchParams.set('immutable', '1');
    database = new DatabaseSync(uri.href, { readOnly: true });
    const schemaVersion = database.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion > CURRENT_SCHEMA) throw new Error('文献库来自更新版本的纸间，请使用相应版本打开。');
    for (const [table, columns] of Object.entries(CORE_COLUMNS)) requireColumns(database, table, columns);
    if (schemaVersion < CURRENT_SCHEMA) throw new Error('这个文献库使用旧版结构。请先完整备份，再使用对应的源码或浏览器版本升级文献库后，重新选择此目录。');
    if (schemaVersion >= 2) requireColumns(database, 'annotations', ['kind']);
    if (schemaVersion >= 3) {
      requireColumns(database, 'documents', ['folder_id']);
      requireColumns(database, 'folders', ['id', 'name', 'name_key', 'created_at', 'updated_at']);
      requireColumns(database, 'library_preferences', ['id', 'theme']);
    }
    if (database.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')
      || database.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('文献库数据库检查未通过，请从完整备份恢复后再打开。');
    }
    const documents = database.prepare('SELECT id, page_count, byte_size FROM documents').all();
    if (!documents.length) throw new Error('这个文献库还没有文献，请选择已有文献的纸间文献库。');
    if (!(await stat(pdfDir)).isDirectory()) throw new Error('文献库缺少原始 PDF 目录。');
    let byteSize = 0;
    const pageCounts = new Map();
    for (const document of documents) {
      if (!UUID.test(document.id) || !Number.isSafeInteger(document.page_count) || document.page_count < 1
        || !Number.isSafeInteger(document.byte_size) || document.byte_size < 1) {
        throw new Error('文献库包含无效的文献记录，请检查完整备份。');
      }
      const pdf = await lstat(path.join(pdfDir, document.id + '.pdf'));
      if (!pdf.isFile() || pdf.size !== document.byte_size) {
        throw new Error('文献库 PDF 缺失或大小与记录不一致，请检查完整备份。');
      }
      byteSize += pdf.size;
      pageCounts.set(document.id, document.page_count);
    }
    for (const row of database.prepare('SELECT document_id, page FROM pages UNION ALL SELECT document_id, page FROM annotations').iterate()) {
      if (!Number.isInteger(row.page) || row.page < 1 || row.page > (pageCounts.get(row.document_id) ?? 0)) {
        throw new Error('文献库包含无效的页面或批注记录，请检查完整备份。');
      }
    }
    return { dataDir, libraryId: libraryIdentity(dataDir), schemaVersion, documentCount: documents.length, byteSize };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('这个目录缺少完整文献库或原始 PDF，请选择正确的纸间文献库。');
    if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('无法读取这个文献库，请检查目录权限。');
    if (error.code?.startsWith('ERR_SQLITE')) throw new Error('这个数据库不是兼容的纸间文献库或已损坏。', { cause: error });
    throw error;
  } finally {
    database?.close();
  }
}
