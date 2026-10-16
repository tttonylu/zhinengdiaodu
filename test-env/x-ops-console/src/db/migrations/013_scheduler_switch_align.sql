INSERT OR IGNORE INTO config_module_switches (module, enabled) VALUES ('scheduler', 1);

-- 确保调度阈值与插件内置一致（秒/毫秒）
UPDATE config_thresholds SET value = '10000', updated_at = datetime('now', '+8 hours') WHERE key = 'stage_tick_interval_ms' AND (value IS NULL OR value = '');
UPDATE config_thresholds SET value = '30000', updated_at = datetime('now', '+8 hours') WHERE key = 'stage_watchdog_ms' AND (value IS NULL OR value = '');
UPDATE config_thresholds SET value = '180', updated_at = datetime('now', '+8 hours') WHERE key = 'stage_stall_cooldown_sec' AND (value IS NULL OR value = '');
UPDATE config_thresholds SET value = '[60,120,240,600]', updated_at = datetime('now', '+8 hours')
WHERE key = 'risk_cooldown_gradient' AND value NOT LIKE '%[%';
