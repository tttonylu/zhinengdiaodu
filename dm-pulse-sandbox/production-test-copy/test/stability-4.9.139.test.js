'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(ROOT, 'nurture', 'nurture-engine.js'), 'utf8');
const trackerSrc = fs.readFileSync(path.join(ROOT, 'nurture', 'nurture-tracker.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function loadTracker() {
  const store = new Map();
  const ctx = {
    console,
    Date,
    localStorage: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); }
    },
    window: { addEventListener() {} },
    self: {},
    NurtureConfig: {
      getCfg() {
        return {
          dailyBudget: {
            likes: { min: 12, max: 12 }, comments: { min: 2, max: 2 },
            reposts: { min: 1, max: 1 }, trends: { min: 5, max: 5 },
            profiles: { min: 2, max: 2 }, enters: { min: 5, max: 5 }
          },
          hourlyBudget: {
            likes: { min: 2, max: 2 }, comments: { min: 2, max: 2 },
            reposts: { min: 1, max: 1 }, trends: { min: 1, max: 1 },
            profiles: { min: 1, max: 1 }, enters: { min: 1, max: 1 }
          },
          likeCooldownMin: 0,
          commentCooldownMin: 0,
          segmentMinutes: 15
        };
      }
    }
  };
  return vm.runInNewContext(trackerSrc + '\nNurtureTracker;', ctx);
}

test('版本升到 4.9.157', () => {
  assert.equal(manifest.version, '4.9.157');
});

test('评论写入失败后进入退避，成功评论后解除', () => {
  const T = loadTracker();
  assert.equal(T.canCommentNow(), true);
  T.noteCommentFailure(10);
  assert.equal(T.canCommentNow(), false);
  T.didOne('comments');
  assert.equal(T.canCommentNow(), true);
});

test('评论写入按原生输入、粘贴、DOM 事件逐级兜底', () => {
  const insert = engineSrc.slice(
    engineSrc.indexOf('async function _nr_insertCommentText'),
    engineSrc.indexOf('async function _nr_leaveCommentComposer')
  );
  const nativeAt = insert.indexOf("execCommand('insertText'");
  const pasteAt = insert.indexOf("new ClipboardEvent('paste'");
  const domAt = insert.indexOf('editor.textContent = want');
  assert.ok(nativeAt >= 0, '必须有 insertText 写入');
  assert.ok(pasteAt > nativeAt, '粘贴必须在原生输入之后兜底');
  assert.ok(domAt > pasteAt, 'DOM 事件必须在粘贴之后兜底');
  assert.match(insert, /_nr_normCommentText\(got\) === want/);
});

test('评论框优先选择 tweetTextarea 与 role=textbox', () => {
  assert.match(engineSrc, /\[data-testid\^="tweetTextarea_"\]\[contenteditable="true"\]/);
  assert.match(engineSrc, /\[contenteditable="true"\]\[role="textbox"\]/);
});

test('评论写入失败会触发退避并退出当前评论框', () => {
  assert.match(engineSrc, /评论-写入失败[\s\S]{0,160}noteCommentFailure\(10\)/);
});
