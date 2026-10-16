-- SCRM 闸门模式：soft=检测失败不拦私信（默认，抗墙）；strict=严格；off=完全不拦
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('scrm_gate_mode', 'soft'),
('scrm_work_start', '08:00'),
('scrm_work_end', '19:00');
-- 已存在时也强制切到 soft（抗墙长期方案）
INSERT INTO config_thresholds (key, value, updated_at) VALUES
('scrm_gate_mode', 'soft', datetime('now', '+8 hours'))
ON CONFLICT(key) DO UPDATE SET value = 'soft', updated_at = datetime('now', '+8 hours');
