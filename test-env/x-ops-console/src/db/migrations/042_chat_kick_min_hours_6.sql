-- 催加间隔默认改为 6 小时（去掉与插件 KICK_DAYS 双重卡住后的产品口径）
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES ('chat_kick_min_hours', '6');
