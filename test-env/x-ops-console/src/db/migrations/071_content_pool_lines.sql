-- H11 内容池线路：每条线路 = 文案模板（persona）+ 绑定的台账发帖号
CREATE TABLE IF NOT EXISTS content_pool_lines (
  persona TEXT PRIMARY KEY,
  account_handle TEXT NOT NULL COLLATE NOCASE DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
INSERT OR IGNORE INTO content_pool_lines (persona, account_handle, label) VALUES
  ('mai', 'mai', 'まい・21岁夜勤新手（软萌型）'),
  ('akari', 'akari', 'あかり・27岁OL前辈（复盘型）');
