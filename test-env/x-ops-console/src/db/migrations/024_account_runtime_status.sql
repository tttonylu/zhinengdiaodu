-- 插件运行态快照 + 远程指令回执（方案 C：确认私信是否开启）
CREATE TABLE IF NOT EXISTS account_runtime_status (
  x_handle TEXT PRIMARY KEY,
  bot_id TEXT,
  engine TEXT,
  stage TEXT,
  running_module TEXT,
  why_idle TEXT,
  followed_today INTEGER DEFAULT 0,
  follow_limit INTEGER DEFAULT 0,
  auto_mode INTEGER DEFAULT 0,
  detail_json TEXT,
  last_cmd_issued TEXT,
  last_cmd_issued_at TEXT,
  last_cmd TEXT,
  last_cmd_acked_at TEXT,
  last_cmd_ok INTEGER DEFAULT 0,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL
);
