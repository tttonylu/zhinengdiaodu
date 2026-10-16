/* Pure checks for deriveChatState (no native sqlite required locally) */
const { deriveChatState } = require('../src/repositories/runtime-status-repo');

function parseSeenMs(s) {
  const m = String(s || '').match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 8, +(m[5] || 0), +(m[6] || 0));
}

let d = deriveChatState({ auto_mode: 1, running_module: 'chat' }, { parseSeenMs, now: Date.now() });
if (d.chat_state !== 'running') throw new Error('running ' + d.chat_state);

d = deriveChatState({ auto_mode: 1, running_module: '', why_idle: '私信冷却 50分' }, { parseSeenMs, now: Date.now() });
if (d.chat_state !== 'idle') throw new Error('idle ' + d.chat_state);

d = deriveChatState({ auto_mode: 0, running_module: '' }, { parseSeenMs, now: Date.now() });
if (d.chat_state !== 'off') throw new Error('off ' + d.chat_state);

d = deriveChatState({
  auto_mode: 1,
  last_cmd_issued_at: '2026/8/2 09:02:00',
  last_cmd_acked_at: null,
}, { parseSeenMs, now: Date.UTC(2026, 7, 2, 1, 3, 0) });
if (!d.cmd_unconfirmed) throw new Error('unconfirmed expected');

d = deriveChatState({
  auto_mode: 1,
  running_module: 'chat',
  last_cmd_issued_at: '2026/8/2 09:02:00',
  last_cmd_acked_at: '2026/8/2 09:02:20',
}, { parseSeenMs, now: Date.UTC(2026, 7, 2, 1, 3, 0) });
if (d.cmd_unconfirmed || d.cmd_pending) throw new Error('acked should be clear');
if (d.chat_state !== 'running') throw new Error('chat after ack');

console.log('OK deriveChatState checks passed');
