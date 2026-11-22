-- 交友两段式：AD 最短等待 60 分 + 模式开关（dating 默认 on）
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES ('chat_ad_min_wait_min', '60');
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES ('chat_two_seg_mode', 'on');
