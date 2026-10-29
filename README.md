# 智能调度
多开 Chrome 档位上的 X（Twitter）账号运营系统：  
**关注获客 → 软风控填窗内私信转化 → 养号保活 → 夜间转帖**，由调度单引擎轮转，并可被 OPS / SCRM 闸住。
当前插件版本以 [`unified-scheduler/manifest.json`](unified-scheduler/manifest.json) 为准。
## 仓库结构
| 目录 | 说明 |
|------|------|
| [`unified-scheduler/`](unified-scheduler/) | **唯一现网插件**（Chrome MV3）。只加载本目录，不要加载 `_archive/` 或 `test-env/plugin/` |
| [`test-env/x-ops-console/`](test-env/x-ops-console/) | OPS 运营后台（配置、话术、账号、战报）· 默认 `:15680` |
| [`test-env/x-pool-service/`](test-env/x-pool-service/) | 号池（博主任务队列）· 默认 `:15678` |
| [`test-env/scrm-monitor/`](test-env/scrm-monitor/) | SCRM 客服在线监控 |
| [`docs/`](docs/) | 技术指导 / 工作手册 / 改码白名单 |
| [`x-japan-accounts/`](x-japan-accounts/) | 日本矩阵账号内容素材 |
| `_archive/` | 旧快照，禁止当源码、禁止加载 |
插件目录细则见 [`unified-scheduler/README.md`](unified-scheduler/README.md)。  
分层总览见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
## 核心能力
- **调度（A）**：`scheduler-core.js` 唯一大脑，按阶段 S0–S4 启停关注 / 私信 / 养号 / 转帖
- **关注（B）**：号池领号、点击关注、平台软风控填窗
- **私信（C）**：破冰 / 守箱 / 广告 / PIN / 年龄闸
- **养号（D）**：刷首页点赞评论，按预算保活
- **转帖（E）**：夜间专场；支持来源号转帖与内容池原创直发
- **配置同步（F）**：OPS → 插件阈值 / 阶段 / 模块开关（约 1 分钟）
- **自愈（K）**：ChallengeGuard、白屏 heal、媒体闸与页面瘦身
## 快速开始
### 1. 加载插件
1. Chrome → 扩展程序 → 开发者模式 →「加载已解压的扩展程序」
2. 选择 **`unified-scheduler/`**（不是仓库根目录）
3. 打开 x.com 标签页，用面板启停自动模式
### 2. 启动后台（测试环境）
```bash
cd test-env/x-pool-service && docker compose up -d
cd test-env/x-ops-console  && docker compose up -d
```
健康检查：
- 号池 `http://<host>:15678/health`
- OPS  `http://<host>:15680/health`
更完整的部署说明见 [`test-env/README.md`](test-env/README.md)。
### 3. 本地单测
```bash
# 插件
cd unified-scheduler && node --test test/*.test.js
# OPS（在对应目录）
cd test-env/x-ops-console && npm test
```
## 改代码必读（文档三角）
开工顺序不可跳过：
1. [`docs/智能调度插件技术指导.md`](docs/智能调度插件技术指导.md) — 宪法（链 ID / 少跳页）
2. [`docs/调度工作手册.md`](docs/调度工作手册.md) — 分板块不变量
3. [`docs/工作指导.md`](docs/工作指导.md) — 改哪个文件（白名单 + §13 变更记录）
硬边界摘要：
- 改阈值键名必须 **OPS + config-sync + 引擎读取** 三处同改
- 行为变更需 bump `unified-scheduler/manifest.json` 版本号
- 巨石文件（`content_chat.js` / `content_follow_v1522.js` / `scheduler-core.js`）一次只动一个子板块；模块化已冻结，勿主动再拆
## 许可与用途
本仓库为内部运营工具代码与文档。未单独声明开源许可时，默认仅限授权团队使用。
