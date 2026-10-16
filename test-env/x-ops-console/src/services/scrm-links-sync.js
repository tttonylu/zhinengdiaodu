/**
 * Sync OPS promo Line links → SCRM scraper agentIds. v1.1
 * OPS stores full URLs; SCRM expects @ids in config.agentIds.
 * 
 * 改进：
 * - 多格式客服号提取（@id、ti/p/xxx、status/xxx、i/xxx 等）
 * - 多级候选 URL 兜底
 * - 指数退避重试
 * - 同步结果详细日志
 */

const DEFAULT_SCRM_CONFIG_URL = 'http://192.168.0.100:3211/api/config';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

/**
 * 从推广链接中提取客服号
 * 支持格式：
 * - @username
 * - ti/p/username
 * - status/username
 * - i/username
 * - https://x.com/username (从 X 链接提取)
 * - https://twitter.com/username
 */
function extractAgentIds(links) {
  const ids = [];
  const seen = new Set();
  for (const raw of links || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    
    let id = null;
    
    // 1. 优先匹配 @username
    const at = s.match(/@[A-Za-z0-9._-]+/);
    if (at) {
      id = at[0];
    }
    
    // 2. ti/p/username 格式（小红书风格）
    if (!id) {
      const tip = s.match(/ti\/p\/([^\s/?#]+)/i);
      if (tip) id = tip[1].startsWith('@') ? tip[1] : `@${tip[1]}`;
    }
    
    // 3. status/username 格式（X/Twitter 帖子）
    if (!id) {
      const status = s.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status/i);
      if (status) id = `@${status[1]}`;
    }
    
    // 4. x.com/username 或 twitter.com/username 主页
    if (!id) {
      const profile = s.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)(?:[?\/]|$)/i);
      if (profile && !['home', 'explore', 'notifications', 'messages', 'settings', 'i'].includes(profile[1].toLowerCase())) {
        id = `@${profile[1]}`;
      }
    }
    
    // 5. i/username 格式（Instagram 风格）
    if (!id) {
      const inst = s.match(/\/i\/([^\s/?#]+)/i);
      if (inst) id = `@${inst[1]}`;
    }
    
    // 6. 最后尝试：URL 路径中第一段可能是用户名
    if (!id) {
      const pathMatch = s.match(/\.com\/([A-Za-z0-9._-]+)(?:[?\/]|$)/i);
      if (pathMatch && !['s', 'admin', 'api', 'www', 'app', 'share'].includes(pathMatch[1].toLowerCase())) {
        id = `@${pathMatch[1]}`;
      }
    }
    
    if (id && !seen.has(id.toLowerCase())) {
      seen.add(id.toLowerCase());
      ids.push(id);
    }
  }
  return ids;
}

function sameIds(a, b) {
  const aa = [...(a || [])].map(String).map(s => s.toLowerCase()).sort();
  const bb = [...(b || [])].map(String).map(s => s.toLowerCase()).sort();
  if (aa.length !== bb.length) return false;
  return aa.every((v, i) => v === bb[i]);
}

function readSyncConfig(appConfig = {}) {
  const enabledRaw = process.env.SCRM_SYNC_ENABLED;
  const enabled = enabledRaw == null
    ? (appConfig.scrmSyncEnabled !== false)
    : !['0', 'false', 'off', 'no'].includes(String(enabledRaw).toLowerCase());

  return {
    enabled,
    configUrl: process.env.SCRM_CONFIG_URL
      || appConfig.scrmConfigUrl
      || DEFAULT_SCRM_CONFIG_URL,
    intervalMs: Number(process.env.SCRM_SYNC_INTERVAL_MS
      || appConfig.scrmSyncIntervalMs
      || DEFAULT_INTERVAL_MS),
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timeoutMs = options.timeoutMs || 8000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, status: res.status, data, text: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成候选 URL 列表，按优先级排序
 */
function candidateConfigUrls(primary) {
  const list = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (s && !list.includes(s)) list.push(s);
  };
  
  // 1. 主配置（用户指定的）
  push(primary);
  
  // 2. 从主配置推导的变体
  if (primary) {
    try {
      const u = new URL(primary);
      // 同域名的标准路径
      push(`${u.protocol}//${u.host}/api/config`);
    } catch (_) {}
  }
  
  // 3. Docker 环境常见地址
  push('http://scrm-nas:3211/api/config');
  push('http://172.17.0.1:3211/api/config');
  push('http://host.docker.internal:3211/api/config');
  
  // 4. 本地/NAS 直连
  push('http://127.0.0.1:3211/api/config');
  push('http://localhost:3211/api/config');
  push('http://192.168.0.100:3211/api/config');
  
  // 5. 通过 OPS 自身代理（如果 OPS 有 scrm 代理接口）
  // （调用方自行添加，这里不重复）
  
  return list;
}

/**
 * 尝试单个 URL 的同步（带重试）
 */
async function trySyncOneUrl(configUrl, agentIds, retries = MAX_RETRIES) {
  let lastErr = '';
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS * attempt); // 指数退避
    }
    
    try {
      // GET 当前配置
      const current = await fetchJson(configUrl, { method: 'GET', timeoutMs: 6000 });
      if (!current.ok || !current.data || typeof current.data !== 'object') {
        lastErr = `GET failed: HTTP ${current.status} ${current.error || current.text || ''}`;
        continue;
      }
      
      // 已经一致则跳过
      if (sameIds(current.data.agentIds, agentIds)) {
        return { ok: true, skipped: true, agentIds, msg: 'already in sync', configUrl, attempt };
      }
      
      // POST 更新
      const body = { ...current.data, agentIds };
      const put = await fetchJson(configUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        timeoutMs: 8000,
      });
      
      if (!put.ok) {
        lastErr = `POST failed: HTTP ${put.status} ${put.error || put.text || ''}`;
        continue;
      }
      
      return { ok: true, agentIds, msg: 'scrm agentIds updated', configUrl, attempt };
    } catch (err) {
      lastErr = `${err.message || String(err)}`;
    }
  }
  
  return { ok: false, agentIds, error: lastErr, configUrl, attempts: retries + 1 };
}

/**
 * Push agentIds derived from links to SCRM.
 * 尝试多个 URL 候选，每个带重试。
 * @returns {{ ok: boolean, skipped?: boolean, agentIds?: string[], msg?: string, error?: string, configUrl?: string, triedUrls?: number }}
 */
async function syncLinksToScrm(links, options = {}) {
  const cfg = readSyncConfig(options.appConfig || {});
  if (!cfg.enabled) return { ok: true, skipped: true, msg: 'scrm sync disabled' };

  const agentIds = extractAgentIds(links);
  const urls = options.configUrl
    ? [options.configUrl]
    : candidateConfigUrls(cfg.configUrl);

  const errors = [];
  let triedCount = 0;
  
  for (const configUrl of urls) {
    triedCount++;
    const result = await trySyncOneUrl(configUrl, agentIds, options.maxRetries ?? MAX_RETRIES);
    if (result.ok) {
      return { ...result, triedUrls: triedCount };
    }
    errors.push(`${configUrl}: ${result.error}`);
  }
  
  return {
    ok: false,
    agentIds,
    error: errors.join('; ') || 'all SCRM config URLs failed',
    triedUrls: triedCount,
  };
}

function getPromoLinks(db) {
  const row = db.prepare("SELECT value FROM script_settings WHERE key = 'promo_links'").get();
  if (!row) return [];
  try { return JSON.parse(row.value); } catch (_) { return [row.value]; }
}

/** Fire-and-forget sync; logs result, never throws to callers. */
function syncLinksToScrmSafe(links, options = {}) {
  return syncLinksToScrm(links, options).then((result) => {
    if (result.ok) {
      if (result.skipped) {
        console.log(`[scrm-sync] already in sync (${result.triedUrls || 1} URLs tried): ${(result.agentIds || []).join(',') || '(empty)'}`);
      } else {
        console.log(`[scrm-sync] ${result.msg} via ${result.configUrl} (tried ${result.triedUrls || 1} URLs): ${(result.agentIds || []).join(',') || '(empty)'}`);
      }
    } else {
      console.warn(`[scrm-sync] failed after ${result.triedUrls || 0} URLs: ${result.error}`);
    }
    return result;
  }).catch((err) => {
    console.warn(`[scrm-sync] unexpected: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  });
}

/**
 * Start periodic fallback sync. Returns stop() clearer.
 */
function startScrmLinksSyncScheduler(app, options = {}) {
  const cfg = readSyncConfig(app.appConfig || {});
  if (!cfg.enabled) {
    console.log('[scrm-sync] scheduler disabled');
    return () => {};
  }
  const intervalMs = Math.max(30_000, Number(options.intervalMs || cfg.intervalMs) || DEFAULT_INTERVAL_MS);

  const tick = () => {
    try {
      const links = getPromoLinks(app.db);
      syncLinksToScrmSafe(links, { appConfig: app.appConfig });
    } catch (err) {
      console.warn(`[scrm-sync] tick error: ${err.message || err}`);
    }
  };

  // Initial catch-up shortly after boot
  const bootTimer = setTimeout(tick, 5_000);
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  console.log(`[scrm-sync] scheduler every ${Math.round(intervalMs / 1000)}s → ${cfg.configUrl}`);

  return () => {
    clearTimeout(bootTimer);
    clearInterval(timer);
  };
}

module.exports = {
  extractAgentIds,
  sameIds,
  readSyncConfig,
  syncLinksToScrm,
  syncLinksToScrmSafe,
  startScrmLinksSyncScheduler,
  getPromoLinks,
  candidateConfigUrls,
  DEFAULT_SCRM_CONFIG_URL,
  DEFAULT_INTERVAL_MS,
};
