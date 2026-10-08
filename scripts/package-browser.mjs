import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const { version } = packageJson;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Invalid release version.');
}
if (process.argv.length > 2) throw new Error('Usage: npm run browser:dist');

const releaseDir = path.join(root, 'release');
const topFolder = `Paperdesk-${version}-browser`;
const zipName = `${topFolder}.zip`;
const manifestName = 'SHA256SUMS-browser';
const zipPath = path.join(releaseDir, zipName);
const manifestPath = path.join(releaseDir, manifestName);

// Keep this list explicit so a browser archive can never accidentally include
// the local library, ignored files, or another generated release artifact.
const allowedRootFiles = new Set([
  '.editorconfig',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  'CONTRIBUTING.md',
  'PDF_Vibecoding.code-workspace',
  'README.md',
  'LICENSE',
  'electron-builder.config.cjs',
  'index.html',
  'package-lock.json',
  'package.json',
  'vite.config.js',
  '启动纸间.command',
]);
const allowedPrefixes = [
  'desktop/',
  'docs/',
  'plugins/',
  'public/examples/',
  'scripts/',
  'server/',
  'shared/',
  'src/',
  'tests/',
];
const forbiddenPathComponents = new Set(['.git', '.local', 'data', 'node_modules', 'release']);

function assertSafeArchivePath(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const components = normalized.split('/');
  if (normalized.startsWith('/') || components.some(component => !component || component === '..')) {
    throw new Error(`Unsafe archive path: ${relative}`);
  }
  for (const component of components) {
    const lower = component.toLowerCase();
    if (forbiddenPathComponents.has(lower)
      || /^\.env(?:\..*)?$/i.test(component)
      || lower === '.ds_store'
      || /^(?:sqlite|db|log)(?:-|$)/i.test(component)
      || /\.(?:sqlite|db|log)(?:-|$)/i.test(component)) {
      throw new Error(`Forbidden archive path: ${relative}`);
    }
  }
}

async function assertDirectory(directory, label) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function assertRealPath(relative) {
  assertSafeArchivePath(relative);
  const components = relative.replaceAll('\\', '/').split('/');
  let current = root;
  let info;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing to follow symlink: ${relative}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Expected a directory in path: ${relative}`);
    }
  }
  return { path: current, info };
}

async function assertRealFile(relative) {
  const { path: source, info } = await assertRealPath(relative);
  if (!info.isFile()) throw new Error(`Expected a regular file: ${relative}`);
  return { source, info };
}

async function copyTrackedFile(relative, packageRoot) {
  const { source, info } = await assertRealFile(relative);
  const target = path.join(packageRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, info.mode & 0o777);
}

async function copyGeneratedTree(relative, packageRoot) {
  const { path: sourceRoot, info: rootInfo } = await assertRealPath(relative);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Expected a real generated directory: ${relative}`);
  }

  async function visit(source, target, displayPath) {
    assertSafeArchivePath(displayPath);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Refusing to follow symlink: ${displayPath}`);
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      const entries = await readdir(source, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(
          path.join(source, entry.name),
          path.join(target, entry.name),
          path.join(displayPath, entry.name),
        );
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Expected a regular generated file: ${displayPath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, info.mode & 0o777);
  }

  await visit(sourceRoot, path.join(packageRoot, relative), relative);
}

function startHere(versionValue) {
  return [
    `# Paperdesk ${versionValue} 浏览器版`,
    '',
    '这是纸间 Paperdesk 的本地浏览器版源码发布包。它已经包含构建好的界面；按照下面的步骤安装生产依赖即可运行，不需要重新构建前端。',
    '',
    '## 运行环境',
    '',
    '- Node.js 24 或更新版本（建议使用 Node.js 24 LTS）',
    '- 本次已在 macOS 验证；其他系统尚未验证',
    '',
    '## 安装与启动',
    '',
    '在本文件所在的目录执行：',
    '',
    '```sh',
    'npm ci --omit=dev',
    'npm start',
    '```',
    '',
    '然后在浏览器打开 <http://127.0.0.1:4317>。服务只监听本机地址。结束使用时回到终端按 **Control+C**。',
    '',
    '如果 4317 端口已被占用，可以先关闭已有实例，或设置其他端口后启动，例如 `PORT=4320 npm start`。',
    '',
    '## 文献库与数据',
    '',
    '默认数据目录是本目录下的 `data/`。首次导入文献后，PDF、索引、笔记和批注都会保存在这里；`data/` 不包含在这个发布包中。请在停止服务后备份整个目录，包括 SQLite 的 `-wal` 和 `-shm` 文件。也可以用 `PAPERDESK_DATA_DIR` 指定仓库外的文献库路径。',
    '',
    '## Obsidian 仓库与书签',
    '',
    '侧边栏可自动列出知识库的 PDF，首次点击后原位阅读；源文件不移动、改写或再保存一个永久副本。自行导入的外部 PDF 会在 Paperdesk/PDFs 中保存管理副本。笔记、批注、个人页面书签与分类以知识库的 Markdown 为正式资料，本机索引可重建。',
    '',
    '启动仓库模式时，将路径替换为实际知识库根目录（必须包含 .obsidian 文件夹）；索引路径必须位于整个知识库之外：',
    '',
    '```sh',
    'PAPERDESK_VAULT_DIR="/path/to/ObsidianVault" PAPERDESK_DATA_DIR="/path/outside-vault/PaperdeskCache" npm start',
    '```',
    '',
    '默认管理子文件夹是 Paperdesk，可用 PAPERDESK_VAULT_SUBDIR 指定单层文件夹名。已有关联笔记请保留固定名称；笔记正文两边可编辑，批注、书签与分类由 Paperdesk 修改。冲突暂停保存，副本写入并读回成功后才确认保留，正文需要手工比较合并。',
    '',
    '书签保存实际 PDF 页码，在工具栏打开“书签”，添加当前页并按需改名；重新打开 PDF 后点击名称跳转。它不会写入 PDF。',
    '',
    '主库升级到 schema 5 前自动保存 SQLite 一致性备份，但仍应正常停止旧程序，备份完整文献库；仓库模式还应备份正式 Markdown、所有源 PDF 和库外缓存。旧版不能直接读新结构或 v3 完整状态，回退须恢复升级前完整资料。详见 docs/obsidian-vault.md、docs/bookmarks.md 和 docs/desktop-release.md。',
    '',
    '## 功能',
    '',
    '- 导入 PDF、内容去重和本地文献列表',
    '- 正文、笔记和批注搜索',
    '- 分页／连续阅读、缩放、章节目录和多页布局',
    '- 文字高亮、评论和扫描件／图表区域批注',
    '- 笔记自动保存与 Markdown 导出',
    '- 单层文献分类和四套本地阅读皮肤',
    '',
    '扫描件没有 OCR；复杂排版、加密 PDF 和超大文献仍受 PDF.js 与本机资源限制。请保存前核对选区引文。',
    '',
    '## 可选功能与许可证',
    '',
    '软件内翻译 API 和 Codex 插件属于可选功能，需要用户自行配置接口或本机插件环境。未配置时不影响本地阅读、批注、笔记和导出；发布包不包含 API 密钥或个人文献。明确发送给翻译服务或当前 Work／Codex 对话的内容会离开本机，请按需使用。',
    '',
    '项目采用 MIT License，详见 [LICENSE](LICENSE)。',
    '',
  ].join('\n');
}

await assertDirectory(releaseDir, 'release output');
await assertDirectory(path.join(root, '.local'), 'staging parent');
const stagingRoot = await mkdtemp(path.join(root, '.local/paperdesk-browser-'));
let temporaryZipPath;
let temporaryManifest;
try {
  const packageRoot = path.join(stagingRoot, topFolder);
  await mkdir(packageRoot, { recursive: true });

  const { stdout } = await execFile('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const selected = new Set();
  for (const relative of stdout.split('\0').filter(Boolean)) {
    if (allowedRootFiles.has(relative) || allowedPrefixes.some(prefix => relative.startsWith(prefix))) {
      assertSafeArchivePath(relative);
      selected.add(relative);
    }
  }

  // LICENSE and this packager may be newly added in the release branch and
  // therefore not appear in git ls-files until the caller stages them.
  for (const relative of ['LICENSE', 'scripts/package-browser.mjs']) {
    try {
      await lstat(path.join(root, relative));
      assertSafeArchivePath(relative);
      selected.add(relative);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!selected.has('LICENSE')) throw new Error('LICENSE is required for the browser archive.');

  for (const relative of [...selected].sort()) await copyTrackedFile(relative, packageRoot);
  await copyGeneratedTree('dist', packageRoot);
  await writeFile(path.join(packageRoot, 'START-HERE.md'), startHere(version), { mode: 0o644 });

  temporaryZipPath = path.join(releaseDir, `.${zipName}-${randomUUID()}.tmp`);
  await execFile('zip', ['-qrX', temporaryZipPath, topFolder], { cwd: stagingRoot });
  const zipInfo = await lstat(temporaryZipPath);
  if (!zipInfo.isFile() || zipInfo.size === 0) throw new Error('Browser archive is missing or empty.');
  await rename(temporaryZipPath, zipPath);
  temporaryZipPath = undefined;

  const hash = createHash('sha256');
  const archive = await readFile(zipPath);
  hash.update(archive);
  temporaryManifest = path.join(releaseDir, `.${manifestName}-${randomUUID()}.tmp`);
  await writeFile(temporaryManifest, `${hash.digest('hex')}  ${zipName}\n`, { mode: 0o644 });
  await rename(temporaryManifest, manifestPath);
  temporaryManifest = undefined;
  console.log(JSON.stringify({ archive: zipPath, manifest: manifestPath, bytes: zipInfo.size }));
} finally {
  if (temporaryZipPath) await rm(temporaryZipPath, { force: true });
  if (temporaryManifest) await rm(temporaryManifest, { force: true });
  await rm(stagingRoot, { recursive: true, force: true });
}
