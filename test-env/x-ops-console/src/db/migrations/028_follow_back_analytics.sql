-- 回关日统计 + 分析索引
ALTER TABLE account_daily_stats ADD COLUMN follow_back_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_leads_bound_followed
  ON leads(bound_account_id, followed_at);

CREATE INDEX IF NOT EXISTS idx_leads_bound_follow_back
  ON leads(bound_account_id, followed_back_at);

CREATE INDEX IF NOT EXISTS idx_logs_account_action_time
  ON activity_logs(account_id, action_type, created_at);
