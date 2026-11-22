import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS, createToolHandlers } from '../src/mcp-tools.mjs';
import { SessionRegistry } from '../src/session-registry.mjs';

function fakeBridge(result = {}) {
  const calls = [];
  return {
    calls,
    host: '127.0.0.1',
    port: 47321,
    async request(method, params, options) {
      calls.push({ method, params, options });
      return result;
    }
  };
}

function handlers(bridge, registry) {
  const sessionRegistry = registry || new SessionRegistry();
  if (!registry) {
    sessionRegistry.add({ send() {}, close() {} }, {
      extensionVersion: '0.3.0',
      schema: 'xchat-v2',
      remoteAddress: '127.0.0.1'
    });
  }
  return createToolHandlers({
    bridge,
    registry: sessionRegistry,
    serverVersion: '0.1.0'
  });
}

test('tool catalog is exactly six tools, five read-only plus one explicit open', () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((tool) => tool.name),
    ['health', 'list_sessions', 'run_pulse', 'run_deep_pulse', 'read_unread_conversation', 'get_coexistence_state']
  );
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(
      tool.annotations.readOnlyHint,
      tool.name !== 'read_unread_conversation',
      tool.name
    );
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});

test('health reports read-only mode and loopback binding', async () => {
  const result = await handlers(fakeBridge({})).health();

  assert.equal(result.readOnly, true);
  assert.equal(result.mcpEnabled, true);
  assert.equal(result.bridge.host, '127.0.0.1');
  assert.equal(result.sessions, 1);
  assert.equal(result.status, 'ok');
});

test('health reports degraded when no extension is connected', async () => {
  const result = await handlers(fakeBridge({}), new SessionRegistry()).health();

  assert.equal(result.status, 'degraded');
  assert.equal(result.sessions, 0);
});

test('run_pulse clamps budget and interval into safe bounds', async () => {
  const bridge = fakeBridge({ verdict: 'unread_found' });
  const tool = handlers(bridge);

  await tool.run_pulse({ budgetMs: 999999, intervalMs: 1 });
  assert.deepEqual(bridge.calls[0].params, { budgetMs: 30000, intervalMs: 200, deep: false });

  await tool.run_pulse({ budgetMs: 10, intervalMs: 999999 });
  assert.deepEqual(bridge.calls[1].params, { budgetMs: 1000, intervalMs: 5000, deep: false });
});

test('run_pulse applies defaults when params are omitted', async () => {
  const bridge = fakeBridge({ verdict: 'no_unread_confirmed' });
  const tool = handlers(bridge);

  await tool.run_pulse({});

  assert.deepEqual(bridge.calls[0].params, { budgetMs: 15000, intervalMs: 500, deep: false });
});

test('run_deep_pulse clamps scroll controls and requests deep mode', async () => {
  const bridge = fakeBridge({ verdict: 'unread_found' });
  const tool = handlers(bridge);

  await tool.run_deep_pulse({
    budgetMs: 999999,
    intervalMs: 1,
    maxScrolls: 99,
    scrollStepPx: 1,
    settleMs: 1
  });

  assert.deepEqual(bridge.calls[0].params, {
    budgetMs: 30000,
    intervalMs: 200,
    deep: true,
    maxScrolls: 12,
    scrollStepPx: 120,
    settleMs: 250
  });
});

test('run_deep_pulse applies defaults when params are omitted', async () => {
  const bridge = fakeBridge({ verdict: 'no_unread_confirmed' });
  const tool = handlers(bridge);

  await tool.run_deep_pulse({});

  assert.deepEqual(bridge.calls[0].params, {
    budgetMs: 15000,
    intervalMs: 500,
    deep: true,
    maxScrolls: 3,
    scrollStepPx: 600,
    settleMs: 700
  });
});

test('read_unread_conversation requires explicit allowOpen=true', async () => {
  const bridge = fakeBridge({ verdict: 'conversation_probed' });
  const tool = handlers(bridge);

  await assert.rejects(() => tool.read_unread_conversation({}), /allowOpen=true/);
  await assert.rejects(() => tool.read_unread_conversation({ allowOpen: false }), /allowOpen=true/);
  assert.equal(bridge.calls.length, 0);

  await tool.read_unread_conversation({ allowOpen: true, maxWaitMs: 999999 });
  assert.deepEqual(bridge.calls[0].params, { allowOpen: true, maxWaitMs: 30000 });
  assert.equal(bridge.calls[0].method, 'read_unread_conversation');
});

test('read_unread_conversation strips message text and identity fields', async () => {
  const bridge = fakeBridge({
    verdict: 'conversation_probed',
    bubbleCount: 2,
    peerBubbles: 2,
    text: '私有正文',
    messageText: '私有正文',
    handle: '@leak',
    content: '私有正文'
  });

  const result = await handlers(bridge).read_unread_conversation({ allowOpen: true });

  assert.equal(result.verdict, 'conversation_probed');
  assert.equal(result.bubbleCount, 2);
  assert.equal(result.text, undefined);
  assert.equal(result.messageText, undefined);
  assert.equal(result.handle, undefined);
  assert.equal(result.content, undefined);
});

test('run_pulse strips sensitive fields from the extension result', async () => {
  const bridge = fakeBridge({
    verdict: 'unread_found',
    visibleRows: 12,
    rows: [{ conversationKey: 'conversation-abc', handle: '@leak', messageText: 'hi' }],
    debug: { cookie: 'ct0=abc', token: 'secret' }
  });

  const result = await handlers(bridge).run_pulse({});

  assert.equal(result.verdict, 'unread_found');
  assert.equal(result.rows[0].conversationKey, 'conversation-abc');
  assert.equal(result.rows[0].handle, undefined);
  assert.equal(result.rows[0].messageText, undefined);
  assert.equal(result.debug.cookie, undefined);
  assert.equal(result.debug.token, undefined);
});

test('list_sessions never includes token or remote address', async () => {
  const registry = new SessionRegistry();
  registry.add({ send() {}, close() {} }, {
    extensionVersion: '0.3.0',
    schema: 'xchat-v2',
    remoteAddress: '127.0.0.1',
    token: 'secret'
  });

  const result = await handlers(fakeBridge({}), registry).list_sessions();

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].token, undefined);
  assert.equal(result.sessions[0].remoteAddress, undefined);
});

test('get_coexistence_state forwards a read-only probe and sanitizes it', async () => {
  const bridge = fakeBridge({
    urlPath: '/i/chat',
    surface: 'list',
    sandboxInjected: true,
    productionInboxWatchPresent: true,
    productionInboxWatchReady: true,
    readOnly: true,
    leak: 'https://x.com/i/chat/9?token=abc'
  });

  const result = await handlers(bridge).get_coexistence_state({});

  assert.equal(bridge.calls[0].method, 'get_coexistence_state');
  assert.equal(result.urlPath, '/i/chat');
  assert.equal(result.readOnly, true);
  assert.equal(result.leak, '/i/chat/9');
});
