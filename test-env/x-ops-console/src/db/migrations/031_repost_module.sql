-- 转帖模块：默认关闭；阈值供插件拉取
INSERT OR IGNORE INTO config_module_switches (module, enabled) VALUES ('repost', 0);

INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
('repost_targets', '[]'),
('repost_daily_cap', '10'),
('repost_posts_per_handle', '1'),
('repost_cooldown_min', '40'),
('repost_cooldown_max', '90'),
('repost_post_type', 'text_or_image'),
('repost_append_link', '');
