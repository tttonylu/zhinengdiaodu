'use strict';
/**
 * 4.9.130 回归：调度与私信可能在不同标签页，进度心跳必须跨标签页共享。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const schedulerSrc = fs.readFileSync(path.join(root, 'scheduler-core.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');
const loggerSrc = fs.readFileSync(path.join(root, 'shared', 'logger.js'), 'utf8');

function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

function loadSchedulerHelpers(localStorage, sessionStorage) {
  const start = schedulerSrc.indexOf('  function chatProgressAgeMsCo()');
  const end = schedulerSrc.indexOf('  /** 假活回收', start);
  assert.ok(start >= 0 && end > start, '应找到聊天进度辅助函数');
  const code = [
    "var CHAT_PROGRESS_STALE_MS = 45000;",
    "var CHAT_PROGRESS_KEY_CO = 'sg_chat_last_progress_at';",
    schedulerSrc.slice(start, end),
    '({ chatProgressAgeMsCo, chatProgressWhyCo, noteChatProgressCo });'
  ].join('\n');
  return vm.runInNewContext(code, { Date, localStorage, sessionStorage });
}

test('调度能从另一个标签页的 localStorage 读到私信心跳', () => {
  const now = Date.now();
  const helpers = loadSchedulerHelpers(
    makeStorage({ sg_chat_last_progress_at: String(now - 1200) }),
    makeStorage()
  );
  const age = helpers.chatProgressAgeMsCo();
  assert.ok(age >= 1000 && age < 5000, '应读取跨标签页心跳，实际 age=' + age);
});

test('两处心跳都存在时取最新值，旧 sessionStorage 不会覆盖新 localStorage', () => {
  const now = Date.now();
  const helpers = loadSchedulerHelpers(
    makeStorage({ sg_chat_last_progress_at: String(now - 800) }),
    makeStorage({ sg_chat_last_progress_at: String(now - 40000) })
  );
  const age = helpers.chatProgressAgeMsCo();
  assert.ok(age < 5000, '应取最新的 localStorage 心跳，实际 age=' + age);
});

test('noteChatProgressCo 同时写入两个标签页存储', () => {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const helpers = loadSchedulerHelpers(localStorage, sessionStorage);
  helpers.noteChatProgressCo('cross_tab_test');
  assert.ok(Number(localStorage.getItem('sg_chat_last_progress_at')) > 0);
  assert.equal(localStorage.getItem('sg_chat_last_progress_at'), sessionStorage.getItem('sg_chat_last_progress_at'));
  assert.equal(localStorage.getItem('sg_chat_last_progress_why'), 'cross_tab_test');
  assert.equal(sessionStorage.getItem('sg_chat_last_progress_why'), 'cross_tab_test');
});

test('进度原因跟随最新心跳所在存储', () => {
  const now = Date.now();
  const helpers = loadSchedulerHelpers(
    makeStorage({ sg_chat_last_progress_at: String(now - 500), sg_chat_last_progress_why: 'local_new' }),
    makeStorage({ sg_chat_last_progress_at: String(now - 40000), sg_chat_last_progress_why: 'session_old' })
  );
  assert.equal(helpers.chatProgressWhyCo(), 'local_new');
});

test('私信内容脚本的 noteChatProgress 也双写 localStorage', () => {
  const start = chatSrc.indexOf('    function noteChatProgress(why)');
  const end = chatSrc.indexOf('    function clearChatLeaseLocal()', start);
  assert.ok(start >= 0 && end > start, '应找到 noteChatProgress');
  const body = chatSrc.slice(start, end);
  assert.match(body, /localStorage\.setItem\(CHAT_PROGRESS_KEY, at\)/);
  assert.match(body, /localStorage\.setItem\('sg_chat_last_progress_why', reason\)/);
  assert.match(body, /sessionStorage\.setItem\(CHAT_PROGRESS_KEY, at\)/);
});

function loadLogger() {
  const listeners = {};
  const eventIds = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    document: { querySelector() { return null; } },
    location: { href: 'https://x.com/i/chat' },
    SgTelemetry: { emit(id) { eventIds.push(id); } }
  };
  ctx.window = ctx;
  ctx.addEventListener = function (type, fn) { listeners[type] = fn; };
  vm.runInNewContext(loggerSrc, ctx);
  return { ctx, listeners, eventIds };
}

test('浏览器噪声不计入 system.logger_error', () => {
  const { ctx, listeners, eventIds } = loadLogger();
  ctx.Logger.error('X', 'ResizeObserver loop completed with undelivered notifications.');
  ctx.Logger.error('X', 'Extension context invalidated.');
  listeners.error({
    message: 'ResizeObserver loop limit exceeded',
    filename: '',
    lineno: 0,
    colno: 0,
    error: { stack: '' }
  });
  assert.deepEqual(eventIds, []);
  assert.equal(ctx.localStorage.getItem('sg_error_log'), null);
});

test('真实错误仍然正常进入 system.logger_error', () => {
  const { ctx, eventIds } = loadLogger();
  ctx.Logger.error('X', 'real scheduler failure');
  assert.deepEqual(eventIds, ['system.logger_error']);
});
