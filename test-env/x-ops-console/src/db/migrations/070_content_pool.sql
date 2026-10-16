-- H11 原创内容池：AI/人工生产的待发推文，人工审核后插件 claim 直发
CREATE TABLE IF NOT EXISTS content_pool_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_handle TEXT NOT NULL COLLATE NOCASE,   -- 目标发帖号 handle（不带 @）
  persona TEXT NOT NULL DEFAULT '',              -- mai / akari，便于筛选
  text TEXT NOT NULL,                            -- 日文正文（≤1000 字，标签≤3 由生产侧保证）
  media_urls TEXT NOT NULL DEFAULT '[]',         -- JSON 数组，相对路径 /content-media/xxx.jpg
  scheduled_jst_at TEXT NOT NULL,                -- 'YYYY-MM-DDTHH:MM' 日本墙钟
  status TEXT NOT NULL DEFAULT 'pending',        -- pending/approved/claimed/posted/failed/rejected
  source TEXT NOT NULL DEFAULT 'manual',         -- ai_daily / manual
  external_post_id TEXT NOT NULL DEFAULT '',
  fail_reason TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_content_pool_claim
  ON content_pool_items(account_handle, status, scheduled_jst_at);
CREATE INDEX IF NOT EXISTS idx_content_pool_status ON content_pool_items(status);
