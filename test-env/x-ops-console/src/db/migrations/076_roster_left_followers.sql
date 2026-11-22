-- 4.9.126：台账以真实粉丝列表为准。
-- left_followers=1 表示「历史上联系过、但本次全量粉丝列表里已不存在」，
-- 历史保留（审计/私信记录），默认不出现在台账页。
ALTER TABLE dm_roster_items ADD COLUMN left_followers INTEGER DEFAULT 0;
