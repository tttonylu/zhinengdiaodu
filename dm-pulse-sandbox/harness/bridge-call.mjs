import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from '../mcp-bridge/node_modules/ws/wrapper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(here, '..', 'mcp-bridge', 'bridge-config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const method = process.argv[2] || 'get_coexistence_state';
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const ws = new WebSocket('ws://127.0.0.1:' + cfg.port + '/bridge');
let done = false;

function finish(code, payload) {
  if (done) return;
  done = true;
  try { ws.close(); } catch {}
  if (payload !== undefined) console.log(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  setTimeout(() => process.exit(code), 50);
}

const timer = setTimeout(() => finish(2, { error: 'timeout waiting for bridge' }), 30000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'hello',
    token: cfg.token,
    client: { extensionVersion: 'cli', schema: 'cli' }
  }));
});

ws.on('message', (raw) => {
  let frame;
  try { frame = JSON.parse(String(raw)); } catch { return; }
  if (frame.type === 'hello_ok') {
    ws.send(JSON.stringify({
      type: 'request',
      id: 'cli-' + Date.now(),
      method,
      params
    }));
    return;
  }
  if (frame.type === 'response') {
    clearTimeout(timer);
    finish(frame.ok ? 0 : 1, frame.ok ? frame.result : { error: frame.error });
  }
});

ws.on('error', (e) => {
  clearTimeout(timer);
  finish(3, { error: String((e && e.message) || e) });
});
