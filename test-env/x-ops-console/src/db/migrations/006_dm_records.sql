CREATE TABLE IF NOT EXISTS dm_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_handle TEXT NOT NULL,
  target_handle TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  message_content TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_dm_records_bot ON dm_records(bot_handle, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_records_target ON dm_records(bot_handle, target_handle);
CREATE INDEX IF NOT EXISTS idx_dm_records_round ON dm_records(bot_handle, target_handle, round_number);
