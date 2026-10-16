-- 系统配置管理表（v3.0 P1 底座）
-- config_thresholds: 阈值 KV 存储
-- config_stage_policy: 阶段策略 JSON
-- config_module_switches: 模块开关

CREATE TABLE IF NOT EXISTS config_thresholds (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS config_stage_policy (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL DEFAULT '2026-07-01-001',
    policy  TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS config_module_switches (
    module    TEXT PRIMARY KEY,
    enabled   INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

-- 默认阈值
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('follow_daily_limit', '200'),
('follow_first_day_limit', '80'),
('follow_step_per_day', '40'),
('follow_interval_min_sec', '5'),
('follow_interval_max_sec', '8'),
('risk_cooldown_gradient', '[60,120,240,600]'),
('nurture_daily_likes', '30'),
('nurture_daily_comments', '10'),
('nurture_hourly_likes', '5'),
('nurture_hourly_comments', '2'),
('nurture_action_gap_min_sec', '10'),
('nurture_action_gap_max_sec', '20'),
('nurture_like_cooldown_min', '3'),
('chat_rounds_per_day', '3'),
('chat_cooldown_hours', '2'),
('follow_retry_delay_sec', '300'),
('stage_stall_cooldown_sec', '180'),
('stage_tick_interval_ms', '10000'),
('stage_watchdog_ms', '30000');

-- 默认阶段策略
INSERT OR IGNORE INTO config_stage_policy (version, policy) VALUES
('2026-07-27-001', '{"workHours":{"start":[8,0],"end":[23,0]},"chatHours":{"start":[8,0],"end":[18,0]},"stages":{"S0":{"priority":[]},"S1":{"dayMax":2,"priority":["nurture"]},"S2":{"dayMin":3,"dayMax":6,"priority":["follow","nurture"]},"S3":{"dayMin":7,"priority":["follow","chat","nurture"]},"S4":{"maxOccupyMin":30,"priority":["chat"]}},"cooldown":{"stallCooldownSec":180,"tickIntervalMs":10000,"watchdogMs":30000}}');

-- 默认模块开关
INSERT OR IGNORE INTO config_module_switches (module, enabled) VALUES
('nurture', 1),
('follow', 1),
('chat', 1);
