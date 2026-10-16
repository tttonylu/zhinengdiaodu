-- 账号每日工作统计表
-- 记录每个账号每天的关注/私信/养号工作量和用时

CREATE TABLE IF NOT EXISTS account_daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    stat_date TEXT NOT NULL,
    follow_count INTEGER DEFAULT 0,
    follow_duration_sec INTEGER DEFAULT 0,
    chat_rounds INTEGER DEFAULT 0,
    chat_duration_sec INTEGER DEFAULT 0,
    nurture_likes INTEGER DEFAULT 0,
    nurture_comments INTEGER DEFAULT 0,
    nurture_duration_sec INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(account_id, stat_date),
    FOREIGN KEY(account_id) REFERENCES accounts(id)
);
