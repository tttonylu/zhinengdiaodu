# SCRM Cookie 日更同步设计

日期：2026-08-07  
状态：已交付（2026-08-10 静默期收口：`cf_clearance` + OPS `kongzhi1` 反代 + `cookieImportToken`）

## 背景

SCRM 页面常被 **Cloudflare** 拦；站点 Cookie 往往只有 **`cf_clearance` + 统计 Cookie**，没有传统后台登录 Cookie。  
此前经「龙虾」手工恢复，拷的就是 `cf_clearance`。  
NAS 爬虫会话会掉；约束：电脑经常关机，但**每天可开一次**；不做代理、不做本机 24h 常驻抓取。

## 目标

1. 每天开机登录 SCRM 后，一键把 cookie 推到 NAS。  
2. NAS 热加载 cookie，继续工作时段抓取，不必手工改文件。  
3. cookie 失效时明确告警，不狂刷 `goto`/`reload` 把会话刷挂。  
4. 减轻无意义整页 reload（当前常 45s timeout）。

## 日常流程

```
开电脑 → 浏览器登录 admin.scrmceo.com → 点扩展「同步到 NAS」
     → 关电脑亦可 → NAS 全天用这份 cookie 抓取
失效 → PushPlus「请开机同步一次」→ 重复上列
```

## 架构

```
[Chrome 扩展] --POST cookies--> [scrm-nas :3211 /api/cookies/import]
                                      ↓
                               /data/scrm_cookies.json
                               /data/scrm_cookies.mtime flag
                                      ↓
                         BrowserSession.apply_cookies()
                         常驻 Chrome (.chrome_data)
                                      ↓
                         抓取成功 → OPS /api/scrm/status
```

## 接口

### `POST /api/cookies/import`

Body:
```json
{
  "token": optional,
  "source": "chrome-extension",
  "cookies": [
    { "name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite" }
  ]
}
```

- 写入 `/data/scrm_cookies.json`（Playwright 可消费格式）  
- 写 `/data/scrm_cookies.reload` 触发热加载  
- 返回 `{ ok, count, imported_at }`

### `GET /api/cookies/status`

返回是否有 cookie、导入时间、条数（不含 value）。

鉴权：与现有内网一致；可选 `opsStatusToken` / `cookieImportToken`。

## 爬虫改动

1. `start()` / 每轮 `scrape()` 开头：若 cookie 文件比上次应用新 → `context.add_cookies` + 可选轻量打开分享页。  
2. `light_refresh`：页面已可读时**优先不 reload**，直接 search 抽数；仅当 `forceReload` 或连续两轮数字可疑时再 reload（timeout 降到 15s，timeout 后可读则继续）。  
3. `needs_login()`：出现登录表单 / 无表格且有账号密码框 → 返回 True。  
4. 需登录时：不上报假快照、不 rebuild 风暴；PushPlus 节流告警（2h 一次）。

## 本机扩展

- MV3，权限：`cookies` + `admin.scrmceo.com` + 用户配置的 NAS 源  
- Popup：NAS 地址（默认 `http://192.168.0.100:3211`）、可选 token、同步按钮  
- 导出 domain 含 `scrmceo.com` 的 cookie 并 POST

## 非目标

- 住宅代理  
- 本机 24h 爬虫  
- 逆向 SCRM 私有 API（可后续）

## 验收

1. 扩展同步后 NAS `cookies/status` 显示新时间。  
2. 下一轮抓取日志出现 `cookies applied`，能搜到监控号。  
3. 故意清 cookie 后：告警「需同步」，不连续 cold_open。  
4. 可读状态下多数轮次无 `Page.reload timeout`。
