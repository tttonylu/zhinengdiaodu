-- 066: 账号管理标签（方案A：标签 = 模块策略模板）
-- 语义：标签关闭优先于手动 override（关闭优先，安全侧）；多标签取关闭并集
ALTER TABLE accounts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
