# SCRM Cookie 同步扩展

## 干什么用

把本机 Chrome 里 `admin.scrmceo.com` 的登录 Cookie（尤其 `cf_clearance`）推到 NAS：

`POST http://192.168.0.100:3211/api/cookies/import`

爬虫才能打开分享页，检出客服在线。

## 安装（本机 Chrome）

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」
4. 选本目录：`test-env/scrm-monitor/cookie-sync-extension`

## 每天怎么用

1. 浏览器打开并登录 https://admin.scrmceo.com （过 Cloudflare）
2. 点扩展图标 → 确认 NAS = `http://192.168.0.100:3211`
3. Token 默认已填（与 NAS `cookieImportToken` 一致）
4. 点「同步 Cookie 到 NAS」
5. 再点「检查 NAS 状态」应看到 `hasCookies: true` 且时间是今天
6. 等爬虫下一轮（约 12 分钟）或看 OPS `chat-gate` 的 `snapshot_at`

## 注意

- 这不是「智能调度」扩展，是单独的小扩展
- 3211 管理页填链接/密码 ≠ 同步 Cookie
- 电脑可关机；Cookie 在 NAS，爬虫继续用
