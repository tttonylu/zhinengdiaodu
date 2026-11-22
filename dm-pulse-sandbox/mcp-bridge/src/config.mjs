import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_PORT = 47321;

export async function loadBridgeConfig(env = process.env) {
  const configPath = env.DM_PULSE_BRIDGE_CONFIG || path.join(BRIDGE_ROOT, 'bridge-config.json');
  let fileConfig = {};

  try {
    const raw = await readFile(configPath, 'utf8');
    fileConfig = JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('无法读取桥配置 ' + configPath + '：' + error.message);
    }
  }

  const rawPort = Number(env.DM_PULSE_BRIDGE_PORT || fileConfig.port || DEFAULT_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT;
  const token = String(env.DM_PULSE_BRIDGE_TOKEN || fileConfig.token || '');

  return { port, token, configPath };
}
