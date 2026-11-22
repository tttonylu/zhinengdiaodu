/**
 * 运行观测 PushPlus 告警（telemetry 写入后评估）
 * 全舰队按事件去重；计数门槛始终生效（catalog push 不再绕过）
 *
 * 4.6.171 CPU 优化：config_thresholds 进程内缓存 60s，避免每次批量上报
 * 对每个候选事件重复 SELECT（原每次 batch 最坏 40+ 次 SQL → 最多 4 次）
 */
const { sendNotify } = require('./push-notify');

// ---- config 进程内缓存 ----
const CONFIG_CACHE_TTL_MS = 60 * 1000;
let _cache = null;        // { ts: number, map: { key: value } }

function loadAllConfig(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM config_thresholds').all();
    const map = Object.create(null);
    for (const r of rows) map[r.key] = r.value;
    return map;
  } catch (e) {
    return Object.create(null);
  }
}

function getCachedConfig(db) {
  const now = Date.now();
  if (_cache && now - _cache.ts < CONFIG_CACHE_TTL_MS) return _cache.map;
  _cache = { ts: now, map: loadAllConfig(db) };
  return _cache.map;
}

function invalidateConfigCache() {
  _cache = null;
}

function pushEnabled(db) {
  const cfg = getCachedConfig(db);
  const v = cfg['telemetry_push_enabled'] != null ? cfg['telemetry_push_enabled'] : 'true';
  return v === true || v === 'true' || v === '1' || v === 1;
}

function dedupeHours(db) {
  const cfg = getCachedConfig(db);
  const h = parseInt(cfg['telemetry_push_dedupe_hours'] || '2', 10);
  return Number.isNaN(h) || h < 1 ? 2 : h;
}

function shouldSkipDedupe(db, dedupeKey, hours) {
  try {
    const cfg = getCachedConfig(db);
    if (cfg[dedupeKey]) {
      const last = Date.parse(cfg[dedupeKey]);
      if (!Number.isNaN(last) && Date.now() - last < hours * 3600 * 1000) return true;
    }
  } catch (e) {}
  return false;
}

function markDedupe(db, dedupeKey) {
  try {
    db.prepare(
      `INSERT INTO config_thresholds (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`
    ).run(dedupeKey, new Date().toISOString());
    invalidateConfigCache();
  } catch (e) {}
}

function getThreshold(db, key, fallback) {
  const cfg = getCachedConfig(db);
  const v = cfg[key];
  return v != null && v !== '' ? v : fallback;
}

/**
 * 批量告警评估：同一请求内共享一次 config 读取 + 共享去重检查
 * 原来每个候选事件独立查 config → 8 × 3 = 24 次 config 查询 → 现在 1 次
 *
 * @param {object} app fastify app
 * @param {object} telemetryRepo (或 countAdapter)
 * @param {Array} candidates 最多 8 个候选事件
 * @param {string} accountHandle
 * @returns {Promise<number>} 实际推送次数
 */
async function maybeAlertTelemetryBatch(app, telemetryRepo, candidates, accountHandle) {
  if (!pushEnabled(app.db)) return 0;
  if (!Array.isArray(candidates) || !candidates.length) return 0;

  const pushEvents = {
    'scheduler.scrm_blocked': true,
    'scheduler.chat_zombie_reclaim': true,
    'scheduler.diag_anomaly': true,
    'chat.dm_send_fail': true,
    'chat.inbox_dom_miss': true,
    'inbox_dom_miss': true,
    'chat.no_promo_link': true,
    'no_promo_link': true,
  };

  const hours = dedupeHours(app.db);
  let pushed = 0;
  const nowMs = Date.now();
  const since30 = new Date(nowMs - 30 * 60 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  for (const ev of candidates) {
    const eventId = ev.event_id || '';
    const catalogPush = ev.push === true || ev.push === 1;
    if (!catalogPush && !pushEvents[eventId]) continue;

    // 全舰队按事件去重
    const dedupeKey = `telemetry_push_${eventId}`;
    if (shouldSkipDedupe(app.db, dedupeKey, hours)) continue;

    let extraRule = false;
    const accountId = ev.account_id;
    if (eventId === 'chat.dm_send_fail' || eventId === 'DM_SEND_UNCONFIRMED' || eventId === 'DM_REPORT_FAILED') {
      const c = telemetryRepo.countRecentByEvent(accountId, 'chat.dm_send_fail', since30)
        + telemetryRepo.countRecentByEvent(accountId, 'DM_SEND_UNCONFIRMED', since30)
        + telemetryRepo.countRecentByEvent(accountId, 'DM_REPORT_FAILED', since30);
      extraRule = c >= 3;
    } else if (eventId === 'chat.inbox_dom_miss' || eventId === 'inbox_dom_miss') {
      const c = telemetryRepo.countRecentByEvent(accountId, 'chat.inbox_dom_miss', since30)
        + telemetryRepo.countRecentByEvent(accountId, 'inbox_dom_miss', since30);
      extraRule = c >= 3;
    } else if (eventId === 'scheduler.chat_zombie_reclaim') {
      const c = telemetryRepo.countRecentByEvent(accountId, 'scheduler.chat_zombie_reclaim', since30);
      extraRule = c >= 2;
    } else if (
      eventId === 'scheduler.scrm_blocked'
      || eventId === 'chat.no_promo_link'
      || eventId === 'no_promo_link'
      || eventId === 'scheduler.diag_anomaly'
    ) {
      extraRule = true;
    }
    if (!extraRule) continue;

    const label = ev.label_zh || eventId;
    const title = `观测告警 · ${label} · 首次 @${accountHandle || '?'}`;
    const meta = ev.meta || {};
    const content = [
      `事件: ${label}`,
      `账号: @${accountHandle || '?'}`,
      `时间: ${ev.created_at || ''}`,
      `详情: ${JSON.stringify(meta).slice(0, 400)}`,
    ].join('\n');

    try {
      const r = await sendNotify(app.db, title, content);
      if (r && r.ok) {
        markDedupe(app.db, dedupeKey);
        pushed += 1;
      }
    } catch (ePush) {}
  }
  return pushed;
}

/**
 * 单事件告警（兼容旧调用点，内部复用批量逻辑但只处理一个）
 */
async function maybeAlertTelemetry(app, telemetryRepo, event, accountHandle) {
  const results = await maybeAlertTelemetryBatch(app, telemetryRepo, [event], accountHandle);
  return { pushed: results > 0, reason: results > 0 ? 'sent' : 'threshold_not_met' };
}

module.exports = { maybeAlertTelemetry, maybeAlertTelemetryBatch, pushEnabled, dedupeHours };
