'use strict';
/**
 * E5 · repost-engine 内容池分支纯逻辑 QA（4.6.126）
 * 覆盖：模式判定 / 空池 5 分钟再查不导航不发空帖 / claim 异常与认号兜底 /
 *       配图下载失败报 retry 本轮跳过 / 存待发补 contentPoolId 并跳 /compose/post /
 *       发布结果 posted·retry·failed 回报触发条件 / runOnce 分流接线（池模式绝不扫来源号）
 * 运行：unified-scheduler 下 node --test "test/*.test.js"
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(seed, failSetKey) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { if (failSetKey && k === failSetKey) throw new Error('storage_full'); obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  Object.assign(obj, seed || {});
  return obj;
}

/** 沙箱加载真实 repost-engine.js，返回引擎 + 可观察桩 */
function loadEngine(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'repost', 'repost-engine.js'), 'utf8');
  const timeouts = []; // EngineUtils.createTimeout 捕获（ms + 回调，不真跑）
  const calls = { claims: [], reports: [], fetches: [], navs: [], getCurrent: 0, stops: [] };
  const storage = makeStorage(opts.session, opts.failSetKey);
  const local = makeStorage(opts.local);
  let handles = opts.handles || ['mai'];
  let cfg = Object.assign({}, opts.cfg);
  let claimImpl = opts.claimImpl || (() => null);
  let fetchMediaImpl = opts.fetchMediaImpl || (() => []);
  const client = {
    claim: async (h) => { calls.claims.push(h); return claimImpl(); },
    report: async (id, result, meta) => { calls.reports.push([id, result, meta]); return { ok: true }; },
    fetchMedia: async (urls) => { calls.fetches.push(urls); return fetchMediaImpl(urls); },
  };
  const EngineUtils = {
    isActive: () => true,
    isRunning: () => false,
    isAntiSpamCooldown: () => false,
    start() {}, stop(n) { calls.stops.push(n); }, resume() {}, ping() {},
    createTimeout(cb, ms) { const t = { cb, ms, cancel() { t.canceled = true; } }; timeouts.push(t); return t; },
    createWatchdog: () => ({ cancel() {} }),
  };
  const tracker = {
    getConfig: () => cfg,
    ownHandleCandidates: () => handles,
    getCurrent: () => { calls.getCurrent++; return null; },
    getTargets: () => [],
    dailyExhausted: () => false,
    remainingDaily: () => 1,
    isAutoSlot: () => false,
    getAccountDayCount: () => 1,
    getDailyQuota: () => 1,
    getDaily: () => ({ date: '2026-10-14', count: 0 }),
  };
  const sandbox = {
    window: { RepostTracker: tracker, ContentPoolClient: opts.noClient ? null : client, addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: null },
    sessionStorage: storage,
    localStorage: local,
    EngineUtils,
    console,
    setTimeout, clearTimeout,
    SchedulerGate: { go: (mod, url, o) => { calls.navs.push([mod, url, o]); return opts.navOk !== false; } },
    location: { href: 'https://x.com/home' },
  };
  if (opts.fileReader) sandbox.FileReader = opts.fileReader;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'repost-engine.js' });
  return { E: sandbox.window.RepostEngine, timeouts, calls, storage, local };
}

test('模式判定：client 缺失一律 false；contentPoolMode 真/字符串/1 开，其余关（Task 9 前未下发维持来源号模式）', () => {
  const { E } = loadEngine({});
  const t = E._test.isContentPoolMode;
  assert.equal(t({ contentPoolMode: true }), true);
  assert.equal(t({ contentPoolMode: 'true' }), true);
  assert.equal(t({ contentPoolMode: 1 }), true);
  assert.equal(t({ contentPoolMode: false }), false);
  assert.equal(t({ contentPoolMode: '0' }), false);
  assert.equal(t({}), false);
  assert.equal(t(null), true); // 计划临时判定：cfg 缺失视为开启
  const { E: E2 } = loadEngine({ noClient: true });
  assert.equal(E2._test.isContentPoolMode({ contentPoolMode: true }), false);
  assert.equal(E2._test.isContentPoolMode(null), false);
});

test('回报分类：media_restore_fail/media_download_fail → retry；api_business/mention_blocked/未知 → failed', () => {
  const { E } = loadEngine({});
  const c = E._test.classifyPoolSkipResult;
  assert.equal(c('media_restore_fail'), 'retry');
  assert.equal(c('media_download_fail'), 'retry');
  assert.equal(c('api_business'), 'failed');
  assert.equal(c('mention_blocked'), 'failed');
  assert.equal(c('empty_pending'), 'failed');
  assert.equal(c(''), 'failed');
});

test('回报触发：成功→posted 带 externalPostId；跳过按原因 retry/failed；连败≥5→failed；无 contentPoolId/无 client 不回报', async () => {
  const { E, calls } = loadEngine({});
  const R = E._test.reportPoolOutcome;
  await R({ contentPoolId: 'cp9', tweetId: 'cp9' }, true, 0);
  assert.deepEqual(calls.reports[0], ['cp9', 'posted', { externalPostId: 'cp9' }]);
  R({ contentPoolId: 'cp9' }, { skipped: true, reason: 'media_restore_fail' }, 1);
  assert.deepEqual(calls.reports[1], ['cp9', 'retry', { failReason: 'media_restore_fail' }]);
  R({ contentPoolId: 'cp9' }, { skipped: true, reason: 'api_business' }, 1);
  assert.deepEqual(calls.reports[2], ['cp9', 'failed', { failReason: 'api_business' }]);
  R({ contentPoolId: 'cp9' }, { skipped: true, reason: 'mention_blocked' }, 1);
  assert.deepEqual(calls.reports[3], ['cp9', 'failed', { failReason: 'mention_blocked' }]);
  R({ contentPoolId: 'cp9' }, false, 5);
  assert.deepEqual(calls.reports[4], ['cp9', 'failed', { failReason: 'publish_failed_x5' }]);
  R({ contentPoolId: 'cp9' }, false, 4); // 未达熔断阈值不报（保留重试）
  R({ tweetId: 'x1' }, true, 0); // 来源号待发无 contentPoolId 不报
  R(null, true, 0);
  assert.equal(calls.reports.length, 5);
  const { E: E2, calls: c2 } = loadEngine({ noClient: true });
  E2._test.reportPoolOutcome({ contentPoolId: 'cp9' }, true, 0);
  assert.deepEqual(c2.reports, []);
});

test('空池：claim null → scheduleNext(5min)，不导航、不回报、不下图、不发空文本', async () => {
  const { E, timeouts, calls } = loadEngine({ cfg: { contentPoolMode: true } });
  await E._test.runContentPoolTick();
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 5 * 60000);
  assert.deepEqual(calls.claims, ['mai']);
  assert.deepEqual(calls.reports, []);
  assert.deepEqual(calls.fetches, []);
  assert.deepEqual(calls.navs, []);
});

test('claim 异常：60 秒后再查，不导航不回报', async () => {
  const { E, timeouts, calls } = loadEngine({
    cfg: { contentPoolMode: true },
    claimImpl: () => ({ error: 'network_down' }),
  });
  await E._test.runContentPoolTick();
  assert.equal(timeouts[0].ms, 60000);
  assert.deepEqual(calls.reports, []);
  assert.deepEqual(calls.navs, []);
});

test('认不到本号 handle：不 claim，60 秒后再查', async () => {
  const { E, timeouts, calls } = loadEngine({ cfg: { contentPoolMode: true }, handles: [] });
  await E._test.runContentPoolTick();
  assert.deepEqual(calls.claims, []);
  assert.equal(timeouts[0].ms, 60000);
});

test('认号兜底：ownHandleCandidates 为空时回退 matrix_my_handle（去 @/#guard、小写）', async () => {
  const { E, calls, local } = loadEngine({ cfg: { contentPoolMode: true }, handles: [], local: { matrix_my_handle: '@Akari#guard' } });
  await E._test.runContentPoolTick();
  assert.deepEqual(calls.claims, ['akari']);
  void local;
});

test('配图下载失败：报 retry(media_download_fail) 后本轮跳过，不存待发不导航（禁硬发缺图内容）', async () => {
  const { E, timeouts, calls, storage } = loadEngine({
    cfg: { contentPoolMode: true },
    claimImpl: () => ({ id: 'cp1', text: 'こんばんは', media_urls: ['m/a.jpg'] }),
    fetchMediaImpl: () => { throw new Error('media_fail'); },
  });
  await E._test.runContentPoolTick();
  assert.deepEqual(calls.reports, [['cp1', 'retry', { failReason: 'media_download_fail' }]]);
  assert.equal(timeouts[0].ms, 60000);
  assert.equal(storage.getItem('sg_repost_pending_content'), null);
  assert.deepEqual(calls.navs, []);
});

test('claim 到纯文：存待发并补 contentPoolId，跳 /compose/post，不再定时（保持 isProcessing）', async () => {
  const { E, timeouts, calls, storage } = loadEngine({
    cfg: { contentPoolMode: true },
    claimImpl: () => ({ id: 'cp2', text: 'おはよう', media_urls: [] }),
  });
  await E._test.runContentPoolTick();
  const pend = JSON.parse(storage.getItem('sg_repost_pending_content'));
  assert.equal(pend.text, 'おはよう');
  assert.equal(pend.tweetId, 'cp2');
  assert.equal(pend.contentPoolId, 'cp2');
  assert.ok(!pend.requireMedia);
  assert.deepEqual(calls.navs, [['repost', 'https://x.com/compose/post', { force: true }]]);
  assert.equal(timeouts.length, 0);
  assert.deepEqual(calls.fetches, []);
});

test('claim 到带图：fetchMedia 后按 .blob/.ext/.type 存待发（对齐来源号抓图结构）', async () => {
  const { E, calls, storage } = loadEngine({
    cfg: { contentPoolMode: true },
    claimImpl: () => ({ id: 'cp3', text: 'みんな', media_urls: ['m/a.png'] }),
    fetchMediaImpl: () => [{ type: 'image/png' }],
    fileReader: class {
      readAsDataURL(b) { this.result = 'data:' + (b && b.type || 'image/jpeg') + ';base64,QUJD'; if (this.onloadend) this.onloadend(); }
    },
  });
  await E._test.runContentPoolTick();
  assert.deepEqual(calls.fetches, [['m/a.png']]);
  const pend = JSON.parse(storage.getItem('sg_repost_pending_content'));
  assert.equal(pend.requireMedia, true);
  assert.equal(pend.mediaCount, 1);
  assert.equal(pend.mediaBase64[0].ext, 'png');
  assert.equal(pend.mediaBase64[0].type, 'image/png');
  assert.equal(pend.contentPoolId, 'cp3');
});

test('存待发失败：报 retry(save_pending_fail)，30 秒后再查', async () => {
  const { E, timeouts, calls } = loadEngine({
    cfg: { contentPoolMode: true },
    claimImpl: () => ({ id: 'cp4', text: 'テスト', media_urls: [] }),
    failSetKey: 'sg_repost_pending_content',
  });
  await E._test.runContentPoolTick();
  assert.deepEqual(calls.reports, [['cp4', 'retry', { failReason: 'save_pending_fail' }]]);
  assert.equal(timeouts[0].ms, 30000);
  assert.deepEqual(calls.navs, []);
});

test('runOnce 分流：内容池模式无 pending → 只 claim 等 5 分钟，绝不 getCurrent/扫来源号/stop', async () => {
  const { E, timeouts, calls } = loadEngine({ cfg: { contentPoolMode: true } });
  await E._test.runOnce();
  assert.deepEqual(calls.claims, ['mai']);
  assert.equal(calls.getCurrent, 0);
  assert.equal(timeouts[0].ms, 5 * 60000);
  assert.deepEqual(calls.stops, []);
  assert.deepEqual(calls.navs, []);
});

test('runOnce 控制组：非内容池账号不 claim，照常进来源号扫描（无目标 → 走既有完成/延迟停止语义）', async () => {
  const { E, calls } = loadEngine({ cfg: {} });
  await E._test.runOnce();
  assert.deepEqual(calls.claims, []);
  assert.equal(calls.getCurrent, 1); // 已进入来源号扫描（getCurrent 取目标）
  assert.deepEqual(calls.reports, []);
});
