'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..', '..');
const productionDir = path.join(root, 'unified-scheduler');
const copyDir = path.join(root, 'dm-pulse-sandbox', 'production-test-copy');
const TEST_ONLY_FILES = ['chat/inbox-v2-adapter.js', 'chat/inbox-decision.js', 'chat/inbox-pulse.js', 'chat/inbox-state.js'];
const TEST_MODIFIED_FILES = ['background.js', 'chat/chat-gates.js', 'chat/inbox-watch.js', 'chat/content_chat.js', 'obs/event-catalog.json', 'scheduler-core.js', 'scheduler/page-router.js', 'scheduler/stage-detector.js', 'shared/config-sync.js', 'shared/config.js', 'shared/telemetry.js', 'ui/panel.js'];

function filesUnder(dir) {
  const out = [];
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(path.join(current, entry.name), nextRelative);
      else out.push(nextRelative.replaceAll('\\', '/'));
    }
  }
  walk(dir, '');
  return out.sort();
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('production test copy isolation', () => {
  it('测试副本有不可混淆的 manifest 标识', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(copyDir, 'manifest.json'), 'utf8'));
    assert.match(manifest.name, /测试副本/);
    assert.match(manifest.action.default_title, /测试副本/);
    assert.match(manifest.description, /测试/);
    assert.match(manifest.version_name, /test-copy/);
  });

  it('除 manifest、测试说明和只读适配改动外，副本与当前生产目录逐文件一致', () => {
    const productionFiles = filesUnder(productionDir).filter(file => file !== 'manifest.json');
    const businessFiles = productionFiles.filter(file => !file.startsWith('test/') && !file.startsWith('migrations/'));
    const copyFiles = filesUnder(copyDir).filter(file => ![
      'manifest.json',
      'TEST_COPY_README.md',
      ...TEST_ONLY_FILES
    ].includes(file));
    // 测试副本允许缺少生产目录里的测试文件，但不能缺业务代码
    const missing = businessFiles.filter(file => !copyFiles.includes(file));
    assert.deepEqual(missing, []);
    for (const file of businessFiles) {
      if (TEST_MODIFIED_FILES.includes(file)) continue;
      assert.equal(sha(path.join(copyDir, file)), sha(path.join(productionDir, file)), file);
    }
    for (const file of TEST_MODIFIED_FILES) {
      const copySource = fs.readFileSync(path.join(copyDir, file), 'utf8');
      const productionSource = fs.readFileSync(path.join(productionDir, file), 'utf8');
      assert.notEqual(sha(path.join(copyDir, file)), sha(path.join(productionDir, file)), file);
      if (file === 'background.js') {
        assert.match(copySource, /const TEST_OPS_LOCKED = true;/, file);
        assert.match(copySource, /http:\/\/127\.0\.0\.1:15681/, file);
        assert.match(copySource, /TEST_OPS_LOCKED \? DEFAULT_OPS_SERVER/, file);
        assert.doesNotMatch(productionSource, /TEST_OPS_LOCKED/, file);
      } else if (file === 'scheduler-core.js') {
        assert.match(copySource, /var liveHost = getMyHandle\(\)/, file);
        assert.doesNotMatch(productionSource, /var liveHost = getMyHandle\(\)/, file);
      } else if (file === 'scheduler/page-router.js') {
        assert.match(copySource, /sg_run_mode/, file);
        assert.doesNotMatch(productionSource, /sg_run_mode/, file);
      } else if (file === 'shared/config-sync.js') {
        assert.match(copySource, /扩展上下文失效/, file);
        assert.doesNotMatch(productionSource, /扩展上下文失效/, file);
      } else if (file === 'chat/chat-gates.js') {
        assert.match(copySource, /getInboxKickGapMs/, file);
        assert.match(copySource, /chat_inbox_kick_min_minutes/, file);
        assert.doesNotMatch(productionSource, /getInboxKickGapMs/, file);
      } else if (file === 'obs/event-catalog.json') {
        assert.match(copySource, /chat\.inbox_cycle/, file);
        assert.match(copySource, /chat\.fan_roster_check/, file);
        assert.doesNotMatch(productionSource, /chat\.inbox_cycle/, file);
      } else if (file === 'shared/telemetry.js') {
        assert.match(copySource, /getHealth/, file);
        assert.match(copySource, /writeHealth/, file);
        assert.doesNotMatch(productionSource, /writeHealth/, file);
      } else if (file === 'shared/config.js') {
        assert.match(copySource, /127\.0\.0\.1:15681/, file);
        assert.doesNotMatch(productionSource, /127\.0\.0\.1:15681/, file);
      } else if (file === 'ui/panel.js') {
        assert.match(copySource, /renderTelemetryHealth/, file);
        assert.match(copySource, /v-tel-health/, file);
        assert.doesNotMatch(productionSource, /renderTelemetryHealth/, file);
      } else {
        assert.match(copySource, /SgInboxV2Adapter/, file);
        assert.doesNotMatch(productionSource, /SgInboxV2Adapter/, file);
      }
    }
  });

  it('只读适配器只存在于测试副本，且生产目录没有引用', () => {
    for (const file of TEST_ONLY_FILES) {
      assert.ok(fs.existsSync(path.join(copyDir, file)), file);
      assert.ok(!fs.existsSync(path.join(productionDir, file)), file);
    }

    const productionSources = filesUnder(productionDir)
      .filter(file => /\.(js|json)$/i.test(file))
      .map(file => fs.readFileSync(path.join(productionDir, file), 'utf8'));
    assert.ok(productionSources.every(source => !source.includes('SgInboxV2Adapter')));

    const manifest = JSON.parse(fs.readFileSync(path.join(copyDir, 'manifest.json'), 'utf8'));
    const js = manifest.content_scripts.flatMap(script => script.js || []);
    const adapterIndex = js.indexOf('chat/inbox-v2-adapter.js');
    const inboxIndex = js.indexOf('chat/inbox-watch.js');
    assert.ok(adapterIndex >= 0);
    assert.ok(inboxIndex > adapterIndex);
  });
});
