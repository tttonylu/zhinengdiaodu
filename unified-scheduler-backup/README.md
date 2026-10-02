# 智能调度插件

Chrome MV3 扩展。**只加载本目录** `unified-scheduler/`。

不要加载：

- `_archive/DAN`、`_archive/号池`（旧快照，已归档）
- `test-env/plugin`（3.0 空壳，脚本路径已不存在）

版本以 `manifest.json` 为准（当前 **4.3.24**）。改行为才 bump 版本。

- **技术指导（宪法·链 ID）：** [`docs/智能调度插件技术指导.md`](../docs/智能调度插件技术指导.md)  
- **分板块细则：** [`docs/调度工作手册.md`](../docs/调度工作手册.md)  
- **改码白名单：** [`docs/工作指导.md`](../docs/工作指导.md)  

本文件只说明插件自己怎么排。

## 边界

| 目录 | 是什么 |
|------|--------|
| `unified-scheduler/` | 浏览器里跑的插件 |
| `test-env/x-ops-console/` | OPS 后台（阈值、话术、日志） |
| `test-env/x-pool-service/` | 号池 `:15678` |
| `test-env/scrm-monitor/` | 客服在线监控 |
| `docs/` | 工作指导与审查，不是扩展代码 |

插件通过 `background.js` 访问 OPS 和号池。改阈值键名必须 OPS + `shared/config-sync.js` + 引擎读取三处一起改。

## 目录（按板块）

```
manifest.json              加载清单与版本
background.js              K2 自愈 / HTTP 转发（Service Worker）
scheduler-core.js          A2–A4 唯一调度大脑（coTick）
page-diag-bridge.js        G6 主世界诊断桥
chat_scripts.json          话术包（页面可访问）

scheduler/                 A1 阶段 · A5 私信策略 · A6 时间预算 · 页面路由
follow/                    B 关注（巨石 content_follow_v1522.js）
chat/                      C 私信（巨石 content_chat.js）
nurture/                   D 养号
repost/                    E 转帖 / 资料克隆 / 浮层
shared/                    F 配置同步 · G 遥测 · K1 ChallengeGuard
ui/                        G1 面板
obs/                       运行时只注入 test-monitor.js + event-catalog.json
test/                      本地单测，不进扩展
icons/                     工具栏图标
```

`scheduler/coordinator.js` **不要加载**。逻辑已并进 `scheduler-core.js`，文件只留作对照。

`obs/` 里的 `*.md`、`*.jsonl`、`*.ps1`、`reply-chain-verify.js` 是验收和排障，不进 `manifest.json`。

## 注入顺序

`manifest.json` 的 content script 顺序就是依赖顺序，不要随便调：

1. `page-diag-bridge.js`（MAIN world，`document_start`）
2. `shared/` 基础：config、id、logger、telemetry、闸门、时间、ChallengeGuard、远程阈值
3. `follow/`：风控 → 号池 API → 软风控 → 关注巨石 → 回关 → 推博主
4. `scheduler/`：阶段、路由、预算、私信策略
5. `chat/`：年龄、目标库、链接、闸门、PIN、守箱，最后 `content_chat.js`
6. `nurture/` → `repost/` → `scheduler-core.js` → `ui/panel.js`

已拆出、够用即止、不要再拆的模块：

| 板块 | 文件 | 入口 |
|------|------|------|
| B2 | `follow/pool-api.js` | `SgPoolApi` |
| B4 | `follow/soft-risk.js` | `SgSoftRisk` |
| C1 | `chat/target-db.js` | `SgTargetDb` |
| C3 | `chat/inbox-watch.js` | `SgInboxWatch` |
| C4 | `chat/age-parse.js` | `SgAgeParse` |
| C5/C8 | `chat/chat-gates.js` | `SgChatGates` |
| C6 | `chat/dm-pin.js` | `SgDmPin` |
| C7 | `chat/promo-links.js` | `SgPromoLinks` |
| A4 填窗模式 | `shared/soft-fill-mode.js` | SoftFillMode |

仍在巨石里、按锚点改：关注点击（B3）、破冰与主巡航（C2/C9）、调度主循环（A2）。一次只动一个子板块。

## 本地检查

```bash
node --test test/*.test.js
```
