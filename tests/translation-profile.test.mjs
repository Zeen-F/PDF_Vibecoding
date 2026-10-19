import test from 'node:test';
import assert from 'node:assert/strict';
import { hasConfirmedTranslationProfile } from '../src/translation-profile.mjs';

test('missing/failed configuration preview cannot authorize sending or an unpinned retry', () => {
  for (const profile of [null, undefined, {}, { configured: true }, { configured: true, provider: 'baidu' }, { configured: false, provider: 'baidu', revision: 'a'.repeat(64) }, { configured: true, provider: 'baidu', revision: 'invalid' }, { configured: true, provider: 'unknown', revision: 'a'.repeat(64) }]) {
    assert.equal(hasConfirmedTranslationProfile(profile), false);
  }
  assert.equal(hasConfirmedTranslationProfile({ configured: true, provider: 'baidu', revision: 'a'.repeat(64) }), true);
});
