# 软风控优先 + 加速关注（设计摘要）

日期：2026-07-30

## 目标

关注是主引擎：更快点关注以触发软风控；软风控窗口内再分流私信/养号；窗口外关注优先，避免日常被养号挤掉。

## 行为

1. **关注间隔**默认 `5–8s`（原 `12–19s`）。
2. **软风控窗**随机 `15–18` 分钟，写入 `sg_state`：
   - `softRiskUntil`
   - `softRiskMode`: `chat` | `nurture`
   - `softRiskChatDone`
   - 同步 `followNextDelayUntil = softRiskUntil`
3. **分流规则**：Day>2（≥3）且私信时段且轮次未满时 50/50；否则只养号。
   - Day1–2 软风控仍只养号（不塞私信）
   - 日常阶段表私信主线同为 S3（Day≥3 + 私信时段）
4. **窗口内优先级覆盖**：
   - `chat` 且未完成 → 只跑私信（整轮，最长约 30min，不中断）
   - 私信结束后若窗口未尽 → 养号填满
   - `nurture` → 只养号
   - 禁止领号/关注
5. **窗口外**：S1 默认 `follow, nurture`（配额满仍仅养号）。

## 关键文件

- `unified-scheduler/follow/content_follow_v1522.js` — 间隔、`enterSoftRiskDiversion`
- `unified-scheduler/scheduler-core.js` — 优先级覆盖、chat 完成边沿、面板 softRisk
- `unified-scheduler/scheduler/stage-detector.js` — S1 关注优先
- `unified-scheduler/shared/config-sync.js` / `remote-settings.js`
- `unified-scheduler/ui/panel.js` — 软风控行
- OPS：`014_soft_risk_follow_first.sql`、`config.njk`

## 验收要点

- 间隔日志约 5–8s
- 软风控日志/面板：`分流 → chat|nurture`、剩余秒数
- 窗口内无新关注；私信整轮后再养号
- 窗口结束恢复关注优先

## 关键业务规则（必读，含未写明部分）

> 用户原话：「博主要点完五十个，点十五个风控的时候，进行其他任务，然后跳转回来继续点击，当前博主点完后切换下一个博主。」

1. **触发点**：连续点关注约 **15 个**后 X 触发软风控 → 进 15–18 分钟休息窗。
2. **休息期**：窗口内切到其它任务（chat/nurture 分流），不点关注。
3. **休息后回原博主**：窗口结束调度恢复关注时，**必须恢复当前博主**的粉丝列表继续点（任务锁 `matrix_current_task_id` / `matrix_current_creator` 在窗口内不得释放；`startFollow` 走锁恢复路径，`matrix_step = SCAN`，进度靠 `matrix_follow_processed_fans` 续点）。
4. **切换博主**：仅当前博主粉丝列表点完（触底 + 本博关注 ≥ `POOL_DONE_MIN_FOLLOWS=5`）→ `pool_done` → 才领下一博主。
5. **回归验收**：风控休息 15–18 分钟后，面板应回到**同一个博主**（非新号）；再点 15 个 → 再休息 → 循环；当前博主点完才出现新博主。
