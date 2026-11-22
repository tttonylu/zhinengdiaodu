/**
 * 舰队重活租约：同时最多 N 个 handle 持有 chat/follow 槽
 */
function createFleetLeaseRepo(db) {
  function purgeExpired(nowMs) {
    db.prepare('DELETE FROM fleet_leases WHERE expires_at < ?').run(nowMs);
  }

  function countActive(nowMs) {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM fleet_leases WHERE expires_at >= ?')
      .get(nowMs);
    return (row && row.c) || 0;
  }

  /**
   * @returns {{ granted:boolean, reason:string, active:number, slots:number, expires_at?:number }}
   */
  function acquire(handle, kind, slots, ttlMs, nowMs, ts) {
    const h = String(handle || '').replace(/^@/, '').toLowerCase();
    const k = String(kind || 'chat').toLowerCase();
    if (!h) return { granted: false, reason: 'no_handle', active: 0, slots: slots | 0 };
    const now = nowMs || Date.now();
    const ttl = Math.max(30000, parseInt(ttlMs, 10) || 180000);
    const slotN = parseInt(slots, 10);
    if (isNaN(slotN) || slotN <= 0) {
      return { granted: true, reason: 'lease_off', active: 0, slots: 0 };
    }
    purgeExpired(now);
    const existing = db
      .prepare('SELECT expires_at, updated_at FROM fleet_leases WHERE handle = ? AND kind = ?')
      .get(h, k);
    const expires = now + ttl;
    if (existing) {
      // 4.6.191：超员时续约不再一律放行。按初次 updated_at 留下最早的 slotN 个，其余删行拒绝。
      const older = db
        .prepare(
          `SELECT COUNT(*) AS c FROM fleet_leases
           WHERE expires_at >= ?
             AND (
               COALESCE(updated_at, '') < COALESCE(?, '')
               OR (COALESCE(updated_at, '') = COALESCE(?, '') AND handle < ?)
               OR (COALESCE(updated_at, '') = COALESCE(?, '') AND handle = ? AND kind < ?)
             )`
        )
        .get(now, existing.updated_at, existing.updated_at, h, existing.updated_at, h, k);
      if ((older && older.c) >= slotN) {
        db.prepare('DELETE FROM fleet_leases WHERE handle = ? AND kind = ?').run(h, k);
        return { granted: false, reason: 'slots_full', active: countActive(now), slots: slotN };
      }
      db.prepare(
        'UPDATE fleet_leases SET expires_at = ? WHERE handle = ? AND kind = ?'
      ).run(expires, h, k);
      return {
        granted: true,
        reason: 'renew',
        active: countActive(now),
        slots: slotN,
        expires_at: expires,
      };
    }
    const active = countActive(now);
    if (active >= slotN) {
      return { granted: false, reason: 'slots_full', active, slots: slotN };
    }
    db.prepare(
      'INSERT INTO fleet_leases (handle, kind, expires_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(h, k, expires, ts || null);
    return {
      granted: true,
      reason: 'acquired',
      active: active + 1,
      slots: slotN,
      expires_at: expires,
    };
  }

  function release(handle, kind) {
    const h = String(handle || '').replace(/^@/, '').toLowerCase();
    const k = String(kind || '').toLowerCase();
    if (!h) return { ok: false };
    if (k) {
      db.prepare('DELETE FROM fleet_leases WHERE handle = ? AND kind = ?').run(h, k);
    } else {
      db.prepare('DELETE FROM fleet_leases WHERE handle = ?').run(h);
    }
    return { ok: true };
  }

  return { acquire, release, purgeExpired, countActive };
}

module.exports = { createFleetLeaseRepo };
