-- SCRM 进线按日存档（today_done 日切覆盖，历史靠本表）
CREATE TABLE IF NOT EXISTS scrm_inbound_daily (
  stat_date TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  today_done INTEGER DEFAULT 0,
  today_target INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0,
  ice INTEGER DEFAULT 0,
  ad_link INTEGER DEFAULT 0,
  snapshot_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (stat_date, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_scrm_inbound_daily_date ON scrm_inbound_daily(stat_date);
