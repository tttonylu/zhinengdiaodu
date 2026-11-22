ALTER TABLE script_sets ADD COLUMN pool TEXT NOT NULL DEFAULT 'dating';

CREATE INDEX IF NOT EXISTS idx_script_sets_pool ON script_sets(pool, enabled);
