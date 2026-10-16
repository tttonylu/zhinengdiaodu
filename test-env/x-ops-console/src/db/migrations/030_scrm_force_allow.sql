-- SCRM 人工强制放行（开闸 / 续期 / 取消）
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('scrm_gate_force_allow', '0'),
('scrm_gate_force_allow_until', '');
