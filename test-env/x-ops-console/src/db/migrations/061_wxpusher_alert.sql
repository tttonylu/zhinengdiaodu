-- WxPusher 告警通道（替代 PushPlus）
-- pushplus 已被封，默认切到 wxpusher
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('push_provider', 'wxpusher'),
('wxpusher_app_token', 'AT_asSqY2Wn719XctLJVbOJa9RVeFR8RR99'),
('wxpusher_uids', 'UID_VAmLOrbKFZIQuXx9hcPuXsQhC3XN');
