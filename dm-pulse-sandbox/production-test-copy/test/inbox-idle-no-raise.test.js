const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('后台标签：先预检列表，没有未读/待回复时不激活标签', () => {
  const fnStart = chatSrc.indexOf('function hiddenInboxHasWork');
  assert.ok(fnStart > 0, '应存在 hiddenInboxHasWork 预检');
  const fn = chatSrc.slice(fnStart, chatSrc.indexOf('async function runInboxPulse', fnStart));
  assert.match(fn, /actionable/);
  assert.match(fn, /iceSentAt/);
  assert.match(fn, /inboxClosedAt/);

  const pulseStart = chatSrc.indexOf('async function runInboxPulse');
  const preAt = chatSrc.indexOf('hiddenInboxHasWork()', pulseStart);
  const actAt = chatSrc.indexOf('await activateInboxTab()', pulseStart);
  assert.ok(preAt > 0, '脉冲里应调用预检');
  assert.ok(actAt > 0, '脉冲里仍需在必要时激活标签');
  assert.ok(preAt < actAt, '预检必须发生在激活标签之前');
  assert.match(chatSrc.slice(preAt, actAt), /hiddenPre\.actionable === 0/);
});

test('台账待处理：对方关闭收件箱算终态，不再永久显示待催加', () => {
  const start = chatSrc.indexOf('function inboxLedgerPendingSummary');
  const fn = chatSrc.slice(start, chatSrc.indexOf('function inboxLoopHeartbeat', start));
  assert.match(fn, /inboxClosedAt/);
  assert.match(fn, /inbox_closed/);
  assert.match(fn, /!closed && round === 2/);
  assert.match(fn, /!closed && round === 1/);
});

test('心跳输出单实例 CPU 占空比与 tick 耗时（矩阵化估算）', () => {
  const start = chatSrc.indexOf('function inboxLoopHeartbeat');
  const fn = chatSrc.slice(start, chatSrc.indexOf('function getRosterCheckIntervalMs', start));
  assert.match(fn, /cpu_pct_est/);
  assert.match(fn, /tick_ms_avg/);
  assert.match(fn, /tick_ms_max/);
  assert.match(fn, /sg_work_tick_ms/);
  assert.match(fn, /scan_ms_avg/);
  assert.match(fn, /work_ms_total/);
  assert.match(chatSrc, /function sgWorkAdd/);

  assert.match(coreSrc, /function coTickTimed/);
  assert.match(coreSrc, /coTickTimed\(\)/);
  assert.match(coreSrc, /sg_work_tick_ms/);
  assert.match(coreSrc, /sg_work_tick_n/);
  assert.match(coreSrc, /sg_work_tick_max/);
});

test('拉新回本号主页是正常步骤：记为 info，不再刷 warn', () => {
  const at = chatSrc.indexOf("result: 'nav_to_profile'");
  assert.ok(at > 0);
  const block = chatSrc.slice(Math.max(0, at - 400), at);
  assert.match(block, /severity: 'info'/);
});

test('后台节流不判成系统压力', () => {
  const start = coreSrc.indexOf('function _coDetectPressure');
  const fn = coreSrc.slice(start, coreSrc.indexOf('window.sgIsUnderPressure', start));
  assert.match(fn, /visibilityState === 'hidden'/);
  assert.match(fn, /_coWasHiddenForPressure/);
});

test('心跳带上上一拍 scan_drop，直接回答“为什么没处理”', () => {
  assert.match(chatSrc, /last_scan:/);
  assert.match(chatSrc, /sg_inbox_last_scan/);
});

test('版本号递增到 4.9.157', () => {
  assert.equal(manifest.version, '4.9.157');
  assert.match(manifest.action.default_title, /4\.9\.157/);
});

test('心跳探针不能抢在正式心跳之前占用 60 秒闸', () => {
  // 探针与正式心跳共用 chat.inbox_loop 事件名。旧顺序是
  // 「探针先写 sg_tel_probe_at → 正式心跳被闸挡掉」，
  // OPS 里只剩 {probe, phase, at} 空壳，看不到引擎状态和待处理台账。
  const hbStart = chatSrc.indexOf('function inboxLoopHeartbeat');
  assert.ok(hbStart > 0, '缺少 inboxLoopHeartbeat');
  const hbEnd = chatSrc.indexOf('function getRosterCheckIntervalMs', hbStart);
  const hb = chatSrc.slice(hbStart, hbEnd > 0 ? hbEnd : hbStart + 8000);

  const heartbeatAt = hb.indexOf("reportChatMetric('chat.inbox_loop'");
  const probeAt = hb.indexOf('probe: \'inbox_audit\'');
  assert.ok(heartbeatAt > 0, '心跳必须上报 chat.inbox_loop');
  assert.ok(probeAt > 0, '探针必须保留');
  assert.ok(probeAt > heartbeatAt, '探针必须在正式心跳之后发送，不能抢闸');
});
