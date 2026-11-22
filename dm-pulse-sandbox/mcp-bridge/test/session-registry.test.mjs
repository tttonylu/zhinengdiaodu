import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry, SessionError } from '../src/session-registry.mjs';

function fakeSocket() {
  return {
    closed: false,
    send() {},
    close() { this.closed = true; }
  };
}

test('registers a session with metadata and a random id', () => {
  const registry = new SessionRegistry();
  const session = registry.add(fakeSocket(), {
    extensionVersion: '0.3.0',
    schema: 'xchat-v2',
    remoteAddress: '127.0.0.1'
  });

  assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.extensionVersion, '0.3.0');
  assert.equal(session.schema, 'xchat-v2');
  assert.equal(registry.size, 1);
});

test('session ids are unique across registrations', () => {
  const registry = new SessionRegistry();
  const a = registry.add(fakeSocket(), {});
  const b = registry.add(fakeSocket(), {});

  assert.notEqual(a.sessionId, b.sessionId);
});

test('list never exposes token or remote address', () => {
  const registry = new SessionRegistry();
  registry.add(fakeSocket(), {
    extensionVersion: '0.3.0',
    schema: 'xchat-v2',
    remoteAddress: '127.0.0.1',
    token: 'secret'
  });

  const [row] = registry.list();

  assert.equal(row.token, undefined);
  assert.equal(row.remoteAddress, undefined);
  assert.equal(row.extensionVersion, '0.3.0');
});

test('heartbeat advances lastSeenAt without creating a session', () => {
  const registry = new SessionRegistry({ now: () => 1000 });
  const session = registry.add(fakeSocket(), {});

  registry.touch(session.sessionId, 5000);

  assert.equal(registry.get(session.sessionId).lastSeenAt, 5000);
  assert.equal(registry.size, 1);
});

test('stale sessions are reported but not silently deleted', () => {
  const registry = new SessionRegistry({ now: () => 1000, staleAfterMs: 30000 });
  const session = registry.add(fakeSocket(), {});

  registry.touch(session.sessionId, 20000);

  const [row] = registry.list();
  assert.equal(row.stale, false);

  const [later] = registry.list({ now: 60000 });
  assert.equal(later.stale, true);
  assert.equal(registry.size, 1);
});

test('pick returns the only live session', () => {
  const registry = new SessionRegistry();
  const session = registry.add(fakeSocket(), {});

  assert.equal(registry.pick().sessionId, session.sessionId);
});

test('pick throws NO_SESSION when nothing is connected', () => {
  const registry = new SessionRegistry();

  assert.throws(() => registry.pick(), (error) => {
    assert.ok(error instanceof SessionError);
    assert.equal(error.code, 'NO_SESSION');
    return true;
  });
});

test('remove resolves every pending request with SESSION_CLOSED', () => {
  const registry = new SessionRegistry();
  const session = registry.add(fakeSocket(), {});
  const seen = [];

  registry.addPending(session.sessionId, 'req-1', (error) => seen.push(error.code));
  registry.remove(session.sessionId);

  assert.deepEqual(seen, ['SESSION_CLOSED']);
  assert.equal(registry.size, 0);
});
