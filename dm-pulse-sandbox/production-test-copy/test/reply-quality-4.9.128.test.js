'use strict';
/**
 * 4.9.128 回复质量回归：
 *  - 催加时间闸（广告后 3h / 终催 12h）
 *  - OPS 轮次 → 本地轮次映射（OPS 3 不是完结）
 *  - 话术池以 OPS random_pool 为准
 *  - 出站过程中也按间隔巡查守箱
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(ROOT, 'chat', 'content_chat.js'), 'utf8');
const gatesSrc = fs.readFileSync(path.join(ROOT, 'chat', 'chat-gates.js'), 'utf8');

function makeStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  Object.assign(obj, seed || {});
  return obj;
}

function loadGates(seed) {
  const sandbox = {
    console,
    localStorage: makeStorage(seed),
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(gatesSrc, sandbox, { filename: 'chat/chat-gates.js' });
  return sandbox.window.SgChatGates;
}

test('广告后 3 小时内不催加，满 3 小时才放行', () => {
  const gates = loadGates({
    sg_config_thresholds: JSON.stringify({ chat_two_seg_mode: 'off' }),
  });
  const now = Date.now();
  const freshAd = { round: 2, adSentAt: now - 4 * 60 * 1000 };
  assert.equal(gates.canSendKickNow('alice', freshAd), false);

  const oldAd = { round: 2, adSentAt: now - 181 * 60 * 1000, lastInboundAt: now - 60 * 60 * 1000 };
  assert.equal(gates.canSendKickNow('alice', oldAd), true);
});

test('首次催加后 12 小时内不终催，满 12 小时才放行', () => {
  const gates = loadGates({
    sg_config_thresholds: JSON.stringify({ chat_two_seg_mode: 'off' }),
  });
  const now = Date.now();
  const justKicked = {
    round: 2,
    adSentAt: now - 6 * 60 * 60 * 1000,
    kickCount: 1,
    kickSentAt: now - 60 * 60 * 1000,
  };
  assert.equal(gates.canSendKickNow('bob', justKicked), false);

  const kickLongAgo = {
    round: 2,
    adSentAt: now - 20 * 60 * 60 * 1000,
    kickCount: 1,
    kickSentAt: now - 721 * 60 * 1000,
    lastInboundAt: now - 60 * 60 * 1000,
  };
  assert.equal(gates.canSendKickNow('bob', kickLongAgo), true);

  const closed = {
    round: 3,
    kickCount: 2,
    kickSentAt: now - 48 * 60 * 60 * 1000,
    finalKickSentAt: now - 30 * 60 * 60 * 1000,
  };
  assert.equal(gates.canSendKickNow('bob', closed), false);
});

test('OPS 3 映射为本地 2（未完结），OPS 4+ 才映射为 3', () => {
  assert.match(chatSrc, /var opsLocal = ops >= 4 \? 3 : \(ops >= 1 \? Math\.min\(ops, 2\) : 0\);/);
});

test('getPoolMessage 抽台账里的 random_pool，而不是固定本地 v1..v15', () => {
  const start = chatSrc.indexOf('function isUsableScriptPool');
  const end = chatSrc.indexOf('function ensureJobScriptsBootstrapped', start);
  assert.ok(start > 0 && end > start, '应能切出话术池选择片段');
  const slice = chatSrc.slice(start, end)
    + '\n;this.__api = { isUsableScriptPool, getPoolMessage };\n';

  const local = makeStorage({
    dan_scripts: JSON.stringify({
      version: '3',
      mode: 'random',
      random_pool: ['direct_v1'],
      scripts: {
        direct_v1: { name: 'direct', icebreaker: 'OPS 新破冰' },
        v1: { name: 'old', icebreaker: '本地旧破冰' },
      },
    }),
  });
  const sandbox = {
    console,
    localStorage: local,
    sessionStorage: makeStorage(),
    getActiveScriptDefaults() {
      return {
        mode: 'random',
        random_pool: ['v1'],
        scripts: { v1: { name: 'old', icebreaker: '本地旧破冰' } },
      };
    },
    getActiveScriptsStorageKey() { return 'dan_scripts'; },
    getScriptPoolMode() { return 'dating'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox, { filename: 'content_chat.js#pool-source' });

  assert.equal(sandbox.__api.isUsableScriptPool(
    { scripts: { direct_v1: {} } }, ['direct_v1']), true);
  assert.equal(sandbox.__api.getPoolMessage('icebreaker'), 'OPS 新破冰');
});

test('loadScripts 不因为 OPS 池数量少就回退本地 v1..v15', () => {
  assert.match(chatSrc, /if \(!isUsableScriptPool\(config, config\.random_pool\)\) \{\s*config\.random_pool = defaults\.random_pool\.slice\(\);/);
});

test('OPS 陈旧 kick 行在本地已有催加证据时直接跳过', () => {
  const start = chatSrc.indexOf("if (kd === 'kick' || rs === 'kick_ready')");
  assert.ok(start > 0);
  const block = chatSrc.slice(start, start + 900);
  assert.match(block, /localKickEntry\.kickSentAt/);
  assert.match(block, /localKickEntry\.kickCount/);
  assert.match(block, /skippedKick\+\+/);
});

test('出站任务边界也按间隔切守箱巡查', () => {
  assert.match(chatSrc, /enterInboxPatrol\('patrol_interval'\)/);
  assert.match(chatSrc, /!sessionStorage\.getItem\('dan_auto_step'\)/);
  assert.match(chatSrc, /!sessionStorage\.getItem\('dan_dm_inflight'\)/);
  assert.match(chatSrc, /!iceQueueCurrentDoing\(\)/);
});
