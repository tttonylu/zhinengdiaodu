-- 067: 账号级转帖日限
ALTER TABLE accounts ADD COLUMN daily_repost_limit INTEGER DEFAULT NULL;
