CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x_handle TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  daily_follow_limit INTEGER NOT NULL DEFAULT 200,
  daily_dm_limit INTEGER NOT NULL DEFAULT 50,
  last_seen_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'x',
  target_handle TEXT NOT NULL UNIQUE,
  target_user_id TEXT,
  source TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  bound_account_id INTEGER,
  discovered_at TEXT,
  followed_at TEXT,
  followed_back_at TEXT,
  dm_ready_at TEXT,
  dm_sent_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(bound_account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  account_id INTEGER,
  action_type TEXT NOT NULL,
  action_result TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT,
  source TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(lead_id) REFERENCES leads(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(current_stage);
CREATE INDEX IF NOT EXISTS idx_leads_bound_stage ON leads(bound_account_id, current_stage);
CREATE INDEX IF NOT EXISTS idx_leads_last_activity ON leads(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_logs_lead_time ON activity_logs(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_account_time ON activity_logs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_action_time ON activity_logs(action_type, created_at);
