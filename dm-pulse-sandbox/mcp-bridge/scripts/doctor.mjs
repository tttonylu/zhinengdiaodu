import { BridgeServer } from '../src/bridge-server.mjs';
import { loadBridgeConfig } from '../src/config.mjs';
import { createToolHandlers } from '../src/mcp-tools.mjs';

const waitMs = Number(process.argv[2]) || 20000;
const runPulse = process.argv.includes('--pulse');
const runDeepPulse = process.argv.includes('--deep');
const readUnread = process.argv.includes('--read');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function print(label, value) {
  console.log('\n=== ' + label + ' ===');
  console.log(JSON.stringify(value, null, 2));
}

const config = await loadBridgeConfig();
if (!config.token) {
  console.log('缺少令牌：先运行 npm run gen:config');
  process.exit(1);
}

const bridge = new BridgeServer({
  host: '127.0.0.1',
  port: config.port,
  token: config.token
});

try {
  await bridge.listen();
} catch (error) {
  console.log('监听失败：' + error.message);
  console.log('如果是 EADDRINUSE，说明 Codex 已经启动了同一个桥实例，请直接在会话里调用 MCP 工具。');
  process.exit(1);
}

console.log('等待扩展连接：' + bridge.url + '（最长 ' + Math.round(waitMs / 1000) + ' 秒）');

const deadline = Date.now() + waitMs;
while (Date.now() < deadline && bridge.registry.size === 0) {
  await sleep(250);
}

const handlers = createToolHandlers({
  bridge,
  registry: bridge.registry,
  serverVersion: 'doctor'
});

if (bridge.registry.size === 0) {
  console.log('\nNO_SESSION：扩展尚未连上。');
  console.log('请在 chrome://extensions 中重新加载 DM Pulse Sandbox（需要 0.5.0 后台脚本）。');
  await bridge.close();
  process.exit(2);
}

print('sessions', await handlers.list_sessions());
print('health', await handlers.health());

if (runPulse) {
  try {
    print('pulse', await handlers.run_pulse({ budgetMs: 5000, intervalMs: 500 }));
  } catch (error) {
    print('pulse-error', { code: error.code || 'ERROR', message: String(error.message || error) });
  }
}

if (runDeepPulse) {
  try {
    print('deep-pulse', await handlers.run_deep_pulse({ budgetMs: 12000, intervalMs: 500 }));
  } catch (error) {
    print('deep-pulse-error', { code: error.code || 'ERROR', message: String(error.message || error) });
  }
}

if (readUnread) {
  try {
    print('conversation', await handlers.read_unread_conversation({ allowOpen: true }));
  } catch (error) {
    print('conversation-error', { code: error.code || 'ERROR', message: String(error.message || error) });
  }
}

try {
  print('coexistence', await handlers.get_coexistence_state({}));
} catch (error) {
  print('coexistence-error', { code: error.code || 'ERROR', message: String(error.message || error) });
}

await bridge.close();
