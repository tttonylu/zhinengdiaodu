import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, 'server.mjs');
const TOKEN = 'integration-token-abcdefghijklmnop';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startMcp(port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      DM_PULSE_BRIDGE_PORT: String(port),
      DM_PULSE_BRIDGE_TOKEN: TOKEN
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const pending = new Map();
  let nextId = 0;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {});

  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('mcp request timed out: ' + method));
      }, 8000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  return { child, call, notify };
}

function connectExtension(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/bridge');
    const inbox = [];
    const waiters = [];

    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else inbox.push(frame);
    });

    socket.once('error', reject);
    socket.once('open', () => {
      const next = () => inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((accept) => waiters.push(accept));
      resolve({ socket, next });
    });
  });
}

test('real stdio MCP server exposes the six tools', async (t) => {
  const port = await freePort();
  const mcp = startMcp(port);
  t.after(() => mcp.child.kill());

  const init = await mcp.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' }
  });
  assert.equal(init.serverInfo.name, 'dm-pulse-bridge');
  mcp.notify('notifications/initialized', {});

  const list = await mcp.call('tools/list', {});
  assert.deepEqual(
    list.tools.map((tool) => tool.name),
    ['health', 'list_sessions', 'run_pulse', 'run_deep_pulse', 'read_unread_conversation', 'get_coexistence_state']
  );

  const health = await mcp.call('tools/call', { name: 'health', arguments: {} });
  const healthBody = JSON.parse(health.content[0].text);
  assert.equal(healthBody.readOnly, true);
  assert.equal(healthBody.sessions, 0);
  assert.equal(healthBody.bridge.host, '127.0.0.1');
});

test('stdio MCP forwards run_pulse to a connected extension and back', async (t) => {
  const port = await freePort();
  const mcp = startMcp(port);
  t.after(() => mcp.child.kill());

  await mcp.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' }
  });
  mcp.notify('notifications/initialized', {});

  const extension = await connectExtension(port);
  t.after(() => extension.socket.close());

  extension.socket.send(JSON.stringify({
    type: 'hello',
    token: TOKEN,
    client: { extensionVersion: '0.3.0', schema: 'xchat-v2' }
  }));
  const hello = await extension.next();
  assert.equal(hello.type, 'hello_ok');

  const requestPromise = extension.next();
  const toolPromise = mcp.call('tools/call', {
    name: 'run_pulse',
    arguments: { budgetMs: 2000, intervalMs: 300 }
  });

  const request = await requestPromise;
  assert.equal(request.method, 'run_pulse');
  assert.deepEqual(request.params, { budgetMs: 2000, intervalMs: 300, deep: false });

  extension.socket.send(JSON.stringify({
    type: 'response',
    id: request.id,
    ok: true,
    result: {
      verdict: 'unread_found',
      visibleRows: 12,
      unreadRows: 1,
      handle: '@leak',
      debugUrl: 'https://x.com/i/chat/5?token=secret'
    }
  }));

  const response = await toolPromise;
  const body = JSON.parse(response.content[0].text);
  assert.equal(body.verdict, 'unread_found');
  assert.equal(body.visibleRows, 12);
  assert.equal(body.handle, undefined);
  assert.equal(body.debugUrl, '/i/chat/5');
});
