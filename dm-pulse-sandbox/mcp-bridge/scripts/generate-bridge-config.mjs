import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SANDBOX = path.dirname(ROOT);
const EXTENSION = path.join(SANDBOX, 'extension');
const DEFAULT_PORT = 47321;

const argPort = Number(process.argv[2] || process.env.DM_PULSE_BRIDGE_PORT || DEFAULT_PORT);
const port = Number.isInteger(argPort) && argPort > 0 && argPort < 65536 ? argPort : DEFAULT_PORT;
const token = randomBytes(24).toString('base64url');

const payload = { enabled: true, port, token };

await mkdir(ROOT, { recursive: true });
await writeFile(path.join(ROOT, 'bridge-config.json'), JSON.stringify({ port, token }, null, 2) + '\n', 'utf8');
await writeFile(path.join(EXTENSION, 'bridge-config.js'), 'self.DM_PULSE_BRIDGE_CONFIG = ' + JSON.stringify(payload, null, 2) + ';\n', 'utf8');

console.log('已生成：');
console.log('  ' + path.join(ROOT, 'bridge-config.json'));
console.log('  ' + path.join(EXTENSION, 'bridge-config.js'));
console.log('端口 ' + port + '，令牌长度 ' + token.length + '。');
