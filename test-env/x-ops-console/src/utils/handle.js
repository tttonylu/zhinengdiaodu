/**
 * 统一账号 handle 归一化：去 @、去 #guard / 其它 #后缀、小写、trim。
 * 避免 bot_id 有时带 @、有时不带时产生 `foo` vs `fooguard` 重复账号。
 *
 * 同时拒绝「幽灵号」：
 * - X 路径段被误当成 handle（settings/account → account）
 * - 私信/关注在拿不到 Profile 时用的随机 4–5 位纯数字 fallback
 */
const RESERVED = new Set([
  'account', 'home', 'explore', 'settings', 'messages', 'notifications',
  'search', 'compose', 'i', 'intent', 'share', 'login', 'signup', 'logout',
  'unknown', 'null', 'undefined', 'demouniquetest', 'navcheck',
  // 测试/误提取，禁止入库
  'plugin_smoke', 'smoke', 'test', 'guest', 'demo', 'admin', 'root',
]);

function normalizeHandle(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^@+/, '');
  s = s.replace(/#guard$/i, '');
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  s = s.toLowerCase().trim();
  if (!s || RESERVED.has(s)) return '';
  // 随机假号：历史 bug 会生成 10000–99999；也拒 4 位纯数字
  if (/^\d{4,5}$/.test(s)) return '';
  // X handle 规则粗过滤
  if (!/^[a-z0-9_]{1,15}$/.test(s)) return '';
  return s;
}

/** 从 bot_id / worker_id / @handle#guard 提取纯 handle */
function extractHandle(botId) {
  return normalizeHandle(botId);
}

module.exports = { normalizeHandle, extractHandle, RESERVED };
