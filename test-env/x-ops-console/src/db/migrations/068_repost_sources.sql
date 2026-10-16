-- 转帖来源号池（H9）：统一登记来源号；banned 由 H1 组装下发时剔除
CREATE TABLE IF NOT EXISTS repost_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'unknown',   -- unknown / alive / banned
  note TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_repost_sources_status ON repost_sources(status);
