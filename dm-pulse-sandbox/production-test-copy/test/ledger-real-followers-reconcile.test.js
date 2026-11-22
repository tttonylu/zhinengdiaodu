'use strict';

/**
 * 4.9.126：台账必须以「真实粉丝列表」为准。
 * - 本次全量扫到的人 → 刷新 lastSeenOnFollowersAt；
 * - 有私信历史但没再出现 → leftFollowers（保留历史，不再进队列）；
 * - 从没联系过的幽灵条目 → 直接从目标库删除；
 * - 队列内 pending/deferred 但没再出现 → skipped/left_followers；
 * - 浅扫（cells 明显少于主页 F）一律不动台账。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');

function extractFn(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  assert.ok(start > 0, '缺少函数 ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('函数体不闭合: ' + name);
}

function normalizeHandle(h) {
  return String(h || '').replace(/^@/, '').toLowerCase().trim();
}

function runReconcile(opts) {
  const state = {
    db: JSON.parse(JSON.stringify(opts.db || {})),
    queue: JSON.parse(JSON.stringify(opts.queue || { items: [] })),
    seen: (opts.seen || []).slice(),
    telemetry: []
  };
  const fnSrc = extractFn(chatSrc, 'reconcileTargetDbToRealFollowers');
  const factory = new Function(
    'getSessionList', 'normalizeChatHandle', 'loadTargetDB', 'saveTargetDB',
    'loadIceTaskQueue', 'saveIceTaskQueue', 'SgTelemetry', 'console',
    'return (' + fnSrc + ');'
  );
  const fn = factory(
    () => state.seen,
    normalizeHandle,
    () => state.db,
    (db) => { state.db = db; },
    () => state.queue,
    (q) => { state.queue = q; },
    { emit: (name, payload) => state.telemetry.push({ name, payload }) },
    { log() {}, warn() {}, error() {} }
  );
  const res = fn(opts.reason || 'bottom_reached');
  return { res, state };
}

test('真实粉丝对账：扫到的保留、有历史的标取关、无历史的删除', () => {
  const { res, state } = runReconcile({
    seen: ['@Alice', 'bob'],
    db: {
      alice: { firstSeen: 1 },
      bob: { iceSentAt: 111 },
      carol: { iceSentAt: 222, round: 1 },
      dave: { firstSeen: 333 }
    }
  });
  assert.equal(res.ok, true);
  assert.equal(res.seen, 2);
  assert.equal(res.kept, 2);
  assert.equal(res.markedLeft, 1);
  assert.equal(res.removed, 1);

  assert.ok(state.db.alice, 'alice 仍在粉丝列表 → 必须保留');
  assert.ok(state.db.bob, 'bob 仍在粉丝列表 → 必须保留');
  assert.ok(state.db.alice.lastSeenOnFollowersAt > 0, '扫到的人要刷新 lastSeenOnFollowersAt');
  assert.equal(state.db.alice.leftFollowers, false);

  assert.equal(state.db.carol.leftFollowers, true, '有私信历史但没扫到 → 标取关，保留历史');
  assert.ok(state.db.carol.leftFollowersAt > 0);
  assert.equal(state.db.carol.iceSentAt, 222, '取关不能抹掉历史');

  assert.equal(state.db.dave, undefined, '从没联系过又不在粉丝列表 → 直接删除');
});

test('真实粉丝对账：队列里没再出现的人不再开人', () => {
  const { res, state } = runReconcile({
    seen: ['alice'],
    db: { alice: {}, carol: { iceSentAt: 1 } },
    queue: {
      items: [
        { handle: 'alice', status: 'pending' },
        { handle: 'carol', status: 'pending' },
        { handle: 'ghost999', status: 'deferred' },
        { handle: 'bob', status: 'done' }
      ]
    }
  });
  assert.equal(res.queueSkipped, 2);
  const byHandle = {};
  state.queue.items.forEach((it) => { byHandle[normalizeHandle(it.handle)] = it; });
  assert.equal(byHandle.alice.status, 'pending', '仍在粉丝列表的 pending 不能被误杀');
  assert.equal(byHandle.carol.status, 'skipped');
  assert.equal(byHandle.carol.reason, 'left_followers');
  assert.equal(byHandle.ghost999.status, 'skipped');
  assert.equal(byHandle.ghost999.reason, 'left_followers');
  assert.equal(byHandle.bob.status, 'done', '已完成的历史条目不动');
});

test('真实粉丝对账：空扫描直接放弃，不许清空台账', () => {
  const { res, state } = runReconcile({
    seen: [],
    db: { alice: {}, bob: { iceSentAt: 1 } }
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_scan');
  assert.deepEqual(Object.keys(state.db).sort(), ['alice', 'bob']);
});

test('真实粉丝对账：发出 chat.ledger_reconcile 遥测', () => {
  const { state } = runReconcile({
    seen: ['alice'],
    db: { alice: {}, bob: { iceSentAt: 1 } }
  });
  const ev = state.telemetry.find((t) => t.name === 'chat.ledger_reconcile');
  assert.ok(ev, '必须上报 chat.ledger_reconcile');
  assert.equal(ev.payload.seen, 1);
  assert.equal(ev.payload.removed, 0);
  assert.equal(ev.payload.marked_left, 1);
});

test('读全粉丝列表才触发真实对账（触底，或 cells 覆盖主页 F）', () => {
  const start = chatSrc.indexOf('// 4.9.126：读全了粉丝列表才按真实粉丝对账');
  assert.ok(start > 0, '缺少 4.9.126 对账闸门');
  const gateStart = chatSrc.indexOf('var isBottomReason =', start - 1200);
  assert.ok(gateStart > 0, '缺少封口完整性判定');
  const body = chatSrc.slice(gateStart, start + 600);
  assert.match(body, /if \(isFullSeal && !profileGap && cellsSeen > 0\)/);
  assert.match(body, /reconcileTargetDbToRealFollowers\(reason \|\| 'seal'\)/);
  // 不能只看 reason：浅扫封口也可能已经滚满全部粉丝格
  assert.match(body, /var cellsCoverProfile = profileFollowers > 0 && cellsSeen > 0 && cellsSeen \+ 2 >= profileFollowers;/);
  assert.match(body, /var isFullSeal = isBottomReason \|\| cellsCoverProfile;/);
});

test('已取关条目不得进入台账快照（否则 OPS/allHandles 又把人带回去）', () => {
  const start = chatSrc.indexOf('function buildFanLedgerSnapshot(');
  assert.ok(start > 0);
  const body = chatSrc.slice(start, start + 1600);
  assert.match(body, /var leftSet = \{\}/);
  assert.match(body, /if \(leftSet\[h\]\) return;/);
  assert.match(body, /String\(qIt\.reason \|\| ''\) === 'left_followers'/);
});

test('已取关条目不再进入任何破冰队列', () => {
  const start = chatSrc.indexOf('function classifyFanRosterAction(');
  assert.ok(start > 0);
  const body = chatSrc.slice(start, start + 900);
  assert.match(body, /if \(entry\.leftFollowers\) \{/);
  assert.match(body, /kind: 'left_followers'/);
});

test('OPS 回灌时取关行不能被重新写进本地台账', () => {
  const start = chatSrc.indexOf('function seedOpsRosterDebtToQueue(');
  assert.ok(start > 0);
  const body = chatSrc.slice(start, start + 800);
  assert.match(body, /if \(it\.left_followers \|\| it\.leftFollowers\) continue;/);
});

test('台账行数明显多于主页粉丝时强制全量重扫（否则永远只浅扫顶部）', () => {
  assert.match(chatSrc, /function maybeForceFullRosterReconcile\(/);
  const start = chatSrc.indexOf('function maybeForceFullRosterReconcile(');
  const body = chatSrc.slice(start, start + 2600);
  // 只数在册人数：已取关历史留在库里，不能算进溢出，否则对账后每 30 分钟白滚一次
  assert.match(body, /if \(!\(activeTotal > F \+ 3\)\) return false;/);
  assert.match(body, /if \(!\(dbNow\[k\] && dbNow\[k\]\.leftFollowers\)\) activeTotal\+\+;/);
  assert.match(body, /clearFanRosterBaseline\('ledger_overflow_rescan'\)/);
  assert.match(body, /clearIceTaskQueue\('ledger_overflow_rescan'\)/);
  assert.match(body, /chat\.fan_roster_overflow_rescan/);
  // 必须有冷却，防止每轮都清基线反复滚列表
  assert.match(body, /30 \* 60 \* 1000/);
  // 必须置「强制全量」标记，禁止 hasFanRosterBaseline 的推断副作用立刻补回基线
  assert.match(body, /sessionStorage\.setItem\('sg_roster_force_full_rescan', '1'\)/);
  assert.match(chatSrc, /if \(sessionStorage\.getItem\('sg_roster_force_full_rescan'\) === '1'\) return false;/);
  // 真正全量封口对账成功后要清掉标记
  assert.match(chatSrc, /sessionStorage\.removeItem\('sg_roster_force_full_rescan'\)/);
  // 必须在扫描段调用
  assert.match(chatSrc, /try \{ maybeForceFullRosterReconcile\(\); \} catch \(eOverflow\) \{\}/);
});
