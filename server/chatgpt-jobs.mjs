import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import path from 'node:path';
import { validPng } from './plugin-api.mjs';
import { createChatgptRunner } from './chatgpt-runner.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['queued', 'connecting', 'uploading', 'sending', 'waiting', 'needs_user', 'completed', 'failed', 'uncertain']);
const TERMINAL = new Set(['completed', 'failed', 'uncertain']);
const MAX_JOBS = 8;
const MAX_PREVIEW = 2 * 1024 * 1024;
const PUBLIC_FIELDS = ['id', 'requestId', 'parentJobId', 'documentId', 'title', 'page', 'state', 'message', 'canResume', 'dispatchInvoked', 'response', 'chatUrl', 'modelLabel', 'depthLabel', 'createdAt', 'updatedAt', 'startedAt', 'completedAt'];
const WAITING_MESSAGE = '上次执行未能确认完成。请先在 ChatGPT 核对，任务不会自动重发。';

function digest(payload) {
  const input = [payload.documentId, payload.page, payload.question, payload.selection];
  if (payload.parentJobId) input.push(payload.parentJobId);
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function conversationUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash
      || !/^\/c\/[A-Za-z0-9-]{8,128}$/.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function registerChatgptJobs({ app, dataDir, chatgptRunner, documentOr404, HttpError, objectBody, stringValue, pageValue }) {
  const stateDir = path.join(dataDir, 'chatgpt-jobs');
  const journalPath = path.join(stateDir, 'journal.json');
  let jobs = new Map(), receipts = new Map(), queue = [], runner = chatgptRunner, active = null, closed = false, storageError = false;

  const uuid = (value, label) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label}必须是有效的 UUID。`);
    return value.toLowerCase();
  };
  function selectionValue(value) {
    const selected = objectBody(value, ['kind', 'text', 'preview']);
    if (!['text', 'region'].includes(selected.kind)) throw new HttpError(400, '选区类型必须是 text 或 region。');
    const text = stringValue(selected.text, '选区文字', 50_000, { nonempty: selected.kind === 'text' });
    if (selected.kind === 'text') {
      if (Object.hasOwn(selected, 'preview')) throw new HttpError(400, '文字选区不能附带图片。');
      return { kind: 'text', text };
    }
    if (text !== '') throw new HttpError(400, '区域选区不能包含虚构引文。');
    const prefix = 'data:image/png;base64,';
    if (typeof selected.preview !== 'string' || selected.preview.length > MAX_PREVIEW || !selected.preview.startsWith(prefix)) {
      throw new HttpError(400, '区域选区需要最多 2 MiB 的 PNG 预览。');
    }
    const encoded = selected.preview.slice(prefix.length);
    if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new HttpError(400, '区域选区图片无效。');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || !validPng(bytes)) throw new HttpError(400, '区域选区必须是有效的 PNG 图片。');
    return { kind: 'region', text: '', preview: selected.preview };
  }
  function publicJob(job) {
    return Object.fromEntries(PUBLIC_FIELDS.filter(key => job[key] !== undefined && (key !== 'response' || job.state === 'completed')).map(key => [key, key === 'canResume' ? job.canResume && active?.id !== job.id : job[key]]));
  }
  function available() {
    if (closed) throw new HttpError(503, '本机任务服务正在关闭。');
    if (storageError) throw new HttpError(503, '本机任务记录无法安全读取或保存，请检查数据目录后重启服务；不会自动重发。');
  }
  // Every state acknowledged to the runner has reached an atomically replaced,
  // fsynced journal. A crash must never turn an uncertain dispatch into a retry.
  function persist(nextJobs = jobs, nextReceipts = receipts) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(stateDir).isDirectory() || lstatSync(stateDir).isSymbolicLink()) throw new Error('Unsafe task directory');
    chmodSync(stateDir, 0o700);
    const temporary = path.join(stateDir, `.journal-${randomUUID()}.tmp`);
    let file;
    try {
      file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(file, JSON.stringify({ version: 1, jobs: [...nextJobs.values()], receipts: [...nextReceipts.values()] }));
      fsyncSync(file); closeSync(file); file = undefined;
      renameSync(temporary, journalPath);
      const directory = openSync(stateDir, constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (file !== undefined) closeSync(file);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function commit(nextJobs, nextReceipts = receipts) {
    try { persist(nextJobs, nextReceipts); }
    catch { storageError = true; throw new HttpError(503, '本机任务记录未能安全保存，已停止执行；不会自动重发。'); }
    jobs = nextJobs; receipts = nextReceipts;
  }
  function replace(job) {
    const next = new Map(jobs); next.set(job.id, job); commit(next); return job;
  }
  function uncertain(job, message = WAITING_MESSAGE) {
    return { ...job, state: 'uncertain', message, canResume: false, updatedAt: new Date().toISOString() };
  }
  function forgetPayload(id) {
    try {
      runner ??= createChatgptRunner({ stateDir });
      void Promise.resolve(runner.forget?.(id)).catch(() => {});
    } catch { /* Receipt stays durable even when private material cleanup fails. */ }
  }
  // Do not create a task directory for libraries that have never used the bridge.
  if (existsSync(journalPath)) {
    try {
      if (!lstatSync(stateDir).isDirectory() || lstatSync(stateDir).isSymbolicLink() || !lstatSync(journalPath).isFile() || lstatSync(journalPath).isSymbolicLink()) throw new Error('Unsafe task journal');
      const saved = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > MAX_JOBS || !Array.isArray(saved.receipts)) throw new Error('Invalid journal');
      for (const receipt of saved.receipts) {
        if (uuid(receipt.requestId, '请求 ID') !== receipt.requestId || !/^[a-f0-9]{64}$/.test(receipt.digest) || !['completed', 'failed'].includes(receipt.state)
          || typeof receipt.dispatchInvoked !== 'boolean' || receipts.has(receipt.requestId)) throw new Error('Invalid receipt');
        receipts.set(receipt.requestId, { requestId: receipt.requestId, digest: receipt.digest, state: receipt.state, dispatchInvoked: receipt.dispatchInvoked });
      }
      for (const item of saved.jobs) {
        if (uuid(item.id, '任务 ID') !== item.id || item.id !== item.requestId || jobs.has(item.id) || receipts.has(item.id)
          || !STATES.has(item.state) || typeof item.title !== 'string' || typeof item.createdAt !== 'string' || typeof item.dispatchInvoked !== 'boolean') throw new Error('Invalid job');
        const job = { ...item, documentId: uuid(item.documentId, '文献 ID'), page: pageValue(item.page, 2000), question: stringValue(item.question, '问题', 4000, { nonempty: true }), selection: selectionValue(item.selection) };
        if (job.parentJobId !== undefined) {
          job.parentJobId = uuid(job.parentJobId, '上一任务 ID');
          if (!Array.isArray(job.followupContext) || !job.followupContext.length || job.followupContext.length > 6 || JSON.stringify(job.followupContext).length > 100_000) throw new Error('Invalid discussion context');
          job.followupContext = job.followupContext.map(turn => {
            const fields = objectBody(turn, ['question', 'response']);
            return { question: stringValue(fields.question, '先前问题', 4000, { nonempty: true }), response: stringValue(fields.response, '先前回答', 100_000, { nonempty: true }) };
          });
        } else if (job.followupContext !== undefined) throw new Error('Unexpected discussion context');
        if (job.digest !== digest(job)) throw new Error('Invalid job digest');
        jobs.set(job.id, TERMINAL.has(job.state) ? job : uncertain(job));
      }
      persist();
      for (const id of receipts.keys()) forgetPayload(id);
    } catch { jobs.clear(); receipts.clear(); storageError = true; }
  }

  function applyPatch(id, patch) {
    const job = jobs.get(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid runner update');
    let state = patch.state ?? job.state;
    if (!STATES.has(state) || state === 'queued') throw new Error('Invalid runner state');
    const dispatchInvoked = job.dispatchInvoked || patch.dispatchInvoked === true;
    if (state === 'failed' && dispatchInvoked) state = 'uncertain';
    if (TERMINAL.has(job.state) && state !== job.state) throw new Error('Terminal task cannot restart');
    const next = { ...job, state, updatedAt: new Date().toISOString(), canResume: state === 'needs_user' && (patch.canResume ?? job.canResume) === true, dispatchInvoked };
    for (const [key, limit] of [['message', 2000], ['response', 500_000], ['modelLabel', 100], ['depthLabel', 100]]) {
      if (!Object.hasOwn(patch, key)) continue;
      if (typeof patch[key] !== 'string' || patch[key].length > limit || patch[key].includes('\0')) throw new Error('Invalid runner text');
      next[key] = key === 'message' ? patch[key].replaceAll(stateDir, '[本机任务记录]') : patch[key];
    }
    if (Object.hasOwn(patch, 'chatUrl')) {
      const url = conversationUrl(patch.chatUrl);
      if (url) next.chatUrl = url;
      else delete next.chatUrl;
    }
    if (state === 'completed') {
      if (!next.response?.trim()) throw new Error('Completed task has no answer');
      next.completedAt ??= new Date().toISOString();
    }
    return replace(next);
  }
  function pump() {
    if (closed || storageError || active || !queue.length) return;
    if ([...jobs.values()].some(job => job.state === 'needs_user' || job.state === 'uncertain')) return;
    const entry = queue.shift(), job = jobs.get(entry.id);
    if (job?.state !== 'queued') { pump(); return; }
    const token = { id: job.id }; active = token;
    void (async () => {
      try {
        const started = replace({ ...job, state: 'connecting', startedAt: job.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), canResume: false });
        runner ??= createChatgptRunner({ stateDir });
        const emit = async patch => {
          if (closed || storageError || active !== token) throw new Error('Task service stopped');
          applyPatch(job.id, patch);
        };
        const patch = await runner.run(structuredClone(started), emit, { resume: entry.resume });
        if (closed || storageError || active !== token) return;
        if (patch !== undefined) applyPatch(job.id, patch);
        const result = jobs.get(job.id);
        if (!TERMINAL.has(result.state) && result.state !== 'needs_user') replace(uncertain(result));
      } catch {
        if (closed || storageError || active !== token) return;
        const latest = jobs.get(job.id);
        if (TERMINAL.has(latest.state)) return;
        const unsafe = latest.dispatchInvoked || ['sending', 'waiting'].includes(latest.state);
        try { replace(unsafe ? uncertain(latest) : { ...latest, state: 'failed', canResume: false, message: '执行未完成，尚未确认发送。请检查本机连接后重新准备任务。', updatedAt: new Date().toISOString() }); }
        catch { /* commit already disabled further execution */ }
      } finally {
        if (active === token) active = null;
        pump();
      }
    })();
  }
  function enqueue(id, resume) {
    if (resume) queue.unshift({ id, resume });
    else queue.push({ id, resume });
    // Return the durable acknowledgement before starting external work.
    setImmediate(pump);
  }
  function existing(id) {
    available();
    if (receipts.has(id)) throw new HttpError(410, '这个任务已处理，完整结果已过期；不会再次发送。');
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, '没有找到这个 ChatGPT 任务。');
    return job;
  }

  const getRunner = () => runner ??= createChatgptRunner({ stateDir });
  const connectionResult = async action => {
    available();
    const current = getRunner();
    if (typeof current[action] !== 'function') return { engine: 'managed-browser', state: 'closed', message: '当前测试连接器未启动浏览器。' };
    try { return await current[action](); }
    catch (error) {
      const message = error.message === 'BROWSER_PROFILE_BUSY' ? '另一个纸间连接器正在使用登录配置，请先结束该连接后重试。'
        : '无法打开纸间 ChatGPT 连接窗口，请检查浏览器运行环境；不会自动改用其他回答渠道。';
      throw new HttpError(503, message);
    }
  };
  app.get('/api/chatgpt/connection', async (_req, res) => res.json({ connection: await connectionResult('connectionStatus') }));
  app.post('/api/chatgpt/connection/open', async (req, res) => {
    objectBody(req.body, []);
    res.json({ connection: await connectionResult('openConnection') });
  });
  app.post('/api/chatgpt/connection/close', async (req, res) => {
    available(); objectBody(req.body, []);
    if (active || queue.length) throw new HttpError(409, '有问题正在执行或排队，请待任务结束后关闭连接窗口。');
    const connection = await connectionResult('closeConnection');
    for (const job of jobs.values()) if (job.state === 'needs_user' && !job.dispatchInvoked) applyPatch(job.id, { state: 'failed', canResume: false, message: '连接窗口已关闭，问题尚未发送。可以重新选择内容准备提问。' });
    res.json({ connection });
  });

  app.post('/api/chatgpt/jobs', (req, res) => {
    available();
    const body = objectBody(req.body, ['requestId', 'documentId', 'page', 'question', 'selection', 'parentJobId']);
    const requestId = uuid(body.requestId, '请求 ID'), documentId = uuid(body.documentId, '文献 ID');
    const question = stringValue(body.question, '问题', 4000, { nonempty: true });
    const selection = selectionValue(body.selection);
    const page = pageValue(body.page, 2000);
    const parentJobId = Object.hasOwn(body, 'parentJobId') ? uuid(body.parentJobId, '上一任务 ID') : undefined;
    const fingerprint = digest({ documentId, page, question, selection, parentJobId });
    const previous = jobs.get(requestId) || receipts.get(requestId);
    if (previous) {
      if (previous.digest !== fingerprint) throw new HttpError(409, '这个请求 ID 已用于不同的问题或选区，请不要重复使用。');
      if (receipts.has(requestId)) throw new HttpError(410, '这个任务已处理，完整结果已过期；不会再次发送。');
      return res.status(202).json({ job: publicJob(previous) });
    }
    if ([...jobs.values()].some(job => job.state === 'uncertain')) throw new HttpError(429, '有任务的发送结果尚未确认，请先在原 ChatGPT 对话核对；不会启动新的自动任务。');
    const doc = documentOr404(documentId); pageValue(page, doc.page_count);
    let followupContext;
    if (parentJobId) {
      const parent = existing(parentJobId);
      if (parent.state !== 'completed' || !parent.response?.trim()) throw new HttpError(409, '只能继续提问已经完成且回答仍保留的任务。');
      if (parent.documentId !== documentId || parent.page !== page || JSON.stringify(parent.selection) !== JSON.stringify(selection)) throw new HttpError(409, '继续提问必须使用上一任务的原文献、页码和选区。');
      followupContext = [...(parent.followupContext || []), { question: parent.question, response: parent.response }];
      if (followupContext.length > 6 || JSON.stringify(followupContext).length > 100_000) throw new HttpError(400, '这组讨论已过长，请选择关键内容开始新的提问。');
    }
    const next = new Map(jobs), nextReceipts = new Map(receipts);
    let evictedId;
    if (next.size >= MAX_JOBS) {
      const evictable = [...next.values()].filter(job => job.id !== active?.id && (job.state === 'completed' || job.state === 'failed' && !job.dispatchInvoked))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
      if (!evictable) throw new HttpError(429, '已有 8 个待处理或结果未确认的任务，请先核对这些任务。');
      next.delete(evictable.id);
      evictedId = evictable.id;
      nextReceipts.set(evictable.id, { requestId: evictable.requestId, digest: evictable.digest, state: evictable.state, dispatchInvoked: evictable.state === 'completed' || evictable.dispatchInvoked });
    }
    const now = new Date().toISOString();
    const job = { id: requestId, requestId, documentId, title: doc.title, page, question, selection, digest: fingerprint, state: 'queued', message: '任务已在本机排队。', canResume: false, dispatchInvoked: false, createdAt: now, updatedAt: now };
    if (parentJobId) Object.assign(job, { parentJobId, selection: structuredClone(jobs.get(parentJobId).selection), followupContext });
    next.set(job.id, job); commit(next, nextReceipts);
    if (evictedId) forgetPayload(evictedId);
    enqueue(job.id, false);
    res.status(202).json({ job: publicJob(job) });
  });
  app.get('/api/chatgpt/jobs/:id', (req, res) => res.json({ job: publicJob(existing(uuid(req.params.id, '任务 ID'))) }));
  app.post('/api/chatgpt/jobs/:id/resume', (req, res) => {
    available(); objectBody(req.body, []);
    const job = existing(uuid(req.params.id, '任务 ID'));
    if (job.state !== 'needs_user' || !job.canResume || active?.id === job.id) throw new HttpError(409, '只有等待你处理、且允许继续的任务才能恢复；结果未确认的任务不会重发。');
    const next = replace({ ...job, state: 'queued', canResume: false, message: '已收到继续请求，正在等待执行。', updatedAt: new Date().toISOString() });
    enqueue(job.id, true); res.status(202).json({ job: publicJob(next) });
  });
  return {
    close() {
      if (closed) return;
      closed = true; queue = [];
      if (!storageError && jobs.size) {
        const next = new Map([...jobs].map(([id, job]) => [id, TERMINAL.has(job.state) ? job : uncertain(job, '本机服务已停止，任务结果尚未确认；不会自动重发。')]));
        try { commit(next); } catch { /* the last durable state is recovered as uncertain */ }
      }
      try { return Promise.resolve(runner?.close?.()).catch(() => {}); } catch { return; }
    },
  };
}
