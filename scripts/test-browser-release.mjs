import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rootFiles = new Set(['.editorconfig', '.gitattributes', '.node-version', '.npmrc', '.nvmrc', 'CONTRIBUTING.md',
  'PDF_Vibecoding.code-workspace', 'README.md', 'START-HERE.md', 'LICENSE', 'electron-builder.config.cjs',
  'index.html', 'package-lock.json', 'package.json', 'vite.config.js', '启动纸间.cmd', '启动纸间.command', '.agents/plugins/marketplace.json']);
const prefixes = ['desktop/', 'docs/', 'plugins/', 'public/examples/', 'scripts/', 'server/', 'shared/',
  'src/', 'tests/', 'dist/'];
const samplePdfs = new Set(['public/examples/reading-demo.pdf', 'dist/examples/reading-demo.pdf', 'tests/fixtures/password-protected.pdf']);
const forbiddenComponents = new Set(['data', '.local', '.git', 'node_modules', 'release', '__macosx',
  'backups', 'recoveries', 'exports', 'screenshots']);

function safeEntry(name) {
  assert.ok(name && !/[\\\x00-\x1f\x7f]/.test(name), 'ZIP contains a nonportable or unsafe path');
  assert.ok(!name.startsWith('/') && !/^[a-z]:/i.test(name), 'ZIP contains an absolute path');
  const parts = name.replace(/\/$/, '').split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..'), 'ZIP contains path traversal');
  for (const part of parts) {
    assert.ok(!forbiddenComponents.has(part.toLowerCase()) && !/^\.env(?:\..*)?$/i.test(part)
      && !/^\.ds_store$/i.test(part) && !/\.(?:sqlite|sqlite3|db|log)(?:[-.]|$)/i.test(part)
      && !/\.(?:pem|key|p12|pfx)$/i.test(part), 'ZIP contains library data, private files or credentials');
  }
  const relative = parts.slice(1).join('/');
  if (relative && !name.endsWith('/')) {
    assert.ok(rootFiles.has(relative) || prefixes.some(prefix => relative.startsWith(prefix)),
      'ZIP contains an unexpected file outside the release allowlist');
    assert.ok(!/\.pdf$/i.test(relative) || samplePdfs.has(relative), 'ZIP contains an unapproved PDF');
    assert.ok(!/\.(?:png|jpe?g|gif|webp|heic|docx?|xlsx?|pptx?|zip|dmg)$/i.test(relative),
      'ZIP contains unexpected personal media or another archive');
  }
  return { top: parts[0], relative };
}

function inspectExtra(bytes, start, length, name) {
  const end = start + length;
  assert.ok(end <= bytes.length, 'ZIP extra field bounds are invalid');
  while (start < end) {
    assert.ok(start + 4 <= end, 'ZIP extra field header is invalid');
    const kind = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2);
    start += 4;
    assert.ok(start + size <= end, 'ZIP extra field length is invalid');
    assert.notEqual(kind, 1, 'ZIP64 entries are unsupported');
    // Info-ZIP may use this name instead of the main filename during unzip.
    if (kind === 0x7075) assert.ok(size >= 5 && bytes[start] === 1
      && bytes.subarray(start + 5, start + size).equals(Buffer.from(name)), 'ZIP alternate Unicode path disagrees');
    start += size;
  }
}

// Inspect central AND local names before asking unzip to write anything. This
// rejects links, duplicate destinations and traversal before extraction.
export function inspectArchive(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  assert.ok(end >= 0, 'ZIP end record is missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multipart ZIP is unsupported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multipart ZIP is unsupported');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count, 'Multipart ZIP is unsupported');
  assert.ok(count > 0 && count < 50000 && size !== 0xffffffff && start !== 0xffffffff,
    'ZIP is empty, too large, or uses unsupported ZIP64');
  assert.equal(start + size, end, 'ZIP central directory bounds are invalid');
  let offset = start, totalBytes = 0, top;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'ZIP directory entry is invalid');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), type = (bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    assert.ok(!(flags & 1) && [0, 8].includes(method), 'Encrypted or unsupported ZIP entry');
    assert.ok([0, 0x8000, 0x4000].includes(type), 'ZIP contains a symlink or special file');
    assert.ok(offset + 46 + nameLength + extra + comment <= end, 'ZIP filename bounds are invalid');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    assert.ok(Buffer.from(name).equals(nameBytes), 'ZIP filename is not valid UTF-8');
    inspectExtra(bytes, offset + 46 + nameLength, extra, name);
    const parsed = safeEntry(name);
    top ??= parsed.top;
    assert.equal(parsed.top, top, 'ZIP must contain exactly one top-level release folder');
    assert.ok(/^Paperdesk-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-browser$/.test(top), 'ZIP release folder name is invalid');
    assert.ok(type !== 0x4000 || name.endsWith('/'), 'ZIP directory type/name mismatch');
    const destination = name.replace(/\/$/, '');
    assert.ok(!entries.has(destination), 'ZIP contains duplicate destinations');
    assert.ok(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50, 'ZIP local header is invalid');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    assert.ok(bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes), 'ZIP local and central filenames disagree');
    inspectExtra(bytes, local + 30 + localNameLength, localExtra, name);
    assert.equal(bytes.readUInt16LE(local + 6), flags, 'ZIP local and central flags disagree');
    assert.equal(bytes.readUInt16LE(local + 8), method, 'ZIP local and central methods disagree');
    assert.ok(local + 30 + localNameLength + localExtra + compressed <= start, 'ZIP compressed data escapes its bounds');
    totalBytes += uncompressed;
    assert.ok(totalBytes < 500 * 1024 * 1024, 'ZIP extraction exceeds the release size limit');
    entries.set(destination, { name, directory: name.endsWith('/'), bytes: uncompressed });
    offset += 46 + nameLength + extra + comment;
  }
  assert.equal(offset, end, 'ZIP directory length is inconsistent');
  for (const entry of entries.values()) {
    let parent = path.posix.dirname(entry.name.replace(/\/$/, ''));
    while (parent !== '.') {
      assert.ok(!entries.has(parent) || entries.get(parent).directory, 'ZIP file collides with a parent directory');
      parent = path.posix.dirname(parent);
    }
  }
  return { top, entries, totalBytes };
}

async function scanExtracted(directory, archive) {
  const observed = new Set();
  async function walk(current, relative = '') {
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink(), 'Extracted archive contains a symlink');
    if (info.isDirectory()) {
      for (const name of await readdir(current)) await walk(path.join(current, name), relative ? `${relative}/${name}` : name);
      return;
    }
    assert.ok(info.isFile(), 'Extracted archive contains a special file');
    const name = `${archive.top}/${relative}`, entry = archive.entries.get(name);
    assert.ok(entry && !entry.directory, 'Extracted file was absent from inspected ZIP');
    assert.equal(info.size, entry.bytes, 'Extracted file size differs from ZIP');
    observed.add(name);
    if (/\.(?:mjs|cjs|js|jsx|json|md|txt|yml|yaml|html|css|command|sh|code-workspace)$/.test(relative)
      || rootFiles.has(relative)) {
      const text = await readFile(current, 'utf8');
      assert.ok(!/\/(?:Users|home)\/[A-Za-z0-9_. -]+\//.test(text)
        && !/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+[\\/]/.test(text), 'Archive contains a private absolute user path');
      assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
        && !/\b(?:sk-[A-Za-z0-9_-]{32,}|gh[opusr]_[A-Za-z0-9]{30,})\b/.test(text), 'Archive contains a credential');
    }
  }
  await walk(directory);
  assert.equal(observed.size, [...archive.entries.values()].filter(entry => !entry.directory).length,
    'Extracted archive is missing inspected files');
}

export function cleanEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (/^(?:PAPERDESK_|DEV_API_PORT$|PORT$|NODE_PATH$|NODE_OPTIONS$|NODE_TEST_CONTEXT$|NPM_CONFIG_)/i.test(name)) delete result[name];
  }
  result.PATH = `${path.dirname(process.execPath)}${path.delimiter}${result.PATH || ''}`;
  return result;
}

async function randomPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

async function request(base, route) {
  const response = await fetch(`${base}/api${route}`, { signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  assert.ok(response.ok, `GET ${route}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--archive') throw new Error('Usage: node scripts/test-browser-release.mjs --archive <browser.zip>');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24+ is required');
  const archivePath = await realpath(path.resolve(args[1]));
  assert.ok((await lstat(archivePath)).isFile(), 'Archive must be a regular file');
  const started = Date.now();
  const result = { status: 'running', archive: path.basename(archivePath), checks: [], cleanup: false };
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'paperdesk-browser-release-')));
  const children = new Set();
  let browser, cleanupPromise, interrupted = false, stage = 'archive';
  const passed = name => { result.checks.push(name); console.error(`PASS ${name}`); };
  const terminate = (child, signal) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const launch = (command, commandArgs, options = {}) => {
    const child = spawn(command, commandArgs, { env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', ...options });
    child.output = '';
    const capture = chunk => { child.output = (child.output + chunk.toString()).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.done = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
    });
    children.add(child);
    return child;
  };
  const stop = async (child, strict = true) => {
    if (!child) return;
    terminate(child, 'SIGTERM');
    let timer;
    const exited = await Promise.race([child.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); })]);
    clearTimeout(timer);
    if (!exited) { terminate(child, 'SIGKILL'); await child.done; if (strict) throw new Error('Service did not stop gracefully'); }
    else if (strict) assert.ok(!exited.error && exited.code === 0 && !exited.signal, `Service exited abnormally: ${child.output}`);
  };
  const cleanup = () => cleanupPromise ??= (async () => {
    const errors = [];
    try { await browser?.close(); } catch (error) { errors.push(error.message); }
    const stopped = await Promise.allSettled([...children].map(child => stop(child, false)));
    errors.push(...stopped.filter(item => item.status === 'rejected').map(item => item.reason.message));
    if (!errors.length) {
      try {
        await rm(temporary, { recursive: true, force: true });
        assert.equal(await lstat(temporary).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false,
          'Temporary acceptance tree still exists after cleanup');
        assert.equal(children.size, 0, 'Owned child processes remain after cleanup');
      } catch (error) { errors.push(error.message); }
    }
    if (errors.length) throw new Error(`Cleanup failed: ${errors.join('; ')}`);
    result.cleanup = true;
  })();
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { interrupted = true; void cleanup().catch(error => { result.cleanupError = error.message; }); };
    handlers.set(signal, handler); process.once(signal, handler);
  }
  const command = async (executable, commandArgs, options = {}, timeout = 240000) => {
    assert.ok(!interrupted, 'Acceptance was interrupted');
    const child = launch(executable, commandArgs, options);
    let timer;
    const outcome = await Promise.race([child.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]);
    clearTimeout(timer);
    if (!outcome) { terminate(child, 'SIGKILL'); await child.done; throw new Error(`Command timed out: ${executable}`); }
    assert.ok(!outcome.error && outcome.code === 0 && !outcome.signal, `${executable} failed: ${outcome.error?.message || child.output}`);
    return child.output;
  };
  try {
    const bytes = await readFile(archivePath), archive = inspectArchive(bytes);
    result.sha256 = sha256(bytes);
    const extract = path.join(temporary, 'extracted');
    await mkdir(extract);
    await command('unzip', ['-q', archivePath, '-d', extract]);
    const packageRoot = path.join(extract, archive.top);
    await scanExtracted(packageRoot, archive);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(archive.top, `Paperdesk-${metadata.version}-browser`);
    result.version = metadata.version;
    for (const required of ['server/index.mjs', 'dist/index.html', 'public/examples/reading-demo.pdf', 'package-lock.json']) {
      assert.ok((await lstat(path.join(packageRoot, required))).isFile(), `Required packaged file missing: ${required}`);
    }
    assert.ok((await readFile(path.join(packageRoot, 'dist/examples/reading-demo.pdf')))
      .equals(await readFile(path.join(packageRoot, 'public/examples/reading-demo.pdf'))),
    'Built demonstration PDF differs from the original packaged example');
    const marketplace = JSON.parse(await readFile(path.join(packageRoot, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(marketplace.name, 'paperdesk-local');
    const plugin = marketplace.plugins.find(item => item.name === 'paperdesk');
    assert.deepEqual(plugin?.source, { source: 'local', path: './plugins/paperdesk' });
    for (const manifest of ['plugin.json', '.codex-plugin/plugin.json']) {
      assert.equal(JSON.parse(await readFile(path.join(packageRoot, 'plugins/paperdesk', manifest), 'utf8')).name, 'paperdesk');
    }
    passed('archive-safety-and-privacy');
    stage = 'production-dependencies';
    const npmConfig = path.join(temporary, 'npmrc');
    await writeFile(npmConfig, '');
    await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund',
      '--userconfig', npmConfig, '--cache', path.join(temporary, 'npm-cache')], { cwd: packageRoot });
    const probe = `import {createRequire} from 'node:module';import path from 'node:path';import {realpathSync} from 'node:fs';const r=createRequire(path.resolve('package.json'));for(const name of ['express','pdfjs-dist/package.json','@napi-rs/canvas','@modelcontextprotocol/sdk/server/mcp.js']){const resolved=realpathSync(r.resolve(name));if(!resolved.startsWith(realpathSync('node_modules')+path.sep))throw new Error('Dependency outside clean package: '+name);}try{r.resolve('@playwright/test');throw new Error('Development dependency installed');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}`;
    await command(process.execPath, ['--input-type=module', '-e', probe], { cwd: packageRoot });
    passed('isolated-npm-ci-production-only');
    // Only the driver imports project Playwright. The application and all its
    // dependency resolution run from the independently extracted package.
    const { chromium, expect } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true });
    const demoPath = path.join(packageRoot, 'public/examples/reading-demo.pdf'), demo = await readFile(demoPath);
    const baseEnvironment = cleanEnvironment();
    const start = async ({ dataDir, vaultDir, port }) => {
      assert.ok(!interrupted, 'Acceptance was interrupted');
      const env = { ...baseEnvironment, PORT: String(port), PAPERDESK_DATA_DIR: dataDir,
        ...(vaultDir ? { PAPERDESK_VAULT_DIR: vaultDir, PAPERDESK_VAULT_SUBDIR: 'Paperdesk' } : {}) };
      const child = launch(process.execPath, ['server/index.mjs'], { cwd: packageRoot, env });
      const base = `http://127.0.0.1:${port}`;
      let status;
      try {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged service failed: ${child.output}`);
          try {
            const response = await fetch(`${base}/api/plugin/status`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { status = await response.json(); break; }
          } catch { /* Only this freshly allocated loopback port is polled. */ }
          await delay(100);
        }
        assert.ok(status, `Packaged service readiness timed out: ${child.output}`);
        assert.equal(status.productVersion, metadata.version);
        assert.equal(status.libraryId, sha256(Buffer.from(path.resolve(vaultDir ? path.join(vaultDir, 'Paperdesk') : dataDir))));
        const storage = await request(base, '/storage');
        assert.equal(storage.mode, vaultDir ? 'vault' : 'library');
        return { child, base, status };
      } catch (error) { await stop(child, false); throw error; }
    };
    const contextFor = async base => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      const errors = [];
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(`${base}/`) || /^(?:blob:|data:)/.test(url)) return route.continue();
        errors.push('Unexpected external browser request'); return route.abort();
      });
      await context.addInitScript(() => {
        window.paperdeskDesktop = {
          onFlushRequest(callback) { window.__releaseFlush = callback; return () => { delete window.__releaseFlush; }; },
          onLibrarySwitch() { return () => {}; },
        };
      });
      return { context, errors };
    };
    const rendered = async (page, at = 1) => {
      const paper = page.locator(`.pdf-paper[data-page="${at}"]`);
      await expect(paper).toBeVisible(); await expect(paper).not.toHaveClass(/is-loading/);
      const canvas = paper.getByLabel(`PDF 第 ${at} 页`, { exact: true });
      await expect(canvas).toBeVisible();
      assert.ok(await canvas.evaluate(element => {
        if (!element.width || !element.height) return false;
        const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
        for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] && Math.min(...pixels.subarray(index, index + 3)) < 220) return true;
        return false;
      }), 'PDF canvas must contain rendered ink');
    };
    const flush = async page => {
      await page.waitForFunction(() => typeof window.__releaseFlush === 'function');
      // A response/download can arrive before the UI clears its import/open/
      // export guard. Wait for the real guard, then flush all save queues.
      await expect(page.getByRole('button', { name: '导入 PDF', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: '导出 Markdown', exact: true })).toBeEnabled();
      await page.evaluate(() => window.__releaseFlush());
      await expect(page.locator('.save-row [role="status"]')).toHaveText(/已保存到/);
      await expect(page.locator('.bookmarks-error, .notes-conflict, .notes-save-failure')).toHaveCount(0);
    };
    const saveNotes = async (page, base, id, notes, mode) => {
      const expand = page.getByRole('button', { name: '展开笔记面板', exact: true });
      if (await expand.isVisible()) await expand.click();
      await page.locator('.panel-tabs').getByRole('button', { name: '笔记', exact: true }).click();
      const editor = page.getByRole('textbox', { name: '笔记', exact: true });
      await editor.fill(notes); await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.locator('.save-row [role="status"]')).toHaveText(mode === 'vault' ? '已保存到 Obsidian 仓库' : '已保存到本机');
      assert.equal((await request(base, `/documents/${id}`)).document.notesZh, notes);
    };
    const annotate = async (page, base, id) => {
      const span = page.locator('.pdf-paper[data-page="1"] .textLayer span').filter({ hasText: /^Reading with intention$/ });
      await expect(span).toBeVisible(); const box = await span.boundingBox();
      await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
      await page.getByRole('button', { name: '高亮并批注', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /高亮与批注/ });
      await expect(dialog.locator('blockquote')).toHaveText('Reading with intention');
      await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill('干净发布包：真实拖选引文仍绑定第一页。');
      const pending = page.waitForResponse(response => response.url() === `${base}/api/documents/${id}/annotations` && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: '保存批注', exact: true }).click(); const response = await pending;
      assert.equal(response.status(), 201); const { annotation } = await response.json();
      assert.equal(annotation.quote, 'Reading with intention'); assert.equal(annotation.page, 1);
      assert.ok(annotation.rects.length > 0);
      for (const rect of annotation.rects) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001);
      await expect(dialog).not.toBeVisible(); await expect(page.locator(`[data-annotation="${annotation.id}"]`).first()).toBeVisible();
      return annotation;
    };
    const exportNotes = async (page, notes, annotation, bookmark) => {
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
      const download = await pending; assert.match(download.suggestedFilename(), /\.md$/);
      const text = await readFile(await download.path(), 'utf8');
      assert.ok(text.includes(notes) && text.includes(annotation.quote) && text.includes(annotation.comment));
      if (bookmark) assert.ok(text.includes(bookmark.title) && text.includes('PDF 第 2 页'));
    };
    const documentButton = (page, id) => page.locator(`[data-document-id="${id}"] .document-item`);
    const goto = async (page, at) => {
      if (await page.getByRole('region', { name: '个人书签', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭书签', exact: true }).click();
      const input = page.getByRole('spinbutton', { name: '页码', exact: true });
      await input.fill(String(at)); await input.press('Enter'); await expect(input).toHaveValue(String(at)); await rendered(page, at);
    };
    const openBookmarks = async page => {
      if (!await page.getByRole('region', { name: '个人书签', exact: true }).isVisible()) await page.getByRole('button', { name: '展开书签', exact: true }).click();
      await expect(page.getByRole('button', { name: '刷新书签', exact: true })).toBeEnabled();
    };

    stage = 'library-workflow';
    const libraryDir = path.join(temporary, 'ordinary-library'), libraryPort = await randomPort();
    let library = await start({ dataDir: libraryDir, port: libraryPort });
    const libraryBrowser = await contextFor(library.base); let page = await libraryBrowser.context.newPage();
    await page.goto(library.base); assert.deepEqual((await request(library.base, '/documents')).documents, []);
    const imported = page.waitForResponse(response => response.url() === `${library.base}/api/documents` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '打开阅读示例', exact: true }).click();
    const importResponse = await imported; assert.equal(importResponse.status(), 201); const ordinary = (await importResponse.json()).document;
    assert.equal(ordinary.pageCount, 2); await rendered(page);
    const ordinaryAnnotation = await annotate(page, library.base, ordinary.id);
    const ordinaryNotes = '## 干净浏览器包验收\n\n真实拖选、笔记和导出应在停止后完整保留。\n\nOriginal evidence stays local.';
    await saveNotes(page, library.base, ordinary.id, ordinaryNotes, 'library');
    await exportNotes(page, ordinaryNotes, ordinaryAnnotation); await flush(page);
    const ordinarySnapshot = await request(library.base, `/documents/${ordinary.id}`);
    assert.equal(sha256(await readFile(path.join(libraryDir, 'pdfs', `${ordinary.id}.pdf`))), sha256(demo));
    const ordinaryInstance = library.status.instanceId; await page.close(); await stop(library.child);
    library = await start({ dataDir: libraryDir, port: libraryPort });
    assert.notEqual(library.status.instanceId, ordinaryInstance);
    const ordinaryRestart = await request(library.base, `/documents/${ordinary.id}`);
    assert.equal(ordinaryRestart.document.notesZh, ordinaryNotes); assert.deepEqual(ordinaryRestart.annotations, ordinarySnapshot.annotations);
    page = await libraryBrowser.context.newPage(); await page.goto(library.base); await documentButton(page, ordinary.id).click();
    await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(ordinaryNotes); await rendered(page);
    await flush(page); await page.close(); await stop(library.child); assert.deepEqual(libraryBrowser.errors, []);
    await libraryBrowser.context.close(); assert.equal(sha256(await readFile(demoPath)), sha256(demo));
    passed('library-demo-render-real-drag-notes-export-graceful-restart');

    stage = 'vault-workflow';
    const vaultDir = path.join(temporary, '合成知识库'), sourceRelative = '已有资料/模拟电路/阅读 #示例.pdf';
    const sourcePdf = path.join(vaultDir, sourceRelative), externalPdf = path.join(temporary, '外部原创示例.pdf');
    const externalBytes = Buffer.concat([demo, Buffer.from('\n% Original external release acceptance fixture\n')]);
    await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true }); await mkdir(path.dirname(sourcePdf), { recursive: true });
    await writeFile(sourcePdf, demo); await writeFile(externalPdf, externalBytes);
    const vaultPort = await randomPort(), vaultCache = path.join(temporary, 'vault-cache');
    let vault = await start({ dataDir: vaultCache, vaultDir, port: vaultPort });
    const vaultBrowser = await contextFor(vault.base); page = await vaultBrowser.context.newPage(); await page.goto(vault.base);
    const sidebarSource = page.getByRole('navigation', { name: '文献库', exact: true })
      .getByRole('button', { name: `打开 Obsidian PDF：${sourceRelative}`, exact: true });
    await expect(sidebarSource).toBeVisible(); assert.deepEqual((await request(vault.base, '/documents')).documents, []);
    const opened = page.waitForResponse(response => response.url() === `${vault.base}/api/vault/pdfs/open` && response.request().method() === 'POST');
    await sidebarSource.click(); const openedResponse = await opened; assert.equal(openedResponse.status(), 201);
    const source = (await openedResponse.json()).document; await rendered(page);
    assert.deepEqual(await readdir(path.join(vaultDir, 'Paperdesk', 'PDFs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
    const sourceAnnotation = await annotate(page, vault.base, source.id), sourceNotes = '## 原位 PDF\n\n源文件留在原目录，书签使用实际 PDF 页码。';
    await saveNotes(page, vault.base, source.id, sourceNotes, 'vault'); await goto(page, 2); await openBookmarks(page);
    const added = page.waitForResponse(response => response.url() === `${vault.base}/api/documents/${source.id}/bookmarks` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '添加当前页书签', exact: true }).click(); const addedResponse = await added;
    assert.equal(addedResponse.status(), 201); let bookmark = (await addedResponse.json()).bookmark;
    const row = page.locator('.bookmark-row[data-bookmark-page="2"]');
    await row.getByRole('button', { name: /^重命名书签：/ }).click();
    await page.getByRole('textbox', { name: '书签名称，PDF 第 2 页', exact: true }).fill('回看工作条件');
    const renamed = page.waitForResponse(response => response.url() === `${vault.base}/api/documents/${source.id}/bookmarks/${bookmark.id}` && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存书签名称', exact: true }).click(); const renamedResponse = await renamed;
    assert.equal(renamedResponse.status(), 200); bookmark = (await renamedResponse.json()).bookmark;
    assert.equal(bookmark.title, '回看工作条件'); await goto(page, 1); await openBookmarks(page);
    await row.getByRole('button', { name: '书签：回看工作条件，PDF 第 2 页', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '页码', exact: true })).toHaveValue('2'); await rendered(page, 2);
    await exportNotes(page, sourceNotes, sourceAnnotation, bookmark); await flush(page);
    const externalUpload = page.waitForResponse(response => response.url() === `${vault.base}/api/documents` && response.request().method() === 'POST');
    await page.getByLabel('选择 PDF 文件').setInputFiles(externalPdf); const externalResponse = await externalUpload;
    assert.equal(externalResponse.status(), 201); const copied = (await externalResponse.json()).document; assert.notEqual(copied.id, source.id);
    await rendered(page); const copiedNotes = '外部导入的副本属于知识库，外部原件仍须原样保留。';
    await saveNotes(page, vault.base, copied.id, copiedNotes, 'vault'); await flush(page);
    const duplicateUpload = page.waitForResponse(response => response.url() === `${vault.base}/api/documents` && response.request().method() === 'POST');
    await page.getByLabel('选择 PDF 文件').setInputFiles(externalPdf); const duplicateResponse = await duplicateUpload;
    assert.equal(duplicateResponse.status(), 200); assert.equal((await duplicateResponse.json()).document.id, copied.id);
    await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(copiedNotes); await flush(page);
    assert.deepEqual(await readdir(path.join(vaultDir, 'Paperdesk', 'PDFs')), [`${copied.id}.pdf`]);
    assert.equal(sha256(await readFile(path.join(vaultDir, 'Paperdesk', 'PDFs', `${copied.id}.pdf`))), sha256(externalBytes));
    assert.equal(sha256(await readFile(sourcePdf)), sha256(demo)); assert.equal(sha256(await readFile(externalPdf)), sha256(externalBytes));
    const formalNote = await readFile(path.join(vaultDir, 'Paperdesk', 'Notes', `${source.id}.md`), 'utf8');
    assert.ok(formalNote.includes(sourceNotes) && formalNote.includes(sourceAnnotation.quote) && formalNote.includes(bookmark.title));
    const state = JSON.parse(formalNote.match(/<!-- paperdesk-state:v1\n([^\n]+)\n-->/)?.[1] || 'null');
    assert.equal(state.version, 3); assert.deepEqual(state.pdfSource, { kind: 'vault', path: sourceRelative });
    assert.equal(state.bookmarks[0].id, bookmark.id); assert.equal(state.bookmarks[0].page, 2);
    const vaultInstance = vault.status.instanceId; await page.close(); await stop(vault.child);
    // A new outside cache verifies formal Markdown, rather than an old SQLite
    // projection or a browser recovery draft, is sufficient after restart.
    vault = await start({ dataDir: path.join(temporary, 'rebuilt-vault-cache'), vaultDir, port: vaultPort });
    assert.notEqual(vault.status.instanceId, vaultInstance);
    assert.equal((await request(vault.base, '/documents')).documents.length, 2);
    const sourceRestart = await request(vault.base, `/documents/${source.id}`);
    assert.equal(sourceRestart.document.notesZh, sourceNotes); assert.deepEqual(sourceRestart.annotations, [sourceAnnotation]);
    assert.deepEqual((await request(vault.base, `/documents/${source.id}/bookmarks`)).bookmarks, [bookmark]);
    assert.equal((await request(vault.base, `/documents/${copied.id}`)).document.notesZh, copiedNotes);
    page = await vaultBrowser.context.newPage(); await page.goto(vault.base); await documentButton(page, source.id).click();
    await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(sourceNotes);
    await goto(page, 1); await openBookmarks(page);
    await page.getByRole('button', { name: '书签：回看工作条件，PDF 第 2 页', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '页码', exact: true })).toHaveValue('2'); await rendered(page, 2);
    await flush(page); await page.close(); await stop(vault.child); assert.deepEqual(vaultBrowser.errors, []); await vaultBrowser.context.close();
    assert.equal(sha256(await readFile(sourcePdf)), sha256(demo)); assert.equal(sha256(await readFile(externalPdf)), sha256(externalBytes));
    assert.deepEqual(await readdir(path.join(vaultDir, 'Paperdesk', 'PDFs')), [`${copied.id}.pdf`]);
    passed('vault-sidebar-original-import-copy-real-bookmark-jump-markdown-rebuild');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.stage = stage;
    result.error = String(error.message).replaceAll(temporary, '<temporary>').replaceAll(root.replace(/\/$/, ''), '<project>').slice(-6000);
    process.exitCode = 1;
  } finally {
    try { await cleanup(); } catch (error) { result.status = 'failed'; result.cleanupError = error.message; process.exitCode = 1; }
    for (const [signal, handler] of handlers) process.off(signal, handler);
    result.durationMs = Date.now() - started;
    const output = path.join(root, '.local', 'verification', 'browser-release');
    await mkdir(output, { recursive: true });
    const filename = `result-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
    await writeFile(path.join(output, filename), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await writeFile(path.join(output, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ ...result, resultFile: path.join(output, filename) }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
