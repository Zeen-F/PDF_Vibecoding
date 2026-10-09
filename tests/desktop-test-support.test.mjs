import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { desktopTestTarget, temporaryTestDirectory, removeTestDirectory } from '../scripts/desktop-test-support.mjs';

test('desktop acceptance accepts source, Mac app, and Windows directory or executable with Chinese/spaced names', () => {
  assert.equal(desktopTestTarget(null, { electronExecutable: 'source-electron' }).executablePath, 'source-electron');
  const mac = path.resolve('Paperdesk 中文.app');
  assert.deepEqual(desktopTestTarget(mac, { platform: 'darwin' }), { executablePath: path.join(mac, 'Contents/MacOS/Paperdesk'), appPath: path.join(mac, 'Contents/Resources/app') });
  const windows = path.resolve('纸间 预览版');
  const expected = { executablePath: path.join(windows, 'Paperdesk.exe'), appPath: path.join(windows, 'resources/app') };
  assert.deepEqual(desktopTestTarget(windows, { platform: 'win32' }), expected);
  assert.deepEqual(desktopTestTarget(path.join(windows, 'Paperdesk.exe'), { platform: 'win32' }), expected);
});

test('fixture cleanup removes only the directory created for this test', async () => {
  const prefix = 'paperdesk-cleanup-test-';
  const directory = await temporaryTestDirectory(prefix);
  try {
    await mkdir(path.join(directory, 'synthetic-library'));
    await assert.rejects(removeTestDirectory(path.join(directory, 'synthetic-library'), prefix), /Refusing to remove/);
    await access(directory);
  } finally { await removeTestDirectory(directory, prefix); }
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
