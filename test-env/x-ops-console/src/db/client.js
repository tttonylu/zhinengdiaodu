const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/**
 * 归一化 zh-CN / SQLite 时间戳为 SQLite 可解析的 "YYYY-MM-DD HH:MM:SS"。
 * SQLite date()/datetime()/julianday() 无法解析 "2026/8/23 10:10:20"（返回 NULL），
 * 也拒绝无前导零的 "2026-8-23"。此函数同时兼容：
 *   "2026/8/23 10:10:20"（插件 toLocaleString）
 *   "2026/08/23 10:10:20"
 *   "2026-08-23 10:10:20"（SQLite datetime('now','+8 hours')）
 *   "2026-08-23T10:10:20.000Z"（ISO，取其日期部分）
 * 解析失败返回 null。
 */
function zhDateSql(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const y = m[1];
  const mo = String(m[2]).padStart(2, '0');
  const d = String(m[3]).padStart(2, '0');
  const hh = String(m[4] || '0').padStart(2, '0');
  const mm = String(m[5] || '0').padStart(2, '0');
  const ss = String(m[6] || '0').padStart(2, '0');
  return `${y}-${mo}-${d} ${hh}:${mm}:${ss}`;
}

function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 确保 SQLite 使用 UTF-8 编码处理文本
  db.pragma("encoding = 'UTF-8'");

  // 注册 zhdate()：让 datetime()/julianday() 能处理中文格式时间戳
  try {
    db.function('zhdate', { deterministic: true }, zhDateSql);
  } catch (eFn) {
    // 已注册或版本不支持时忽略
  }

  return db;
}

module.exports = { createDb, zhDateSql };
