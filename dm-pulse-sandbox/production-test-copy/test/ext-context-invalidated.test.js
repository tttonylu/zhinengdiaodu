'use strict';
/**
 * 4.9.147：扩展重载后旧内容脚本变成孤儿，读取 chrome.runtime.onMessage
 * 会抛 "Extension context invalidated"，错误面板被刷红，定时器还在跑。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const coreSrc = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8');

function sliceFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '应定义 ' + name);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 未闭合');
}

function loadAlive(chrome) {
  return vm.runInNewContext(
    'var _sgOrphanLogged = false;\n'
      + sliceFunction(coreSrc, 'sgExtensionAlive') + '\n'
      + 'sgExtensionAlive',
    { chrome }
  );
}

test('扩展上下文判活：有 runtime.id 才算存活', () => {
  assert.equal(loadAlive({ runtime: { id: 'abc' } })(), true);
});

test('扩展上下文判活：runtime 缺失或读取抛错都算失效', () => {
  const fn = vm.runInNewContext(
    sliceFunction(coreSrc, 'sgExtensionAlive') + '\n; sgExtensionAlive',
    {
      chrome: {
        get runtime() {
          throw new Error('Extension context invalidated.');
        }
      }
    }
  );
  assert.equal(fn(), false);
  const fn2 = vm.runInNewContext(
    sliceFunction(coreSrc, 'sgExtensionAlive') + '\n; sgExtensionAlive',
    {}
  );
  assert.equal(fn2(), false);
});

test('孤儿脚本会停掉调度定时器，只告警一次', () => {
  const cleared = [];
  const warnings = [];
  const ctx = {
    chrome: {},
    window: {},
    console: { warn: (m) => warnings.push(m) },
    coTimer: 1,
    coWdTimer: 2,
    clearInterval: (t) => cleared.push(t)
  };
  const fn = vm.runInNewContext(
    'var _sgOrphanLogged = false;\n'
      + sliceFunction(coreSrc, 'sgExtensionAlive') + '\n'
      + sliceFunction(coreSrc, 'sgStopIfOrphaned') + '\n'
      + 'sgStopIfOrphaned',
    ctx
  );
  assert.equal(fn('test'), true);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /扩展已重载/);
});

test('tick 与 watchdog 都带孤儿保护', () => {
  const tick = sliceFunction(coreSrc, 'coTickTimed');
  assert.ok(tick.indexOf("sgStopIfOrphaned('coTick')") > 0);
  assert.ok(tick.indexOf("sgStopIfOrphaned('coTick')") < tick.indexOf('coTick();'));
  const watchdogAt = coreSrc.indexOf("sgStopIfOrphaned('watchdog')");
  assert.ok(watchdogAt > 0, 'watchdog 缺少孤儿保护');
});

test('消息监听注册失败不再抛到错误面板', () => {
  const start = coreSrc.indexOf('// ==================== 消息监听 ====================');
  const end = coreSrc.indexOf("window.addEventListener('beforeunload', saveSG);", start);
  const block = coreSrc.slice(start, end);
  assert.match(block, /^\s*try \{/m);
  assert.match(block, /catch \(eMsgBind\)/);
  assert.match(block, /sgStopIfOrphaned\('onMessageBind'\)/);
  assert.match(block, /消息监听注册失败/);
});

test('配置模块识别失效上下文，不再用 console.error 刷错误面板', () => {
  const helper = sliceFunction(configSrc, 'isExtContextInvalidated');
  assert.match(helper, /Extension context invalidated/);
  const loadIdx = configSrc.indexOf('async function loadFromStorage()');
  const loadBlock = configSrc.slice(loadIdx, loadIdx + 3000);
  assert.match(loadBlock, /if \(isExtContextInvalidated\(e\)\)/);
  assert.match(loadBlock, /扩展已重载，本页沿用默认配置/);
});
