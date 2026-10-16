-- 粉丝台账：封口快照 + 每人一行 upsert
CREATE TABLE IF NOT EXISTS dm_roster_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  bot_handle TEXT,
  pulse_id TEXT,
  sealed_at INTEGER,
  profile_followers INTEGER DEFAULT 0,
  cells_seen INTEGER DEFAULT 0,
  queue_total INTEGER DEFAULT 0,
  pending INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_dm_roster_snap_bot
  ON dm_roster_snapshots(bot_id, created_at);

CREATE TABLE IF NOT EXISTS dm_roster_items (
  bot_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  round INTEGER DEFAULT 0,
  queue_status TEXT,
  queue_kind TEXT,
  queue_reason TEXT,
  blocked INTEGER DEFAULT 0,
  block_reason TEXT,
  rejected INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  ice_sent_at INTEGER,
  blocked_at INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  PRIMARY KEY (bot_id, handle)
);

CREATE INDEX IF NOT EXISTS idx_dm_roster_items_bot
  ON dm_roster_items(bot_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_dm_roster_items_blocked
  ON dm_roster_items(bot_id, blocked);
