/**
 * 轻量内存结果缓存工厂（TTL 过期 + 按 key 覆盖）。
 * 每个 OPS app 实例独立一份缓存，避免多实例/测试间串数据。
 * 用于 dashboard / analytics 等重计算页面：避免 30s 元刷新或来回切换标签时反复全量聚合。
 */
function createTtlCache() {
  const cache = new Map();

  function getCached(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  function setCached(key, value, ttlMs = 30000) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (now > v.expiresAt) cache.delete(k);
      }
    }
    return value;
  }

  function invalidateCache(prefix) {
    if (prefix) {
      for (const k of [...cache.keys()]) {
        if (k.startsWith(prefix)) cache.delete(k);
      }
      return;
    }
    cache.clear();
  }

  function clear() {
    cache.clear();
  }

  return { getCached, setCached, invalidateCache, clear, size: () => cache.size };
}

module.exports = { createTtlCache };
