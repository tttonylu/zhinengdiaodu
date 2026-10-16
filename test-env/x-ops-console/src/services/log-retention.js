const { exec } = require('node:child_process');
const { createLogRepo } = require('../repositories/log-repo');
const { sendNotify } = require('./push-notify');

const DEFAULT = {
  eventDays: 30,       // 日志明细保留天数（到期滚入小时汇总后删除）
  snapshotDays: 14,    // 诊断快照保留天数
  rollupDays: 180,     // 小时汇总保留天数
  activityDays: 90,    // 业务库 activity_logs 保留天数
  diskMinG: 20,        // 磁盘剩余水位告警（GB）
};

function shanghaiWallTime(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function daysAgoWallTime(days) {
  return shanghaiWallTime(Date.now() - days * 86400000);
}

function diskFreeGb(dir) {
  return new Promise((resolve) => {
    exec(`df -Pk "${String(dir)}"`, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const lines = String(stdout).trim().split('\n');
      if (lines.length < 2) { resolve(null); return; }
      const cols = lines[1].trim().split(/\s+/);
      if (cols.length < 4) { resolve(null); return; }
      const availKb = Number(cols[3]);
      resolve(Number.isFinite(availKb) ? availKb / 1024 / 1024 : null);
    });
  });
}

function lastDiskAlertDate(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM config_thresholds WHERE key = 'log_disk_alert_date'"
    ).get();
    return row && row.value ? String(row.value) : '';
  } catch (e) {
    return '';
  }
}

function markDiskAlertDate(db, dateKey) {
  try {
    db.prepare(`
      INSERT INTO config_thresholds (key, value)
      VALUES ('log_disk_alert_date', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(dateKey);
  } catch (e) {}
}

async function runLogRetention({ logDb, businessDb, dataDir }) {
  const logRepo = createLogRepo(logDb);
  const out = {};

  // 1) 日志明细：30 天前 → 滚入小时汇总 → 删除
  try {
    out.events = logRepo.rollupEvents(daysAgoWallTime(DEFAULT.eventDays));
  } catch (e) {
    out.events = { error: e.message };
  }

  // 2) 诊断快照：14 天
  try {
    out.snapshots = logRepo.purgeSnapshots(daysAgoWallTime(DEFAULT.snapshotDays));
  } catch (e) {
    out.snapshots = { error: e.message };
  }

  // 3) 小时汇总：180 天
  try {
    out.rollups = logRepo.purgeRollups(daysAgoWallTime(DEFAULT.rollupDays));
  } catch (e) {
    out.rollups = { error: e.message };
  }

  // 4) 业务库 activity_logs：90 天（zhdate 兼容 zh-CN 时间戳格式）
  try {
    const del = businessDb.prepare(
      'DELETE FROM activity_logs WHERE id IN (SELECT id FROM activity_logs WHERE zhdate(created_at) <= @until LIMIT 5000)'
    );
    let n = 0;
    for (;;) {
      const r = del.run({ until: daysAgoWallTime(DEFAULT.activityDays) });
      if (!r.changes) break;
      n += r.changes;
    }
    out.activity_logs = n;
  } catch (e) {
    out.activity_logs = { error: e.message };
  }

  // 5) 业务库 dm_roster_snapshots：30 天硬上限 + 7 天明细 + 同日去重（契约 obs-retention↔H2）
  try {
    const { createDmRosterRepo } = require('../repositories/dm-roster-repo');
    const r = createDmRosterRepo(businessDb).purgeSnapshots();
    out.dm_roster_snapshots = { deleted: r.deleted, stripped: r.stripped };
  } catch (e) {
    out.dm_roster_snapshots = { error: e.message };
  }

  // 6) 磁盘水位：剩余 < 20G 时推告警（每天最多一次）
  if (dataDir) {
    try {
      const freeGb = await diskFreeGb(dataDir);
      out.disk_free_gb = freeGb;
      if (freeGb != null && freeGb < DEFAULT.diskMinG) {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        if (lastDiskAlertDate(businessDb) !== today) {
          const sizeMb = (logRepo.dbSize() / 1024 / 1024).toFixed(1);
          await sendNotify(
            businessDb,
            '磁盘空间不足告警',
            `磁盘剩余 ${freeGb.toFixed(1)}GB < ${DEFAULT.diskMinG}GB\n日志库: ${sizeMb}MB\n请及时扩容或清理。`
          );
          markDiskAlertDate(businessDb, today);
          out.disk_alerted = true;
        }
      }
    } catch (e) {
      out.disk = { error: e.message };
    }
  }

  out.ran_at = shanghaiWallTime(Date.now());
  return out;
}

/**
 * 定时保留任务：启动 60s 后首跑，之后每 intervalMs 执行一次。
 * 返回停止函数。
 */
function startLogRetentionScheduler({ logDb, businessDb, dataDir, intervalMs = 6 * 60 * 60 * 1000 }) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const res = await runLogRetention({ logDb, businessDb, dataDir });
      console.log('[log-retention]', JSON.stringify(res));
    } catch (e) {
      console.warn('[log-retention] failed:', e && e.message);
    } finally {
      running = false;
    }
  }
  setTimeout(tick, 60 * 1000);
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

module.exports = { runLogRetention, startLogRetentionScheduler, DEFAULT };