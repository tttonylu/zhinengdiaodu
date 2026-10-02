# 大升级验收清单 · 2026-08-11

插件目标版本：**3.1.0**

## 已交付（代码 + OPS 部署目标）

- [x] A2 面板「服务器」可配置 OPS / 号池
- [x] A3 `send_report` → OPS lite 心跳（15s 节流）
- [x] B `/monitor` + `GET /api/monitor/overview` + 导航
- [x] C 效率分析：今日效率 tab、漏斗逐步转化率；导航文案「效率分析」
- [x] 驾驶舱漏斗显示转化率

## 本机必做

- [ ] Chrome 重载 `unified-scheduler`（确认 3.1.0）
- [ ] 面板 → 服务器：确认 OPS/号池地址；外网可填 `https://kongzhi1.kooldns.cn`（若插件 API 已反代）或内网 IP
- [ ] 开自动模式跑一轮，打开 OPS `/monitor`：≤60s 出现账号心跳
- [ ] `/analytics?tab=efficiency` 有表（无 daily-stats 时多为 0 亦可）
- [ ] S1–S4 短测勾选（见 ROADMAP）

## SCRM 子轨（非阻塞）

- [ ] 扩展推 `cf_clearance`（token 见 `.cookie_import_token.txt`）
- [ ] 补全 OPS `promo_links` 含客服号
