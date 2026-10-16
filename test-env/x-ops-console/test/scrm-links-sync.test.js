const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAgentIds,
  sameIds,
  readSyncConfig,
  syncLinksToScrm,
} = require('../src/services/scrm-links-sync');

test('extractAgentIds parses line.me @id URLs', () => {
  assert.deepEqual(
    extractAgentIds(['https://line.me/R/ti/p/@136scvkl']),
    ['@136scvkl'],
  );
});

test('extractAgentIds handles ti/p without @ and dedupes', () => {
  assert.deepEqual(
    extractAgentIds([
      'https://line.me/ti/p/abc123',
      'https://line.me/R/ti/p/@abc123',
      '  ',
      'not-a-link',
    ]),
    ['@abc123'],
  );
});

test('sameIds ignores order', () => {
  assert.equal(sameIds(['@a', '@b'], ['@b', '@a']), true);
  assert.equal(sameIds(['@a'], ['@b']), false);
});

test('readSyncConfig respects SCRM_SYNC_ENABLED=0', () => {
  const prev = process.env.SCRM_SYNC_ENABLED;
  process.env.SCRM_SYNC_ENABLED = '0';
  try {
    assert.equal(readSyncConfig({}).enabled, false);
  } finally {
    if (prev == null) delete process.env.SCRM_SYNC_ENABLED;
    else process.env.SCRM_SYNC_ENABLED = prev;
  }
});

test('syncLinksToScrm skips when disabled', async () => {
  const result = await syncLinksToScrm(['https://line.me/R/ti/p/@x'], {
    appConfig: { scrmSyncEnabled: false },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});
