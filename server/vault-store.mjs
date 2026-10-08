import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TextDecoder } from 'node:util';
import { mergeNotes, MAX_NOTE_LENGTH } from '../shared/notes.mjs';
import { THEME_IDS } from '../shared/library.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const START = '\n\n<!-- paperdesk-generated:start:v1 -->\n';
const END = '\n<!-- paperdesk-generated:end:v1 -->\n';
const STATE_START = '<!-- paperdesk-state:v1\n';
const STATE_END = '\n-->';
const LIBRARY_START = '<!-- paperdesk-library:v1\n';
const MAX_MARKDOWN_BYTES = 128 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = value => createHash('sha256').update(value).digest('hex');

class VaultError extends Error {
  constructor(message, code) { super(message); this.name = 'VaultError'; this.status = 409; if (code) this.code = code; }
}
const invalid = message => { throw new VaultError(message); };
const fileConflict = message => { throw new VaultError(message, 'VAULT_FILE_CONFLICT'); };
function guard(work) {
  try { return work(); }
  catch (error) {
    if (error instanceof VaultError) throw error;
    const failure = new VaultError('Obsidian 文件读写失败，请检查文件权限和磁盘状态；请保留当前草稿并核对原文件。');
    failure.cause = error; throw failure;
  }
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid(`${label}格式不正确，请保留文件并修复 Paperdesk 元数据。`);
}
function text(value, max, label, nonempty = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max
    || (nonempty && !value.trim())) invalid(`${label}必须是${nonempty ? '非空的' : ''}有效文本，最多 ${max} 个字符。`);
  return value;
}
function uuid(value, label = '文献') {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(`${label}标识不是有效的小写 UUID。`);
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}超出有效整数范围。`);
  return value;
}
function timestamp(value, label) {
  text(value, 100, label, true);
  if (!Number.isFinite(Date.parse(value))) invalid(`${label}不是有效日期。`);
}
function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(`${label}不是有效的 SHA-256。`);
}
function page(value, count) { integer(value, 1, count, 'PDF 页码'); }
function array(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || value.length > max) invalid(`${label}数量或格式不正确。`);
}
function unique(rows, key, label) {
  const values = rows.map(row => row[key]);
  if (new Set(values).size !== values.length) invalid(`${label}包含重复标识。`);
}
function validateState(input, expectedId) {
  object(input, ['version', 'document', 'annotations', 'annotationRequests', 'positionWriters'], '文献状态');
  if (input.version !== 1) invalid('此 Markdown 使用不支持的 Paperdesk 格式版本，请使用相应版本打开。');
  const doc = input.document;
  object(doc, ['id', 'sha256', 'title', 'filename', 'page_count', 'byte_size', 'created_at', 'updated_at', 'text_available', 'notes_zh', 'notes_en', 'last_page', 'folder_id'], '文献属性');
  uuid(doc.id); if (doc.id !== expectedId) invalid('文献文件名与元数据 UUID 不一致，请先核对原文件。');
  hash(doc.sha256, 'PDF 校验和'); text(doc.title, 500, '文献标题', true);
  text(doc.filename, 512, '原始文件名', true);
  if (/[\\/\x00-\x1f\x7f]/.test(doc.filename)) invalid('原始文件名不能包含路径或控制字符。');
  integer(doc.page_count, 1, 2000, 'PDF 页数'); integer(doc.byte_size, 1, Number.MAX_SAFE_INTEGER, 'PDF 大小');
  timestamp(doc.created_at, '创建日期'); timestamp(doc.updated_at, '更新日期');
  integer(doc.text_available, 0, 1, '文本索引状态'); page(doc.last_page, doc.page_count);
  if (doc.folder_id !== null) uuid(doc.folder_id, '文件夹');
  text(doc.notes_zh, MAX_NOTE_LENGTH, '笔记'); text(doc.notes_en, 250_000, '英文笔记');
  text(mergeNotes(doc.notes_zh, doc.notes_en), MAX_NOTE_LENGTH, '合并笔记');
  array(input.annotations, '批注'); unique(input.annotations, 'id', '批注');
  for (const row of input.annotations) {
    object(row, ['id', 'document_id', 'page', 'quote', 'comment', 'color', 'rects', 'created_at', 'updated_at', 'kind'], '批注');
    uuid(row.id, '批注'); if (row.document_id !== doc.id) invalid('批注绑定了其他文献。');
    page(row.page, doc.page_count);
    if (!['text', 'region'].includes(row.kind)) invalid('批注类型必须是 text 或 region。');
    text(row.quote, 50_000, '选中文字', row.kind === 'text'); text(row.comment, 20_000, '批注评论');
    if (row.kind === 'region' && row.quote !== '') invalid('区域批注不应包含选中文字。');
    if (!['yellow', 'green', 'pink'].includes(row.color)) invalid('批注颜色格式不正确。');
    text(row.rects, 100_000, '批注坐标');
    let rects; try { rects = JSON.parse(row.rects); } catch { invalid('批注坐标 JSON 已损坏。'); }
    array(rects, '批注区域', 200);
    if (!rects.length || (row.kind === 'region' && rects.length !== 1)) invalid('批注区域数量不正确。');
    for (const rect of rects) {
      object(rect, ['x', 'y', 'width', 'height'], '批注矩形');
      const { x, y, width, height } = rect;
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
        || x > 1 || y > 1 || width > 1 || height > 1 || x + width > 1 || y + height > 1) invalid('批注坐标必须位于 PDF 页面内。');
    }
    timestamp(row.created_at, '批注创建日期'); timestamp(row.updated_at, '批注更新日期');
  }
  array(input.annotationRequests, '批注重试记录', 10_000); unique(input.annotationRequests, 'request_id', '批注重试记录');
  for (const row of input.annotationRequests) {
    object(row, ['document_id', 'request_id', 'request_hash', 'annotation_id', 'created_at'], '批注重试记录');
    if (row.document_id !== doc.id) invalid('批注重试记录绑定了其他文献。');
    uuid(row.request_id, '请求'); uuid(row.annotation_id, '批注'); hash(row.request_hash, '请求校验和');
    integer(row.created_at, 0, Number.MAX_SAFE_INTEGER, '请求时间');
  }
  array(input.positionWriters, '阅读位置记录', 10_000); unique(input.positionWriters, 'writer_id', '阅读位置记录');
  for (const row of input.positionWriters) {
    object(row, ['document_id', 'writer_id', 'sequence', 'page', 'updated_at'], '阅读位置记录');
    if (row.document_id !== doc.id) invalid('阅读位置记录绑定了其他文献。');
    uuid(row.writer_id, '阅读窗口'); integer(row.sequence, 1, Number.MAX_SAFE_INTEGER, '阅读位置序号');
    page(row.page, doc.page_count); integer(row.updated_at, 0, Number.MAX_SAFE_INTEGER, '阅读位置时间');
  }
  return input;
}
function validateLibrary(state) {
  object(state, ['folders', 'theme'], '文献库属性');
  if (!THEME_IDS.includes(state.theme)) invalid('文献库主题格式不正确。');
  array(state.folders, '文件夹'); unique(state.folders, 'id', '文件夹'); unique(state.folders, 'name_key', '文件夹');
  for (const folder of state.folders) {
    object(folder, ['id', 'name', 'name_key', 'created_at', 'updated_at'], '文件夹');
    uuid(folder.id, '文件夹'); text(folder.name, 80, '文件夹名称', true);
    if (/[\p{Cc}\p{Cf}]/u.test(folder.name) || folder.name.trim() !== folder.name
      || folder.name_key !== folder.name.normalize('NFKC').toLowerCase()) invalid('文件夹名称或名称索引不正确。');
    timestamp(folder.created_at, '文件夹创建日期'); timestamp(folder.updated_at, '文件夹更新日期');
  }
  return state;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function checkedPath(root, target, { missing = false, directory = false } = {}) {
  if (!inside(root, target)) invalid('文件路径必须位于指定的 Obsidian Paperdesk 文件夹内。');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) invalid('Obsidian 路径不能是符号链接。');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info; try { info = lstatSync(current); } catch (error) {
      if (missing && error.code === 'ENOENT') return null;
      if (error.code === 'ENOENT') invalid('Obsidian 文件缺失，请恢复原文件后重试。');
      throw error;
    }
    if (info.isSymbolicLink()) invalid('Paperdesk 不读取或替换符号链接，请使用知识库内的真实文件。');
    if (index < parts.length - 1 || directory) {
      if (!info.isDirectory()) invalid('Obsidian 文件夹路径被普通文件占用。');
    } else if (!info.isFile()) invalid('Paperdesk 文件路径必须指向普通文件。');
    if (!inside(root, realpathSync(current))) invalid('文件实际路径越出了指定 Obsidian 知识库。');
  }
  return lstatSync(target);
}

// Validation is read-only: selecting a vault never creates an Obsidian marker.
export function validateVaultDirectory(vaultDir) {
  return guard(() => {
    text(vaultDir, 32_768, 'Obsidian 知识库路径', true);
    const requested = path.resolve(vaultDir);
    if (!existsSync(requested)) invalid('没有找到指定的 Obsidian 知识库文件夹。');
    const info = lstatSync(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) invalid('请使用真实的 Obsidian 知识库文件夹，不能选择符号链接或文件。');
    const canonical = realpathSync(requested);
    checkedPath(canonical, path.join(canonical, '.obsidian'), { directory: true });
    return canonical;
  });
}
function scalar(value) { return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'); }
function frontmatter(doc) {
  return `---\npaperdesk_id: ${scalar(doc.id)}\ntitle: ${scalar(doc.title)}\npdf: ${scalar(`../PDFs/${doc.id}.pdf`)}\npages: ${doc.page_count}\npaperdesk_format: 1\n---\n`;
}
function splitFrontmatter(source) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) invalid('Paperdesk 笔记缺少完整的 YAML 属性区，请先恢复文件。');
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(source);
  if (!match) invalid('Paperdesk 笔记的 YAML 属性区已损坏，请先恢复文件。');
  return { properties: match[0], content: source.slice(match[0].length) };
}
function oneMarker(source, marker, label) {
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + marker.length) !== -1) invalid(`${label}缺失或重复，请保留文件并修复生成区域。`);
  return index;
}
function parseDocument(source, id) {
  const { properties, content } = splitFrontmatter(source);
  const start = oneMarker(content, START, 'Paperdesk 批注开始标记');
  const end = oneMarker(content, END, 'Paperdesk 批注结束标记');
  if (end <= start) invalid('Paperdesk 批注标记顺序不正确。');
  // Unknown/edited marker spellings are rejected rather than treated as notes.
  if ((content.match(/<!-- paperdesk-generated:/g) || []).length !== 2) invalid('Paperdesk 批注标记已损坏。');
  if ((content.match(/<!-- paperdesk-state:/g) || []).length !== 1) invalid('Paperdesk 隐藏元数据标记缺失或重复。');
  const generated = content.slice(start + START.length, end);
  const stateStart = oneMarker(generated, STATE_START, 'Paperdesk 元数据标记');
  const stateEnd = generated.indexOf(STATE_END, stateStart + STATE_START.length);
  if (stateEnd < 0 || generated.slice(stateEnd + STATE_END.length).trim()) invalid('Paperdesk 元数据结束标记已损坏。');
  let state; try { state = JSON.parse(generated.slice(stateStart + STATE_START.length, stateEnd)); }
  catch { invalid('Paperdesk 隐藏元数据 JSON 已损坏，原文件未被覆盖。'); }
  validateState(state, id);
  const rebuilt = generatedMarkdown(state);
  const expectedVisible = rebuilt.slice(START.length, rebuilt.indexOf(STATE_START));
  if (generated.slice(0, stateStart) !== expectedVisible) {
    invalid('Paperdesk 自动生成的批注区已被修改，原文件未被覆盖。请把额外文字移到笔记正文；批注内容请在 Paperdesk 中修改。');
  }
  const notes = content.slice(0, start) + content.slice(end + END.length);
  text(notes, MAX_NOTE_LENGTH, 'Obsidian 笔记正文');
  return { state, properties, notes };
}
function annotationMarkdown(row, id) {
  const link = `../PDFs/${id}.pdf#page=${row.page}`;
  const visible = value => value.replaceAll('<!--', '&lt;!--');
  const quote = row.kind === 'region' ? '> 区域批注（页面坐标保存在元数据中）' : visible(row.quote).split('\n').map(line => `> ${line}`).join('\n');
  return `### [PDF 第 ${row.page} 页](${link}) · ${row.color}\n\n${quote}\n\n${visible(row.comment) || '（暂无评论）'}\n`;
}
function generatedMarkdown(state) {
  return `${START}## Paperdesk 批注\n\n此区域由 Paperdesk 维护；请在上方正文编辑阅读笔记。\n\n${state.annotations.map(row => annotationMarkdown(row, state.document.id)).join('\n')}${STATE_START}${scalar(state)}${STATE_END}${END}`;
}
function signature(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function futureDirectory(requested) {
  let current = path.resolve(requested);
  const missing = [];
  for (;;) {
    let info;
    try { info = lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(current)); current = path.dirname(current); continue;
    }
    if (!missing.length && info.isSymbolicLink()) invalid('恢复目录不能是符号链接。');
    if (!info.isDirectory() && !info.isSymbolicLink()) invalid('恢复目录路径被普通文件占用。');
    return path.join(realpathSync(current), ...missing);
  }
}

export function createVaultStore({ vaultDir, subdir = 'Paperdesk', recoveryDir } = {}) {
  return guard(() => {
    const canonical = validateVaultDirectory(vaultDir);
    text(subdir, 1024, 'Paperdesk 文件夹名称', true);
    const segments = subdir.split(/[\\/]/);
    if (path.isAbsolute(subdir) || segments.some(segment => !segment || ['.', '..', '.obsidian'].includes(segment)
      || /[\x00-\x1f\x7f]/.test(segment))) invalid('Paperdesk 文件夹必须是知识库内的相对路径，不能包含上级目录。');
    const rootDir = path.join(canonical, ...segments);
    const pdfDir = path.join(rootDir, 'PDFs'), notesDir = path.join(rootDir, 'Notes');
    const conflictDir = path.join(notesDir, 'Conflicts'), libraryPath = path.join(rootDir, 'Library.md');
    const recoveryRoot = futureDirectory(recoveryDir || path.join(tmpdir(), 'paperdesk-vault-recovery', digest(canonical).slice(0, 24)));
    if (inside(canonical, recoveryRoot)) invalid('文件恢复副本必须保存在 Obsidian 知识库之外。');
    function ensureDirectory(dir) {
      checkedPath(canonical, dir, { missing: true, directory: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      checkedPath(canonical, dir, { directory: true });
    }
    for (const dir of [rootDir, pdfDir, notesDir]) ensureDirectory(dir);
    let libraryEstablished = existsSync(libraryPath) || readdirSync(notesDir).some(name => name.endsWith('.md'))
      || readdirSync(pdfDir).some(name => name.endsWith('.pdf'));
    const pdfCache = new Map();
    const pdfPath = id => { uuid(id); const target = path.join(pdfDir, `${id}.pdf`); checkedPath(canonical, target, { missing: true }); return target; };
    const notePath = id => { uuid(id); const target = path.join(notesDir, `${id}.md`); checkedPath(canonical, target, { missing: true }); return target; };
    function openFile(file) {
      const expected = checkedPath(canonical, file);
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const current = fstatSync(fd);
      if (!current.isFile() || current.ino !== expected.ino || current.dev !== expected.dev) { closeSync(fd); fileConflict('文件正在被外部程序替换，请重新读取后重试。'); }
      return fd;
    }
    function markdown(file, missing = false) {
      if (!checkedPath(canonical, file, { missing })) return null;
      const fd = openFile(file);
      try {
        const before = signature(fstatSync(fd));
        if (fstatSync(fd).size > MAX_MARKDOWN_BYTES) invalid('Paperdesk Markdown 文件过大，请拆分正文或批注。');
        const bytes = readFileSync(fd);
        const after = signature(fstatSync(fd));
        if (bytes.length > MAX_MARKDOWN_BYTES) invalid('Paperdesk Markdown 文件过大，请拆分正文或批注。');
        if (before !== after) fileConflict('Obsidian 正在修改此 Markdown 文件，请稍后重新读取。');
        return { source: utf8.decode(bytes), token: digest(bytes), signature: after };
      } finally { closeSync(fd); }
    }
    function verifyPdf(doc) {
      const file = pdfPath(doc.id), fd = openFile(file);
      try {
        const stat = fstatSync(fd), key = signature(stat);
        if (stat.size !== doc.byte_size) invalid('PDF 大小与文献记录不一致，请核对或恢复原始 PDF。');
        const cached = pdfCache.get(file);
        let sha = cached?.signature === key ? cached.sha256 : null;
        if (!sha) {
          const buffer = Buffer.alloc(64 * 1024), hasher = createHash('sha256');
          let position = 0, count;
          do {
            count = readSync(fd, buffer, 0, buffer.length, position);
            if (!position && (count < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-')) invalid('原始文献不是有效的 PDF 文件。');
            if (count) { hasher.update(buffer.subarray(0, count)); position += count; }
          } while (count);
          if (signature(fstatSync(fd)) !== key) invalid('PDF 正在被其他程序修改，请稍后重新读取。');
          sha = hasher.digest('hex'); pdfCache.set(file, { signature: key, sha256: sha });
        }
        if (sha !== doc.sha256) invalid('PDF 校验和与文献记录不一致，请核对或恢复原始 PDF。');
        return file;
      } finally { closeSync(fd); }
    }
    function readDocument(id) {
      return guard(() => {
        const file = notePath(id), saved = markdown(file, true);
        if (!saved) return null;
        const { state, notes } = parseDocument(saved.source, id);
        return { document: { ...state.document, notes_zh: notes, notes_en: '' },
          annotations: state.annotations, annotationRequests: state.annotationRequests, positionWriters: state.positionWriters,
          token: saved.token, pdfPath: verifyPdf(state.document), notePath: file };
      });
    }
    function recoveryLink(file) {
      // Hardlinks keep the replaced inode: an editor holding an open descriptor
      // can still finish its write without destroying the recovery copy.
      mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
      if (lstatSync(recoveryRoot).isSymbolicLink() || !lstatSync(recoveryRoot).isDirectory()
        || inside(canonical, realpathSync(recoveryRoot))) invalid('恢复目录必须是知识库之外的真实文件夹。');
      const saved = path.join(recoveryRoot, `${path.basename(file, '.md')}-${Date.now()}-${randomUUID()}.md`);
      try { linkSync(file, saved); }
      catch (error) {
        const failure = new VaultError('无法创建可恢复的 Markdown 原文件副本，本次保存已停止，请检查恢复目录权限与所在磁盘。');
        failure.cause = error; throw failure;
      }
      return saved;
    }
    function replaceMarkdown(file, source, expectedToken) {
      if (Buffer.byteLength(source, 'utf8') > MAX_MARKDOWN_BYTES) invalid('Paperdesk Markdown 文件过大，请拆分正文或批注；原文件未被覆盖。');
      if (expectedToken !== null && (typeof expectedToken !== 'string' || !HASH.test(expectedToken))) invalid('保存前必须提供读取到的 Markdown 版本标识。');
      const previous = markdown(file, true);
      if ((previous?.token ?? null) !== expectedToken) fileConflict('Obsidian 文件已被修改，请读取最新内容后合并；本次保存未覆盖原文件。');
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
      let fd, backup;
      try {
        checkedPath(canonical, temp, { missing: true });
        fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, source, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
        const nextToken = digest(Buffer.from(source, 'utf8'));
        if (previous) {
          backup = recoveryLink(file);
          if (digest(readFileSync(backup)) !== expectedToken || markdown(file).token !== expectedToken) fileConflict('Obsidian 正在编辑此文件，请重新读取后合并保存。');
          checkedPath(canonical, file);
          renameSync(temp, file);
          if (digest(readFileSync(backup)) !== expectedToken) {
            if (markdown(file).token === nextToken) {
              recoveryLink(file);
              const restore = `${temp}.restore`; linkSync(backup, restore); renameSync(restore, file);
            }
            const error = new VaultError('Obsidian 在保存期间修改了原文件，已保留恢复副本，请重新读取并合并。', 'VAULT_FILE_CONFLICT');
            error.recoveryPath = backup; throw error;
          }
        } else {
          // Exclusive creation avoids replacing a note created by another editor.
          try { linkSync(temp, file); } catch (error) {
            if (error.code === 'EEXIST') fileConflict('Obsidian 已创建同名文件，请先读取并核对内容；本次保存未覆盖它。');
            throw error;
          }
          unlinkSync(temp);
        }
        return nextToken;
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    function writeDocument({ document, annotations, annotationRequests = [], positionWriters = [] }, expectedToken) {
      return guard(() => {
        if (libraryEstablished) readLibrary();
        const id = uuid(document?.id), file = notePath(id);
        const normalized = { ...document, folder_id: document.folder_id ?? null };
        const state = validateState({ version: 1, document: normalized, annotations, annotationRequests, positionWriters }, id);
        verifyPdf(state.document);
        const previous = markdown(file, true);
        let properties = frontmatter(state.document);
        if (previous) properties = parseDocument(previous.source, id).properties;
        const notes = mergeNotes(normalized.notes_zh, normalized.notes_en);
        if (/<!-- paperdesk-(?:generated|state):/.test(notes)) invalid('笔记正文不能包含 Paperdesk 专用生成标记，请保留原文并移除重复标记后重试。');
        // There is only one editable note. State carries metadata, not a stale
        // second copy of its body that could override an Obsidian edit.
        const persisted = { ...state, document: { ...normalized, notes_zh: '', notes_en: '' } };
        replaceMarkdown(file, properties + notes + generatedMarkdown(persisted), expectedToken);
        return readDocument(id);
      });
    }
    function readAll() {
      return guard(() => {
        checkedPath(canonical, notesDir, { directory: true });
        const names = readdirSync(notesDir);
        for (const name of names) if (lstatSync(path.join(notesDir, name)).isSymbolicLink()) invalid('Paperdesk 笔记目录含有符号链接，请恢复知识库内的真实文件。');
        const records = names.filter(name => name.endsWith('.md')).sort().map(name => {
          const id = name.slice(0, -3); uuid(id);
          return readDocument(id);
        });
        unique(records.map(record => record.document), 'sha256', '文献 PDF');
        unique(records.flatMap(record => record.annotations), 'id', '跨文献批注');
        return records;
      });
    }
    function writeConflict(documentId, notes) {
      return guard(() => {
        uuid(documentId); text(notes, MAX_NOTE_LENGTH, '冲突笔记'); ensureDirectory(conflictDir);
        const file = path.join(conflictDir, `${documentId}-${Date.now()}-${randomUUID()}.md`);
        const source = `---\npaperdesk_source_id: ${scalar(documentId)}\npaperdesk_conflict: true\ncreated_at: ${scalar(new Date().toISOString())}\n---\n${notes}`;
        const token = replaceMarkdown(file, source, null);
        const saved = markdown(file);
        if (saved.token !== token || saved.source !== source) invalid('冲突笔记副本写入后未通过读回检查，请保留本机草稿并重试。');
        return file;
      });
    }
    function readLibrary() {
      return guard(() => {
        const saved = markdown(libraryPath, true);
        if (!saved) {
          if (libraryEstablished) invalid('已建立的 Obsidian 仓库缺少 Library.md，请恢复原文件后再刷新或保存；没有使用空分类和默认皮肤覆盖原记录。');
          return { state: { folders: [], theme: 'forest' }, token: null };
        }
        if ((saved.source.match(/<!-- paperdesk-library:/g) || []).length !== 1) invalid('Paperdesk 文献库标记缺失或重复。');
        const start = oneMarker(saved.source, LIBRARY_START, 'Paperdesk 文献库标记');
        const end = saved.source.indexOf(STATE_END, start + LIBRARY_START.length);
        if (end < 0 || saved.source.slice(end + STATE_END.length).trim()) invalid('文献库元数据结束标记已损坏。');
        let metadata; try { metadata = JSON.parse(saved.source.slice(start + LIBRARY_START.length, end)); }
        catch { invalid('文献库 Markdown 元数据已损坏，原文件未被覆盖。'); }
        object(metadata, ['version', 'state'], '文献库元数据');
        if (metadata.version !== 1) invalid('不支持此 Paperdesk 文献库格式版本。');
        const state = validateLibrary(metadata.state); libraryEstablished = true;
        return { state, token: saved.token };
      });
    }
    function writeLibrary(state, expectedToken) {
      return guard(() => {
        validateLibrary(state); readLibrary();
        const names = state.folders.map(folder => `- ${folder.name.replaceAll('<!--', '&lt;!--')} (${folder.id})`).join('\n');
        const source = `# Paperdesk 文献库\n\n此文件保存分类与阅读皮肤；由 Paperdesk 维护。\n\n当前皮肤：${state.theme}\n\n${names}\n\n${LIBRARY_START}${scalar({ version: 1, state })}${STATE_END}\n`;
        replaceMarkdown(libraryPath, source, expectedToken); return readLibrary();
      });
    }
    return { vaultDir: canonical, rootDir, pdfDir, notePath, pdfPath, readAll, readDocument,
      writeDocument, writeConflict, readLibrary, writeLibrary,
      rollbackDocument: (previousRecord, expectedToken) => writeDocument(previousRecord, expectedToken) };
  });
}
