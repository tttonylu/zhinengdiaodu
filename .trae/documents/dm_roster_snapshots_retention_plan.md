# dm_roster_snapshots 保留策略优化 实施计划

## 仓库研究

### 现状
- `dm_roster_snapshots` 存储粉丝台账封口快照，每行 `payload` 是整份请求体 JSON（含完整粉丝列表 `items`），平均 **16.8KB/行**。
- 上一轮已修复①查询去 LOWER、②仅 final chunk 写快照、③`purgeSnapshots` 每 bot 每天留最新一封。
- 当前 purge 保留「全时段每 bot 每天一封」——**无时间上限**，以 54 bot 计每天 +54 行 ≈ 900KB/天，年增 33MB，长期仍膨胀。

### 消费端（决定保留什么）
| 消费方 | 用什么 | 需不需要 payload.items |
|--------|--------|----------------------|
| `latestSnapshotMeta`（GET roster + 账号页实时态） | `profile_followers`/`cells_seen`/`queue_total`/`pending`/`skipped` 列 + `payload.rejected_empty` | **否**（items 由 `dm_roster_items` 表提供，插件只读 `r.items`） |
| `listDailySnapshots`（30 天下拉列表/趋势） | 元数据列（不含 payload） | **否**（查询本身已不返回 payload） |
| `getSnapshot`（点选某日回看粉丝列表） | `payload.items` 解析为表格 | **是**（历史粉丝明细唯一来源） |

结论：`payload.items` 仅服务「历史某一天的粉丝明细回看」；趋势图只依赖元数据列。旧快照的完整 items 实际很少被查看。

## 候选策略对比

| 方案 | 保留内容 | 存量（54 bot × 30 天） | 历史明细 | 复杂度 |
|------|---------|----------------------|---------|--------|
| A. 现状：每 bot 每天 1 封全量（无限期） | 全量 payload | 无上限 +900KB/天 | ✅ 全部 | 低 |
| B. **分层 + 30 天硬上限**（推荐） | 近 7 天全量 payload；8–30 天仅元数据（`payload='{}'`）；>30 天删除 | ~1.7MB（54×7×16.8KB + 54×23×0.5KB） | ✅ 近 7 天明细 + 30 天趋势 | 低 |
| C. 全部仅元数据（永不存 items） | `payload` 只存 flags | ~800KB | ❌ 历史明细全丢 | 低 |
| D. 仅保留最新一封 | 每 bot 1 封 | ~900KB | ❌ 历史全丢 | 极低 |
| E. 周全量 + 日差分 | 每周 1 封全量 + 每日 diff | ~500KB | ✅ 理论全历史 | 高（读写都复杂） |

## 推荐方案：B（分层 + 30 天硬上限）

理由：
- 30 天与 `listDailySnapshots(handle, 30)` 的展示窗口对齐，超出即删。
- 近 7 天保留明细（运营常需回看本周粉丝变动/排查拉黑）；8–30 天只留趋势（F/cells/queue 走势），明细很少被翻。
- 实现成本低：只改 `purgeSnapshots`，不动写入路径、不动表结构。
- 存储有界：~1.7MB 封顶，不再无限增长。

### 时间锚点
用 `sealed_at`（ms 时间戳）做年龄判定，**避开 `created_at` 非零填充日串（'2026/10/9'）字符串比较不可靠的问题**（项目记忆已记录此坑）。

## 文件与模块

- `test-env/x-ops-console/src/repositories/dm-roster-repo.js`
  - 重写 `purgeSnapshots`：①删 >30 天；②同 bot 同日只留 id 最大一封；③7–30 天的快照 `payload` 置为 `'{}'`（保留元数据列）；④近 7 天不动。
- `test-env/x-ops-console/src/services/log-retention.js`
  - 调用不变（已接入 `purgeSnapshots`）；若返回值需区分「删除行数 / 剥离行数」则调整日志字段。
- 文档：`docs/调度工作手册.md` §X 契约行 `obs-retention↔H2` 更新保留语义；`docs/OPS-DM-ROSTER.md` §6 同步。

## 实施步骤

1. **dm-roster-repo.js `purgeSnapshots` 重写**（同一子 ID，无跨板块）
   ```
   const now = Date.now();
   const DAY = 86400000;
   // 1) 删 >30 天
   // 2) 同 bot 同日保留 MAX(id)，其余删除
   // 3) 7–30 天：UPDATE payload='{}' WHERE sealed_at 在区间内
   ```
   分批执行（每批 2 万行），避免长事务锁库。
2. **log-retention.js** 日志输出补 `purged` / `stripped` 两个计数，便于观测。
3. **文档**：§X 契约行、OPS-DM-ROSTER.md §6 更新为「30 天硬上限 + 7 天明细 + 趋势永久」语义。
4. **部署 NAS**（全量 src tar → build → up -d --force-recreate）。
5. **手动触发一次 purge** 验证：行数应 ≈ 54×7 + 54×(≤23) = 54×30 ≈ 1620 行；>7 天的行 payload='{}'。
6. **VACUUM** 回收空间（行数少，秒级）。

## 依赖与注意事项

- `sealed_at` 是插件上传的 `Date.now()`，以插件端为准；若插件时钟偏差大，年龄判定会有误差（可接受，保留是粗粒度策略）。
- 不新增迁移、不改表结构；`payload` 列保持 TEXT，旧值逐步被 `'{}'` 覆盖。
- `listDailySnapshots` 仍返回 30 天每天一封（元数据列齐全），下拉选择器不变；只有点选 8 天前的快照时，表格无 items（显示「该历史快照仅保留趋势数据」提示）。
- `getSnapshot` 解析 `payload.items` 为空数组时，`items=[]`，账号页历史模式表格为空——需在路由层给个友好提示。

## 验证

- `node --check` 三个改动文件。
- `npm test` 全量通过。
- NAS 部署后：手动跑 `purgeSnapshots`，断言行数、`payload='{}'` 的行数、>30 天行数=0。
- 点选 8 天前历史快照，页面显示空表 + 提示文案；点选 7 天内历史快照，粉丝列表正常。
- VACUUM 后 `page_count` 稳定，库体积 < 2MB。

## 风险

- **历史明细丢失**：8 天前的粉丝列表无法回看——若运营确实需要更长明细窗口，可调大 `fullDays` 参数（方案设计为可配置常量）。缓解：常量 `FULL_PAYLOAD_DAYS=7` 置于方法顶部，一行可调。
- **`sealed_at` 缺失/为 0 的旧快照**：历史脏数据若 `sealed_at` 为 0 或 null，`sealed_at < now-30d` 永真 → 被删。缓解：`COALESCE(sealed_at, 0)` 判定，或对 `sealed_at=0` 的行单独保留（保守起见本次保留 `sealed_at IS NULL` 的行）。
- **写入频率仍高**：每封口仍写一封快照（每 bot 一天多封），purge 会在 6h 内收敛到每天一封，不影响存量上限；若要进一步降写入，可在写入端加「同 bot 30 分钟内重复封口跳过」——本次不做，留作后续。
