/**
 * 运行观测 PushPlus 告警（telemetry 写入后评估）
 * 全舰队按事件去重；计数门槛始终生效（catalog push 不再绕过）
 */
const { sendNotify } = require('./push-notify');

function getThreshold(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM config_thresholds WHERE key = ?').get(key);
    return row && row.value != null && row.value !== '' ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

function pushEnabled(db) {
  const v = getThreshold(db, 'telemetry_push_enabled', 'true');
  return v === true || v === 'true' || v === '1' || v === 1;
}

function dedupeHours(db) {
  const h = parseInt(getThreshold(db, 'telemetry_push_dedupe_hours', '2'), 10);
  return Number.isNaN(h) || h < 1 ? 2 : h;
}

function shouldSkipDedupe(db, dedupeKey, hours) {
  try {
    const row = db.prepare('SELECT value FROM config_thresholds WHERE key = ?').get(dedupeKey);
    if (row && row.value) {
      const last = Date.parse(row.value);
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
  } catch (e) {}
}

/**
 * @param {object} app fastify app
 * @param {object} telemetryRepo
 * @param {object} event row with account_id, event_id, label_zh, meta
 */
async function maybeAlertTelemetry(app, telemetryRepo, event, accountHandle) {
  if (!pushEnabled(app.db)) return { pushed: false, reason: 'push_disabled' };
  const ev = event.event_id || '';
  const catalogPush = event.push === true || event.push === 1;
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
  if (!catalogPush && !pushEvents[ev]) return { pushed: false, reason: 'not_push_event' };

  const hours = dedupeHours(app.db);
  // 全舰队按事件去重，避免同事件每个账号各推一遍
  const dedupeKey = `telemetry_push_${ev}`;
  if (shouldSkipDedupe(app.db, dedupeKey, hours)) {
    return { pushed: false, reason: 'deduped' };
  }

  let extraRule = false;
  const accountId = event.account_id;
  const since30 = new Date(Date.now() - 30 * 60 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  if (ev === 'chat.dm_send_fail' || ev === 'DM_SEND_UNCONFIRMED' || ev === 'DM_REPORT_FAILED') {
    const c = telemetryRepo.countRecentByEvent(accountId, 'chat.dm_send_fail', since30)
      + telemetryRepo.countRecentByEvent(accountId, 'DM_SEND_UNCONFIRMED', since30)
      + telemetryRepo.countRecentByEvent(accountId, 'DM_REPORT_FAILED', since30);
    extraRule = c >= 3;
  } else if (ev === 'chat.inbox_dom_miss' || ev === 'inbox_dom_miss') {
    const c = telemetryRepo.countRecentByEvent(accountId, 'chat.inbox_dom_miss', since30)
      + telemetryRepo.countRecentByEvent(accountId, 'inbox_dom_miss', since30);
    extraRule = c >= 3;
  } else if (ev === 'scheduler.chat_zombie_reclaim') {
    const c = telemetryRepo.countRecentByEvent(accountId, 'scheduler.chat_zombie_reclaim', since30);
    extraRule = c >= 2;
  } else if (
    ev === 'scheduler.scrm_blocked'
    || ev === 'chat.no_promo_link'
    || ev === 'no_promo_link'
    || ev === 'scheduler.diag_anomaly'
  ) {
    extraRule = true;
  }
  // catalog push 不再绕过计数/即时门槛
  if (!extraRule) return { pushed: false, reason: 'threshold_not_met' };

  const label = event.label_zh || ev;
  const title = `观测告警 · ${label} · 首次 @${accountHandle || '?'}`;
  const meta = event.meta || {};
  const content = [
    `事件: ${label}`,
    `账号: @${accountHandle || '?'}`,
    `时间: ${event.created_at || ''}`,
    `详情: ${JSON.stringify(meta).slice(0, 400)}`,
  ].join('\n');

  let pushed = false;
  try {
    const r = await sendNotify(app.db, title, content);
    pushed = !!(r && r.ok);
    if (pushed) markDedupe(app.db, dedupeKey);
  } catch (ePush) {}

  return { pushed, reason: pushed ? 'sent' : 'push_failed' };
}

module.exports = { maybeAlertTelemetry, pushEnabled, dedupeHours };
