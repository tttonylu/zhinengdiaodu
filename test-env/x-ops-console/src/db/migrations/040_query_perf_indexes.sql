-- 查询性能优化：为日级统计核心列补索引
-- 背景：今天格式为 zh-CN "2026/8/23 10:10:20"，所有日级查询用 created_at LIKE 'YYYY/M/D %' 前缀匹配
-- 此前 activity_logs / dm_records 无 created_at 单列索引 → 每天全表扫描，页面卡顿

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_dm_records_created_at ON dm_records(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_dm_records_bot_result ON dm_records(bot_handle, result, round_number);

-- runtime 状态按小写 handle 关联（accounts.x_handle 均为小写，此处兜底旧数据）
CREATE INDEX IF NOT EXISTS idx_runtime_lower_handle ON account_runtime_status(lower(x_handle));

-- 热门 action_type 日级聚合索引
CREATE INDEX IF NOT EXISTS idx_logs_action_result_time ON activity_logs(action_type, action_result, created_at);
