# OPS · 粉丝台账 `dm/roster` 落库补丁说明

> 插件 ≥4.3.28 封口后会 `POST /api/plugin/dm/roster`。  
> **已落地（2026-10-02）：** 本仓 `test-env/x-ops-console` 迁移 `056_dm_roster.sql` + `dm-roster-repo.js` + plugin 路由；已部署 NAS `x-ops-console-*-test-1`。

## 1. 接口

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/plugin/dm/roster` | 插件上传台账快照（鉴权同其它 `/api/plugin/*`） |
| GET | `/api/plugin/dm/roster/:bot` | 按 bot_id 或 handle 拉取最新 items（给页面/导出） |

**POST body（插件已发）示例字段：**

```json
{
  "bot_id": "worker-xxx",
  "botHandle": "mybot",
  "pulseId": "...",
  "profileFollowers": 59,
  "cellsSeen": 59,
  "queueTotal": 59,
  "pending": 12,
  "skipped": 40,
  "deferred": 5,
  "doing": 0,
  "done": 2,
  "mismatch": false,
  "profileGap": false,
  "expectedNew": 0,
  "sealedAt": 1710000000000,
  "items": [
    {
      "handle": "peer1",
      "displayName": "名前",
      "round": 1,
      "queueStatus": "pending",
      "queueKind": "ad",
      "queueReason": "",
      "blocked": false,
      "blockReason": "",
      "rejected": false,
      "done": false,
      "iceSentAt": 1710000000000,
      "blockedAt": 0
    }
  ]
}
```

失败返回 `{ ok: false }` 即可；插件**不挡**本地开人。

## 2. 表结构（建议）

```sql
CREATE TABLE IF NOT EXISTS dm_roster_snapshots (
  id BIGSERIAL PRIMARY KEY,
  bot_id TEXT NOT NULL,
  bot_handle TEXT,
  pulse_id TEXT,
  sealed_at BIGINT,
  profile_followers INT,
  cells_seen INT,
  queue_total INT,
  pending INT,
  skipped INT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dm_roster_snap_bot ON dm_roster_snapshots (bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dm_roster_items (
  bot_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  round INT DEFAULT 0,
  queue_status TEXT,
  queue_kind TEXT,
  queue_reason TEXT,
  blocked BOOLEAN DEFAULT false,
  block_reason TEXT,
  rejected BOOLEAN DEFAULT false,
  done BOOLEAN DEFAULT false,
  ice_sent_at BIGINT,
  blocked_at BIGINT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bot_id, handle)
);
```

## 3. 处理逻辑（伪代码）

```js
// POST /api/plugin/dm/roster
async function postDmRoster(req, res) {
  const body = req.body || {};
  const botId = String(body.bot_id || body.botHandle || '').trim();
  if (!botId) return res.json({ ok: false, error: 'no_bot' });

  await db.query(
    `INSERT INTO dm_roster_snapshots
      (bot_id, bot_handle, pulse_id, sealed_at, profile_followers, cells_seen, queue_total, pending, skipped, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [botId, body.botHandle || null, body.pulseId || null, body.sealedAt || Date.now(),
     body.profileFollowers|0, body.cellsSeen|0, body.queueTotal|0, body.pending|0, body.skipped|0,
     JSON.stringify(body)]
  );

  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) {
    const h = String(it.handle || '').replace(/^@/, '').toLowerCase();
    if (!h) continue;
    await db.query(
      `INSERT INTO dm_roster_items
        (bot_id, handle, display_name, round, queue_status, queue_kind, queue_reason,
         blocked, block_reason, rejected, done, ice_sent_at, blocked_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (bot_id, handle) DO UPDATE SET
         display_name=EXCLUDED.display_name, round=EXCLUDED.round,
         queue_status=EXCLUDED.queue_status, queue_kind=EXCLUDED.queue_kind,
         queue_reason=EXCLUDED.queue_reason, blocked=EXCLUDED.blocked,
         block_reason=EXCLUDED.block_reason, rejected=EXCLUDED.rejected,
         done=EXCLUDED.done, ice_sent_at=EXCLUDED.ice_sent_at,
         blocked_at=EXCLUDED.blocked_at, updated_at=now()`,
      [botId, h, it.displayName || '', it.round|0, it.queueStatus || '', it.queueKind || '',
       it.queueReason || '', !!it.blocked, it.blockReason || '', !!it.rejected, !!it.done,
       it.iceSentAt || null, it.blockedAt || null]
    );
  }
  return res.json({ ok: true, upserted: items.length });
}
```

挂载点：与现有 `routes/api/plugin.js` 的 `dm/record`、`dm/rounds` 同文件同鉴权。

## 4. 早对账（4.6.59）

- **每日早间**：插件全量扫后 POST roster；运营打开 **`GET /dm-roster/:handle`**（页面）对照 `profileFollowers` / `cellsSeen` / `queueTotal` / 已核验数。
- 顶栏 mismatch / profileGap 红标；items 表：`round`、`queueStatus`、`queueReason`、`iceSentAt`（空=未破冰）、`dmVerifiedAt`、`blocked`/`blockReason`。
- 筛选 pending / skipped / deferred；skipped 必须带 reason（含 `they_blocked_us`、`stale_48h_no_reply`）。

## 5. 验收

1. 插件封口后 OPS 日志出现 200；`dm_roster_items` 有行。  
2. `GET .../roster/:bot` 与页面能看到 `blocked=true` / `they_blocked_us` / `stale_48h_no_reply`。  

## 6. 性能纪律（2026-10-15 血泪教训，契约 obs-retention↔H2）

- **查询禁 `LOWER(bot_id)`**：`LOWER()` 包裹列使 `idx_dm_roster_snap_bot` 失效 → 全表扫描；快照表膨胀后单次查询可达秒级，better-sqlite3 同步驱动直接卡死事件循环。查询一律 `bot_id = ?` 等值（写入端 `cleanH` 已小写化）；取最新一封用 `WHERE id = (SELECT MAX(id) ... WHERE bot_id = ?)`。
- **快照写入=每封口一封**：仅 `isFinalChunk` 写 `dm_roster_snapshots`，分片是传输细节不产生多份（否则日增数万行）。
- **保留策略（分层 + 30 天硬上限）**：`log-retention` 每 6h 调 `dm-roster-repo.purgeSnapshots()`——①`sealed_at` 超 30 天删除；②同 bot 同日（`substr(created_at,1,10)` 日串）只留 `MAX(id)` 一封；③`sealed_at` 7–30 天的快照 `payload` 置 `'{}'`（仅留 `profile_followers`/`cells_seen`/`queue_total`/`pending`/`skipped` 元数据列，供趋势图）；④≤7 天保留完整 `payload.items`（历史粉丝明细回看唯一来源）。年龄判定一律用 `sealed_at`（ms 时间戳），**禁用 `created_at` 日串比较**（非零填充 `'2026/10/9'` 字符串序不可靠）。`dm_roster_items` 全量保留（对账真相源，插件 GET roster 只读此表的 `items`，不读快照 payload）。
3. 未部署时插件仅 warn，私信仍正常。
