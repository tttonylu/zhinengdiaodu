'use strict';
/**
 * 4.9.131：存活心跳必须带 build，OPS 才能确认浏览器实际加载的版本。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const telemetrySrc = fs.readFileSync(path.join(root, 'shared', 'telemetry.js'), 'utf8');
const backgroundSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

test('system.page_alive 带 build', () => {
  const start = telemetrySrc.indexOf("emit('system.page_alive'");
  assert.ok(start > 0);
  const body = telemetrySrc.slice(start, start + 900);
  assert.match(body, /build:\s*\(function\s*\(\)/);
  assert.match(body, /getManifest\(\)\.version/);
});

test('system.sw_alive 带 build', () => {
  const start = backgroundSrc.indexOf("event_id: 'system.sw_alive'");
  assert.ok(start > 0);
  const body = backgroundSrc.slice(start, start + 900);
  assert.match(body, /build:\s*\(function\s*\(\)/);
  assert.match(body, /getManifest\(\)\.version/);
});
