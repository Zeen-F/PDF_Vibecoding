import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createManagedBrowser } from './chatgpt-browser.mjs';
import { runBridge } from './chatgpt-ego.mjs';

const implementation = pathToFileURL(fileURLToPath(new URL('./chatgpt-ego.mjs', import.meta.url))).href;
const prefix = 'PAPERDESK_CHATGPT_EVENT ';
const uuid = /^[a-f0-9-]{36}$/i;

export function createChatgptRunner(options) {
  const engine = options.engine || (options.command ? 'ego' : process.env.PAPERDESK_CHATGPT_ENGINE || 'managed-browser');
  if (engine === 'ego') return createEgoChatgptRunner(options);
  if (engine !== 'managed-browser') throw new Error('Unknown ChatGPT connection engine');
  return createManagedChatgptRunner(options);
}

export function createManagedChatgptRunner({ stateDir, profileDir = process.env.PAPERDESK_CHATGPT_PROFILE_DIR || path.join(homedir(), '.config', 'paperdesk', 'chatgpt-browser'), browserFactory = createManagedBrowser } = {}) {
  const browser = browserFactory({ profileDir });
  let closed = false, active = false;
  const activeDirectories = new Set();
  return {
    connectionStatus: () => browser.status(),
    openConnection: () => browser.open(),
    closeConnection() { if (active) throw new Error('Question active'); return browser.disconnect(); },
    async run(job, emit, { resume = false } = {}) {
      if (closed) return { state: 'failed', dispatchInvoked: false, message: '纸间服务已停止，问题未发送。' };
      if (active || !uuid.test(job.id)) throw new Error('Invalid or concurrent browser question');
      active = true;
      const jobDir = path.join(stateDir, job.id), inputPath = path.join(jobDir, 'input.json');
      let dispatchInvoked = Boolean(job.dispatchInvoked);
      const durableDispatch = async () => { try { dispatchInvoked ||= Boolean(JSON.parse(await readFile(path.join(jobDir, 'ledger.json'), 'utf8')).dispatchInvoked); } catch {} };
      try {
        await mkdir(jobDir, { recursive: true, mode: 0o700 });
        activeDirectories.add(jobDir);
        const values = [job.documentId, job.page, job.question, job.selection];
        if (job.followupContext) values.push(job.followupContext);
        const payloadHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
        await writeFile(inputPath, JSON.stringify({ job, payloadHash, resume, jobDir }), { mode: 0o600 });
        if (closed) return { state: 'failed', dispatchInvoked, message: '纸间服务已停止，未启动新的连接。' };
        const api = Object.create(browser);
        api.emit = async patch => { dispatchInvoked ||= patch.dispatchInvoked === true; await emit(patch); };
        const result = await runBridge(api, inputPath);
        await durableDispatch();
        if (result?.state === 'failed' && !dispatchInvoked) await browser.discardUnsent?.('paperdesk-question-' + job.id);
        if (!result) return { state: dispatchInvoked ? 'uncertain' : 'failed', dispatchInvoked, message: '连接结果未能确认，不会自动重新发送。' };
        if (result.state === 'failed' && dispatchInvoked) return { state: 'uncertain', dispatchInvoked: true, canResume: false, message: '问题已到达发送边界，不会自动重新发送。' };
        return { ...result, dispatchInvoked };
      } catch {
        await durableDispatch();
        if (!dispatchInvoked) await Promise.resolve(browser.discardUnsent?.('paperdesk-question-' + job.id)).catch(() => {});
        return { state: dispatchInvoked ? 'uncertain' : 'failed', dispatchInvoked, canResume: false, message: '纸间 ChatGPT 连接未完成。请检查连接窗口；不会自动改用其他渠道或重发。' };
      } finally { active = false; activeDirectories.delete(jobDir); }
    },
    async close() { closed = true; for (const directory of activeDirectories) { try { writeFileSync(path.join(directory, 'close-requested'), '', { mode: 0o600 }); } catch {} } await browser.close(); },
    async forget(id) {
      if (!uuid.test(id)) return;
      const directory = path.join(stateDir, id);
      for (const name of ['input.json', 'selection.png', 'transport.png']) await unlink(path.join(directory, name)).catch(() => {});
      try { const file = path.join(directory, 'ledger.json'), ledger = JSON.parse(await readFile(file, 'utf8')); if (Object.hasOwn(ledger, 'response')) { delete ledger.response; await writeFile(file, JSON.stringify(ledger), { mode: 0o600 }); } } catch {}
    },
  };
}

export function createEgoChatgptRunner({ stateDir, command = process.env.PAPERDESK_EGO_COMMAND }) {
  command ||= existsSync(path.join(homedir(),'.local/bin/ego-browser'))?path.join(homedir(),'.local/bin/ego-browser'):'ego-browser';
  let closed = false;
  const activeDirectories=new Set();
  return {
    async run(job, emit, { resume = false } = {}) {
      if (closed) return { state: 'failed', message: '纸间服务已停止，问题未发送。' };
      if (!uuid.test(job.id)) throw new Error('Invalid job identity');
      const jobDir = path.join(stateDir, job.id);
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      if(closed)return {state:'failed',dispatchInvoked:false,message:'纸间服务已停止，问题未发送。'};
      activeDirectories.add(jobDir);
      const inputPath = path.join(jobDir, 'input.json');
      const values = [job.documentId, job.page, job.question, job.selection];
      if (job.followupContext) values.push(job.followupContext);
      const payloadHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
      await writeFile(inputPath, JSON.stringify({ job, payloadHash, resume, jobDir }), { mode: 0o600 });
      if(closed){activeDirectories.delete(jobDir);return {state:'failed',dispatchInvoked:Boolean(job.dispatchInvoked),message:'纸间服务已停止，未启动新的连接。'};}
      const source = `const {runBridge}=await import(${JSON.stringify(implementation)});await runBridge({taskSpace,listTaskSpaces,takeOverTaskSpace},${JSON.stringify(inputPath)});`;
      let final, dispatchInvoked = Boolean(job.dispatchInvoked), eventQueue = Promise.resolve(), queueFailure = false, bytes = 0, lastSequence=0;
      const durableDispatch = async () => {
        try { dispatchInvoked ||= Boolean(JSON.parse(await readFile(path.join(jobDir,'ledger.json'),'utf8')).dispatchInvoked); } catch {}
        return dispatchInvoked;
      };
      return await new Promise(resolve => {
        const child = spawn(command, ['nodejs', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        const accept = line => {
          if (!line.startsWith(prefix)) return;
          let event;
          try { event = JSON.parse(line.slice(prefix.length)); } catch { return; }
          if (!event || typeof event.state !== 'string') return;
          if(Number.isInteger(event.sequence)){if(event.sequence<=lastSequence)return;lastSequence=event.sequence;}
          if (event.dispatchInvoked) dispatchInvoked = true;
          eventQueue = eventQueue.then(async()=>{if(!queueFailure)await emit(event);}).catch(()=>{queueFailure=true;});
          if (['completed', 'failed', 'uncertain', 'needs_user'].includes(event.state)) final = event;
        };
        const consume = stream => {
          let lineBuffer='';const decoder=new StringDecoder('utf8');
          stream.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) return;
          lineBuffer += decoder.write(chunk);
          let end;
          while ((end = lineBuffer.indexOf('\n')) >= 0) { accept(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1); }
          });
          stream.on('end',()=>{lineBuffer+=decoder.end();if(lineBuffer)accept(lineBuffer);});
        };
        consume(child.stdout);consume(child.stderr);
        // The EGO CLI may buffer console output until the script completes.
        // Read only its own durable, content-free progress checkpoint meanwhile.
        let observing=false;
        const progress=setInterval(async()=>{
          if(observing)return;observing=true;
          try{const ledger=JSON.parse(await readFile(path.join(jobDir,'ledger.json'),'utf8'));
            if(ledger.payloadHash===payloadHash&&ledger.stage&&ledger.stage.state!=='completed')accept(prefix+JSON.stringify({...ledger.stage,sequence:ledger.eventSequence}));
          }catch{}finally{observing=false;}
        },1000);
        progress.unref();
        // Browser errors may contain account content or local paths. Only the
        // controlled events above are exposed through the application's API.
        child.on('error', async error => {
          clearInterval(progress);activeDirectories.delete(jobDir);
          await eventQueue.catch(() => {});
          await durableDispatch();
          resolve({ state: dispatchInvoked ? 'uncertain' : 'failed', dispatchInvoked,
            message: error.code === 'ENOENT' ? '未找到 EGO 浏览器。请先安装并启动 EGO Lite，再连接 ChatGPT。' : '无法启动 ChatGPT 连接程序；未自动重新发送。' });
        });
        child.on('close', async () => {
          clearInterval(progress);activeDirectories.delete(jobDir);
          try {
            await eventQueue;
            await durableDispatch();
            if(queueFailure){resolve({state:'uncertain',dispatchInvoked,message:'任务状态未能安全保存，已停止自动重新发送。'});return;}
            if (!final) {
              final = { state: dispatchInvoked ? 'uncertain' : 'failed', dispatchInvoked,
                message: dispatchInvoked ? '问题可能已发送，连接意外结束。为避免重复提问，已停止重发，请查看原 ChatGPT 对话。' : '连接意外结束，未确认发送问题。' };
            }
            final.dispatchInvoked = dispatchInvoked;
            if(final.state==='failed'&&dispatchInvoked)final={state:'uncertain',dispatchInvoked:true,message:'问题已到达发送边界，任务结果尚未确认；不会自动重发。'};
            resolve(final);
          } catch {
            await durableDispatch();
            resolve({ state: 'uncertain', dispatchInvoked, message: '任务状态无法确认，已停止自动重新发送。' });
          }
        });
      });
    },
    close() { closed = true;for(const directory of activeDirectories){try{writeFileSync(path.join(directory,'close-requested'),'',{mode:0o600});}catch{}} },
    async forget(id) {
      if (!uuid.test(id)) return;
      const directory = path.join(stateDir, id);
      for (const name of ['input.json', 'selection.png', 'transport.png']) await unlink(path.join(directory, name)).catch(() => {});
      try{const file=path.join(directory,'ledger.json'),ledger=JSON.parse(await readFile(file,'utf8'));if(Object.hasOwn(ledger,'response')){delete ledger.response;await writeFile(file,JSON.stringify(ledger),{mode:0o600});}}catch{}
      // Keep the non-content attempt ledger. It is never used to resend.
    },
  };
}
