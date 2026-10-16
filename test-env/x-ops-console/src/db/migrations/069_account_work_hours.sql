-- 069: 账号级上班/下班时间（工作窗覆盖；NULL=跟随全局 stagePolicy.workHours）
ALTER TABLE accounts ADD COLUMN work_start TEXT DEFAULT NULL;
ALTER TABLE accounts ADD COLUMN work_end TEXT DEFAULT NULL;
