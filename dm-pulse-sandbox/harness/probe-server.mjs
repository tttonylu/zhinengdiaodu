import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(here, 'probe-log.jsonl');
const port = Number(process.env.SG_PROBE_PORT) || 47322;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const line = JSON.stringify({ receivedAt: new Date().toISOString(), body: body.slice(0, 200000) });
    try { fs.appendFileSync(logPath, line + '\n'); } catch (e) {}
    console.log('[probe] ' + body.slice(0, 4000));
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('probe listening 127.0.0.1:' + port + ' → ' + logPath);
});
