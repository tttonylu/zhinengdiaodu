-- 4.1.61：盾牌/催加按轮次下一窗即可，废除 2h 间隔
INSERT OR REPLACE INTO config_thresholds (key, value) VALUES ('chat_kick_min_hours', '0');
