-- 057: 账号确认机制（手动确认为真实账号，幽灵号判定以确认为准）
ALTER TABLE accounts ADD COLUMN confirmed_at TEXT;

-- 已有 last_seen_at 或有业务数据的账号自动标记为已确认（兼容旧数据）
-- 注：这里不自动确认任何账号，全部等用户手动确认，符合产品意图
-- （如果想让"有上线记录的自动确认"，打开下面这句）
-- UPDATE accounts SET confirmed_at = datetime('now', '+8 hours') WHERE confirmed_at IS NULL AND last_seen_at IS NOT NULL;
