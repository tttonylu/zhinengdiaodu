-- 4.3.32：关注配额前移一档（Day1 = 原 Day2 标准）
-- 账号来源更换，新号质量更好，Day1 即可跑更高配额
UPDATE config_thresholds SET value = '45' WHERE key = 'follow_day1_min';
UPDATE config_thresholds SET value = '50' WHERE key = 'follow_day1_max';
UPDATE config_thresholds SET value = '50' WHERE key = 'follow_first_day_limit';
UPDATE config_thresholds SET value = '90' WHERE key = 'follow_day2_min';
UPDATE config_thresholds SET value = '100' WHERE key = 'follow_day2_max';
UPDATE config_thresholds SET value = '100' WHERE key = 'follow_day2_limit';
UPDATE config_thresholds SET value = '150' WHERE key = 'follow_day3_min';
UPDATE config_thresholds SET value = '160' WHERE key = 'follow_day3_max';
UPDATE config_thresholds SET value = '200' WHERE key = 'follow_day4_min';
UPDATE config_thresholds SET value = '210' WHERE key = 'follow_day4_max';
UPDATE config_thresholds SET value = '250' WHERE key = 'follow_day5_min';
UPDATE config_thresholds SET value = '260' WHERE key = 'follow_day5_max';
