import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatgptRunner } from '../server/chatgpt-runner.mjs';

// This executable only writes controlled fixture output. It does not evaluate
// the EGO source argument, import the browser bridge, or open a browser.
async function fixture(t, childSource) {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-runner-'));
  const stateDir = path.join(directory, 'state');
  const job = {
    id: randomUUID(), requestId: randomUUID(), documentId: randomUUID(), title: '原创执行器测试', page: 3,
    question: '解释 α 与 β。', selection: { kind: 'text', text: '  保留引文\nUnicode 🧪  ' }, state: 'queued', dispatchInvoked: false,
  };
  job.requestId = job.id;
  const jobDir = path.join(stateDir, job.id), inputPath = path.join(jobDir, 'input.json');
  const command = path.join(directory, 'mock-ego.mjs');
  const source = `#!${process.execPath}
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
const inputPath=${JSON.stringify(inputPath)};
const input=JSON.parse(await readFile(inputPath,'utf8'));
const jobDir=input.jobDir;
assert.equal(process.argv[2],'nodejs');
assert.equal(process.argv[3],'-e');
assert.ok(process.argv[4].includes(JSON.stringify(inputPath)));
await writeFile(${JSON.stringify(path.join(directory, 'invoked'))},'yes');
const write=(stream,bytes)=>new Promise(resolve=>stream.write(bytes,resolve));
const event=(patch,stream=process.stderr,newline='\\n')=>write(stream,'PAPERDESK_CHATGPT_EVENT '+JSON.stringify(patch)+newline);
const ledger=patch=>writeFile(path.join(jobDir,'ledger.json'),JSON.stringify(patch),{mode:0o600});
async function splitUtf8(stream,patch,needle,newline='\\n') {
  const bytes=Buffer.from('PAPERDESK_CHATGPT_EVENT '+JSON.stringify(patch)+newline);
  const index=bytes.indexOf(Buffer.from(needle));
  assert.ok(index>=0);
  await write(stream,bytes.subarray(0,index+1)); await delay(25);
  await write(stream,bytes.subarray(index+1,index+2)); await delay(25);
  await write(stream,bytes.subarray(index+2));
}
${childSource}
`;
  await writeFile(command, source, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, stateDir, job, jobDir, inputPath, command, runner: createChatgptRunner({ stateDir, command }) };
}

test('real child transport accepts prefixed stdout/stderr only and awaits ordered durable events before returning', { timeout: 8000 }, async t => {
  const fixtureData = await fixture(t, String.raw`
await write(process.stdout,'generic stdout /private/path account@example.invalid\n');
await write(process.stderr,'generic stderr PRIVATE_ACCOUNT_TOKEN\nnot-a-prefix PAPERDESK_CHATGPT_EVENT {"state":"completed"}\nPAPERDESK_CHATGPT_EVENT invalid JSON\n');
await event({state:'connecting',message:'连接已就绪'},process.stdout);
await delay(35);
await event({state:'uploading',message:'只处理选区'},process.stderr);
await event({state:'waiting',dispatchInvoked:true},process.stderr);
await event({state:'completed',dispatchInvoked:true,response:'只返回经过核实的回答',chatUrl:'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'},process.stderr);
`);
  const events = [], completionOrder = []; let active = 0, maximum = 0;
  const result = await fixtureData.runner.run(fixtureData.job, async patch => {
    active++; maximum = Math.max(maximum, active); events.push(patch);
    await new Promise(resolve => setTimeout(resolve, 12));
    completionOrder.push(patch.state); active--;
  });
  assert.deepEqual(events.map(event => event.state), ['connecting', 'uploading', 'waiting', 'completed']);
  assert.deepEqual(completionOrder, ['connecting', 'uploading', 'waiting', 'completed']);
  assert.equal(maximum, 1); assert.equal(active, 0);
  assert.equal(result.state, 'completed'); assert.equal(result.response, '只返回经过核实的回答');
  assert.ok(!JSON.stringify({ events, result }).includes('PRIVATE_ACCOUNT_TOKEN'));
  assert.ok(!JSON.stringify({ events, result }).includes('account@example.invalid'));
  const stored = JSON.parse(await readFile(fixtureData.inputPath, 'utf8'));
  assert.deepEqual(stored.job.selection, fixtureData.job.selection);
  assert.equal(stored.payloadHash, createHash('sha256').update(JSON.stringify([fixtureData.job.documentId, fixtureData.job.page, fixtureData.job.question, fixtureData.job.selection])).digest('hex'));
  assert.equal(stored.resume, false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(fixtureData.jobDir)).mode & 0o777, 0o700);
    assert.equal((await stat(fixtureData.inputPath)).mode & 0o777, 0o600);
  }
});

test('UTF-8 split across child stream chunks preserves exact Chinese and astral characters, including final lines without LF', { timeout: 8000 }, async t => {
  const { runner, job } = await fixture(t, String.raw`
await splitUtf8(process.stdout,{state:'connecting',message:'汉字分块不能损坏'},'汉');
await delay(35);
await splitUtf8(process.stderr,{state:'completed',dispatchInvoked:true,response:'区域回答 🧪 保留 α、β 与换行\n下一行'},'🧪','');
`);
  const events = [];
  const result = await runner.run(job, async event => { events.push(event); });
  assert.equal(events[0].message, '汉字分块不能损坏');
  assert.equal(result.response, '区域回答 🧪 保留 α、β 与换行\n下一行');
  assert.equal(events.at(-1).response, result.response);
  assert.ok(!JSON.stringify(events).includes('\ufffd'));
});

test('unexpected child exit reads the durable dispatch ledger even when no sending event arrived', { timeout: 8000 }, async t => {
  const { runner, job, stateDir } = await fixture(t, String.raw`
await ledger({dispatchInvoked:true,sentAt:12345,payloadHash:input.payloadHash});
await write(process.stderr,'private browser account and local path '+jobDir+'\n');
process.exitCode=23;
`);
  const events = [];
  const result = await runner.run(job, async event => { events.push(event); });
  assert.equal(events.length, 0); assert.equal(result.state, 'uncertain'); assert.equal(result.dispatchInvoked, true);
  assert.ok(!JSON.stringify(result).includes(stateDir)); assert.ok(!JSON.stringify(result).includes('private browser account'));
});

test('a terminal child failure cannot downgrade an already durable dispatch boundary', { timeout: 8000 }, async t => {
  const { runner, job } = await fixture(t, String.raw`
await ledger({dispatchInvoked:true,sentAt:12345,payloadHash:input.payloadHash});
await event({state:'failed',dispatchInvoked:false,message:'controlled failure'},process.stderr);
`);
  const result = await runner.run(job, async () => {});
  assert.equal(result.state, 'uncertain'); assert.equal(result.dispatchInvoked, true);
  assert.notEqual(result.canResume, true);
});

test('a child that exits before dispatch fails without leaking stderr and cannot fabricate a result', { timeout: 8000 }, async t => {
  const { runner, job } = await fixture(t, String.raw`
await ledger({dispatchInvoked:false});
await write(process.stderr,'Browser stack /private/account/secret.json TOKEN_VALUE\n');
process.exitCode=9;
`);
  const result = await runner.run(job, async () => {});
  assert.equal(result.state, 'failed'); assert.equal(result.dispatchInvoked, false);
  assert.ok(!JSON.stringify(result).includes('secret.json')); assert.ok(!JSON.stringify(result).includes('TOKEN_VALUE'));
});

test('missing executables fail safely for a fresh job but respect a previous durable dispatch boundary', { timeout: 8000 }, async t => {
  const data = await fixture(t, 'throw new Error("mock executable must not run");');
  const missing = path.join(data.directory, 'missing-command');
  const runner = createChatgptRunner({ stateDir: data.stateDir, command: missing });
  const fresh = await runner.run(data.job, async () => {});
  assert.equal(fresh.state, 'failed'); assert.equal(fresh.dispatchInvoked, false);
  assert.match(fresh.message, /EGO/); assert.ok(!fresh.message.includes(missing));
  await writeFile(path.join(data.jobDir, 'ledger.json'), JSON.stringify({ dispatchInvoked: true, payloadHash: 'durable' }), { mode: 0o600 });
  const resumed = await runner.run(data.job, async () => {}, { resume: true });
  assert.equal(resumed.state, 'uncertain'); assert.equal(resumed.dispatchInvoked, true);
  assert.ok(!resumed.message.includes('问题未发送'));
});

test('a rejected persistence callback is contained and an on-disk dispatch remains uncertain', { timeout: 8000 }, async t => {
  const { runner, job } = await fixture(t, String.raw`
await ledger({dispatchInvoked:true});
await event({state:'connecting',message:'controlled progress'},process.stderr);
await delay(80);
process.exitCode=7;
`);
  const result = await runner.run(job, async () => { throw new Error('DISK_PRIVATE_SECRET'); });
  assert.equal(result.state, 'uncertain'); assert.equal(result.dispatchInvoked, true);
  assert.ok(!JSON.stringify(result).includes('DISK_PRIVATE_SECRET'));
});

test('close prevents any new child invocation and resume reaches the existing input identity', { timeout: 8000 }, async t => {
  const data = await fixture(t, String.raw`
assert.equal(input.resume,true);
await event({state:'needs_user',canResume:true,message:'需要本人登录'},process.stderr);
`);
  const result = await data.runner.run(data.job, async () => {}, { resume: true });
  assert.equal(result.state, 'needs_user'); assert.equal(result.canResume, true);
  await rm(path.join(data.directory, 'invoked'));
  data.runner.close();
  const closed = await data.runner.run({ ...data.job, id: randomUUID() }, async () => { assert.fail('Closed runner cannot emit progress'); });
  assert.equal(closed.state, 'failed'); assert.ok(!(await readdir(data.directory)).includes('invoked'));
  assert.deepEqual(await readdir(data.stateDir), [data.job.id]);
});

test('durable progress arrives while console output is buffered, ignores another payload, and deduplicates replayed sequence numbers', { timeout: 15000 }, async t => {
  const data = await fixture(t, String.raw`
await ledger({payloadHash:'another-payload',eventSequence:1,stage:{state:'connecting',message:'wrong payload'}});
await delay(1250);
await ledger({payloadHash:input.payloadHash,eventSequence:2,stage:{state:'waiting',dispatchInvoked:true,message:'等待合成回答'},response:'PRIVATE_LEDGER_RESPONSE',privatePath:jobDir});
let acknowledged=false;
for(let attempt=0;attempt<100;attempt++){
  try{await readFile(path.join(jobDir,'progress-seen'));acknowledged=true;break;}catch{}
  await delay(50);
}
assert.ok(acknowledged,'Progress must be delivered before the child exits or writes its buffered console output');
await event({state:'connecting',sequence:1},process.stdout);
await event({state:'waiting',dispatchInvoked:true,sequence:2},process.stderr);
await event({state:'completed',dispatchInvoked:true,sequence:3,response:'最终合成回答'},process.stderr);
`);
  const events = [];
  const result = await data.runner.run(data.job, async patch => {
    events.push(patch);
    if (patch.state === 'waiting') await writeFile(path.join(data.jobDir, 'progress-seen'), 'ack');
  });
  assert.deepEqual(events.map(event => [event.state, event.sequence]), [['waiting', 2], ['completed', 3]]);
  assert.equal(result.response, '最终合成回答');
  assert.ok(!JSON.stringify(events).includes('PRIVATE_LEDGER_RESPONSE'));
  assert.ok(!JSON.stringify(events).includes(data.jobDir));
});

test('close leaves a private checkpoint for an active child without claiming a dispatched request was cancelled', { timeout: 8000 }, async t => {
  const data = await fixture(t, String.raw`
await ledger({payloadHash:input.payloadHash,dispatchInvoked:true});
await event({state:'waiting',dispatchInvoked:true},process.stderr);
let closed=false;
for(let attempt=0;attempt<100;attempt++){
  try{await readFile(path.join(jobDir,'close-requested'));closed=true;break;}catch{}
  await delay(20);
}
assert.ok(closed);
process.exitCode=0;
`);
  const result = await data.runner.run(data.job, async patch => {
    if (patch.state === 'waiting') data.runner.close();
  });
  assert.equal(result.state, 'uncertain'); assert.equal(result.dispatchInvoked, true);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(data.jobDir, 'close-requested'))).mode & 0o777, 0o600);
});

test('close during asynchronous initialization prevents a later child launch', { timeout: 8000 }, async t => {
  const data = await fixture(t, 'await event({state:"failed",message:"Child must not launch after closure"});');
  const pending = data.runner.run(data.job, async () => {});
  data.runner.close();
  const result = await pending;
  assert.equal(result.state, 'failed'); assert.notEqual(result.dispatchInvoked, true);
  assert.ok(!(await readdir(data.directory)).includes('invoked'));
});

test('forget removes only private input and PNG material while retaining the durable non-content ledger', { timeout: 8000 }, async t => {
  const data = await fixture(t, 'throw new Error("forget must not invoke the executable");');
  await mkdir(data.jobDir, { recursive: true });
  const retained = { dispatchInvoked: true, payloadHash: 'known', chatId: randomUUID(), responseHash: createHash('sha256').update('private answer').digest('hex') };
  const ledger = JSON.stringify({ ...retained, response: 'private answer' });
  for (const name of ['input.json', 'selection.png', 'transport.png']) await writeFile(path.join(data.jobDir, name), 'private selected material');
  await writeFile(path.join(data.jobDir, 'ledger.json'), ledger);
  await writeFile(path.join(data.jobDir, 'unrelated.txt'), 'retain unrelated file');
  await data.runner.forget(data.job.id);
  assert.deepEqual((await readdir(data.jobDir)).sort(), ['ledger.json', 'unrelated.txt']);
  assert.deepEqual(JSON.parse(await readFile(path.join(data.jobDir, 'ledger.json'), 'utf8')), retained);
  await data.runner.forget('../outside');
  assert.ok(!(await readdir(data.directory)).includes('invoked'));
});
