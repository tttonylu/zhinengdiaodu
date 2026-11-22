-- 4.6.186：runtime.followed_today 带上海日历日，防跨日残值回灌插件/列表
ALTER TABLE account_runtime_status ADD COLUMN followed_today_date TEXT;
