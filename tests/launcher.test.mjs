import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, access, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserLaunchConfig, probeBrowserService, runBrowserLauncher } from '../scripts/launch.mjs';
import { libraryIdentity, LAUNCHER_PROTOCOL, PRODUCT_VERSION } from '../shared/service-identity.mjs';
import { getVaultConfig } from '../server/vault-config.mjs';
import { isolatedTestEnvironment } from '../scripts/test-isolated.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const config = browserLaunchConfig({ rootDir, env: { PORT: '4317', PAPERDESK_DATA_DIR: path.join(tmpdir(), 'synthetic-paperdesk-launcher') } });
const identity = { service: 'paperdesk', apiVersion: 1, libraryId: config.libraryId, productVersion: PRODUCT_VERSION, launcherProtocol: LAUNCHER_PROTOCOL };

function controlledProbe(status = identity, health = { ok: true }, extra = {}) {
  const calls = [];
  const probe = () => probeBrowserService(config, {
    connectionProbe: async () => 'occupied',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(url.endsWith('/api/plugin/status') ? status : health));
    }, ...extra,
  });
  return { probe, calls };
}

function childStub() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); child.emit('exit', null, signal); return true; };
  return child;
}

function recorder() {
  const opened = [], errors = [], logs = [], spawned = [];
  const child = childStub();
  return { opened, errors, logs, spawned, child, options: {
    rootDir, env: { PORT: '4317', PAPERDESK_DATA_DIR: config.dataDir },
    open: url => opened.push(url), error: message => errors.push(message), log: message => logs.push(message),
    spawnImpl: (...args) => { spawned.push(args); return child; }, pollIntervalMs: 1, shutdownTimeoutMs: 10,
  } };
}

test('browser launcher calculates the exact library binding without opening library files', () => {
  const value = browserLaunchConfig({ rootDir, env: {} });
  assert.equal(value.dataDir, path.join(rootDir, 'data'));
  assert.equal(value.libraryId, libraryIdentity(value.dataDir));
  assert.equal(browserLaunchConfig({ rootDir, env: { PAPERDESK_DATA_DIR: path.join(config.dataDir, '.') } }).libraryId, config.libraryId);
  assert.equal(browserLaunchConfig({ rootDir, env: { PAPERDESK_DATA_DIR: 'synthetic-library' } }).dataDir, path.join(rootDir, 'synthetic-library'));
  for (const port of ['0', '-1', '1.5', '65536', 'abc']) assert.throws(() => browserLaunchConfig({ rootDir, env: { PORT: port } }), /PORT/);
});

test('vault launcher resolves canonical source, shared library identity and default cache without creating files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-vault-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vaultDir = path.join(directory, 'vault'), alias = path.join(directory, 'alias');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await symlink(vaultDir, alias, 'dir');
  const expected = getVaultConfig({ vaultDir: alias, vaultSubdir: 'Reading' });
  const value = browserLaunchConfig({ rootDir, env: { PAPERDESK_VAULT_DIR: alias, PAPERDESK_VAULT_SUBDIR: 'Reading' } });
  assert.equal(value.vaultDir, await realpath(vaultDir));
  assert.equal(value.vaultSubdir, 'Reading');
  assert.equal(value.dataDir, expected.dataDir);
  assert.equal(value.libraryId, libraryIdentity(expected.libraryDir));
  assert.deepEqual(await readdir(vaultDir), ['.obsidian']);
  const cache = path.join(directory, 'not-created-cache');
  const r = recorder();
  let probes = 0;
  const result = await runBrowserLauncher({ ...r.options,
    env: { PAPERDESK_VAULT_DIR: alias, PAPERDESK_VAULT_SUBDIR: 'Reading', PAPERDESK_DATA_DIR: cache },
    probe: async requested => {
      assert.equal(requested.libraryId, value.libraryId);
      if (++probes === 1) return { state: 'free' };
      r.child.emit('message', { type: 'paperdesk-ready' });
      return { state: 'compatible' };
    },
  });
  assert.equal(result.state, 'started');
  assert.equal(r.spawned[0][2].env.PAPERDESK_VAULT_DIR, value.vaultDir);
  assert.equal(r.spawned[0][2].env.PAPERDESK_VAULT_SUBDIR, 'Reading');
  assert.equal(r.spawned[0][2].env.PAPERDESK_DATA_DIR, path.join(await realpath(directory), 'not-created-cache'));
  assert.deepEqual(await readdir(vaultDir), ['.obsidian']);
  await assert.rejects(access(cache), { code: 'ENOENT' });
});

test('invalid vault launcher paths fail before probing, spawning or creating a library', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-vault-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vaultDir = path.join(directory, 'vault'), cache = path.join(directory, 'not-created-cache');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await writeFile(path.join(vaultDir, 'untouched.txt'), 'original fixture');
  for (const patch of [
    { PAPERDESK_VAULT_DIR: path.join(directory, 'missing') },
    { PAPERDESK_VAULT_DIR: 'relative-vault' },
    { PAPERDESK_VAULT_DIR: vaultDir + '\0' },
    { PAPERDESK_VAULT_SUBDIR: '../outside' },
    { PAPERDESK_DATA_DIR: path.join(vaultDir, 'cache') },
  ]) {
    await assert.rejects(runBrowserLauncher({ rootDir,
      env: { PAPERDESK_VAULT_DIR: vaultDir, PAPERDESK_DATA_DIR: cache, ...patch },
      probe: () => assert.fail('Invalid config must not probe'),
      spawnImpl: () => assert.fail('Invalid config must not spawn'),
      open: () => assert.fail('Invalid config must not open'),
    }));
  }
  assert.deepEqual((await readdir(vaultDir)).sort(), ['.obsidian', 'untouched.txt']);
  await assert.rejects(access(cache), { code: 'ENOENT' });
});

test('browser launcher probes identity and health, never HTML title, and only accepts the same library and build contract', async () => {
  const { probe, calls } = controlledProbe();
  assert.deepEqual(await probe(), { state: 'compatible' });
  assert.deepEqual(calls.map(call => new URL(call.url).pathname).sort(), ['/api/health', '/api/plugin/status']);
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('browser launcher refuses wrong libraries, old services, incompatible versions and unhealthy services', async t => {
  for (const [patch, expected, message] of [
    [{ libraryId: 'b'.repeat(64) }, 'library', /另一文献库/],
    [{ libraryId: undefined }, 'unverified', /未提供有效文献库身份/],
    [{ service: 'other' }, 'other-service', /其他服务/],
    [{ apiVersion: 2 }, 'version', /不兼容/],
    [{ launcherProtocol: undefined, productVersion: undefined }, 'version', /不兼容/],
    [{ launcherProtocol: 2 }, 'version', /不兼容/],
    [{ productVersion: '1.0.1' }, 'version', /不兼容/],
  ]) await t.test(JSON.stringify(patch), async () => {
    const result = await controlledProbe({ ...identity, ...patch }).probe();
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, expected);
    assert.match(result.message, message);
  });
  assert.equal((await controlledProbe(identity, { ok: false }).probe()).reason, 'unhealthy');
});

test('unreadable, redirecting, oversized and unreachable identity responses fail closed', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('timeout or redirect'); },
    async () => new Response('<title>纸间 Paperdesk</title>'),
    async () => new Response('x'.repeat(16 * 1024 + 1)),
    async () => new Response('{}', { status: 503 }),
  ]) {
    assert.equal((await controlledProbe(identity, { ok: true }, { fetchImpl }).probe()).reason, 'unverified');
  }
  assert.deepEqual(await probeBrowserService(config, { connectionProbe: async () => 'free', fetchImpl: () => assert.fail('Free port must not fetch') }), { state: 'free' });
  assert.equal((await probeBrowserService(config, { connectionProbe: async () => 'unknown' })).reason, 'unverified');
});

test('compatible service is reused without starting a backend or taking shutdown ownership', async () => {
  const r = recorder();
  const result = await runBrowserLauncher({ ...r.options, probe: async () => ({ state: 'compatible' }) });
  assert.deepEqual(result, { state: 'reused', code: 0 });
  assert.deepEqual(r.opened, [config.baseUrl]);
  assert.equal(r.spawned.length, 0);
  assert.equal(r.child.signals.length, 0);
});

test('wrong-library refusal never starts a backend, opens a browser or creates the target directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-refusal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'must-not-exist');
  const r = recorder();
  const result = await runBrowserLauncher({ ...r.options, env: { PAPERDESK_DATA_DIR: target }, probe: async requested => {
    assert.equal(requested.libraryId, libraryIdentity(target));
    return { state: 'blocked', reason: 'library', message: '另一文献库' };
  } });
  assert.deepEqual(result, { state: 'blocked', code: 1 });
  assert.equal(r.spawned.length, 0);
  assert.equal(r.opened.length, 0);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('launcher starts its own backend with the explicit library and opens only after compatible readiness', async () => {
  const r = recorder();
  const sequence = [{ state: 'free' }, { state: 'blocked', reason: 'unverified' }, { state: 'compatible' }];
  const result = await runBrowserLauncher({ ...r.options, probe: async () => {
    const result = sequence.shift();
    if (result.state === 'compatible') r.child.emit('message', { type: 'paperdesk-ready' });
    return result;
  } });
  assert.equal(result.state, 'started');
  assert.equal(result.child, r.child);
  assert.equal(r.spawned.length, 1);
  assert.deepEqual(r.spawned[0].slice(0, 2), [process.execPath, ['server/index.mjs']]);
  assert.equal(r.spawned[0][2].env.PAPERDESK_DATA_DIR, config.dataDir);
  assert.equal(r.spawned[0][2].env.PORT, '4317');
  assert.deepEqual(r.opened, [config.baseUrl]);
});

test('bind race with a different library stops only the launched child and never opens the conflicting service', async () => {
  const r = recorder();
  let probes = 0;
  const result = await runBrowserLauncher({ ...r.options, probe: async () => ++probes === 1 ? { state: 'free' } : { state: 'blocked', reason: 'library', message: '另一文献库' } });
  assert.equal(result.state, 'blocked');
  assert.deepEqual(r.child.signals, ['SIGTERM']);
  assert.equal(r.opened.length, 0);
});

test('same-library bind race reuses the winner only after the losing child exits', async () => {
  const r = recorder();
  let probes = 0;
  const result = await runBrowserLauncher({ ...r.options, probe: async () => {
    if (++probes === 1) return { state: 'free' };
    if (probes === 3) r.child.emit('exit', 1);
    assert.equal(r.opened.length, 0);
    return { state: 'compatible' };
  } });
  assert.deepEqual(result, { state: 'reused', code: 0, child: undefined });
  assert.equal(probes, 3);
  assert.equal(r.child.signals.length, 0);
  assert.deepEqual(r.opened, [config.baseUrl]);
});

test('failed and stalled backend startup has bounded cleanup and no browser opening', async t => {
  await t.test('finite readiness timeout', async () => {
    const r = recorder();
    const result = await runBrowserLauncher({ ...r.options, startupTimeoutMs: 8, probe: async () => ({ state: 'free' }) });
    assert.equal(result.state, 'failed');
    assert.deepEqual(r.child.signals, ['SIGTERM']);
    assert.equal(r.opened.length, 0);
    assert.match(r.errors[0], /超时/);
  });
  await t.test('child spawn error', async () => {
    const r = recorder();
    let probes = 0;
    const result = await runBrowserLauncher({ ...r.options, probe: async () => {
      if (++probes === 2) r.child.emit('error', new Error('spawn denied'));
      return { state: 'free' };
    } });
    assert.equal(result.state, 'failed');
    assert.match(r.errors[0], /spawn denied/);
    assert.equal(r.opened.length, 0);
  });
  await t.test('cancel during readiness', async () => {
    const r = recorder(), controller = new AbortController();
    let probes = 0;
    const result = await runBrowserLauncher({ ...r.options, signal: controller.signal, probe: async () => {
      if (++probes === 2) controller.abort();
      return { state: probes === 1 ? 'free' : 'compatible' };
    } });
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(r.child.signals, ['SIGTERM']);
    assert.equal(r.opened.length, 0);
  });
});

test('server CLI losing the bind race exits without creating or migrating its target library', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'must-not-exist');
  const server = createServer((_request, response) => response.end('unrelated service'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: rootDir, env: { ...isolatedTestEnvironment(), PORT: String(server.address().port), PAPERDESK_DATA_DIR: target }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(() => clearTimeout(timeout));
  const [code] = await once(child, 'exit');
  assert.equal(code, 1, output);
  assert.match(output, /端口 .* 已被占用/);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

test('real synthetic backend starts, reuses only its library, refuses a different library and shuts down cleanly', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dataDir = path.join(directory, 'synthetic-library');
  const opened = [], errors = [];
  let child, childExit;
  t.after(async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    try { await childExit; } finally { clearTimeout(timer); }
  });
  const options = {
    rootDir, env: { ...isolatedTestEnvironment(), PORT: String(port), PAPERDESK_DATA_DIR: dataDir },
    open: url => opened.push(url), error: message => errors.push(message), log: () => {},
    spawnImpl: (command, args, options) => {
      child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      childExit = once(child, 'exit');
      return child;
    }, pollIntervalMs: 25, startupTimeoutMs: 8000,
  };
  const started = await runBrowserLauncher(options);
  assert.equal(started.state, 'started', errors.join('\n'));
  assert.equal(started.child, child);
  const reused = await runBrowserLauncher({ ...options, spawnImpl: () => assert.fail('Same library must reuse the service') });
  assert.equal(reused.state, 'reused');
  const other = path.join(directory, 'must-not-exist');
  const blocked = await runBrowserLauncher({ ...options, env: { ...options.env, PAPERDESK_DATA_DIR: other }, spawnImpl: () => assert.fail('Wrong library must not start') });
  assert.equal(blocked.state, 'blocked');
  assert.match(errors.at(-1), /另一文献库/);
  assert.equal(opened.length, 2);
  await assert.rejects(access(other), { code: 'ENOENT' });
  const status = await (await fetch(`http://127.0.0.1:${port}/api/plugin/status`)).json();
  assert.equal(status.libraryId, libraryIdentity(dataDir));
  assert.equal(status.productVersion, PRODUCT_VERSION);
  assert.equal(status.launcherProtocol, LAUNCHER_PROTOCOL);
  child.kill('SIGTERM');
  const [code] = await childExit;
  assert.equal(code, 0);
});

test('real vault launcher starts with its canonical cache and reuses the vault across cache choices', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-vault-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vaultDir = path.join(directory, 'vault'), otherVault = path.join(directory, 'other-vault');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await mkdir(path.join(otherVault, '.obsidian'), { recursive: true });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cache = path.join(directory, 'cache'), opened = [], errors = [];
  let child, childExit;
  t.after(async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    try { await childExit; } finally { clearTimeout(timer); }
  });
  const options = { rootDir,
    env: { ...isolatedTestEnvironment(), PORT: String(port), PAPERDESK_VAULT_DIR: vaultDir, PAPERDESK_DATA_DIR: cache },
    open: url => opened.push(url), error: message => errors.push(message), log: () => {},
    spawnImpl: (command, args, options) => {
      child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      childExit = once(child, 'exit'); return child;
    }, pollIntervalMs: 25, startupTimeoutMs: 8000,
  };
  const started = await runBrowserLauncher(options);
  assert.equal(started.state, 'started', errors.join('\n'));
  const status = await (await fetch(`http://127.0.0.1:${port}/api/plugin/status`)).json();
  assert.equal(status.libraryId, libraryIdentity(path.join(await realpath(vaultDir), 'Paperdesk')));
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/storage`)).json()).mode, 'vault');
  const unusedCache = path.join(directory, 'unused-cache');
  assert.equal((await runBrowserLauncher({ ...options,
    env: { ...options.env, PAPERDESK_DATA_DIR: unusedCache },
    spawnImpl: () => assert.fail('Same vault must reuse its service'),
  })).state, 'reused');
  await assert.rejects(access(unusedCache), { code: 'ENOENT' });
  assert.equal((await runBrowserLauncher({ ...options,
    env: { ...options.env, PAPERDESK_VAULT_DIR: otherVault },
    spawnImpl: () => assert.fail('Different vault must not start'),
  })).state, 'blocked');
  assert.deepEqual(await readdir(otherVault), ['.obsidian']);
  assert.equal(opened.length, 2);
  child.kill('SIGTERM'); assert.equal((await childExit)[0], 0);
});

test('two real concurrent launchers reuse one backend and do not retain the losing child', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-launcher-concurrent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const children = [], exits = [], opened = [], errors = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 6000);
    try { await Promise.all(exits); } finally { clearTimeout(timer); }
  });
  const options = {
    rootDir, env: { ...isolatedTestEnvironment(), PORT: String(port), PAPERDESK_DATA_DIR: directory },
    open: url => opened.push(url), error: message => errors.push(message), log: () => {},
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      exits.push(once(child, 'exit'));
      return child;
    }, pollIntervalMs: 25, startupTimeoutMs: 8000,
  };
  const results = await Promise.all([runBrowserLauncher(options), runBrowserLauncher(options)]);
  assert.deepEqual(results.map(result => result.state).sort(), ['reused', 'started'], errors.join('\n'));
  assert.equal(opened.length, 2);
  assert.equal(children.length, 2);
  assert.equal(children.filter(child => child.exitCode === null && child.signalCode === null).length, 1);
  assert.equal(children.find(child => child.exitCode !== null)?.exitCode, 1);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok, true);
});
