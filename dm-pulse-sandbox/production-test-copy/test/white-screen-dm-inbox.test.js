'use strict';
/**
 * 4.9.145 现场回归：新版 /i/chat 私信列表被调度核心误判“白屏”。
 * 页面明明渲染了会话列表，调度核心却每 60 秒请求一次整页 reload，
 * 正在进行的粉丝扫描/发信因此被打断，随后又被当成假活回收。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scheduler-core.js'), 'utf8');

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

function makeEnv(options) {
  const opts = options || {};
  const found = new Set(opts.selectors || []);
  return {
    document: {
      querySelector(selector) {
        if (selector === 'main') {
          return opts.mainText == null ? null : { innerText: opts.mainText };
        }
        if (selector === '[data-testid="primaryColumn"]') {
          return opts.primaryText == null ? null : { innerText: opts.primaryText };
        }
        return found.has(selector) ? { node: selector } : null;
      }
    },
    window: { location: { pathname: opts.path || '/i/chat' } }
  };
}

function runHealthyCheck(options) {
  return vm.runInNewContext(
    sliceFunction(src, 'isPageHealthyDom') + '\n; isPageHealthyDom',
    makeEnv(options)
  )();
}

test('新版 /i/chat 会话行判定为健康', () => {
  assert.equal(runHealthyCheck({
    selectors: ['a[role="option"][id^="dm-conversation-option-"]']
  }), true);
  assert.equal(runHealthyCheck({
    selectors: ['[role="option"][id^="dm-conversation-option-"]']
  }), true);
  assert.equal(runHealthyCheck({
    selectors: ['[data-testid="DMDrawer"], [data-testid="dm-inbox-panel"]']
  }), true);
});

test('/i/chat 主栏有真实文本时判定为健康', () => {
  assert.equal(runHealthyCheck({
    mainText: 'おねむ 2小时 女の子？ Miru 1天 デートしてくれる？ 気軽にメッセージちょうだいね セフレ募集 1天 よかったらデートしようよ たらまは 1天 あれ？まだかな こっちで待ってるよ'
  }), true);
});

test('报错页 / 空白页不能判定为健康', () => {
  assert.equal(runHealthyCheck({
    mainText: 'Something went wrong. Try again'
  }), false);
  assert.equal(runHealthyCheck({ mainText: '出了点问题，请重试' }), false);
  assert.equal(runHealthyCheck({ mainText: '', path: '/i/chat' }), false);
  assert.equal(runHealthyCheck({ mainText: null, path: '/i/chat' }), false);
});

test('主栏有真实文本的 X 路由都判定为健康（新版已无 primaryColumn）', () => {
  assert.equal(runHealthyCheck({
    path: '/home',
    mainText: '主页时间线真实内容'.repeat(20)
  }), true);
  assert.equal(runHealthyCheck({
    path: '/jakelu133969/followers',
    mainText: '关注者列表真实内容'.repeat(20)
  }), true);
});

test('白屏探针仍然先判 hidden，且保留真白屏自愈', () => {
  const probe = sliceFunction(src, 'coProbeWhiteScreen');
  const hiddenAt = probe.indexOf("document.visibilityState === 'hidden'");
  const healthyAt = probe.indexOf('isPageHealthyDom()');
  assert.ok(hiddenAt > 0, '缺少 hidden 判定');
  assert.ok(healthyAt > 0, '缺少健康判定');
  assert.ok(hiddenAt < healthyAt, 'hidden 判定必须在健康判定之前');
  assert.match(probe, /reason: healReason/);
});
