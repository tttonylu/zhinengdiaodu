-- accounts 表新增 day_count 列（账号运行天数）
ALTER TABLE accounts ADD COLUMN day_count INTEGER NOT NULL DEFAULT 1;
