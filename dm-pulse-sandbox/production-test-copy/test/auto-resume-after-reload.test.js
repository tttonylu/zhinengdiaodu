'use strict';
/**
 * 4.9.155：现场 18:14 之后整页静默——最后一条 why_idle 停在
 * 「软风控 1228s」，十分钟一字不变；页面还活着（page_alive 正常、
 * 引擎 lite 心跳正常），但调度 core 已经不再跑，也没有任何 full 心跳。
 *
 * 根因两条：
 *  1. 整页刷新 / 重启 Chrome 后只看 sg_state.running 决定是否恢复，
 *     而 sg_state.running 会被手动测试等路径写成 false，于是永远停在「待命」；
 *  2. 运行态心跳只在运行中上报，内部一暂停就彻底静默，
 *     OPS 永远显示最后一条旧 why_idle，看起来像「插件在跑」。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');

test('启动写自动模式意图，暂停清掉意图', () => {
  const startAt = src.indexOf('function schedulerStart(');
  const pauseAt = src.indexOf('function schedulerPause(');
  assert.ok(startAt >= 0 && pauseAt > startAt, '应有 start / pause 定义');

  const startBody = src.slice(startAt, src.indexOf('function ', startAt + 10));
  const pauseBody = src.slice(pauseAt, pauseAt + 4000);

  assert.match(startBody, /setAutoIntent\(true\)/, '点启动应记录自动模式意图');
  assert.match(pauseBody, /setAutoIntent\(false\)/, '手动暂停应清除自动模式意图');
});

test('刷新后按意图恢复，且不覆盖用户暂停', () => {
  assert.match(src, /else if \(getAutoIntent\(\) && !isUserPausedFlag\(\)\)/,
    '页面加载后应在「有意图且未暂停」时恢复调度');
  const branchAt = src.indexOf('getAutoIntent() && !isUserPausedFlag()');
  const branch = src.slice(branchAt, branchAt + 700);
  assert.match(branch, /coStartScheduler\(\)/, '恢复分支必须真的拉起调度');
  assert.match(branch, /scheduler\.auto_resume/, '恢复要留遥测，便于 OPS 核对');
});

test('运行态心跳不再只在运行中上报', () => {
  const timerAt = src.indexOf('window._sgRuntimeHbTimer = setInterval');
  assert.ok(timerAt > 0, '应有运行态心跳定时器');
  const body = src.slice(timerAt, timerAt + 700);
  assert.doesNotMatch(body, /if \(S\.running \|\| coRunning\) pushRuntimeHeartbeat/,
    '暂停时也必须上报，否则 OPS 永远停在旧 why_idle');
  assert.match(body, /pushRuntimeHeartbeat\('full', false\)/);
});

test('扩展上下文失效时读 storage 不再抛未捕获异常', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8');
  const at = cfg.indexOf('function getStorage()');
  assert.ok(at >= 0, '应定义 getStorage');
  const body = cfg.slice(at, cfg.indexOf('function isExtContextInvalidated', at));
  assert.match(body, /chrome\.runtime\.id/, '先确认扩展上下文仍然有效');
  assert.match(body, /catch \(e\)/, '读取必须吞掉 Extension context invalidated');
});
