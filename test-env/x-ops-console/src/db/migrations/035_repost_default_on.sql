-- 转帖默认开启；双窗全员同跑（暂不分哈希）
UPDATE config_module_switches SET enabled = 1 WHERE module = 'repost';
INSERT OR IGNORE INTO config_module_switches (module, enabled) VALUES ('repost', 1);
INSERT OR IGNORE INTO config_thresholds (key, value) VALUES
  ('repost_eve_end_hour', '23'),
  ('repost_eve_end_min', '0'),
  ('repost_morn_start_hour', '3'),
  ('repost_morn_start_min', '0'),
  ('repost_morn_end_hour', '5'),
  ('repost_morn_end_min', '0');
