'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 以无 chrome/window 依赖的方式加载客户端，注入沙箱桩
function loadClient() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'repost', 'content-pool-client.js'), 'utf8');
  const sandbox = {
    window: {},
    chrome: { runtime: { sendMessage: () => {} } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    Uint8Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.ContentPoolClient;
}

test('client: dataUrlToBlob 还原字节与 mime', () => {
  const C = loadClient();
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
  const blob = C._test.dataUrlToBlob('data:image/png;base64,' + b64);
  assert.equal(blob.type, 'image/png');
  assert.ok(blob.parts[0] instanceof Uint8Array);
  assert.equal(blob.parts[0].length, 6);
});

test('client: isPoolMode 只认真值', () => {
  const C = loadClient();
  assert.equal(C._test.isPoolMode({ contentPoolMode: true }), true);
  assert.equal(C._test.isPoolMode({ contentPoolMode: false }), false);
  assert.equal(C._test.isPoolMode({}), false);
  assert.equal(C._test.isPoolMode(null), false);
});
