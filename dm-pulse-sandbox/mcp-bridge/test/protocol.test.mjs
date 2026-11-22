import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FRAME_BYTES,
  parseFrame,
  sanitizePayload,
  timingSafeEqualToken
} from '../src/protocol.mjs';

test('sanitizePayload removes credential and identity fields at any depth', () => {
  const clean = sanitizePayload({
    ok: true,
    token: 'secret-token',
    auth: 'Bearer abc',
    nested: { handle: '@someone', cookie: 'ct0=abc', keep: 1 },
    list: [{ messageText: 'hello', visibleRows: 3 }]
  });

  assert.equal(clean.token, undefined);
  assert.equal(clean.auth, undefined);
  assert.equal(clean.nested.handle, undefined);
  assert.equal(clean.nested.cookie, undefined);
  assert.equal(clean.nested.keep, 1);
  assert.equal(clean.list[0].messageText, undefined);
  assert.equal(clean.list[0].visibleRows, 3);
});

test('sanitizePayload reduces absolute urls to path only', () => {
  const clean = sanitizePayload({
    link: 'https://x.com/i/chat/123?token=secret#frag',
    ws: 'wss://example.com/socket?key=abc'
  });

  assert.equal(clean.link, '/i/chat/123');
  assert.equal(clean.ws, '/socket');
});

test('sanitizePayload never throws on circular input', () => {
  const cyclic = { visibleRows: 1 };
  cyclic.self = cyclic;

  const clean = sanitizePayload(cyclic);

  assert.equal(clean.visibleRows, 1);
  assert.equal(clean.self, '[circular]');
});

test('sanitizePayload drops functions and undefined values', () => {
  const clean = sanitizePayload({ a: 1, fn: () => 1, missing: undefined });

  assert.deepEqual(clean, { a: 1 });
});

test('parseFrame rejects oversized frames before parsing', () => {
  const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);

  assert.throws(() => parseFrame(huge), /frame too large/);
});

test('parseFrame rejects malformed json and non-object payloads', () => {
  assert.throws(() => parseFrame('{not json'), /invalid json/);
  assert.throws(() => parseFrame('"string"'), /frame must be an object/);
  assert.throws(() => parseFrame('[]'), /frame must be an object/);
});

test('parseFrame accepts a hello frame', () => {
  const frame = parseFrame(JSON.stringify({ type: 'hello', token: 't' }));

  assert.equal(frame.type, 'hello');
  assert.equal(frame.token, 't');
});

test('timingSafeEqualToken requires an exact match', () => {
  assert.equal(timingSafeEqualToken('abc123', 'abc123'), true);
  assert.equal(timingSafeEqualToken('abc123', 'abc124'), false);
  assert.equal(timingSafeEqualToken('abc123', 'abc1234'), false);
  assert.equal(timingSafeEqualToken('', ''), false);
  assert.equal(timingSafeEqualToken('abc123', undefined), false);
});
