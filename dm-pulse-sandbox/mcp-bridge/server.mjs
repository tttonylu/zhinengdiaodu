#!/usr/bin/env node
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { BridgeServer } from './src/bridge-server.mjs';
import { loadBridgeConfig } from './src/config.mjs';
import { TOOL_DEFINITIONS, createToolHandlers } from './src/mcp-tools.mjs';

const SERVER_NAME = 'dm-pulse-bridge';
const SERVER_VERSION = '0.1.0';

function log(...args) {
  console.error('[dm-pulse-bridge]', ...args);
}

async function main() {
  const config = await loadBridgeConfig();

  if (!config.token) {
    log('缺少令牌。请先运行 npm run gen:config 生成 bridge-config.json 和扩展配置。');
    process.exit(1);
  }

  const bridge = new BridgeServer({
    host: '127.0.0.1',
    port: config.port,
    token: config.token,
    logger: (event, payload) => log(event, JSON.stringify(payload || {}))
  });

  try {
    await bridge.listen();
  } catch (error) {
    log('本地桥监听失败（端口 ' + config.port + '）：' + error.message);
    process.exit(1);
  }
  log('只读桥已监听 ' + bridge.url);

  // 本地 HTTP 调用口：给调试脚本用，避免占用 WS 会话
  try {
    const httpPort = Number(process.env.DM_PULSE_BRIDGE_HTTP_PORT) || (config.port + 2);
    http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      if (req.method !== 'POST') { res.writeHead(404).end('not found'); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const result = await bridge.request(
            String(payload.method || ''),
            payload.params || {},
            { timeoutMs: Number(payload.timeoutMs) || 30000 }
          );
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            ok: false,
            error: { code: (error && error.code) || 'ERROR', message: String((error && error.message) || error) }
          }));
        }
      });
    }).listen(httpPort, '127.0.0.1', () => {
      log('HTTP 调试口 http://127.0.0.1:' + httpPort + '/call');
    });
  } catch (eHttp) {
    log('HTTP 调试口启动失败：' + ((eHttp && eHttp.message) || eHttp));
  }

  const handlers = createToolHandlers({
    bridge,
    registry: bridge.registry,
    serverVersion: SERVER_VERSION
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params && request.params.name;
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;

    if (!handler) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'UNKNOWN_TOOL', name }) }],
        isError: true
      };
    }

    try {
      const result = await handler(request.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const code = (error && error.code) || 'INTERNAL_ERROR';
      const message = (error && error.message) || 'unknown error';
      log('tool-error', JSON.stringify({ name, code }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
        isError: true
      };
    }
  });

  await server.connect(new StdioServerTransport());
  log('stdio MCP 已就绪，工具数 ' + TOOL_DEFINITIONS.length);

  const shutdown = async () => {
    try {
      await bridge.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  log('启动失败：' + ((error && error.message) || String(error)));
  process.exit(1);
});
