import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, stat, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedBrowser } from '../server/chatgpt-browser.mjs';

// The fake only models owned page/context lifetime; it never contacts ChatGPT
// or opens a personal profile. One separate headless case exercises Playwright
// against an original loopback fixture and the same dedicated profile contract.
function fakeChromium({ launchGate, failFirst = false } = {}) {
  const launches = [], contexts = [];
  function page() {
    const events = [], element = { value: '' };
    let closed = false, url = 'about:blank';
    return {
      events, element, isClosed: () => closed, url: () => url,
      async goto(target, options) { events.push(['goto', target, options]); url = target; },
      async evaluate(_fn, arg) { events.push(['evaluate', arg]); return arg; },
      async waitForFunction(_fn, arg, options) { events.push(['waitForFunction', arg, options]); return true; },
      locator(selector) { return {
        async click(options) { events.push(['click', selector, options]); },
        async fill(value) { element.value = value; events.push(['fill', selector, value]); },
        async press(key) { events.push(['press', selector, key]); },
      }; },
      async waitForEvent(name) { events.push(['event', name]); return { async setFiles(files) { events.push(['files', files]); } }; },
      async bringToFront() { events.push(['front']); },
      async close() { closed = true; events.push(['close']); },
    };
  }
  const chromium = { async launchPersistentContext(profileDir, options) {
    launches.push({ profileDir, options });
    if (failFirst && launches.length === 1) throw new Error('SYNTHETIC_LAUNCH_FAILURE');
    if (launchGate) await launchGate;
    const context = new EventEmitter(); context.ownedPages = [page()]; context.closeCount = 0;
    context.pages = () => context.ownedPages.filter(page => !page.isClosed());
    context.newPage = async () => { const created = page(); context.ownedPages.push(created); return created; };
    context.close = async () => { context.closeCount++; for (const page of context.ownedPages) await page.close(); context.emit('close'); };
    contexts.push(context); return context;
  } };
  return { chromium, launches, contexts };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'paperdesk-managed-browser-'));
  const profileDir = join(directory, 'private-profile');
  const fake = fakeChromium(options);
  const browser = createManagedBrowser({ profileDir, chromium: fake.chromium, idleMs: options.idleMs ?? 1000 });
  t.after(async () => { await browser.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, profileDir, browser, ...fake };
}
async function eventually(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}

test('managed browser starts lazily with a dedicated protected profile and no existing-browser attachment', async t => {
  assert.throws(() => createManagedBrowser({ profileDir: 'relative-profile' }), /absolute/);
  const { browser, profileDir, launches } = await fixture(t);
  assert.equal((await browser.status()).state, 'closed'); assert.equal(launches.length, 0);
  const space = await browser.taskSpace('original-task');
  assert.equal(launches.length, 1); assert.equal(launches[0].profileDir, profileDir);
  assert.equal(launches[0].options.headless, false); assert.equal(launches[0].options.acceptDownloads, false);
  assert.equal(browser.runParameter, 'paperdesk_run'); assert.equal(browser.accountLock, join(profileDir, 'account-mutation.lock'));
  assert.equal((await browser.status()).state, 'ready');
  const owner = JSON.parse(await readFile(join(profileDir, 'paperdesk-owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid); assert.match(owner.token, /^[a-f0-9-]{36}$/);
  if (process.platform !== 'win32') { assert.equal((await stat(profileDir)).mode & 0o777, 0o700); assert.equal((await stat(join(profileDir, 'paperdesk-owner.json'))).mode & 0o777, 0o600); }
  await space.finish({ keep: [] });
});

test('simultaneous task acquisition cannot create two questions or share one page', async t => {
  const { browser, launches } = await fixture(t);
  const results = await Promise.allSettled([browser.taskSpace('first'), browser.taskSpace('second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await browser.listTaskSpaces()).length, 1); assert.equal(launches.length, 1);
  await results.find(result => result.status === 'fulfilled').value.finish({ keep: [] });
});

test('handoff suspends all page mutations until an explicit takeover and retains exact task identity', async t => {
  const { browser, contexts } = await fixture(t);
  const space = await browser.taskSpace('handoff'), page = space.page('p1');
  await page.goto('https://example.invalid/fixture', { label: 'private label', waitUntil: 'domcontentloaded' });
  await page.click('#submit', { label: 'click label', timeout: 10 }); await page.fill('#question', 'original draft'); await page.press('#question', 'Enter');
  const chooser = await page.waitForFileChooser();
  const actual = contexts[0].ownedPages[0];
  assert.deepEqual(actual.events[0], ['goto', 'https://example.invalid/fixture', { waitUntil: 'domcontentloaded' }]);
  assert.deepEqual(actual.events[1], ['click', '#submit', { timeout: 10 }]);
  await space.handOff(); assert.equal(space.ownership, 'user'); assert.equal((await browser.status()).state, 'needs_user');
  await assert.rejects(browser.taskSpace(space.spaceId), /USER_CONTROL_REQUIRED/);
  for (const operation of [() => page.goto('https://example.invalid/changed'), () => page.evaluate(() => {}), () => page.fill('#question', 'must not write'), () => chooser.setFiles('forbidden.png')]) await assert.rejects(async () => operation(), /USER_CONTROL_REQUIRED/);
  const same = await browser.takeOverTaskSpace(space.spaceId); assert.equal(same.spaceId, space.spaceId); assert.equal(same.ownership, 'agent');
  await same.page('p1').fill('#question', 'explicit resumed draft');
  assert.equal(actual.element.value, 'explicit resumed draft');
  await same.finish({ keep: [] }); assert.deepEqual(await browser.listTaskSpaces(), []);
  await assert.rejects(browser.taskSpace(space.spaceId), /SPACE_IDENTITY_CHANGED/);
});

test('manual closing of an owned page releases that slot for a new question', async t => {
  const { browser, contexts } = await fixture(t);
  const original = await browser.taskSpace('closed-by-user');
  await contexts[0].ownedPages[0].close();
  assert.deepEqual(await browser.listTaskSpaces(), []);
  await assert.rejects(browser.takeOverTaskSpace(original.spaceId), /SPACE_IDENTITY_CHANGED/);
  const next = await browser.taskSpace('next-question'); assert.notEqual(next.spaceId, original.spaceId);
  await next.finish({ keep: [] });
});

test('connection open reuses its window, disconnect preserves profile, and permanent close forbids reopening', async t => {
  const { browser, profileDir, launches, contexts } = await fixture(t);
  assert.equal((await browser.open()).state, 'ready');
  const actual = contexts[0].ownedPages[0];
  assert.equal(actual.events.filter(event => event[0] === 'goto').length, 1);
  assert.equal(actual.url(), 'https://chatgpt.com/?paperdesk_connect=1');
  await browser.open(); assert.equal(launches.length, 1); assert.equal(actual.events.filter(event => event[0] === 'goto').length, 1);
  await writeFile(join(profileDir, 'original-fixture.json'), '{"synthetic":true}');
  assert.equal((await browser.disconnect()).state, 'closed'); assert.equal(contexts[0].closeCount, 1);
  assert.equal(await readFile(join(profileDir, 'original-fixture.json'), 'utf8'), '{"synthetic":true}');
  await assert.rejects(access(join(profileDir, 'paperdesk-owner.json')));
  await browser.open(); assert.equal(launches.length, 2);
  await browser.close(); await assert.rejects(browser.open(), /SERVICE_CLOSED/);
});

test('idle cleanup closes only after the last task finishes and never while the user owns it', async t => {
  const { browser, contexts } = await fixture(t, { idleMs: 25 });
  const task = await browser.taskSpace('pause-for-user'); await task.handOff();
  await delay(60); assert.equal(contexts[0].closeCount, 0);
  await browser.takeOverTaskSpace(task.spaceId); await task.finish({ keep: [] });
  await eventually(() => contexts[0].closeCount === 1, 'Idle context was not closed');
  assert.equal((await browser.status()).state, 'closed');
});

test('another managed instance cannot steal a live profile lock and launch failure releases ownership', async t => {
  const first = await fixture(t), secondFake = fakeChromium();
  const second = createManagedBrowser({ profileDir: first.profileDir, chromium: secondFake.chromium }); t.after(() => second.close());
  const active = await first.browser.taskSpace('live-owner');
  const owner = await readFile(join(first.profileDir, 'paperdesk-owner.json'), 'utf8');
  await assert.rejects(second.taskSpace('not-the-owner'), /BROWSER_PROFILE_BUSY/);
  assert.equal(secondFake.launches.length, 0); assert.equal(await readFile(join(first.profileDir, 'paperdesk-owner.json'), 'utf8'), owner);
  await active.finish({ keep: [] }); await first.browser.disconnect();
  const next = await second.taskSpace('released-profile'); await next.finish({ keep: [] }); await second.close();
  const failing = await fixture(t, { failFirst: true });
  await assert.rejects(failing.browser.taskSpace('failed-launch'), /SYNTHETIC_LAUNCH_FAILURE/);
  await assert.rejects(access(join(failing.profileDir, 'paperdesk-owner.json')));
  const recovered = await failing.browser.taskSpace('retry-launch'); assert.equal(failing.launches.length, 2); await recovered.finish({ keep: [] });
});

test('service close during pending launch closes the eventual context without handing out a task', async t => {
  let release; const launchGate = new Promise(resolve => { release = resolve; });
  const { browser, launches, contexts, profileDir } = await fixture(t, { launchGate });
  const pending = browser.taskSpace('late-launch'); const rejected = assert.rejects(pending, /SERVICE_CLOSED/);
  await eventually(() => launches.length === 1, 'Expected delayed launch to start');
  const closing = browser.close(); release(); await closing; await rejected;
  assert.equal(contexts[0].closeCount, 1); assert.deepEqual(await browser.listTaskSpaces(), []);
  await assert.rejects(access(join(profileDir, 'paperdesk-owner.json')));
});

test('real headless managed profile runs only against an original loopback page and persists its own state', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paperdesk-managed-headless-'));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Original managed test</title><input id="question"><button id="save" onclick="localStorage.setItem(\'original\',document.querySelector(\'#question\').value)">Save original test</button>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}`;
  const browser = createManagedBrowser({ profileDir: join(directory, 'profile'), headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const first = await browser.taskSpace('original-offline-question'), page = first.page('p1');
  await page.goto(url, { waitUntil: 'domcontentloaded', label: 'Original loopback only' }); await page.fill('#question', 'synthetic persistent draft'); await page.click('#save');
  await page.waitForFunction(() => localStorage.getItem('original') === 'synthetic persistent draft');
  await first.finish({ keep: [] }); await browser.disconnect();
  const second = await browser.taskSpace('read-original-state'); await second.page('p1').goto(url);
  assert.equal(await second.page('p1').evaluate(() => localStorage.getItem('original')), 'synthetic persistent draft');
  await second.finish({ keep: [] });
});
