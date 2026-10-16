-- 账号远程指令（插件轮询执行后 ACK 清除）
CREATE TABLE IF NOT EXISTS account_commands (
  x_handle TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
