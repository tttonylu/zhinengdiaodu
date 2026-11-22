import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { BridgeServer, BridgeError } from '../src/bridge-server.mjs';

const TOKEN = 'test-token-1234567890';

async function startServer(options = {}) {
  const server = new BridgeServer({
    port: 0,
    token: TOKEN,
    heartbeatTimeoutMs: 60000,
    requestTimeoutMs: 800,
    ...options
  });
  await server.listen();
  return server;
}

function connect(server) {
  const socket = new WebSocket(server.url);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(String(raw))));
  });
}

async function handshake(server, overrides = {}) {
  const socket = await connect(server);
  const reply = nextMessage(socket);
  socket.send(JSON.stringify({
    type: 'hello',
    token: TOKEN,
    client: { extensionVersion: '0.3.0', schema: 'xchat-v2' },
    ...overrides
  }));
  return { socket, reply: await reply };
}

test('listens only on 127.0.0.1 with the requested port', async () => {
  const server = await startServer();
  try {
    assert.equal(server.host, '127.0.0.1');
    assert.match(server.url, /^ws:\/\/127\.0\.0\.1:\d+\/bridge$/);
  } finally {
    await server.close();
  }
});

test('rejects a connection without a valid token', async () => {
  const server = await startServer();
  try {
    const socket = await connect(server);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'hello', token: 'wrong-token' }));
    const code = await closed;

    assert.equal(code, 4001);
    assert.equal(server.registry.size, 0);
  } finally {
    await server.close();
  }
});

test('rejects a first frame that is not hello', async () => {
  const server = await startServer();
  try {
    const socket = await connect(server);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'heartbeat' }));

    assert.equal(await closed, 4002);
  } finally {
    await server.close();
  }
});

test('accepts a valid hello and replies with a session id', async () => {
  const server = await startServer();
  try {
    const { socket, reply } = await handshake(server);
    assert.equal(reply.type, 'hello_ok');
    assert.match(reply.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(server.registry.size, 1);
    socket.close();
  } finally {
    await server.close();
  }
});

test('run_pulse round-trips a request and correlates the response id', async () => {
  const server = await startServer();
  try {
    const { socket, reply } = await handshake(server);
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'request' && frame.method === 'run_pulse') {
        socket.send(JSON.stringify({
          type: 'response',
          id: frame.id,
          ok: true,
          result: { verdict: 'unread_found', visibleRows: 12, unreadRows: 1 }
        }));
      }
    });

    const result = await server.request('run_pulse', { budgetMs: 2000 });

    assert.equal(result.verdict, 'unread_found');
    assert.equal(result.visibleRows, 12);
  } finally {
    await server.close();
  }
});

test('run_pulse times out when the extension never answers', async () => {
  const server = await startServer({ requestTimeoutMs: 150 });
  try {
    await handshake(server);

    await assert.rejects(
      () => server.request('run_pulse', {}),
      (error) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, 'BRIDGE_TIMEOUT');
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test('extension error responses surface as BridgeError with the same code', async () => {
  const server = await startServer();
  try {
    const { socket } = await handshake(server);
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'request') {
        socket.send(JSON.stringify({
          type: 'response',
          id: frame.id,
          ok: false,
          error: { code: 'WRONG_SURFACE', message: 'not on inbox' }
        }));
      }
    });

    await assert.rejects(
      () => server.request('run_pulse', {}),
      (error) => {
        assert.equal(error.code, 'WRONG_SURFACE');
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test('bridge refuses requests when no extension is connected', async () => {
  const server = await startServer();
  try {
    await assert.rejects(
      () => server.request('run_pulse', {}),
      (error) => {
        assert.equal(error.code, 'NO_SESSION');
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test('closing a socket removes the session immediately', async () => {
  const server = await startServer();
  try {
    const { socket } = await handshake(server);
    const gone = new Promise((resolve) => server.once('session-closed', resolve));
    socket.close();
    await gone;

    assert.equal(server.registry.size, 0);
  } finally {
    await server.close();
  }
});
