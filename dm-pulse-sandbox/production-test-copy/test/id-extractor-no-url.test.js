'use strict';
/**
 * 停在来源主页时，不得把地址栏路径写成登录号。
 * 运行：node --test unified-scheduler/test/id-extractor-no-url.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage() {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  return obj;
}

function loadExtractor(opts) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'id_extractor.js'), 'utf8');
  const local = makeStorage();
  const session = makeStorage();
  const doc = {
    querySelector() { return opts.profile || null; },
    querySelectorAll() { return []; },
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    CustomEvent: function CustomEvent() {},
    window: { location: { pathname: opts.pathname || '/' }, dispatchEvent() {}, addEventListener() {} },
    document: doc,
    localStorage: local,
    sessionStorage: session,
    URLSearchParams,
    chrome: { runtime: { sendMessage() {}, onMessage: { addListener() {} } } },
  };
  sandbox.window.localStorage = local;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'id_extractor.js' });
  return { local };
}

test('来源页 URL 不写入 matrix_my_handle', async () => {
  const { local } = loadExtractor({ pathname: '/raikotsu1987' });
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(local.getItem('matrix_my_handle'), null);
});

test('导航栏链接才是登录号', async () => {
  const { local } = loadExtractor({
    pathname: '/raikotsu1987',
    profile: {
      href: 'https://x.com/sana37_148',
      getAttribute() { return '/sana37_148'; },
    },
  });
  await new Promise((r) => setTimeout(r, 3200));
  assert.match(String(local.getItem('matrix_my_handle') || ''), /sana37_148/i);
});
