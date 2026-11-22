'use strict';
/**
 * 4.9.135：假活回收退避 + 关注空转恢复退避。
 * 现场 14:10–14:33：白屏 45s → 回收 → 下一拍立刻重开 → 又白屏；
 * 同时关注每 90 秒清一次旗标，followed 停在 136 约 50 分钟。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');

function loadFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\(([^)]*)\\)\\s*\\{[\\s\\S]*?\\n  \\}');
  const m = src.match(re);
  assert.ok(m, '应定义 ' + name);
  return m[0];
}

test('假活回收退避 90s → 3min → 6min → 10min，10 分钟后重置', () => {
  const fn = vm.runInNewContext(loadFn('chatZombieBackoffMsCo') + '\nchatZombieBackoffMsCo');
  const t0 = 1794650000000;
  assert.deepEqual(fn({}, t0).cool_ms, 90000);
  assert.equal(fn({ at: t0, n: 1 }, t0 + 1000).cool_ms, 180000);
  assert.equal(fn({ at: t0, n: 2 }, t0 + 2000).cool_ms, 360000);
  assert.equal(fn({ at: t0, n: 3 }, t0 + 3000).cool_ms, 600000);
  assert.equal(fn({ at: t0, n: 9 }, t0 + 4000).cool_ms, 600000);
  const reset = fn({ at: t0, n: 9 }, t0 + 11 * 60000);
  assert.equal(reset.n, 1);
  assert.equal(reset.cool_ms, 90000);
});

test('退避剩余时间从 sessionStorage 读取并归零', () => {
  const store = new Map();
  const ctx = {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
    },
  };
  const fn = vm.runInNewContext(loadFn('chatZombieHoldLeftCo') + '\nchatZombieHoldLeftCo', ctx);
  const now = 1794650000000;
  assert.equal(fn(now), 0);
  store.set('sg_chat_zombie_hold_until', String(now + 5000));
  assert.equal(fn(now), 5000);
  assert.equal(fn(now + 6000), 0);
});

test('回收时写入 hold + chatNextAllowedAt，且退避闸排在软风控分支之前', () => {
  const iReclaim = src.indexOf('function reclaimChatZombieCo');
  const iSetHold = src.indexOf("sessionStorage.setItem('sg_chat_zombie_hold_until'", iReclaim);
  assert.ok(iSetHold > iReclaim, '回收必须写 hold');
  const iNext = src.indexOf('sgZ.chatNextAllowedAt', iReclaim);
  assert.ok(iNext > iReclaim, '回收必须写 chatNextAllowedAt');
  const iGate = src.indexOf('chatZombieHoldLeftCo(now) > 0');
  const iSoft = src.indexOf('softRiskActive(sg, now) && !sg.softRiskChatDone');
  assert.ok(iGate > 0 && iGate < iSoft, '退避闸必须在软风控放行之前');
});

test('关注空转恢复尊重领号宽限并按 1/2/4/8 分钟退避', () => {
  assert.ok(/if \(underQuota && !softRiskActive\(sg, now\) && !followStartGrace\)/.test(src),
    '恢复块必须跳过 followStartGrace');
  const fn = vm.runInNewContext(loadFn('followRecoverBackoffMsCo') + '\nfollowRecoverBackoffMsCo');
  const t0 = 1794650000000;
  assert.equal(fn({}, t0).cool_ms, 0);
  assert.equal(fn({ at: t0, n: 1 }, t0 + 1000).cool_ms, 60000);
  assert.equal(fn({ at: t0, n: 2 }, t0 + 2000).cool_ms, 120000);
  assert.equal(fn({ at: t0, n: 3 }, t0 + 3000).cool_ms, 240000);
  assert.equal(fn({ at: t0, n: 8 }, t0 + 4000).cool_ms, 480000);
  assert.equal(fn({ at: t0, n: 8 }, t0 + 11 * 60000).n, 1);
});
