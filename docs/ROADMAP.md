# 智能调度中心 v3.0 路线图

> 版本：v3.0.0 · 2026-07-26
> 主线：**自动化稳定性 / 规模化管理 / 模块化方便改**
> 起跳基准：25 worker × 25 账号 日进粉 6-10（手动模式），v3.0 以提升/稳定该指标为验收基线
> 扩规模门槛（M3 放行）：G1 24h 无人工 + G2 全 worker 看板可见 + G3 后台改阈值不动代码

---

## 0. 三步破局思路（v3.0 主线执行顺序）

```
Step 1  数据底座先行 (M0)          ← 这是工作室盲飞期 exit gate
  └─ audit_logs + 单号损益表 + worker 注册/心跳锁
       ↓ 暴露"死亡队列"和"零回复 worker"

Step 2  数据出来后做根因决策 (M1)    ← 针对性补业务模块
  └─ C6 消极反馈识别 + B6 评论模板上后台 + 看板上线
       ↓ 死亡率降到 5% 以内，转化漏斗可见

Step 3  工程化重构 (M2，可与 M0/M1 并行)
  └─ 三仓合并 + 配置抽离 + 阈值上后台
       ↓ 老板能在后台改策略不动代码

最终放行 M3：扩规模门槛验收 (G1+G2+G3)
```

---

## 1. 里程碑总览

| 里程碑 | 名 | 主线归属 | 估时 | 关键交付 | 准入 | 准出 |
|---|---|---|---|---|---|---|
| M0 | 数据底座 | 一+二 P0 | 2 周 | audit_logs / worker 注册锁 / 单号损益表初版 | 现状可用 monorepo 决策已拍 | 至少能看到 25 worker 当日死亡+漏斗行 |
| M1 | 业务模块补丁 | 一+三 P0+P1 | 2 周 | C6 消极反馈 / B6 评论上后台 / worker 看板上线 | M0 准出 | 死亡率降到 5% 内 / 看板能看到全部 worker |
| M2 | 工程化重构 | 三 P1 | 2 周 | 三仓合并 / bg 抽硬编码 / 阈值后台改 | M0 准出 | 后台改阈值 ≤30s 反映到 worker |
| M3 | 扩规模门槛验收 | 验收 | 1 周 | G1+G2+G3 全达 | M1+M2 准出 | 连续 72h×3 次试验无人工且封号不高于手动 |

总估时 5-7 周（M2 可与 M0/M1 并行，实际挤压在 5 周内）。

---

## 2. M0 数据底座（2 周，主线一+二 P0）

### 工作分解
| ID | 任务 | 后端 | 插件 | 验收 |
|---|---|---|---|---|
| M0-T1 | x-pool-service 加 `workers` 表 + 注册接口 | ✓ | | 注册 25 worker 0 重复 |
| M0-T2 | x-pool-service 加 `pool/lease` + 续约锁 + `pool/heartbeat` | ✓ | | 1 worker 重复领号 0 次 |
| M0-T3 | x-ops-console 加 `audit_logs` 表 + migration | ✓ | | 任何审计事件 1s 入库 |
| M0-T4 | x-ops-console 加 POST/GET `/api/plugin/audit[/batch]` | ✓ | | 失败本地入队重发 |
| M0-T5 | background.js 加 `report_audit[/batch]` action + 失败入队 | | ✓ | 插件重启审计事件 0 丢失 |
| M0-T6 | 三引擎调用点接入 audit 上报（不破坏 Idle/Follow/Chat/Nurture 流程） | | ✓ | 每 follow_batch_end/dm_round_sent/nurture_action 至少 1 条 |
| M0-T7 | ops-console 单号损益页（24h + 7d 两档） | ✓ | | 看到 25 行 |
| M0-T8 | ops-console worker 看板（活/死/动作量/劣反馈计数色阶） | ✓ | | 一屏看 25 worker |

### M0 准出条件
- 25 worker 注册+心跳 0 重复领号事件
- 单号损益页能显示当日 24h 行
- 看板能看到全部 worker 活/死灯
- 审计上报失败本地入队重发，插件重启 0 丢失

---

## 3. M1 业务模块补丁（2 周，主线一+三）

### 工作分解
| ID | 任务 | 后端 | 插件 | 验收 |
|---|---|---|---|---|
| M1-T1 | content_chat.js 加 C6 消极反馈识别块（关键词+行为检测） | | ✓ | 命中即拉冷 24h + report_audit |
| M1-T2 | C6 上报链路：拉冷→audit→看板账户损益行标"消极反馈" | ✓ | ✓ | 任意拉黑 5s 内入库 |
| M1-T3 | ops-console 加 `/api/nurture/comments` GET/POST + 迁移硬编码模板 | ✓ | | 后台增改一模板 ≤30s 生 |
| M1-T4 | nurture-comments.js 改：API 拉 + chrome.storage 兜底（30min 同步 + 离线用 BANK） | | ✓ | API 宕走兜底，业务不停 |
| M1-T5 | ops-console 加阈值编辑页 → 写 matrix_config_overrides | ✓ | | 改 followLimit 全 worker 30s 内生效 |
| M1-T6 | background.js 加 fetch 指数退避重试 + 5s timeout 抽到 config | | ✓ | 网络抖动 3 次重试后报错 |
| M1-T7 | scheduler-core.js 补 D6 卡死场景化重启（已有 3-tick 触发） | | ✓ | 卡死场景 90s 内归 idle + 180s 冷却 |
| M1-T8 | 看板补"死亡队列"页 + "零回复 worker" 页（基于 M0 数据） | ✓ | | 一屏看到 TOP 死亡队列 |

### M1 准出条件
- C6 命中即自动拉冷 + 写 audit 5s 内
- 评论模板后台增改 30s 内对全 worker 生效
- 阈值后台改 30s 内对全 worker 生效
- 死亡率从 5-15% 降到 5% 以内（基线：M0 完成后 4 周观测对比）

---

## 4. M2 工程化重构（2 周，主线三 P1，可与 M0/M1 并行）

### 工作分解
| ID | 任务 | 验收 |
|---|---|---|
| M2-T1 | 根仓 git init + initialize master | 一次提交完成 |
| M2-T2 | services/x-pool-service 接入（合并 test-env + 号池 两副本） | 单副本入仓 |
| M2-T3 | services/x-ops-console 接入（合并 test-env + DAN 副本） | 单副本入仓 |
| M2-T4 | extension/unified-scheduler 整体入仓（17 文件 + manifest） | 路径准确 |
| M2-T5 | 删除 test-env/号池/DAN 三套旧副本（仅保留 DAN/x-ops-console 作旧版参考 stub） | monorepo 无重复 |
| M2-T6 | 根 README.md + workspace package.json | 起本地 dev 三栈一句话能跑 |
| M2-T7 | background.js 抽 POOL_SERVER/OPS_SERVER/timeout 到 shared/config.js | 0 硬编码服务器路径 |
| M2-T8 | monorepo 文档最终化（README + 三 service 各自 README） | 接手 30min 上手 |

### M2 准出条件
- 单一副本 monorepo 跑得动
- 配置 0 硬编码服务器路径
- 新人 30min 内能起本地三栈（号池+后台+扩展）

---

## 5. M3 扩规模门槛验收（1 周）

### 验收清单
| 准则 | 验收试验 | 通过线 |
|---|---|---|
| G1 24h 无人工 | 连续 72h 试验 ×3 次 | 0 次人工介入 + 封号率 ≤ 手动模式 |
| G2 全 worker 看板 | ops-console 一屏看 25→50 worker | 所有 worker 活/死灯+动作量+存活率可见 |
| G3 后台改阈值 | 任选 1 阈值后台改 | ≤30s 反映到全部 worker |

### M3 通过后的下一步
- 启动 50 worker → 100 worker 阶梯扩规模试验
- v3.1 启动候选：IP/设备指纹代理池、话术多占位、CI 流水线

---

## 6. 风险登记表

| ID | 风险 | 描述 | 对策 | 缓解时点 |
|---|---|---|---|---|
| R1 | 工程先于业务 | monorepo 先做完业务没动 | 严格 M0 数据底座先于 M2 | M0 必做完再开始 M2 |
| R2 | IP/设备未隔离 | 25 同机多 profile 扎堆被封 | v3.0 不解决，留 v3.1 代理池 | M3 后评估 |
| R3 | 话术被平台识别 | 日文 icebreaker 模板雷同 | C6 + 单号损益表暴露后做话术指纹 | M1 后观测 |
| R4 | 号源质量差 | pool 领到的号死亡率高 | 任务锁 + matrix_dead_handles + 死号占比入 audit | M0/T6 |
| R5 | audit 写爆后端 | 25 worker × 高频审计写入压垮 sqlite | 异步批量上报 + 写入失败本地入队 | M0/T4 |
| R6 | C6 关键词误判 | 拉黑识别关键词撞回复正常 | 双判（关键词+无再回复超 N 分钟）+ 看 audit 流校准 | M1/T1 |
| R7 | monorepo 合并丢代码 | 删副本误删线上版本 | 合并前每副本 git tag 留版本 | M2/T2 |
| R8 | 跨机时钟漂移 | 各 worker 机器时间不一致导致 heartbeat 错误 | 以服务端时间为准；客户端只带 ts 做参考 | M0/T2 |

---

## 7. v3.1 待办池（v3.0 不做）

| 项 | 主线 | 入池原因 |
|---|---|---|
| 话术 {LINK} 多占位 / 分渠道链接 | 一 | v3.0 暂不动话术（决策项 2） |
| IP/设备指纹代理池 | 一 | R2，必须等 M3 后单号损益表暴露 |
| Playwright e2e / 插件 jest 单测 | 三 | 决策项 8，v3.0 不做 CI |
| CI 流水线 | 三 | 同上 |
| 跨资源竞标/优先级 | 二 | v3.0 任务锁已够用，再细化推后 |
| 调度策略可视化编排 | 三 | v3.0 后台改阈值已够 |
| 话术骨架重设计 | 一 | 内容需 v3.0 上线后数据驱动 |
| 代号审计/合规协议文档 | 一 | 决策项 6 改为 audit_logs 技术化，合规协议留后 |

---

## 8. 关键节点对齐时间线（建议）

| 周次 | M0 | M1 | M2 | M3 |
|---|---|---|---|---|
| W1 | T1-T4 | | T1-T3 (git 初始化) | |
| W2 | T5-T8 准出 | | T4-T6 (合并副本) | |
| W3 | | T1-T3 | T7-T8 准出 | |
| W4 | | T4-T8 准出 | | |
| W5 | | | | G1 启动 ×3 试验 |
| W6 | | | | M3 验收 → 放行扩规模 |
| W7 | | | | （缓冲） |

---

## 9. 引用

- 需求详见 `REQUIREMENTS.md`
- 架构详见 `ARCHITECTURE.md`
- 接口契约详见 `API_CONTRACT.md`