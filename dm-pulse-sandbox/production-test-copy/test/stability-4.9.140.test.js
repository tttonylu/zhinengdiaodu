'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function loadHeartbeatModule() {
  const stateStart = src.indexOf('var liteHeartbeatThrottle');
  const stateEnd = src.indexOf('function maybeSwPresenceHeartbeat');
  const sendStart = src.indexOf('/** 引擎 send_report');
  const sendEnd = src.indexOf('// ==================== 资料克隆');
  assert.ok(stateStart >= 0 && stateEnd > stateStart, 'heartbeat state block found');
  assert.ok(sendStart >= 0 && sendEnd > sendStart, 'lite heartbeat block found');
  const block = src.slice(stateStart, stateEnd) + '\n' + src.slice(sendStart, sendEnd);
  const bodies = [];
  const ctx = {
    console,
    Date,
    JSON,
    normalizeBotId(v) { return String(v || '').toLowerCase().trim(); },
    handleFromBotId(v) { return /^[a-z0-9_]{1,15}$/.test(String(v || '')) ? String(v) : ''; },
    opsFetch(url, opts) {
      bodies.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true });
    },
    chrome: { storage: { local: { get(keys, cb) { cb({ my_handle: 'alice' }); } } } }
  };
  const api = vm.runInNewContext(
    block + '\n;({ forwardLiteHeartbeat: forwardLiteHeartbeat, noteLiveEngine: noteLiveEngine, getLiveEngine: getLiveEngine, liteHeartbeatThrottle: liteHeartbeatThrottle })',
    ctx
  );
  return { api, bodies };
}

test('版本升到 4.9.157', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '4.9.157');
});

test('养号运行中，chat/follow 的空闲心跳不会覆盖 OPS 运行模块', () => {
  const { api, bodies } = loadHeartbeatModule();
  api.noteLiveEngine('alice', { engine: 'nurture', running_module: 'nurture' }, true);

  api.forwardLiteHeartbeat({ bot_id: 'alice', engine: 'chat', status: 'idle' });
  api.liteHeartbeatThrottle.alice = 0;
  api.forwardLiteHeartbeat({ bot_id: 'alice', engine: 'follow', status: 'idle' });

  assert.equal(bodies.length, 2);
  bodies.forEach((item) => {
    assert.equal(item.body.engine, undefined);
    assert.equal(item.body.running_module, undefined);
  });
  assert.equal(api.getLiveEngine('alice'), 'nurture');
});

test('同模块空闲或调度器 full 心跳可以将状态清为 idle', () => {
  const { api, bodies } = loadHeartbeatModule();
  api.noteLiveEngine('alice', { engine: 'nurture', running_module: 'nurture' }, true);

  api.forwardLiteHeartbeat({ bot_id: 'alice', engine: 'nurture', status: 'idle' });
  assert.equal(bodies[0].body.engine, 'idle');
  assert.equal(bodies[0].body.running_module, null);
  assert.equal(api.getLiveEngine('alice'), '');

  api.noteLiveEngine('alice', { engine: 'nurture', running_module: 'nurture' }, true);
  api.noteLiveEngine('alice', { engine: 'coor', running_module: null }, true);
  assert.equal(api.getLiveEngine('alice'), '');
});

test('chat 运行时同模块 idle 仍能正常清空，running 心跳能重新占位', () => {
  const { api, bodies } = loadHeartbeatModule();
  api.noteLiveEngine('alice', { engine: 'chat', status: 'running' }, false);
  api.liteHeartbeatThrottle.alice = 0;
  api.forwardLiteHeartbeat({ bot_id: 'alice', engine: 'chat', status: 'idle' });
  assert.equal(bodies[0].body.engine, 'idle');
  assert.equal(api.getLiveEngine('alice'), '');
});

test('台账补记带 ledger_backfill 标记，后台原样转发给 OPS', () => {
  const chatSrc = fs.readFileSync(path.join(ROOT, 'chat', 'content_chat.js'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(chatSrc, /opsDmRecordOnce\(targetHandle, rr, fillText, 'success', true\)/);
  assert.match(bgSrc, /ledger_backfill: request\.ledger_backfill === true/);
});

test('战报必须在气泡确认成功后才写，失败不记 ad_sent', () => {
  const chatSrc = fs.readFileSync(path.join(ROOT, 'chat', 'content_chat.js'), 'utf8');
  const confirmAt = chatSrc.indexOf('var confirm = await threadSafeSendAndConfirm');
  const reportAt = chatSrc.indexOf("sendLogToNAS(targetHandle, actionTypes[userRound] || 'AD'");
  assert.ok(confirmAt >= 0 && reportAt > confirmAt, 'sendLogToNAS must come after confirmation');
  const before = chatSrc.slice(0, confirmAt);
  assert.equal(
    before.includes("sendLogToNAS(targetHandle, actionTypes[userRound] || 'AD'"),
    false,
    'no success report before confirmation'
  );
});

test('正常的 round_gap 补记不再当作警告刷扩展错误徽标', () => {
  const chatSrc = fs.readFileSync(path.join(ROOT, 'chat', 'content_chat.js'), 'utf8');
  assert.match(chatSrc, /console\.log\('\[私信\] OPS round_gap，开始补记'/);
  assert.doesNotMatch(chatSrc, /console\.warn\('\[私信\] OPS round_gap，开始补记'/);
});
