-- SCRM 客服在线快照 + 闸门元数据（私信放行用）
CREATE TABLE IF NOT EXISTS scrm_agent_status (
  agent_id TEXT PRIMARY KEY,
  nickname TEXT,
  online INTEGER DEFAULT 0,
  status_text TEXT,
  remark TEXT,
  today_done INTEGER DEFAULT 0,
  today_target INTEGER DEFAULT 0,
  not_found INTEGER DEFAULT 0,
  snapshot_at TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrm_status_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrm_link_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  agent_ids_json TEXT,
  synced_at TEXT,
  updated_at TEXT NOT NULL
);
