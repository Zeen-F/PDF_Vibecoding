import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentEnvironment } from '../scripts/dev-environment.mjs';

test('development cannot inherit production vault files or its cache location', () => {
  const production = { PAPERDESK_VAULT_DIR: '/synthetic/production-vault', PAPERDESK_VAULT_SUBDIR: 'Formal', PAPERDESK_DATA_DIR: '/synthetic/production-cache', PORT: '4317', PATH: '/synthetic/runtime' };
  const before = { ...production };
  const development = developmentEnvironment(production, { apiPort: 4328, dataDir: '/synthetic/dev-data' });
  assert.equal(development.PAPERDESK_VAULT_DIR, undefined);
  assert.equal(development.PAPERDESK_VAULT_SUBDIR, undefined);
  assert.equal(development.PAPERDESK_DATA_DIR, '/synthetic/dev-data');
  assert.equal(development.PORT, '4328');
  assert.equal(development.DEV_API_PORT, '4328');
  assert.equal(development.PATH, production.PATH);
  assert.deepEqual(production, before);
});
