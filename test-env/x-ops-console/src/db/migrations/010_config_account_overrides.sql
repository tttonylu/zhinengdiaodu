CREATE TABLE IF NOT EXISTS config_account_overrides (
  x_handle   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  PRIMARY KEY (x_handle, key)
);

CREATE INDEX IF NOT EXISTS idx_account_overrides_handle ON config_account_overrides(x_handle);
