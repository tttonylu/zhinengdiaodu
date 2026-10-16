-- 4.1.45 上线：SCRM 闸门改回 soft；催加改为 2h（同日后续填窗可催，非同窗连发）
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES ('scrm_gate_mode', 'soft');
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES ('chat_kick_min_hours', '2');
