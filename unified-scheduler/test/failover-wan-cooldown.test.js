/**
 * K2 · 内外网候选（4.6.180 冷静期 + 4.6.181 默认只走内网）
 * 运行：node --test --test-force-exit unified-scheduler/test/failover-wan-cooldown.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

function loadBgSlice(wanEnabled) {
  const code = `
    var DEFAULT_POOL_SERVER = 'http://192.168.0.100:15678';
    var DEFAULT_OPS_SERVER = 'http://192.168.0.100:15680';
    var FALLBACK_POOL_SERVER = 'https://haochi1.kooldns.cn';
    var FALLBACK_OPS_SERVER = 'https://kongzhi1.kooldns.cn';
    var WAN_FAILOVER_ENABLED = ${wanEnabled ? 'true' : 'false'};
    var WAN_COOLDOWN_MS = 5 * 60 * 1000;
    var wanCooldownUntil = { pool: 0, ops: 0 };
    var failoverSticky = { pool: { base: '', until: 0 }, ops: { base: '', until: 0 } };
    var cachedPoolServer = DEFAULT_POOL_SERVER;
    var cachedOpsServer = DEFAULT_OPS_SERVER;
    function normalizeServerUrl(u, fallback) {
      var s = String(u || '').trim().replace(/\\/$/, '');
      if (!s) return fallback;
      if (!/^https?:\\/\\//i.test(s)) s = 'http://' + s;
      s = s.replace(/^(https:\\/\\/[^/:]+):443$/i, '$1');
      return s.replace(/\\/$/, '');
    }
    function isLanUrl(u) {
      return /192\\.168\\.0\\.100(?::\\d+)?$/i.test(String(u || '').replace(/^https?:\\/\\//i, '').split('/')[0])
        || /^https?:\\/\\/192\\.168\\.0\\.100(?::\\d+)?$/i.test(String(u || ''));
    }
    function isDefaultPool78(u) { return /:15678$/i.test(normalizeServerUrl(u, '')); }
    function canFallBackToWan(kind, preferred) {
      if (!WAN_FAILOVER_ENABLED) return false;
      if (!isLanUrl(preferred)) return false;
      if (kind !== 'pool') return true;
      return isDefaultPool78(preferred);
    }
    function forceLanIfWanDisabled(kind, url) {
      var u = normalizeServerUrl(url, kind === 'pool' ? DEFAULT_POOL_SERVER : DEFAULT_OPS_SERVER);
      if (!WAN_FAILOVER_ENABLED && !isLanUrl(u)) {
        return kind === 'pool' ? DEFAULT_POOL_SERVER : DEFAULT_OPS_SERVER;
      }
      return u;
    }
    function markWanDead(kind) {
      wanCooldownUntil[kind] = Date.now() + WAN_COOLDOWN_MS;
    }
    function clearWanCooldown(kind) { wanCooldownUntil[kind] = 0; }
    function candidatesFor(kind) {
      var preferred = kind === 'pool' ? cachedPoolServer : cachedOpsServer;
      var wan = kind === 'pool' ? FALLBACK_POOL_SERVER : FALLBACK_OPS_SERVER;
      var lanDefault = kind === 'pool' ? DEFAULT_POOL_SERVER : DEFAULT_OPS_SERVER;
      var sticky = failoverSticky[kind] || { base: '', until: 0 };
      var now = Date.now();
      var list = [];
      function push(u) {
        u = normalizeServerUrl(u, '');
        if (!u) return;
        if (list.indexOf(u) < 0) list.push(u);
      }
      if (!WAN_FAILOVER_ENABLED && !isLanUrl(preferred)) preferred = lanDefault;
      push(preferred);
      if (WAN_FAILOVER_ENABLED && sticky.base && sticky.until > now && sticky.base !== preferred) {
        if (!(wanCooldownUntil[kind] > now && !isLanUrl(sticky.base))) push(sticky.base);
      }
      if (canFallBackToWan(kind, preferred) && !(wanCooldownUntil[kind] > now)) push(wan);
      if (WAN_FAILOVER_ENABLED && !isLanUrl(preferred)) push(lanDefault);
      return list;
    }
    globalThis.__api = {
      candidatesFor, markWanDead, clearWanCooldown, forceLanIfWanDisabled,
      setPool: function(u){ cachedPoolServer = normalizeServerUrl(u, DEFAULT_POOL_SERVER); }
    };
  `;
  const sandbox = { Date, Math, String, Array, Object, console, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.__api;
}

describe('K2 · LAN-only default (4.6.181/183)', () => {
  it('关外网：LAN preferred 不带 haochi1', () => {
    const api = loadBgSlice(false);
    api.setPool('http://192.168.0.100:15678');
    const list = Array.from(api.candidatesFor('pool'));
    assert.equal(list.length, 1);
    assert.equal(list[0], 'http://192.168.0.100:15678');
    assert.equal(list.some((u) => /haochi1/.test(u)), false);
  });

  it('关外网：storage 误配外网 → 只走内网默认，不先撞 WAN', () => {
    const api = loadBgSlice(false);
    api.setPool('https://haochi1.kooldns.cn');
    const list = Array.from(api.candidatesFor('pool'));
    assert.equal(list.length, 1);
    assert.equal(list[0], 'http://192.168.0.100:15678');
  });

  it('关外网：forceLanIfWanDisabled 读写端统一改回内网', () => {
    const api = loadBgSlice(false);
    assert.equal(
      api.forceLanIfWanDisabled('pool', 'https://haochi1.kooldns.cn'),
      'http://192.168.0.100:15678'
    );
    assert.equal(
      api.forceLanIfWanDisabled('ops', 'https://kongzhi1.kooldns.cn'),
      'http://192.168.0.100:15680'
    );
    assert.equal(
      api.forceLanIfWanDisabled('pool', 'http://192.168.0.100:15679'),
      'http://192.168.0.100:15679'
    );
  });
});

describe('K2 · WAN cooldown when failover on', () => {
  it('开外网：冷静期内不再带外网', () => {
    const api = loadBgSlice(true);
    api.setPool('http://192.168.0.100:15678');
    api.clearWanCooldown('pool');
    let list = api.candidatesFor('pool');
    assert.ok(list.some((u) => /haochi1/.test(u)), '默认应含外网兜底');
    api.markWanDead('pool');
    list = api.candidatesFor('pool');
    assert.equal(list.some((u) => /haochi1/.test(u)), false, '冷静期应跳过外网');
    assert.ok(list[0].includes('192.168.0.100'));
  });

  it('开外网：preferred 误配外网仍补内网号池', () => {
    const api = loadBgSlice(true);
    api.setPool('https://haochi1.kooldns.cn');
    api.markWanDead('pool');
    const list = api.candidatesFor('pool');
    assert.ok(list.some((u) => u.includes('192.168.0.100:15678')), '应有内网兜底');
  });
});
