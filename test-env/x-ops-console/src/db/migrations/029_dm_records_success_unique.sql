-- 成功轮次唯一：同一 bot+target 不得重复写入同一成功 round（防并发双插 / 重发记库）
-- 先清历史重复（保留最早 id），再建部分唯一索引

DELETE FROM dm_records
WHERE id IN (
  SELECT d.id FROM dm_records d
  INNER JOIN (
    SELECT
      LOWER(bot_handle) AS b,
      LOWER(REPLACE(target_handle, '@', '')) AS t,
      round_number AS r,
      MIN(id) AS keep_id
    FROM dm_records
    WHERE LOWER(COALESCE(result, 'success')) = 'success'
    GROUP BY LOWER(bot_handle), LOWER(REPLACE(target_handle, '@', '')), round_number
    HAVING COUNT(*) > 1
  ) x
    ON LOWER(d.bot_handle) = x.b
   AND LOWER(REPLACE(d.target_handle, '@', '')) = x.t
   AND d.round_number = x.r
   AND LOWER(COALESCE(d.result, 'success')) = 'success'
   AND d.id <> x.keep_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_records_success_round_unique
ON dm_records (
  LOWER(bot_handle),
  LOWER(REPLACE(target_handle, '@', '')),
  round_number
)
WHERE LOWER(COALESCE(result, 'success')) = 'success';
