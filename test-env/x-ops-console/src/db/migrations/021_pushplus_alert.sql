-- PushPlus 告警（账号冻结等）；token 可在配置页改
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('pushplus_token', '7d32ec31843143f6a60811d516d04008'),
('push_alerts_enabled', '1');
