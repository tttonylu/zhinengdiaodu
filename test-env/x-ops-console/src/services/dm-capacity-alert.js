/**
 * 私信可控产能告警：盯「含链接广告」（第2轮广告中带推广链的子集）是否断崖。
 * 进线转化波动大，仅作备注，不作为硬判条件。
 */
const { sendNotify } = require('./push-notify');
const { shanghaiHour } = require('../utils/shanghai-date');

function buildCapacitySnapshot(dmRepo, health) {
  const dmHealth = health || dmRepo.todayHourlyHealth();
  const hourNow = shanghaiHour();
  // 用上一完整小时，避免当前小时尚未结束误报
  const prevKey = String(Math.max(0, hourNow - 1)).padStart(2, '0');
  const prev = (dmHealth.hours || []).find((h) => h.hour === prevKey) || {
    hour: prevKey, ice: 0, ad: 0, ad_link: 0, kick: 0, failed: 0, total: 0,
  };
  const morningAdLink = (dmHealth.hours || [])
    .filter((h) => {
      const n = parseInt(h.hour, 10);
      return n >= 9 && n <= 11;
    })
    .reduce((s, h) => s + (h.ad_link || 0), 0);

  return {
    hourNow,
    prevHour: prev,
    morningAdLink,
    totals: dmHealth.totals,
    hours: dmHealth.hours,
  };
}

/**
 * @param {object} app
 * @param {object} dmRepo
 * @param {object} [dmHealth] 预计算的今日小时统计，避免重复扫描
 * @returns {{ alert: boolean, reason?: string, snapshot: object, pushed?: boolean }}
 */
async function maybeAlertDmCapacity(app, dmRepo, dmHealth) {
  const snapshot = buildCapacitySnapshot(dmRepo, dmHealth);
  const hour = snapshot.hourNow;
  // 仅工作时段检查（9–18），避开早盘未起量
  if (hour < 10 || hour > 18) {
    return { alert: false, reason: 'outside_window', snapshot };
  }

  const prev = snapshot.prevHour;
  const cliff =
    snapshot.morningAdLink >= 20 &&
    (prev.ad_link || 0) <= 2 &&
    (prev.ice || 0) + (prev.ad || 0) + (prev.kick || 0) <= 8;

  if (!cliff) {
    return { alert: false, reason: 'ok', snapshot };
  }

  const dedupeKey = `dm_capacity_cliff_${snapshot.prevHour.hour}`;
  let skip = false;
  try {
    const prevRow = app.db.prepare('SELECT value FROM config_thresholds WHERE key = ?').get(dedupeKey);
    if (prevRow && prevRow.value) {
      const last = Date.parse(prevRow.value);
      if (!Number.isNaN(last) && Date.now() - last < 2 * 3600 * 1000) skip = true;
    }
  } catch (e) {}

  let pushed = false;
  if (!skip) {
    const title = `私信产能告警 · ${snapshot.prevHour.hour}点含链接广告断崖`;
    const msg = [
      `${snapshot.prevHour.hour}时：含链接广告 ${prev.ad_link || 0} / 第1轮破冰 ${prev.ice || 0} / 失败 ${prev.failed || 0}`,
      `今早9–11含链接广告合计 ${snapshot.morningAdLink}`,
      '说明：含链接广告是第2轮广告中带推广链的子集；这是可控发送量告警，进线转化本身有波动，不作硬判。',
    ].join('\n');
    try {
      const r = await sendNotify(app.db, title, msg);
      pushed = !!(r && r.ok);
      app.db.prepare(
        `INSERT INTO config_thresholds (key, value, updated_at) VALUES (?, ?, datetime('now', '+8 hours'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`
      ).run(dedupeKey, new Date().toISOString());
    } catch (ePush) {}
  }

  return { alert: true, reason: 'ad_link_cliff', snapshot, pushed, skipped: skip };
}

module.exports = {
  buildCapacitySnapshot,
  maybeAlertDmCapacity,
};
