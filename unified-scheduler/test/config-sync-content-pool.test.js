'use strict';
/**
 * Task 9 · config-sync 透传 contentPoolMode QA
 * 覆盖：applyRepostRemote 构建 cfg 时把 repost_content_pool（账号 override）写入
 *       contentPoolMode 位，随 sg_repost_config / RepostTracker.setConfig / chrome.storage 下发。
 * 运行：unified-scheduler 下 node --test "test/*.test.js"
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  Object.assign(obj, seed || {});
  return obj;
}

/** 沙箱加载真实 config-sync.js，chrome.runtime.sendMessage 按需回包 */
function loadSync(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'config-sync.js'), 'utf8');
  const local = makeStorage(opts.local);
  const session = makeStorage();
  const storageSets = [];
  const responses = opts.responses || {};
  let trackerCfg = null;
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    window: { addEventListener() {}, dispatchEvent() {} },
    document: { hidden: false },
    localStorage: local, sessionStorage: session,
    chrome: {
      runtime: {
        sendMessage(msg, cb) {
          const res = responses[msg.action];
          if (cb && res) cb(res);
        },
      },
      storage: { local: { set(o) { storageSets.push(o); } } },
    },
  };
  if (opts.withTracker) {
    sandbox.RepostTracker = {
      setTargets() {},
      setConfig(cfg) { trackerCfg = cfg; },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'config-sync.js' });
  return { local, session, storageSets, getTrackerCfg: () => trackerCfg };
}

const okPayload = (thresholds) => ({
  ok: true,
  account: { x_handle: '@mai' },
  thresholds,
});

test('repost_content_pool=1 → cfg.contentPoolMode=true 落到 sg_repost_config（无 tracker 走 localStorage 路径）', () => {
  const { local, storageSets } = loadSync({
    responses: { fetch_remote_config: okPayload({ repost_content_pool: '1' }) },
  });
  const cfg = JSON.parse(local.getItem('sg_repost_config'));
  assert.equal(cfg.contentPoolMode, true);
  const mirror = storageSets.find((o) => o.matrix_repost_config);
  assert.ok(mirror, 'chrome.storage.local 应有 matrix_repost_config 镜像');
  assert.equal(mirror.matrix_repost_config.contentPoolMode, true);
});

test('未配置 / 0 / false → contentPoolMode=false（默认关，维持来源号模式）', () => {
  const a = loadSync({ responses: { fetch_remote_config: okPayload({}) } });
  assert.equal(JSON.parse(a.local.getItem('sg_repost_config')).contentPoolMode, false);

  const b = loadSync({ responses: { fetch_remote_config: okPayload({ repost_content_pool: '0' }) } });
  assert.equal(JSON.parse(b.local.getItem('sg_repost_config')).contentPoolMode, false);

  const c = loadSync({ responses: { fetch_remote_config: okPayload({ repost_content_pool: false }) } });
  assert.equal(JSON.parse(c.local.getItem('sg_repost_config')).contentPoolMode, false);
});

test('tracker 在场 → contentPoolMode 随 setConfig 透传（tracker Object.assign 全量保存，无白名单）', () => {
  const { getTrackerCfg } = loadSync({
    withTracker: true,
    responses: { fetch_remote_config: okPayload({ repost_content_pool: 'true' }) },
  });
  assert.ok(getTrackerCfg(), 'RepostTracker.setConfig 应被调用');
  assert.equal(getTrackerCfg().contentPoolMode, true);
});
