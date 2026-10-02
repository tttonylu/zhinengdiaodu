# 智能调度 + 效率分析 · 大升级设计

> 日期：2026-08-10  
> 状态：待确认后开工  
> 说明：取代「仅 SCRM 静默期收口」作为当前主升级包；SCRM 降为支撑子轨。

## 1. 目标

一次大升级收齐原路线图设想的核心部分：

1. **智能调度**：可配置、可观测、验收后可扩机  
2. **效率分析**：从「回关率表」升级为指导运营的效率面板  
3. **任务监控一期**：OPS `/monitor`（原 ROADMAP「暂不实现」，本期启用）  
4. **SCRM**：仅支撑私信闸门，不占主工期  

## 2. 非目标

- worker lease / 心跳锁停引擎  
- 单号损益 / LINE 点击归因  
- 监控二期下钻、企微推送  
- 住宅代理 / SCRM 私有 API  

## 3. 四条轨道

### 轨道 A · 调度

| 项 | 内容 |
|----|------|
| A1 | S1–S4 现场验收（≥4h 假死 / 互抢 / 恢复 / 配置 1min） |
| A2 | `POOL_SERVER` / `OPS_SERVER` 可配置（panel + storage） |
| A3 | 引擎 `send_report` → OPS lite 心跳（节流合并） |
| A4 | 缓存自愈：剩余 reload 收口到 heal 保险丝 |
| A5 | 插件版本 **3.1.0** |

### 轨道 B · 任务监控一期

设计：`docs/superpowers/specs/2026-07-29-task-monitor-phase1-design.md`

- `GET /api/monitor/overview`
- 页面 `/monitor` + 导航「任务监控」
- 号池 status 降级；告警：心跳陈旧 / assigned 积压 / 号池不可达  
- 监控只看不锁  

### 轨道 C · 效率分析

- `/analytics` 增强（导航文案可改为「效率分析」）：`account_daily_stats` 时长与次数、漏斗逐步转化率 %  
- 驾驶舱漏斗旁补转化率（同源）  
- 低回关博主：复制/标记入口（不自动写号池）  
- 回关检测质量按既有设计打开/验收  

### 轨道 D · SCRM 支撑

- 扩展 + token + `cf_clearance` + 工作时段抓取  
- 补全残缺 `promo_links`  
- 不抢 A/B/C 工期  

## 4. 强制顺序

```
A2 可配置地址 + A3 send_report
    → B /monitor 一期
    → A1 短测修复 + A4 自愈
    → C 效率面板 + 驾驶舱转化率
    → C3/C4 + D 收尾 + 3.1.0 全机
```

原则：先可观测，再效率；先调度稳，再扩机。

## 5. 成功标准

1. `/monitor` ≤60s 反映自动模式账号；号池挂了账号表不空白  
2. 插件可改 OPS/号池地址且心跳/领号仍通  
3. 效率分析可见时长类指标 + 漏斗转化率  
4. 至少 1 台机 S1–S4 短测过；版本 3.1.0  
5. SCRM soft 闸门不挡私信主线  

## 6. 关键文件（预期）

- 插件：`background.js`、`ui/panel.js`、`scheduler-core.js`、`manifest.json`  
- OPS：新 monitor 路由/页；`analytics.njk` / dashboard；nav  
- 文档：本文件 + `ROADMAP.md` 修订 + mega 验收清单  

## 7. 确认方式

回复其一：

- **「按大升级开始」** — 从 A2→A3→B 开工  
- **「先做 A+B，C 往后」** — 砍效率面板到二批  
- **「先做 C」** — 仅效率分析（不推荐，缺监控则数据难信）
