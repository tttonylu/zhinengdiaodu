-- 机位序号 sort_order 非空时全局唯一（允许多个 NULL）
-- 先消解历史重复：同一序号只保留 id 最小的一条，其余清空
UPDATE accounts
SET sort_order = NULL,
    updated_at = datetime('now', '+8 hours')
WHERE sort_order IS NOT NULL
  AND id NOT IN (
    SELECT keep_id FROM (
      SELECT MIN(id) AS keep_id
      FROM accounts
      WHERE sort_order IS NOT NULL
      GROUP BY sort_order
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_sort_order_unique
ON accounts(sort_order)
WHERE sort_order IS NOT NULL;
