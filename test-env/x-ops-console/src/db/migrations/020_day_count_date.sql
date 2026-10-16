-- 天数锚点日期（上海自然日 YYYY-MM-DD）：与 last_seen 解耦，避免 claim 心跳冲掉跨日判定
ALTER TABLE accounts ADD COLUMN day_count_date TEXT;
