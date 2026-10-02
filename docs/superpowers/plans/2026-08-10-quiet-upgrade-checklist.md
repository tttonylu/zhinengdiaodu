# 静默期升级验收清单 · 2026-08-10

> 范围：A+C 收口上线 + 轻加固。回滚包：NAS `/tmp/quiet-upgrade-2026-08-10/`

## 已完成（服务端）

- [x] Phase0 基线备份（OPS `scrm.js.bak`、SCRM app tar、config.bak）
- [x] OPS 部署 cookie 反代 `/api/scrm/cookies/*`（容器 `x-ops-console-*-test-1`）
- [x] SCRM 部署 `cookie_store` / sanitize / soft refresh / authNeeded
- [x] `cookieImportToken` 已写入 `/data/config.json`（错 token → 401）
- [x] SCRM `agentIds` 恢复 `@140rrusv`
- [x] OPS `scrm_link_sync` 写入 `@140rrusv`；`gate_mode=soft`
- [x] 闸门验收：`allow_chat=true`（soft 放行；快照仍 stale/未找到，待工作时段抓取）

## 待你本机完成

### Cookie 扩展 1.2.0

- [ ] `chrome://extensions` 重新加载 `test-env/scrm-monitor/cookie-sync-extension`
- [ ] NAS 地址：`https://kongzhi1.kooldns.cn/api/scrm`
- [ ] Token：见 `test-env/scrm-monitor/.cookie_import_token.txt`（勿提交 git）
- [ ] 粘贴/同步 `cf_clearance`（冒烟测试曾覆盖 cookie 文件，需重新推一次）

### 插件 3.0.39

- [ ] 各业务机加载 `unified-scheduler/`（manifest 3.0.39）
- [ ] S1 `await __sgDiag()` 无空转
- [ ] S2 自动模式无双引擎抢导航
- [ ] S3 软导航/F5 后可恢复
- [ ] S4 OPS 改限额/间隔 ≤1min 生效
- [ ] 转帖默认关，不影响白天主线
- [ ] 账号列表无幽灵号

### 次日工作时段（08:00–19:00）

- [ ] SCRM 至少 1 次成功上报；`@140rrusv` 非 not_found
- [ ] 仪表盘闸门与在线一致

## 备注

- 本机访问 `kongzhi1` 若 Connection refused，优先查本机代理/防火墙；NAS 内网反代已通。
- `promo_links` 当前仅为 `https://line.me/R/ti/p/`（缺客服号），闸门暂靠 `scrm_link_sync`；后续应在 OPS 话术/换链里补回带 `@140rrusv` 的完整链接。
