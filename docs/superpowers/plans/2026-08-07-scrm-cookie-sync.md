# SCRM Cookie 日更同步 — 实现计划

> **For agentic workers:** 按任务勾选推进。设计见 `docs/superpowers/specs/2026-08-07-scrm-cookie-sync-design.md`。

**Goal:** 本机一键把 `admin.scrmceo.com` 登录 cookie 推到 NAS，爬虫热加载并在失效时告警、停止刷页。

**Architecture:** Chrome MV3 扩展导出 cookie → `POST /api/cookies/import` → `/data/scrm_cookies.json` → Playwright `add_cookies`；status 轮次默认 soft refresh。

**Tech Stack:** Flask, Playwright, Chrome Extension MV3

---

### Task 1: cookie_store + API
- [x] `cookie_store.py`
- [x] `web_server.py` import/status + CORS
- [x] `test_cookie_store.py`

### Task 2: scraper / scheduler
- [x] `apply_imported_cookies` / `needs_admin_login` / soft `light_refresh`
- [x] `scrape` 返回 `authNeeded`
- [x] `main.py` PushPlus 节流告警

### Task 3: Chrome 扩展
- [x] `cookie-sync-extension/`

### Task 4: 部署 NAS
- [x] docker cp 到 `scrm-nas` 并重启
- [x] 验证 `/api/cookies/status` → `200` `hasCookies:false`
