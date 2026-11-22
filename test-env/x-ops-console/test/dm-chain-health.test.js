const test = require('node:test');
const assert = require('node:assert');
const { buildIssues, buildPipeline } = require('../src/services/dm-chain-health');

function ev(event_id, meta, at, handle) {
  return {
    event_id,
    account_handle: handle || 'jakelu133969',
    created_at: at || '2026-11-13 00:20:00',
    meta: meta || {},
  };
}

test('page_hidden 连续出现 → warn，并说明不是对方没回', () => {
  const { issues } = buildIssues({
    events: [
      ev('chat.inbox_pulse', { hidden: true, reason: 'page_hidden_deferred' }),
      ev('chat.inbox_pulse', { reason: 'deferred_not_visible' }),
    ],
    roster: [],
    account: null,
  });
  const it = issues.find((i) => i.code === 'page_hidden_stuck');
  assert.ok(it);
  assert.equal(it.severity, 'warn');
  assert.match(it.reason_zh, /不是对方没回/);
  assert.equal(it.count, 2);
});

test('page_hidden 连续 90 拍才升级为 error', () => {
  const { issues } = buildIssues({
    events: [
      ev('chat.inbox_pulse', { hidden: true, reason: 'page_hidden_deferred', hidden_streak: 90 }),
      ev('chat.inbox_pulse', { hidden: true, reason: 'page_hidden_deferred', hidden_streak: 91 }),
    ],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'page_hidden_stuck');
  assert.ok(it);
  assert.equal(it.severity, 'error');
});

test('对方关闭收件箱是 info 终态，不算发送失败', () => {
  const { issues } = buildIssues({
    events: [
      ev('chat.inbox_tick', {
        action: 'send', sent: false, send_error: 'peer_inbox_closed',
        route: 'kick', target: 'closed_user', peer_id: '123',
      }),
    ],
    roster: [],
  });
  assert.ok(!issues.find((i) => i.code === 'dm_send_failed'));
  const it = issues.find((i) => i.code === 'dm_peer_inbox_closed');
  assert.ok(it);
  assert.equal(it.severity, 'info');
});

test('真正的输入框/气泡确认失败仍是 error', () => {
  const { issues } = buildIssues({
    events: [
      ev('chat.inbox_tick', {
        action: 'send', sent: false, send_error: 'no_composer',
        route: 'ad', target: 'real_failure', peer_id: '456',
      }),
    ],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'dm_send_failed');
  assert.ok(it);
  assert.equal(it.severity, 'error');
});

test('nav 被拦住单独成项，不能混进“没回复”', () => {
  const { issues } = buildIssues({
    events: [ev('chat.inbox_pulse', {
      reason: 'nav_budget_wait', target: 'ksp0cy', peer_id: '2074013208516665344',
      nav_guard_reason: 'cooldown',
    })],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'conversation_nav_blocked');
  assert.ok(it);
  assert.deepEqual(it.handles, ['ksp0cy']);
});

test('读到正文失败与身份未证明分开统计', () => {
  const { issues } = buildIssues({
    events: [
      ev('chat.inbox_tick', { target: 'a', reply_verdict: 'reply_read_failed', dom_leaves: 0, dom_articles: 0 }),
      ev('chat.inbox_tick', { target: 'b', identity_ok: false, identity_reason: 'header_mismatch' }),
    ],
    roster: [],
  });
  assert.ok(issues.find((i) => i.code === 'reply_read_failed'));
  assert.ok(issues.find((i) => i.code === 'identity_unproven'));
});

test('关注页真的走错账号才报 handle 不匹配', () => {
  const { issues } = buildIssues({
    events: [ev('follow.page_handle_mismatch', {
      step: 'scan_followers',
      expected: 'followers:fx8qktdnsx67753',
      actual: 'profile:someone_else',
      page: '/someone_else',
      cells: 0,
    })],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'follow_page_handle_mismatch');
  assert.ok(it);
  assert.equal(it.evidence[0].cells, 0);
  assert.match(it.evidence[0].expected, /fx8qktdnsx67753/);
});

test('粉丝列表加载不出 UserCell 单独成项，不再冒充 handle 不匹配', () => {
  const { issues } = buildIssues({
    events: [ev('follow.followers_loading_wait', {
      step: 'scan_followers',
      expected: 'followers:fx8qktdnsx67753',
      actual: 'followers:fx8qktdnsx67753',
      page: '/fx8qktdnsx67753/followers',
      cells: 0,
      mismatch_count: 9,
      busy: 1,
    })],
    roster: [],
  });
  assert.ok(issues.find((i) => i.code === 'follow_followers_loading_stuck'));
  assert.ok(!issues.find((i) => i.code === 'follow_page_handle_mismatch'));
});

test('0 Followers 是业务结果，不报故障', () => {
  const { issues } = buildIssues({
    events: [ev('follow.followers_empty', { creator: 'fx8qktdnsx67753', cells: 0 })],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'follow_followers_empty');
  assert.ok(it);
  assert.equal(it.severity, 'warn');
});

test('白屏自愈循环单独点名', () => {
  const { issues } = buildIssues({
    events: [
      ev('system.logger_warn', { mod: 'Heal', msg: '白屏≥45s，请求 sg_request_heal reason=white_screen' }),
      ev('system.logger_warn', { mod: 'Heal', msg: '白屏≥45s，请求 sg_request_heal reason=white_screen' }),
      ev('system.logger_warn', { mod: 'Heal', msg: '白屏≥45s，请求 sg_request_heal reason=white_screen' }),
    ],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'white_screen_loop');
  assert.ok(it);
  assert.equal(it.severity, 'error');
});

test('守箱心跳在但脉冲超 5 分钟没跑 → 明确点名', () => {
  const now = Date.parse('2026-11-13T00:50:00+08:00');
  const { issues } = buildIssues({
    events: [ev('chat.inbox_loop', {
      running: true,
      paused_reason: '',
      last_pulse_at: now - 8 * 60 * 1000,
      hidden: false,
      path: '/i/chat',
    })],
    roster: [],
    now,
  });
  const it = issues.find((i) => i.code === 'inbox_pulse_stale');
  assert.ok(it);
  assert.equal(it.evidence[0].age_sec, 480);
});

test('夜间时段外暂停是业务规则，标 info 不是 bug', () => {
  const { issues } = buildIssues({
    events: [ev('chat.inbox_loop', { running: true, paused_reason: 'outside_chat_hours', test_24h: false })],
    roster: [],
  });
  const it = issues.find((i) => i.code === 'chat_paused_outside_hours');
  assert.ok(it);
  assert.equal(it.severity, 'info');
});

test('关注日计数未跨日归零能被发现', () => {
  const { issues } = buildIssues({
    events: [],
    roster: [],
    account: { x_handle: 'jakelu133969', followed_today: 82, followed_today_date: '2026-11-12' },
    now: Date.parse('2026-11-13T00:30:00+08:00'),
  });
  assert.ok(issues.find((i) => i.code === 'follow_daily_not_rolled'));
});

test('链路漏斗按回复结论和闸门聚合', () => {
  const out = buildPipeline({
    hours: 1,
    events: [
      ev('chat.inbox_tick', { reply_verdict: 'reply_detected', action: 'send', sent: true, route: 'ad', open_mode: 'direct' }),
      ev('chat.inbox_tick', { reply_verdict: 'no_new_reply', action: 'skip', send_gate: 'await_reply' }),
      ev('chat.inbox_pulse', { scan: { rows: 12, candidates: 3 } }),
    ],
    roster: [
      { round: 0, queue_status: 'pending' },
      { round: 1, queue_status: 'pending' },
      { round: 3, queue_status: 'done' },
    ],
  });
  assert.equal(out.ticks, 2);
  assert.equal(out.sent, 1);
  assert.equal(out.reply.reply_detected, 1);
  assert.equal(out.reply.no_new_reply, 1);
  assert.equal(out.send_gate[0].gate, 'await_reply');
  assert.equal(out.routes.ad, 1);
  assert.equal(out.roster.ice_pending, 1);
  assert.equal(out.roster.ad_pending, 1);
});
