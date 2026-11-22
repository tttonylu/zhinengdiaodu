'use strict';
/**
 * 守箱引擎看门狗：换页后引擎失联 / 拉新卡死必须能自愈。
 * 运行：node --test --test-force-exit test/engine-watchdog.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    _map: map
  };
}

function loadWatchdog(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'engine-watchdog.js'), 'utf8');
  const localStorage = makeStorage(opts.local || {});
  const sessionStorage = makeStorage(opts.session || {});
  const navigations = [];
  const emitted = [];
  const window = {
    location: {
      pathname: opts.pathname || '/i/chat',
      assign(url) { navigations.push(url); }
    },
    SgTelemetry: {
      emit(name, meta) { emitted.push({ name, meta }); }
    },
    TimeUtil: {
      isWithinChatHours() { return opts.inChatHours !== false; }
    }
  };
  const sandbox = {
    window,
    localStorage,
    sessionStorage,
    console,
    Math,
    Number,
    parseInt,
    JSON,
    Date,
    Object,
    setTimeout() { return 0; },
    setInterval() { return 0; },
    chrome: undefined
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { api: window.SgEngineWatchdog, localStorage, sessionStorage, navigations, emitted, window };
}

function baseLocal(extra) {
  return Object.assign({
    sg_run_mode: 'inbox',
    sg_test_inbox_watch: 'true'
  }, extra || {});
}

describe('守箱引擎看门狗', () => {
  it('拉新阶段停留超过 90 秒 → 复位回守箱', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({
        phase: 'roster', enteredAt: now - 5 * 60 * 1000, scanActive: false
      })
    });
    const ctx = loadWatchdog({ local });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'watch');
    assert.equal(cyc.reason, 'watchdog_roster_stale');
    assert.equal(cyc.enteredAt, 0);
  });

  it('拉新阶段刚进入（未超时）→ 不动', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({ phase: 'roster', enteredAt: now - 10 * 1000 })
    });
    const ctx = loadWatchdog({ local });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'roster');
  });

  it('粉丝扫描中 90 秒没进度 → 不误杀，继续扫描', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({
        phase: 'roster',
        enteredAt: now - 10 * 60 * 1000,
        scanActive: true,
        scanActiveAt: now - 97 * 1000
      })
    });
    const ctx = loadWatchdog({ local, pathname: '/jakelu133969/followers' });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'roster');
    assert.equal(ctx.navigations.length, 0);
  });

  it('粉丝扫描超过 180 秒仍无收尾 → 复位回守箱', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({
        phase: 'roster',
        enteredAt: now - 10 * 60 * 1000,
        scanActive: true,
        scanActiveAt: now - 181 * 1000
      })
    });
    const ctx = loadWatchdog({ local, pathname: '/jakelu133969/followers' });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'watch');
    assert.equal(cyc.reason, 'watchdog_roster_stale');
  });

  it('守箱开关关闭时不做任何动作', () => {
    const now = Date.now();
    const local = {
      sg_run_mode: 'outbound',
      sg_inbox_cycle: JSON.stringify({ phase: 'roster', enteredAt: now - 10 * 60 * 1000 })
    };
    const ctx = loadWatchdog({ local });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'roster');
    assert.equal(ctx.navigations.length, 0);
  });

  it('私信时段外即使拉新超时也不得复位或导航', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({ phase: 'roster', enteredAt: now - 10 * 60 * 1000 })
    });
    const ctx = loadWatchdog({ local, pathname: '/jakelu133969', inChatHours: false });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'roster');
    assert.equal(ctx.navigations.length, 0);
  });

  it('拉新超时且不在私信页 → 复位并导航回 /i/chat', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({ phase: 'roster', enteredAt: now - 5 * 60 * 1000 })
    });
    const ctx = loadWatchdog({ local, pathname: '/jakelu133969' });
    ctx.api.tick();
    assert.deepEqual(ctx.navigations, ['/i/chat']);
  });

  it('脉冲逾期且主引擎不存在、停在别的页面 → 回列表页重载', () => {
    const now = Date.now();
    const local = baseLocal();
    const session = {
      sg_inbox_state: JSON.stringify({ busy: false, nextPulseAt: now - 10 * 60 * 1000 })
    };
    const ctx = loadWatchdog({ local, session, pathname: '/somewhere' });
    ctx.api.tick();
    assert.deepEqual(ctx.navigations, ['/i/chat']);
  });

  it('脉冲逾期但主引擎在 → 只唤醒，不跳页', () => {
    const now = Date.now();
    const local = baseLocal();
    const session = {
      sg_inbox_state: JSON.stringify({ busy: false, nextPulseAt: now - 10 * 60 * 1000 })
    };
    const ctx = loadWatchdog({ local, session, pathname: '/i/chat' });
    let nudged = 0;
    ctx.window.__sgChatMainEngineTick = function () { nudged++; };
    ctx.api.tick();
    assert.equal(nudged, 1);
    assert.equal(ctx.navigations.length, 0);
  });

  it('拉新超时但破冰队列仍有新鲜进度 → 不复位（正在 /<handle> 点私信）', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({
        phase: 'roster', enteredAt: now - 5 * 60 * 1000, scanActive: true, scanActiveAt: now - 5 * 60 * 1000
      }),
      sg_chat_last_progress_at: String(now - 5 * 1000),
      sg_chat_last_progress_why: 'step_1'
    });
    const ctx = loadWatchdog({ local, pathname: '/iqnun4x0berva' });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'roster');
    assert.equal(ctx.navigations.length, 0);
  });

  it('拉新超时且进度已过时 → 仍然复位（真卡死要能自愈）', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({
        phase: 'roster', enteredAt: now - 10 * 60 * 1000, scanActive: true, scanActiveAt: now - 10 * 60 * 1000
      }),
      sg_chat_last_progress_at: String(now - 5 * 60 * 1000),
      sg_chat_last_progress_why: 'queue_drain'
    });
    const ctx = loadWatchdog({ local, pathname: '/iqnun4x0berva' });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'watch');
    assert.equal(cyc.reason, 'watchdog_roster_stale');
  });

  it('非私信模块的进度不能给拉新保活', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({ phase: 'roster', enteredAt: now - 5 * 60 * 1000 }),
      sg_chat_last_progress_at: String(now - 5 * 1000),
      sg_chat_last_progress_why: 'follow_round'
    });
    const ctx = loadWatchdog({ local, pathname: '/jakelu133969' });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'watch');
  });

  it('扫描心跳本身不算进度：卡死的扫描仍要被复位', () => {
    const now = Date.now();
    const local = baseLocal({
      sg_inbox_cycle: JSON.stringify({
        phase: 'roster', enteredAt: now - 10 * 60 * 1000, scanActive: true, scanActiveAt: now - 10 * 60 * 1000
      }),
      sg_chat_last_progress_at: String(now - 2 * 1000),
      sg_chat_last_progress_why: 'roster_scan_active'
    });
    const ctx = loadWatchdog({ local, pathname: '/jakelu133969/followers' });
    ctx.api.tick();
    const cyc = JSON.parse(ctx.localStorage.getItem('sg_inbox_cycle'));
    assert.equal(cyc.phase, 'watch');
    assert.equal(cyc.reason, 'watchdog_roster_stale');
  });

  it('清单必须加载看门狗脚本', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    const all = []
      .concat.apply([], manifest.content_scripts.map((c) => c.js || []));
    assert.ok(all.indexOf('chat/engine-watchdog.js') >= 0, 'manifest 缺少 engine-watchdog.js');
  });
});
