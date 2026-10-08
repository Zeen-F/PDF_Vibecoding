import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class ReaderRenderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function readerPageQuery(query, pageCount) {
  if (Object.keys(query).some(key => !['page', 'width'].includes(key))) throw new ReaderRenderError(400, '不支持的页面预览参数。');
  function integer(value, label) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new ReaderRenderError(400, `${label}必须是正整数。`);
    }
    return Number(value);
  }
  const page = integer(query.page, '页码');
  const width = integer(query.width ?? '1200', '图片宽度');
  if (page > pageCount) throw new ReaderRenderError(400, `页码必须是 1 至 ${pageCount} 的整数。`);
  if (width < 600 || width > 1600) throw new ReaderRenderError(400, '图片宽度必须是 600 至 1600 的整数。');
  return { page, width };
}

export function readerPageText(text) {
  let end = Math.min(text.length, 12_000);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return { text: text.slice(0, end), textTruncated: end < text.length };
}

/** One disposable process per page isolates native canvas decoding too. Unlike
 * a Promise timeout, SIGKILL can stop a PDF stalled inside native image code. */
export function createReaderRenderer({ timeoutMs = 30_000, maxQueue = 4 } = {}) {
  const workerFile = fileURLToPath(new URL('./reader-render-worker.mjs', import.meta.url));
  const waiting = [];
  let active = null, closed = false, closing;
  const unavailable = () => new ReaderRenderError(503, '页面预览服务已关闭，请重新连接纸间。');

  function settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(result);
  }
  function advance() {
    if (closed || active || !waiting.length) return;
    const job = waiting.shift();
    active = job;
    let child;
    try {
      child = fork(workerFile, [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      });
    } catch {
      active = null;
      settle(job, new ReaderRenderError(503, '无法启动页面渲染进程，请检查本机运行环境。'));
      advance();
      return;
    }
    job.child = child;
    job.exited = new Promise(resolve => { job.onExit = resolve; });
    child.once('message', message => {
      if (message?.ok === true && typeof message.image === 'string'
        && Number.isInteger(message.width) && Number.isInteger(message.height)) {
        job.result = { width: message.width, height: message.height, mimeType: 'image/png', image: message.image };
      } else {
        const status = message?.status === 503 ? 503 : 422;
        job.error = new ReaderRenderError(status, status === 503
          ? '本机页面渲染组件不可用，请检查依赖安装后重试。'
          : '暂时无法渲染这一页，请检查原始 PDF 后重试。');
      }
    });
    child.once('error', () => {
      job.error = new ReaderRenderError(503, '页面渲染进程无法运行，请检查本机运行环境。');
      child.kill('SIGKILL');
    });
    child.once('close', () => {
      settle(job, job.error || (!job.result ? new ReaderRenderError(503, '页面渲染进程意外结束，请稍后重试。') : null), job.result);
      if (active === job) active = null;
      job.onExit();
      advance();
    });
    child.send(job.input, error => {
      if (!error || job.settled) return;
      job.error = new ReaderRenderError(503, '无法提交页面渲染请求，请稍后重试。');
      child.kill('SIGKILL');
    });
  }

  return {
    render(filePath, page, width) {
      if (closed) return Promise.reject(unavailable());
      if (active && waiting.length >= maxQueue) return Promise.reject(new ReaderRenderError(429, '页面预览请求较多，请稍后重试。'));
      return new Promise((resolve, reject) => {
        const source = typeof filePath === 'string' ? { filePath } : { data: filePath };
        const job = { input: { ...source, page, width }, resolve, reject, settled: false };
        // Queue time counts toward the deadline, so a backlog cannot wait forever.
        job.timer = setTimeout(() => {
          const error = new ReaderRenderError(504, '这一页渲染超过 30 秒，请稍后重试或在浏览器打开。');
          if (active === job) {
            job.error = error;
            settle(job, error);
            job.child?.kill('SIGKILL');
          } else {
            const index = waiting.indexOf(job);
            if (index !== -1) waiting.splice(index, 1);
            settle(job, error);
          }
        }, timeoutMs);
        waiting.push(job);
        advance();
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const job of waiting.splice(0)) settle(job, unavailable());
      if (active) {
        settle(active, unavailable());
        closing = active.exited;
        active.child.kill('SIGKILL');
      } else closing = Promise.resolve();
      return closing;
    },
  };
}
