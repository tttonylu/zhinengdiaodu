'use strict';
/**
 * 4.9.138：点赞日预算越权。
 * 现场 likes 12/12 后又给新帖点了一个赞，根因是 canLikeNow 只查分片/冷却。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const trackerSrc = fs.readFileSync(path.join(ROOT, 'nurture', 'nurture-tracker.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'nurture', 'nurture-engine.js'), 'utf8');
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
            likes: { min: 2, max: 2 }, comments: { min: 2, max: 2 },
            reposts: { min: 1, max: 1 }, trends: { min: 1, max: 1 },
            profiles: { min: 1, max: 1 }, enters: { min: 1, max: 1 }
          },
          hourlyBudget: {
            likes: { min: 40, max: 40 }, comments: { min: 2, max: 2 },
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

test('版本不低于 4.9.138', () => {
  assert.match(manifest.version, /^4\.9\.(13[8-9]|1[4-9]\d|[2-9]\d)$/);
});

test('点赞日预算用完后，分片和冷却仍有余量也不得再点赞', () => {
  const T = loadTracker();
  assert.equal(T.canLikeNow(), true);
  T.didOne('likes');
  assert.equal(T.canLikeNow(), true);
  T.didOne('likes');
  assert.equal(T.getStats().daily.used.likes, 2);
  assert.equal(T.canLikeNow(), false);
});

test('clickLike 入口还有一道 canDo 防御', () => {
  const block = engineSrc.slice(engineSrc.indexOf('async function clickLike()'), engineSrc.indexOf('function _nr_findReplyBtn'));
  assert.match(block, /canDo\('likes'\)/);
});
