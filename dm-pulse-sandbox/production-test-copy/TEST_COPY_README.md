# 智能调度中心测试副本

此目录是 `unified-scheduler/` 在 2026-11-09 的测试副本，用于验证 DM 只读脉冲沙盒与当前插件逻辑的共存和导航行为。

## 4.9.157 破冰队列不再被看门狗掐断 + “等下一轮”不再丢回复

- 现象一：拉新阶段封口后，队列里明明有 1 个待破冰，每次都在 7–12 秒内重复选中同一人（`task_item_done doing`），第 3 次触发 `chat.ice_open_url_fallback` 打开 `/<handle>` 后就没下文；85–105 秒后必然出现 `chat.engine_watchdog reset_roster`，随后 `back_to_inbox`。同一个人永远破不了冰。
- 根因一：看门狗把“拉新阶段进入时长超过 90 秒”当成卡死。封口后逐个开人本来就要离开粉丝列表，队列一跑就超过 90 秒，于是每轮都被复位。
- 根因二：`runInboxRosterPhaseTick` 的页面走丢判定只看“还在不在粉丝列表”，进资料页/会话页 60 秒后直接 `roster_scan_page_lost`，同样会打断破冰。
- 修复一：看门狗改为「进度优先」。主引擎写 `sg_chat_last_progress_at`（`queue_drain / step_* / roster_* / ice_* / has_target` 等私信进度），150 秒内有新鲜进度就不复位；真停死（无进度）仍按原规则自愈。关注/养号进度不算私信保活。
- 修复二：拉新阶段识别“有在飞的破冰任务”（`dan_auto_step` + `current_target` 且不在 `/i/chat`），此时离开粉丝列表不算页面走丢，并持续续写进度。
- 现象二：脉冲读到对方 3 条回复（`reply_verdict=reply_detected`），但结论是 `kick_wait`（催加等待中），这个人被写入 `reopenedAt` 后下一拍直接判 `already_surfaced`，从此再也不会被打开。
- 根因三：收口复活逻辑把 `action=wait` 也当成“已处理”。
- 修复三：只有 `send` / `no_new_reply` / `skip` 才算已处理；`wait` 写 `reopenRetryAt`（15 秒 ~ 10 分钟）与 `reopenRetryReason`，到点重新复活；等待期间对方若真有新消息，预览变化立即复活（不等原定时间）。
- 反馈：`chat.inbox_pulse` 增加 `revived_reason=reopen_retry_wait`，扫描丢弃计数增加「已读到回复、等下一轮才发（排队重试）」。
- 修复四：资料页还没渲染完（读不到 `UserName` / `profileHeader` / 标题）时，不再 2 拍就判「对方没开私信」永久拉黑；改为最多等 6 拍，仍读不到就 `deferred(profile_not_ready)` 等下一轮，并上报 `chat.profile_not_ready`。只有资料页真的渲染出来、确实没有私信按钮，才允许进 `no_dm` 终态。
- 版本升至 4.9.157。验收：拉新封口后应看到同一人从 `doing` 推进到 `1_entering_dm` / 会话页；OPS 不再出现 `reset_roster` 把破冰打断；`/i/chat` 里读到回复但被判定等待的目标，下一轮应重新出现在 `chat.inbox_pulse`。

## 4.9.156 刷新/重启后自动恢复 + 暂停不再“幽灵在线” + 软窗不再同拍判死

- 现象：OPS 账号停在 `engine=idle、running_module=""、why_idle=软风控 1228s | chat_nurture_chat扫描中`，连续十分钟一个字都没变；关注停在 198/298，私信没有 `chat.inbox_pulse`。同一时刻 `system.page_alive` 正常、引擎 lite 心跳正常，看起来“在线在跑”，实际调度核心已经停下。
- 根因一：整页刷新 / 重启 Chrome 后，是否恢复调度只取决于 `sg_state.running`。手动测试、单模块测试等路径会把它写成 `false`，于是新页面永远停在「待命」，没有任何模块被拉起，也不会再写日志。
- 根因二：运行态心跳只在 `S.running || coRunning` 时上报。调度一旦内部停下，OPS 就再也收不到 full 心跳，界面永远显示最后那条旧 `why_idle`，把「已停止」伪装成「在跑」。
- 根因三：4.9.154 的“私信段 10 分钟无进展 → 回关注”只看私信最后进度。刚进软窗时这个时间还停在上一次（现场 14 小时前），于是窗口一开就被同拍判死：`soft_risk_round_end` → 关注 → 再撞软风控 → 再进窗，每 10 秒一轮 `chat.identity_reset`，私信永远起不来。
- 修复一：新增自动模式意图标记 `sg_auto_intent`（点启动/远程 start 置位，手动暂停清除）。页面加载时若「有意图且用户没按暂停」，直接 `coStartScheduler()` 恢复，并发 `scheduler.auto_resume`。
- 修复二：运行态心跳改为始终每 30 秒上报；暂停时 `auto_mode=0`、`why_idle=未启动自动模式`，OPS 不再显示卡住的旧状态。
- 修复三：`tryEndStalledCappedSoftRisk()` 增加「本轮软窗至少已运行 10 分钟」的前置条件（读 `softRiskStartedAt`），新开的窗口必须先真正跑一轮私信，才可能被判无进展。
- 修复四：`shared/config.js` 读取 storage 前先确认 `chrome.runtime.id`，扩展重载后的旧页面不再抛 `Extension context invalidated`。
- 版本升至 4.9.156。验收：刷新页面或重启 Chrome 后 1 分钟内应出现 `scheduler.auto_resume`、`auto_mode=1` 的 full 心跳；手动暂停后 `auto_mode=0` 且不会被自动拉起；软窗开启后不应再出现每 10 秒一轮的 `soft_risk_round_end` + `chat.identity_reset`。

## 4.9.154 软风控私信段无进展 → 回关注（修永久卡死）

- 现象：面板显示“运行 · 自动调度”，OPS 心跳正常，但 `running_module` 一直为空、`why_idle=软风控 0s | chat_nurture_chat扫描中`；私信没有 `chat.inbox_pulse`，关注也停在 183/298 不动，每 30 分钟只重复一条封顶日志。
- 根因：软风控私信段设计上要“排 chat 直到一轮队空”才结束；但私信引擎没有真正跑起来（无候选/启动失败/页面侧停止）时，这一轮永远不会队空，相位一直停在 `chat1`（累计加班封顶后更明显），而 `follow.canRun` 又因软风控为真被拒绝，形成死锁。
- 修复：不再依赖持久化计时字段，每拍直接读 `chatProgressAgeMsCo()`；只要软窗处于 chat1/chat2 且私信最后进度已超过 10 分钟，则判定本轮不可能自然收口，主动结束软窗、清相位并回关注，同时发 `scheduler.soft_risk_round_end(reason=cap_no_progress)` 便于验收。
- 保留：私信仍在推进（10 分钟内有进度）时不会被打断；普通发送仍按 45 秒假活线；关注日配额、新号就绪、软风控仍照常拦截。
- 版本升至 4.9.154。验收：私信段无进展 10 分钟内应出现 `soft_risk_round_end`，随后关注恢复；不再出现长时间 `why_idle=软风控…` 且关注不动。

## 4.9.145 修复 /i/chat 被误判白屏导致反复刷新

- 现象：X 页面明明正常显示私信列表，OPS 仍每 60 秒出现 `Heal 白屏≥45s，请求 sg_request_heal reason=white_screen`；页面被整页刷新后，正在进行的粉丝扫描/发信中断，随后被 45–180 秒假活线回收。
- 根因：新版 X 私信列表不依赖 `primaryColumn`，会话行是 `dm-conversation-option-*`。私信脚本 4.9.32 已适配新结构，但调度核心 `isPageHealthyDom()` 仍只认旧版 `dm-conversation-item-*`，因此同一页面出现“私信脚本认为正常、调度核心认为白屏”的分裂判定。
- 修复：调度核心补认 `a[role="option"][id^="dm-conversation-option-"]`、`[data-testid="DMDrawer"]`、`[data-testid="dm-inbox-panel"]`；并在 `/i/chat` 路径下用 `main` 的真实文本做兜底，明确排除“重试 / Try again / Something went wrong”等报错页。
- 保留：后台标签页不触发白屏自愈；真白屏仍按原预算自愈；普通发送仍按 45 秒假活线判断。
- 版本升至 4.9.145。验收：页面正常显示会话列表时，OPS 不再出现 `reason=white_screen` 的 Heal 请求；扫描期间不再被整页刷新打断。

## 4.9.146 白屏判定兼容新版 X 的 textContent 兜底

- 现象：4.9.145 上线后 OPS 仍有 `Heal 白屏≥45s`，`unhealthyFor` 可达 128 秒；但同一时刻 `system.page_alive` 为 `hidden=false`，页面实际在渲染。
- 根因：新版 X 多个路由（/i/chat、主页、粉丝列表）都已移除 `primaryColumn`，仅靠旧选择器仍会漏判；另外 `innerText` 在后台/未完成布局时可能为空。
- 修复：`isPageHealthyDom()` 改用 `textContent` 读取主栏文本，`main` / `[role="main"]` 有 ≥80 字且不是报错页即视为健康；Heal 告警追加 `path/pl/ml/nodes` 诊断字段，便于下一次直接定位。
- 版本升至 4.9.146。验收：页面正常渲染时不再出现 `reason=white_screen`；若仍出现，日志里的 `ml=` 会直接暴露主栏实际文本长度。

## 4.9.148 扩展重载后的孤儿脚本保护

- 现象：错误面板出现 `[配置] 从 storage 加载配置失败: Extension context invalidated`，以及 `Uncaught Error: Failed to read the 'onMessage' property`（scheduler-core.js:7099）。
- 根因：扩展重载/更新后，旧页面里的内容脚本上下文已失效；消息监听注册和后续定时器仍去读 `chrome.runtime`，于是持续抛错。更危险的是孤儿定时器还会继续操作页面，但所有上报都失败。
- 修复：新增 `sgExtensionAlive()` 判活；`coTick`、watchdog 定时器与消息监听注册都加失效保护，一旦 `chrome.runtime.id` 读不到就停掉调度/心跳/远程命令等定时器，只告警一次，等 Service Worker 重载该标签页。配置模块识别失效上下文后改用 `console.warn`，不再刷红错误面板。
- 同时修复：`forceSoftRiskOvertimeCap()` 原来每个 tick 都写两条 warn + 一条遥测，18 小时累计约 2.8 万条；`softRiskUntil` 会随时间窗推进，不能拿它去重，现改为同一相位最多每 30 分钟记一次，行为不变。
- 版本升至 4.9.148。验收：重载扩展后旧页面不再抛 `Extension context invalidated`；OPS 的封顶日志从每分钟数条降到每 30 分钟最多一组。

## 4.9.144 粉丝扫描不再被普通假活线误杀

- 现象：后台运行 3 小时内出现 22 次 `tick_progress_stale` 假活回收，全部发生在本号粉丝列表；私信被反复暂停 90 秒到 10 分钟。
- 根因：普通出站假活线是 45 秒，拉新看门狗是 90 秒；粉丝列表冷加载或后台标签被 Chrome 节流时，页面超过 45 秒没有新进度，扫描尚未完成就被杀掉重开。
- 修复：识别 `roster_*`、`outbound_fan_scan_*`、`outbound_gap_scroll_*` 等扫描进度；扫描中最多给 180 秒宽限，超时仍会正常回收。看门狗对 `scanActive` 使用 `scanActiveAt` 计时，同样放宽到 180 秒。
- 保留：普通打开会话、发送消息仍按 45 秒假活线判断，不降低真实卡死检测能力。
- 版本升至 4.9.144。验收：粉丝列表扫描期间不再反复出现 `chat_zombie_reclaim`；私信轮次能连续推进。

## 4.9.143 恢复 24h 测试模式（默认全天）

- 需求：测试期间不再区分上下班，关注、养号、私信/守箱均可全天运行。
- 开关：测试副本默认 `sg_test_24h=true`；面板“24h ON / 24h OFF”可一键切回正常昼夜时段。
- 迁移：升级到 4.9.143 时会把旧版本遗留的 `false` 迁移为开启，只执行一次，之后尊重面板选择。
- 边界：旧会话 3 天无往来仍判 `expired_3d_stale`，不会因 24h 模式重新打开几周前的对话；关注配额、新号就绪、软风控等硬闸不变。
- 验收：任意时段均可私信/守箱；OPS 不再出现因下班产生的 `chat.inbox_paused`；面板显示 `24h ON`。

## 4.9.142 超过 3 天的旧会话不再打开

- 现象：私信时段仍会打开很久以前的会话/旧目标，对方的最后一条消息停在几周前。
- 根因：过期判定只看“我方最后一条消息超过 3 天且对方没回”。如果最后一条是对方很久以前发的，判定会认为“有回复”而永不过期，队列每天都会把这些旧会话重新捞出来。
- 修复：新增“双方最后一条消息（不论方向）超过 3 天即过期”的判定；粉丝队列分类、破冰队列出队、守箱动作规划三处统一生效，过期目标标记 `expired_3d_stale` 并跳过。
- 保留：沉默很久后对方刚回新消息（3 天内）仍会正常进入广告/回复流程，不会误杀真实新回复。
- 版本升至 4.9.142。验收：OPS 不再出现旧目标入队；旧会话不会被重新打开；新回关/新回复不受影响。

## 4.9.141 关注配额与重复战报修复

- 现象：OPS 显示今日关注 `193/191`；同一次关注在 OPS 里出现“有目标”和“无目标”两套成功日志；每次页面重载都会补发一批旧关注战报。
- 根因：Day 从本地误判的 Day1 校正到 OPS 的 Day3 时会重抽日限，但没把“今日已用数”作为下限；关注成功后既调用 `reportOpsFollowResult` 又调用旧 `reportToNAS`，旧备份在每次 boot 被 `replayFollowBackup` 重放。
- 修复：日限重抽和读取都不能低于今日已用数；关注成功只保留一条带目标的主上报；OPS `/api/plugin/log` 对同账号、同目标、同日的关注成功日志二次去重。
- 同时修复：`boot` 清空关注进度改用 `sg_follow_proc_cleared_46044` 一次性标记，刷新页面不再反复清空；真正开始关注任务时仍按本轮重置。
- 版本升至 4.9.141。验收：不再出现 `193/191`；同目标当日只有一条成功关注日志；重载页面不再刷“已清空本地关注进度”；19:00 后仍零私信、零守箱。

## 4.9.140 OPS 运行状态被空闲心跳覆盖修复

- 现象：插件面板显示“运行 · 养号中”，OPS 账号运行状态却变成 `engine=idle`。
- 根因：chat/follow 引擎即使没在跑，也每 5 秒发一次 `status=idle` 的 lite 心跳；后台无条件写 idle，把调度器 full 心跳上报的 `running_module=nurture` 覆盖掉。
- 修复：后台按 handle 记录当前真实运行模块（full/lite 心跳共同维护）。其他模块的空闲心跳只更新 `last_seen`，不写 `engine/running_module`；只有同模块自报空闲、或调度器 full 快照显示无模块运行时才清空。
- 同时修复台账补记污染：`round_gap` 补记不再写成一次成功广告，只补轮次序列，不推进线索阶段、不写 `ad_sent` 活动，避免 OPS 看起来像重复发送。
- 同时修复假发送战报：私信战报改为气泡确认成功后才写；发送失败/未确认不再提前记 `ad_sent`，避免 OPS 认为已发、插件又重试导致真重复。
- 版本升至 4.9.140。验收：养号运行期间 OPS 始终 `engine=nurture`、`running_module=nurture`；19:00 后仍零守箱、零私信；点赞不超 12/12。

## 4.9.139 养号评论写入修复

- 现象：养号持续出现 `评论-写入失败`，评论日预算一直不增长，并在 2–3 分钟内反复尝试。
- 根因：旧逻辑把 `ClipboardEvent('paste')` 当作真实粘贴；合成事件不会修改 X 评论框的实际 DOM，读回为空后直接判失败。
- 修复：写入改为 `execCommand('insertText')` → 合成粘贴 → DOM 事件兜底，三种方式逐级校验；评论框选择优先 `tweetTextarea_*` 与 `role=textbox`。写入/输入框/发送键失败增加 5–10 分钟退避，避免连续撞同一错误。
- 版本升至 4.9.139。验收：日志不再连续出现 `评论-写入失败`；成功评论后 `nurture_comments` 正常增长；点赞仍保持 12/12 上限。

## 4.9.138 养号点赞日预算越权修复

- 现象：OPS 显示今日点赞已 `12/12`，养号又给新帖点了赞；页面状态从“喜欢”变成“已喜欢”。
- 根因：`canLikeNow()` 只检查 15 分钟分片和 8 分钟点赞冷却，没有检查每日/每小时预算；日预算满了仍能继续点赞。
- 修复：`canLikeNow()` 先过 `canDo('likes')`（每日 + 每小时），再过分片与冷却；显式配置 `0` 现在表示关闭冷却，不再被默认 8 分钟吞掉；`clickLike()` 再加一道 `canDo('likes')` 防御。
- 版本升至 4.9.138。验收：`nurture_likes` 达到日预算后，新帖不应再出现“已喜欢”；养号应继续做评论/进主页/趋势等未耗尽动作。

## 4.9.137 重载后 park 状态残留修复

- 现象：页面重载后 OPS 的 `system.page_alive` 仍长期显示 `park=true`，看起来像一直在深度空闲；配置同步也会被“park 时 5 分钟一次”的规则拖慢。
- 根因：`sg_idle_park` 写在 `sessionStorage`，页面重载后值还在；但内存里的 `_coIdleParkActive` 初始化为 false。下一拍判定“不 park”时，`applyIdleParkMode(false)` 认为状态没变直接 return，旧标记永远没被清掉。
- 修复：启动时从 `sessionStorage` 恢复 park 状态；`applyIdleParkMode` 先同步存储再判断是否早退，确保内存与存储始终一致。
- 版本升至 4.9.137。验收：重载后 `system.page_alive` 的 `park` 应与实际状态一致；非私信时段关注满额后应看到养号动作，而不是长期 `park=true`。

## 4.9.136 关注满额后养号接上（修复下班后完全空闲）

- 现象：关注跑到 `193/193` 后，18:36 起调度完全空闲，OPS 面板长期 `park=true`；养号没有接上，整晚只发心跳。
- 根因一：`nurture-quota-gate` 在关注满额时直接返回 `follow_quota_full`，把「关注优先、养号兜底」里的兜底也一起拦掉。
- 根因二：`idle-park-gate` 只看关注满额就整拍早退，养号日预算还有余量也不给启动机会。
- 修复：
  - 养号闸改为只看模块开关和养号自身日预算；关注满额时明确返回 `follow_quota_full_nurture_ok` 放行。
  - 仅当养号日预算真正耗尽（`NurtureTracker.isDailyExhausted()`）才停养号、才允许深度空闲。
  - 非私信时段关注满额 + 养号未跑完 → 不 park，交给养号兜底；私信时段仍按 chat 节奏，不被养号拖住。
  - 关注满额不再触发「停养号」日志，夜间仍只关注/养号，不产生私信或守箱。
- 版本升至 4.9.136。验收看 OPS：`followed=193/193` 后应看到养号启动、`build=4.9.136`；只有养号日预算耗尽后才允许 `park=true`。

## 4.9.135 稳定性修复：打断“白屏→回收→立刻重启”的死循环

- 现象：私信时段 OPS 连续出现 `white_screen_loop`、`chat_zombie_reclaim`、`diag_anomaly`、`diag_freeze`，每条间隔约 45–90 秒；同时 `scheduler.follow_idle_recover` 每 90 秒出现一次，关注人数长时间不动（现场 followed 停在 136 约 50 分钟）。
- 根因一：假活回收停掉私信后没有重启冷却，下一拍 `coTick` 又按 `priority=chat` 立刻重开。新文档的白屏计时从 0 开始，但上一个文档的 45 秒回收已经触发，于是形成“页面还没渲染完就被杀 → 重开 → 又白屏”的自锁。
- 根因二：未满配额恢复逻辑没有尊重领号/启动宽限（`followStartGrace`），领号还在飞就被判空转；恢复后也没有退避，下一次仍是同一节奏，形成 90 秒一次的循环。
- 修复：
  - 私信假活回收写入 `sg_chat_zombie_hold_until` 与 `chatNextAllowedAt`，按 90s → 3min → 6min → 10min 递增退避；退避闸排在软风控/赶工之前，任何自动重启路径都不能绕过。10 分钟内不再回收则视为新故障，从 90s 重新计。
  - 关注空转恢复增加 `!followStartGrace` 条件，领号/启动宽限内不再清旗标。
  - 关注空转连续恢复按 1/2/4/8 分钟递增退避；首次和每第 5 次才写日志/OPS，避免同一故障刷屏。
- 版本升至 4.9.135。验收看 OPS：假活回收后至少 90 秒内不应再出现新的 `round_start`；同一故障的 `follow_idle_recover` 不应再每 90 秒一条；关注人数应继续增长。

## 4.9.134 稳定性修复：空闲降频不再误报卡顿，僵尸旗标自动失效

- 现象：关注满额进入空闲后，OPS 周期性出现 `event_loop_lag`（lag≈30s）；随后假活回收被跳过，chat/nurture 的运行旗标长期不释放，`nurture_blocked`、`chat_blocked` 持续刷屏。
- 根因：空闲 park 主动把整拍拉长到 35s，压力检测仍按 10s 预期计算 gap，把调度自己的降频误判成主线程卡顿并升到 L2；L2 又会跳过假活回收，形成自锁。养号 `sg_nurture_running` 残留时，`coEngineAlive` 只看旗标不看心跳，也会永久挡住 park。
- 修复：
  - 压力检测识别“上一拍是主动节流”，跳过该 gap 并清零压力等级，不再产生假的 30s 卡顿。
  - 养号引擎存活判断增加 `sg_module_nurture.lastActive` 心跳，超过 90s 未更新即判死，允许回收并进入空闲 park。
  - `chat_blocked` / `nurture_blocked` 同原因 5 分钟内只上报一次，原因变化立即上报。
  - 生产模式下测试采集器不再每页加载重复上报 `test.monitor_auto_stopped`，且降为 info。
- OPS 同步修正：后台标签页默认只标 warn（连续 90 拍才 error）；`peer_inbox_closed` 归为正常终态 info，不再混进 `dm_send_failed` 红色错误。
- 版本升至 4.9.134。验收看 OPS：空闲 park 时不再出现新的 `event_loop_lag`；`nurture_blocked` 每 5 分钟最多一条；`dm_send_failed` 只保留真正的输入框/气泡确认失败。

## 4.9.133 无新回复不再追加任何私信

- 现象：经典模式下广告发出后，对方没有新回复，仍会在到点后收到“催加”或“终催”；截图中表现为同一个人短时间连续收到带链接的广告。
- 根因：`chat_two_seg_mode=off` 时，广告和两次催加分别由不同的时间闸控制，催加只看 `round`/时间，没有检查广告之后是否真的收到新的对方入站。两段式广告已修，但经典催加仍会追发。
- 修复：`inbox-state`、`inbox-decision`、`chat-gates`、`content_chat` 和 `scheduler-core` 统一按“上一条我方消息之后是否有新入站”判断：第一次催加必须晚于广告，第二次催加必须晚于第一次催加；没有新回复就只等待，超过 3 天按 `expired_3d_no_reply` 过期。
- 同时修正调度侧的可行动催加计数，避免没有新回复的旧会话反复把私信阶段拉起来。
- 版本升至 4.9.133。验收看 OPS：无回复目标只会出现 `await_reply` 或 `expired_3d_no_reply`，不应出现第二次广告/催加发送；真实有回复的目标仍按原节奏推进。

## 4.9.132 无回复不发广告 + 粉丝列表未读全必补扫

- 现象 1：对方破冰后一直没回，17:47 仍收到 LINE 广告；18:00 左右又出现第二条催发。
- 根因 1：两段式模式保留了「等满 60 分钟就发第二段」的时间放行，等待时间被当成回复证据；4.9.129 只修了非两段式，两段式仍会无回复发广告。
- 修复 1：`chat-gates`、`inbox-state`、`inbox-decision` 三处统一改为「必须先有对方回复才发广告」；无回复只等待，最后一次我方消息超过 3 天按 `expired_3d_no_reply` 过期，不再靠时间自动升级成推销。
- 现象 2：粉丝列表实际只读到 28 人、主页显示 60 人，仍封口并把 60 写成新基线，下一轮不涨粉就不再扫，新回关被漏掉。
- 根因 2：封口时只看是否触底，未把 `cells < 主页 F` 当作未读全；退出拉新又把当前主页人数推进基线。
- 修复 2：
  - 未读全（含浅扫、`cells + 2 < F`）不推进基线，写入 `gapPending`。
  - 下一轮即使粉丝数没涨，也按 `rescan_gap` 强制重建队列补扫，直到读全才清除 `gapPending`。
  - 读全后才做真实粉丝对账、推进基线。
- 现象 3：LINE 链接卡把正文拆成多个节点时，发送确认只按整段文本匹配会误判 `no_bubble`，消息其实已上屏，下一轮又换文案重发。
- 修复 3：增加兜底确认「输入框已清空 + 我方气泡数量增加」即视为发送成功（`own_bubble_grew`），不再把已发出的广告当失败重试。
- 现象 4：17:30 后今日末次私信名额已用、关注又满额时，调度仍每 10 秒判一次私信债，持续刷 `chat_last_entry_used`。
- 修复 4：末次名额已用或私信日帽已满时，不再把私信债当成阻止空闲 park 的紧急任务；关注满额即深度 park，次日恢复。
- 版本升至 4.9.132。验收看 OPS：无回复目标只出现 `await_reply` / `expired_3d_no_reply`，不再出现无回复广告发送；粉丝列表浅扫后出现 `rescan_gap` 与 `chat.fan_roster_gap`，后续补扫到 `cellsSeen + 2 >= profileFollowers` 才封口。

## 4.9.131 非私信时段空闲降频（修复满额空转）

- 现象：关注额度已满、又处于非私信时段时，调度仍每 10 秒尝试养号，持续上报 `scheduler.nurture_blocked: follow_quota_full`，页面并没有真正进入空闲。
- 根因：空闲 park 判断把「私信时段外仍有私信债」当成紧急任务，但此时私信硬闸根本不会放行，导致 park 永远不成立。
- 修复：只有私信时段内才把私信债视为阻止 park 的紧急任务；时段外、关注满额且无其他引擎时正常进入深度空闲降频。
- 同时给 `system.sw_alive` / `system.page_alive` 补上 `build` 字段，OPS 可直接确认浏览器实际加载的扩展版本，不再依赖注册表里可能滞后的版本号。
- 版本升至 4.9.131。验收看 OPS：关注满额且非私信时段不再每 10 秒出现 `nurture_blocked`，`system.page_alive` 应显示 `park=true`。

## 4.9.130 跨标签页心跳与错误日志降噪（修复正常任务被误停）

- 现象：OPS 每 45–60 秒出现 `chat_zombie_reclaim / tick_progress_stale`，随后 `diag_freeze` 反复停掉私信和关注；实际私信任务仍在另一个标签页正常运行。
- 根因：私信端把进度心跳只写进 `sessionStorage`，而调度和私信经常不在同一个 X 标签页；`sessionStorage` 按标签页隔离，调度读不到另一页的心跳，就把正常等待误判成“假活”。
- 修复：
  - 私信端 `noteChatProgress`、调度端 `noteChatProgressCo` 同时写 `localStorage` 和 `sessionStorage`。
  - 调度读取进度时取两处存储的较新值；进度原因也跟随最新心跳，不再被旧的 session 数据覆盖。
  - `ResizeObserver loop ...` 与 `Extension context invalidated` 作为浏览器环境噪声处理，不再计入 `system.logger_error`；真实异常仍正常上报。
- 版本升至 4.9.130。验收看 OPS：正常任务不再周期性出现 `tick_progress_stale` / `diag_freeze`；日志 build 为 4.9.130；真实错误仍会出现。

## 4.9.129 无回复不发广告、3 天过期（修复重复催发）

- 现象：Miru 14:22 已破冰且没有回复，16:52 广告发送失败，17:43 又被作为广告重试；截图看起来像同一条广告发了两次。
- 根因：非两段式旧规则把「破冰满 60 秒」当成可发广告，没有把「对方是否回复」作为硬条件；失败记录又被下一轮重新入队。
- 修复：
  - 非两段式：没有对方回复时只等待，绝不发广告、不退化成 `need_probe`；只有本拍读到回复或台账确认曾回复过，才允许发广告/重试失败广告。
  - 3 天过期：最后一次我方主动消息超过 3 天且之后没有对方入站，按台账时间判 `expired_3d_no_reply`；粉丝队列分类、OPS 回灌、守箱候选三处共用同一判定。
  - 有对方新回复的旧会话不过期；精确未读仍优先处理，避免把真正来信漏掉。
- 版本升至 4.9.129。验收看 OPS `dm_records`：同一人无回复时不再出现第 2 轮广告；日志出现 `reason=await_reply` 而非 `decision=no_reply + sent=true`；超过 3 天无回复的人不再被打开。

## 4.9.128 回复质量修复（不再连发、旧话术、两小时后才回）

- 现象：对方 14:24 回「30歳です」，插件 16:42 才发广告；广告 16:42 发出，16:46 又追一句「あれ？まだかな」；同一人 16:43–16:52 被反复写回 `kick_ready` 队列。
- 根因一：巡查只在粉丝队列跑空后进入；白天队列一直有活，回复被压到两小时后。
- 根因二：`chat_inbox_kick_min_minutes` 默认 1 分钟，广告后下一拍就催加。
- 根因三：本地 `round` 与 OPS 轮次口径不同——OPS 3=首次催加，本地 3=完结；`getEffectiveFanRound` 直接取最大，导致催加后状态在“已完成/还欠催加”之间抖动；且 `canSendKickNow` 没有时间闸，队列每轮重新把同一人排成 `kick_ready`。
- 根因四：`getPoolMessage` 只抽本地默认 `v1..v15`，`loadScripts` 又用“数量少就回退”覆盖 OPS 的 `random_pool`，所以 OPS 的 `direct_v1 / curious_v1 / blunt_v1` 从未生效，旧「大人余裕」话术一直发出。
- 修复：
  - 出站任务边界也按 15 分钟间隔切守箱巡查；有 `dan_auto_step / dan_dm_inflight / doing` 时不抢占。
  - 首次催加默认 180 分钟、终催默认 720 分钟；`canSendKickNow` 与状态机共用同一时间闸。
  - `getEffectiveFanRound` 把 OPS 3 映射为本地 2、OPS 4+ 映射为 3；`seedOpsRosterDebtToQueue` 对本地已有 `kickSentAt` 的 OPS kick 行直接跳过。
  - `getPoolMessage` 使用台账里的 `random_pool`；`loadScripts` 只在池子不可用时才回退默认；服务器版本更新时 soft-ice 不再阻止覆盖。
- 版本升至 4.9.128。验收看同一人 3 小时内不出现第二条催加、OPS `dm_records` 不出现 4 分钟内 2/3 轮连发、`dan_scripts.random_pool` 为 OPS 下发的 `direct_v1/curious_v1/blunt_v1`。

## 4.9.127 守箱定时巡查（回复不再靠运气）

- 现象：对方 1 小时前回的私信一直没人看；OPS 上 `chat.inbox_loop` 只有 `paused_reason=inbox_not_running`，守箱根本没开。
- 根因：守箱不是常驻轮询——只有「软风控窗口内 + 破冰队列做完」才会转去 `/i/chat`；窗口一过就再也不看收件箱。4.9.125 的守箱自愈还会把 `sg_test_inbox_watch` 持久化成 `false`，等于把守箱彻底关掉。
- 修复：破冰队列做完后按固定节奏进守箱巡查。
  - 每 15 分钟进一次（`sg_inbox_patrol_min`，3–120 分钟可调）；
  - 每次停留 6 分钟（`sg_inbox_patrol_keep_min`，2–30 分钟可调），到点自动停脉冲、切回出站、本轮交回调度；
  - 巡查不碰破冰队列；非私信时段一律不巡查；`sg_inbox_patrol_on=0` 可整体关闭。
  - 守箱内部节奏不变：脉冲 60 秒一拍（`sg_inbox_pulse_sec`，20–300 秒），同一会话复查冷却 8 分钟（`sg_inbox_revisit_min`）。
- 版本升至 4.9.127。

## 4.9.126 台账以真实粉丝为准（清幽灵/取关）

- 现象：主页只有 60 个粉丝，台账却挂着 288 行；取关/早就不在粉丝列表的人还在排队破冰，OPS 台账永远对不上真实人数。
- 根因：目标库只增不减——历史扫描、OPS 回灌、守箱占位都会写行，但「已取关」从来不清理，`buildFanLedgerSnapshot` 又把全库原样上传。
- 修复：
  - 全量封口（真滚到粉丝列表底，非浅扫）时按本次真实扫到的 handle 集合对账：扫到的刷新 `lastSeenOnFollowersAt`；有私信历史但没再出现的标 `leftFollowers`（保留历史、退出所有队列）；从没联系过的幽灵条目直接删除。
  - 队列里 pending/deferred 但没再出现 → `skipped/left_followers`；`classifyFanRosterAction` 对取关的人第一优先跳过。
  - 台账快照不再包含取关行（否则上传的 `allHandles` 又把人带回来）；OPS 回灌数据里的取关行也直接忽略。
  - OPS 侧：`dm_roster_items.left_followers` 新列；全量封口且 `allHandles` 覆盖主页粉丝数时标记取关；台账页默认只显示真实粉丝，已取关历史折叠隐藏。
  - 触发条件：当本地台账行数明显多于主页粉丝数（`dbTotal > F + 3`）时，自动丢弃本轮浅扫基线、强制重扫整份粉丝列表（30 分钟冷却），否则永远只浅扫顶部、取关永远对不出来。强制重扫期间禁止 `hasFanRosterBaseline()` 的「升级兼容推断」把基线偷偷补回来。
  - 对账判据：触底封口，或本次 `cellsSeen + 2 >= 主页 F`（说明确实滚满了整份列表）才执行；浅扫绝不删人。
- 版本升至 4.9.126。

## 4.9.125 守箱模式自愈（破冰队列卡死）

- 现象：私信队列每 50 秒建一次又清空，一条破冰都发不出去，日志里 `run_mode=inbox` 与 `chat_phase=outbound` 并存。
- 根因：守箱是手动测试态，`sg_run_mode=inbox` 写进 localStorage 后不会自动恢复；自动出站轮次仍被改写成 `/i/chat`，粉丝队列永远不 drain，随后被判假活回收。
- 修复：出站相位（`dan_chat_phase=outbound`）遇到残留 `inbox` 时自愈回 `outbound`，同时清 `sg_test_inbox_watch` 并同步扩展存储；显式守箱（`phase=inbox`）不受影响。
- 版本升至 4.9.125。

## 4.9.124 非私信阶段关注优先

- 非私信阶段（Day1 的 S1、Day≥2 的 S2、下班后与早间）统一为「关注优先、养号兜底」。
- 删除 Day1 的「养号排在关注前」软排序；OPS 下发的顺序也不能再把养号顶到关注前。
- 早间不再有「仅养号」独占分支，一上班即可关注；`morningNurtureUntil` 仅保留为兼容字段。
- 硬闸不变：关注日配额满、新号资料未就绪、关注模块关闭、软风控/冻结时仍只养号，不越权关注。
- 养号正在跑时不会被抢占，等当前任务安全收尾后下一拍按新优先级启动关注。
- 私信链路（S3、chat 置顶、yield、夜间硬停）与 OPS 协议零改动。
- 版本升至 4.9.124；重载后 OPS 应显示 `build=4.9.124`。

## 4.9.123 夜间私信硬停补漏

- 软导航、整页导航、遗留调试恢复、跨 18:00 的已启动脉冲和手动私信测试入口全部纳入同一时段硬闸。
- 18:00 前已开始的一拍若在深扫/选人后跨出时段，不再打开会话、不读取、不发送。
- 后台标签重建若原地址是 DM 页，夜间改回 `/home`；残留的 `00:00–24:00` 全天窗也按关闭处理。
- 阶段检测器同样不再读取旧的 `sg_test_24h`，避免启动初期误判成白天后拉起私信。
- 修复 `00:00` 被默认值误解析成 `09:00`、导致 `00:00–24:00` 实际变成 `09:00–24:00` 的问题；全天旧值和跨午夜/倒置窗口现在统一回落到正常白天窗。
- 版本升至 4.9.123；重载后 OPS 应显示 `build=4.9.123`，夜间不再出现新的守箱动作。

## 4.9.122 夜间私信硬停

- 非私信时段不再存在“主循环被 stop 后又立刻重挂”的路径；清理定时器只会在线段内重挂守箱。
- DM 页面导航、守箱测试、强制守箱、后台 tick、页面看门狗和独立引擎看门狗全部先过同一时段闸。
- 没有 X 标签时，后台只有在私信窗内才会自动补 `/i/chat`；夜间不会再创建守箱页。
- 测试副本永久关闭 24 小时覆盖，旧本地值或 OPS 值都不能绕过 09:00–18:00（账号级时段仍优先）。

## 4.9.121 三天过期与正常昼夜时段

- 最近发送记录超过 3 天的会话不再进入守箱候选；精确未读除外，避免漏掉新来的未读消息。
- 时间取台账里的 `lastDM`、`iceSentAt`、`adSentAt` 与终催发送时间，不把扫描/观察时间误当成联系时间。
- 没有可用发送时间的条目不因缺字段被误删。
- 跳过数量写入 `expired_3d`，明细原因是 `ledger_activity_older_than_3d`。
- 测试副本恢复正常时段：白天按私信窗运行，夜间由调度运行关注；“私信测试”不再强制 24 小时模式。
- 版本升至 4.9.121；重载测试副本后，OPS 日志应显示 `build=4.9.121`。

## 4.9.116 三个让“脉冲看起来没在扫”的真问题

### 1. X 标签页被关掉后，后台永久停摆（最严重）

**现象**：2026-11-13 14:02:01 之后，OPS 里 `chat.inbox_*` 一条都没有了，
但 `system.sw_alive` 每两分钟照常写入，看起来“插件在跑”。检查 Chrome 发现：
X 标签页已经不存在，只剩「扩展程序」和别的网站。

**原因**：后台每 60 秒的存活检查只对「已经存在的 X 标签」做探活；
标签一个都不剩时 `forEach` 直接空转，没有任何重建逻辑。
内容脚本全没了，脉冲自然一条都不会有，但后台心跳还在，所以后台看不出异常。

**现在**：后台每分钟检查一次；**没有任何 X 标签**且守箱开关开着时，
自动补一个 `https://x.com/i/chat` 后台页（`active:false`，不抢焦点）。
带 3 分钟最小间隔 + 每小时最多 4 次，避免崩溃循环里疯狂开标签。
守箱开关通过 `sg_inbox_watch_on` 同步到扩展存储，后台才读得到。

### 2. 后台标签预检用过期缓存判“没有任务”

**现象**：13:58 那拍 `action=idle / reason=no_task`，
`scan.rows=211 / candidates=0 / peer_last=0`，`cache_age_ms=269723`（4.5 分钟前）。
但同一份 211 行列表在 13:50 明明有 16 条“对方最后发言”。

**原因**：后台标签页为了避免抢焦点，会先用整箱快照预检“有没有活”。
旧逻辑只要候选为 0 就直接 `no_task` 并跳过激活，**完全不看缓存有多旧**。
过期快照一旦漏掉新消息，就会一直报“没有任务”，会话永远不打开。

**现在**：缓存超过「一拍 + 30 秒」（90 秒～5 分钟区间）即作废，
强制激活标签做一次真扫描，并在 OPS 里记 `cache_stale_forced_scan`。

### 3. 终催和首次催加发的是同一句话

**现象**：OPS `dm_records` 里 7 个人（`gszlht15`、`hgg21914`、`hide0521ht1233`、
`jiiko0301`、`oeqtv9n79h79835`、`uha_kaikan`、`y_hinata07`）第 3 轮和第 4 轮内容逐字相同。

**原因**：约会池三套话术（`direct_v1 / curious_v1 / blunt_v1`）在 OPS 里只有
`kick_message`，没有 `final_kick_message`。旧兜底链 `final_kick || kick` 直接退回首次催加文案。

**现在**：终催优先用话术池终催 → 默认终催文案 → 首次催加；
并且如果最终选中的文案与首次催加**完全相同**，强制改用默认终催文案，
保证同一个人收到的两次催加一定不是同一句。

## 4.9.115 死代码：点击失败后的「按地址直达」从来没执行过

这一版修的是最直接的“打开了但没读成”的浪费。

### 现象

2026-11-13 11:54–12:02 连续 6 拍 `chat.inbox_tick` 全部是 `reply_read_failed`，特征完全一致：

| 字段 | 值 |
|---|---|
| `open_mode` | `click` |
| `url_peer_id` | 空 |
| `dom_leaves` / `dom_articles` | 0 / 0 |
| `composer_found` | false |
| `identity_ok` | false（`identity_pending`） |

这说明点击列表行之后**根本没进入会话页**，页面还停在 `/i/chat` 列表根。
每一拍都白等 12 秒，然后换下一个人，下一拍又可能点回同一个人。

### 原因

代码里本来有一段“点击失败 → 按 peerId 地址直达”的兜底，但它被写在
一个无条件 `return { reason: 'click_render_timeout' }` 之后，是**永远执行不到的死代码**。
所以兜底从来没生效过。

### 现在

```
点击 → 12 秒内会话挂载？ → 是：正常读取
                          → 否：真的尝试按地址直达一次
                                 → 直达被后台标签挡住：记 deferred_not_visible，换目标
                                 → 直达预算耗尽：记 nav_budget_wait，换目标
                                 → 直达已发起：记 open_nav_failed，下一拍接着读
                                 → 没有可用地址：记 open_unreachable 并换目标
```

### 单拍耗时上报

现场一拍实际 225–255 秒，而 CPU 只占 0.1%，说明时间全在等待里。
旧日志只有 `dan_inbox_stage`（当前卡在哪一段），回答不了“这 250 秒花在哪”。

现在 `chat.inbox_tick` 增加 `stage_trace`：

```
stage_trace: {
  total_ms: 248000,
  segments: 9,
  slowest: [{stage:'msg_wait_done', ms:60000}, {stage:'composer_wait_done', ms:30000}, ...],
  order: ['tick_start','list_ready','row_selected','conv_open','msg_wait_done', ...]
}
```

超过 10 分钟的间隔会被丢弃（页面卡死/系统休眠不算某阶段耗时），
只保留本拍最多 20 段，不会无限累积。

### 等输入框不再空等 30 秒

对方关闭收件箱 / 会话只读时，X 永远不会渲染输入框。
旧逻辑在“等输入框就绪”这段空等满 30 秒才发现没有输入框，
而一拍总共只有 3–4 分钟，这 30 秒是纯浪费，且这个会话本来也发不出去。

现在每 1.2 秒检查一次只读横幅，命中就立刻停止等待，
结论仍落成 `peer_inbox_closed`（不发送、不误记成 `no_composer` 技术失败），
但这一拍可以马上换下一个目标。

### 心跳新增「全台账为什么不回」分布

旧心跳的 `ledger_pending` 只统计「已破冰、还欠广告或催加」的人（现场只有 3 条），
但台账里实际有 282 人。用户截图里一屏没回的人，在后台根本对不上号。

现在 `chat.inbox_loop` 增加 `no_reply_breakdown`，按业务原因分桶：

| 桶 | 含义 | 是否正常 |
|---|---|---|
| `not_iced` | 没破冰（破冰只能从粉丝列表发起） | 正常，不回复 |
| `ad_pending` | 已破冰、还没发广告 | 会继续推进 |
| `kick_pending` | 广告已发、还欠催加 | 会继续推进 |
| `closed_done` | 破冰+广告+两次催加已发完 | 正常，不回复 |
| `rejected` | 已婉拒（年龄/意向不合格） | 正常，不回复 |
| `blocked` | 已拉黑 | 正常，不回复 |
| `inbox_closed` | 对方关闭收件箱 | 本次不发，会复查 |
| `reopened` | 收口后对方又来消息 | 已按既有判定重新处理 |

判定顺序固定为「拉黑 → 婉拒 → 关闭收件箱 → 没破冰 → 已完结 → 欠广告 → 欠催加」，
保证「已拉黑/已婉拒」不会被误算成「没破冰」，也不会让「关闭收件箱」混进「已完结」。
`samples` 只留还在进行中的人（最多 12 条），已完结的不占位。

## 4.9.115 「对方关闭收件箱」不再是永久终态

这一版修的是一类“看起来有明确业务原因、实际上是死路”的漏回复。

### 现象

- 台账里有 3 条被记成 `peer_inbox_closed`（对方关闭了收件箱）。
- 后台心跳只剩 `inbox_closed=3`，`ad_wait / kick_wait / no_verdict` 全是 0。
- 这 3 个人从此再也不会被打开，哪怕对方重新开放了收件箱、甚至发来新消息。
- 现场表现为：后台永远说“对方关闭了收件箱”，但没人能知道他现在到底还关不关。

### 原因

候选过滤里是硬跳过：

```
if (entry && Number(entry.inboxClosedAt)) { drop.peerInboxClosed++; continue; }
```

`inboxClosedAt` 一旦写入就再没有任何清除路径。而 X 允许对方随时重新打开收件箱，
所以“曾经关闭”被错误地当成了“永久关闭”。

### 现在

- 关闭时记下当时的列表预览（`inboxClosedPreview`）。
- 列表预览一变 → 立即复查（对方很可能已经重开并来信）。
- 否则每 6 小时复查一次（`INBOX_CLOSED_RECHECK_MS`）。
- 复查时横幅已经不在，且身份证明 + 正文真读成功 → 清除关闭状态，
  写 `inboxClosedClearedAt` 并上报 `chat.inbox_reopened_by_peer`。
- 关闭期间对方来的消息，记 `lastInboundWhileClosedAt`，
  后台能回答“他明明发消息了，为什么没回”。
- 后台预检（`hiddenInboxHasWork`）把到期复查算成“有活”，
  否则复查永远不会被触发。
- OPS 新增 `peer_inbox_closed_recheck` 计数与 `peer_inbox_closed_samples`
  （带关闭时间、下次复查时间、预览），能区分“等复查”和“正在复查”。

注意：白屏/空壳同样读不到横幅，因此解除关闭状态必须同时满足
“身份证明通过 + 正文真的读出来”，不能凭“没看到横幅”就解除。

### 未读蓝点：从「只报没有」改成「报出为什么没有」

现场 `unread_dot_probe` 连续 6 条都是 `dots: []`，只能证明“按我们的判定没找到蓝点”，
不能回答“这行到底有没有蓝点、蓝点长什么样”。

现在每行额外输出 `edge`：行右缘 70px 内、2–40px 的全部候选元素，
带 `tag / data-icon / data-testid / fill / backgroundColor / 宽高 / 距右缘 dx`。
蓝点再抓不到时，后台能直接看出是：

- 行里确实没有元素（真没点）；
- 有点但尺寸超出 3–14px 判定；
- 有点但颜色不是我们认的蓝色；
- 点画在伪元素或父级容器上。

## 4.9.114 三条会把真实会话静默丢掉的路径

这一版修的是「后台看不出问题、但那个人就是没被处理」。

### 1. 心跳探针抢占 60 秒闸，正式心跳被挡成空壳

- 现场证据：`chat.inbox_loop` 大量记录只有 `{probe, phase, at}` 三个字段，
  没有 `running / busy / ledger_pending / work`，看不出引擎状态和待处理台账。
- 原因：探针和正式心跳共用同一个事件名，也共用 60 秒闸。
  旧顺序是「探针先写闸 → 正式心跳被挡掉」，每分钟只剩探针。
- 现在：正式心跳先发，探针在它之后补发，并用独立的时间键。
  后台每一分钟都能看到完整心跳。

### 2. 台账有记录、列表找不到，只报一个数字

- 旧实现只累加 `not_seen_in_list`，OPS 只能看到一个数字，无法回答“是谁丢了”。
- 现在同处留档 `not_seen_samples`：handle、显示名、peerId、轮次、miss 次数、上次结论。
  这类会话在列表上根本不出现，未读和对方最后发言都抓不到它，必须点名才查得动。

### 3. 没有 peerId 也没有显示名的台账，被按「会话不存在」永久收口

- 这类条目永远匹配不上列表行。旧逻辑仍累加 miss，
  连续 12 次完整扫描后按 `conversation_not_in_inbox` 关掉，
  一个真实存在、可能正在等回复的人就被永久丢弃，且现场查不出原因。
- 现在单独标记 `ledgerUnmatchable`，跳过收口判定，
  并计入 `not_seen_unmatchable`。它属于“必须先补身份”，不属于“找不到会话”。
- 另外，键写成 `p<peerId>` 的台账，peerId 只是没写进字段，不算没身份：
  现在会从键里补回 `peerId`，下一拍就能正常按 peerId 命中。
  真实 `@handle` 同样算可匹配，只有 `dn_` 这类合成键才真的对不上。

## 4.9.113 后台预检永远报「没活」：计数根本没算

这一版修的是「脉冲在扫，但 OPS 永远只显示 unread=0 / peer_last=0，看不出到底有没有人回复」。

### 1. 未读 / 对方最后发言的计数在候选判定之后才算

- 现场证据（2026-11-13 13:58，`chat.inbox_pulse`，hidden=true）：
  后台预检写的是 `rows=211 / scanned=211 / unread=0 / peer_last=0 / candidates=0`；
  而同一份列表在可见拍（13:54）是 `peer_last=16 / candidates=1`。
- 原因：`hiddenInboxHasWork()` 里两个计数写在了 `collectInboxWatchCandidates()` 之后，
  而候选分支会直接 `return out`。只要预检走到候选分支，`unread` / `peer_last` 就永远停在 0。
  这不是「真的没人回」，是反馈字段没被填。
- 现在：先把整份列表的未读与对方最后发言统计完，再做候选判定；
  两套统计都跑完整份快照，不再因为提前 return 丢掉。
  后台从此能区分「整箱确实没有新回复」和「有回复但被规则拦下」。

### 2. 蓝点取证只查行内，蓝点在父级容器时看不到

- 原来 `unread_dot_probe` 只探测会话行内部，现场返回的全是 22–26px 的灰色时间戳，`dots: []`。
- 现在行内探不到时，会再向上探测一层父级容器，输出 `pDots`。
  这样下次现场就能直接看出蓝点到底挂在行里还是行外，而不是每轮都只能猜。

### 3. OPS 里 31 条记录写着 `[local_backfill_r2]`，看起来像发过

- 现场核对 `dm_records`：323 条里有 31 条正文是 `[local_backfill_rN]`。
- 原因：本地台账推进过（多数是从会话历史补认「已经发过」），但没有留下该轮原文，
  OPS 补记缺轮时就写了这个占位符。它不是消息内容，却长得像消息内容。
- 现在改成能直接读懂的中文：`[未记录原文·第2轮·由台账补记，非实际发送内容]`。
  台账里出现这种记录，就说明「这一轮是补记，不是真的发过一条」，不会再被误读成已发送。

## 4.9.112 脉冲节奏失联 + 只有一两条气泡时误判「对方先私信」

这一版修的是「脉冲看起来在跑，实际每 3 分钟才一拍」和「明明是我方破冰过的人，被判成陌生人」。

### 1. clearAllTimers 把守箱主循环清掉，脉冲只剩看门狗抢救

- 现场证据（2026-11-13 13:20–13:58）：`chat.inbox_loop` 心跳里 `next_pulse_in_ms=0`（早就该跑），
  但真实 `chat.inbox_pulse` 每 181–192 秒才出现一次，而且每次都紧跟一条
  `chat.engine_watchdog action=nudge_engine overdue_ms≈190000`。
- 原因：私信一轮收工 / 停机分支会调用 `clearAllTimers()`，把守箱主循环 interval 一起清掉；
  之后没有代码重新挂，只能等看门狗 3 分钟后唤醒一次。
- 现在：`clearAllTimers()` 清完立即检查「守箱模式 + 守箱开关」，
  成立就重置 `_sgChatMainEngineId` 并调用 `ensureChatMainEngine()` 重新挂上。
  脉冲回到正常 60 秒节奏，不再依赖看门狗抢救。

### 2. 会话只有 1–2 条气泡时放弃回翻历史 → 误判对方先私信

- 现场证据：13:50 `p2584897766`、13:54 `p1955301471047569408` 都是
  `bubble_own_count=0 / bubble_peer_count=1`，判定 `peer_dm_before_ice`（对方先私信、我方没发过），永久跳过。
- 原因：`findDmScrollContainer()` 要求 `scrollHeight > clientHeight + 8`。
  会话只有一两条气泡时没有滚动条，返回 null，`loadOlderDmHistoryForIce()` 直接以
  `no_scroller_no_needle` 放弃回翻，读不到更上面的我方破冰气泡。
- 现在：没有滚动条时走新增的 `forceLoadOlderDmMessages()`：
  回到顶部 + 向消息区及其祖先派发 `wheel(deltaY:-600)` + 顶部气泡 `scrollIntoView`，
  最多 4 轮、每轮 700ms，有界不无限滚。
  回翻证据新增 `forced / bubblesBefore / bubblesAfter`，
  结果原因为 `no_scroller_forced_top` 或 `no_scroller_but_more_loaded`，
  后台能直接看出「是没读全，还是确实没有我方气泡」。

## 4.9.110 不许静默丢弃：后台预检 / 临时台账 / 窗口弹跳

这一段修的是「有回复却一直不动，后台只说没活」的三条真实死路。

### 1. 后台标签只扫 12 行就判“没活”（no_task 死锁）

- 旧逻辑：`hiddenInboxHasWork()` 候选为 0 就回 `no_task`，本拍不激活标签。
  但候选 0 可能来自三种情况：只看到顶部 12 行、缓存是几分钟前的、身份冷却还没到期。
  结果：列表下方的未读永远轮不到，脉冲每分钟稳定报 `rows=12 / unread=0`。
- 现在：预检必须回报数据来源 `cache_used / cache_rows / cache_age_ms / live_rows / full_list`；
  只有 `full_list` 为真（用了整箱快照，或行数多于可见行）才允许回 `no_task`。
  列表不完整时直接进入激活+完整扫描，不再靠“看见 12 行”下结论。
- `hidden_no_work` 现在必须带 `drop` 与 `samples`：后台能直接看到
  “没破冰多少人、冷却多少人、谁因为什么被丢”，不再只有一个 0。

### 2. 临时台账读失败一次 → 永久锁死

- 旧逻辑：“同一预览只尝试一次”，第一次打开碰上后台标签/白屏就写下 `lastProbeAttemptPreview`，
  之后这条会话在预览变化前永远不会再被打开。现场表现就是「对方明明回了，这个人永远不动」。
- 现在：新增 `lastProbeAttemptAt`，读失败后 **10 分钟退避重试**；
  列表预览一变（对方真发了新消息）立刻重试。等退避的单独记 `probe_retry_wait`，
  后台能区分“在等重试”和“规则不回”。

### 3. 自愈重建标签把窗口顶到前台

- `recreateXTab()` 旧条件 `active: winFocused && tab.active !== false`，
  只要窗口本来在前台，重建的新标签就 `active:true`，Windows 上会把 Chrome 提到最前。
- 现在重建一律 `active:false`。守箱需要可见时自己发 `sg_activate_tab`，
  不再由自愈路径抢焦点。

## 4.9.105–4.9.109 私信主循环一致性修复

这一段全部围绕同一类问题：**“看起来像对方没回，其实是台账/识别/打开失败”**。

### 4.9.105 同一人两条台账 + 缓存冻结未读

- 真实 `@handle` 台账（有破冰/广告历史）与临时 `p<peerId>`（`round=0`）同时存在时，
  反查取“遍历到的第一条”，常命中临时记录 → 永久判“没破冰、不处理”。
  新增 `ledgerEntryEvidenceRank()`，按「真实 handle / 非 watchOnly / 有 iceSentAt / 有广告痕迹」排序。
- 深扫文字快照把 3 分钟前的 `unreadInfo` 一起缓存，新蓝点亮起后仍报 `unread=0`。
  新增 `refreshSnapshotRowsUnread()`，缓存拍用当前可见 DOM 刷新未读。

### 4.9.106 打开后并回真实账号

- 列表行只有 peerId → 建了临时 `p<peerId>`；打开会话拿到真实 `@handle` 后，
  旧代码不会把两者关联，真实账号的破冰/广告历史永远对不上。
- 新增 `header_adopted`：只补空缺字段，不覆盖真实账号已有证据；临时记录保留 `mergedInto` 痕迹。
- `lastProbePreview`（真正读成功）与 `lastProbeAttemptPreview`（只尝试过）分开，
  避免一次读失败把临时记录永久标记成“已核对”。

### 4.9.107 没进会话就不能读正文

- 现场：`open_mode=click`、URL 仍是 `/i/chat`、没有任何会话 id，
  却继续读气泡 → 0 条 → `reply_read_failed`，看起来像对方没回。
- 打开后加硬校验：`pathHasConversationId()` 且不在列表根，否则直接 `open_nav_failed`。

### 4.9.108 后台预检不再误判“没活”

- `hiddenInboxHasWork()` 以前只看当前可见 12 行，且要求台账已有 `iceSentAt`，
  列表下方未读和临时台账全被漏掉 → 每拍 `no_task`、不激活。
- 改为使用整箱快照 + 复用守箱候选判定，并新增 `readOnly` 模式：
  预检只回答“有没有活”，不写台账、不清冷却、不记 pendingAt。

### 4.9.109 相位与 OPS 记账

- **拉新相位冲突：** 进粉丝列表时写 `dan_chat_phase='outbound'`，守箱看门狗每 5 秒又拉回 `inbox`，
  关注/养号会趁机抢页面，破冰做到一半跳走。现在拉新阶段固定保持 `inbox`。
- **`round_gap` 假告警：** 补记链最后一步仍报 gap，但前几轮其实已经写进 OPS，
  于是记失败并在 5 次后 `give_up`。现在失败前再读一次真实轮次，
  已到目标轮就按 `round_gap_already_recorded` 结案。
- **`peerIdOwnedByOther` 误挡：** 合并后的临时记录仍带同一 peerId，被当成“别人占用”，
  导致真实账号回写 peerId 被拒绝 → `identity_pending`。现在跳过 `mergedInto` 与合成键。

## 4.9.105 漏回复根因：同一人两条台账 + 缓存冻结未读

现场症状：收件箱里明明有对方最后发言（如「40です」「何が？」），脉冲每拍仍报
`candidates=0 / no_ice=145`，这些人永远不会被打开、也不会被回复。

- **根因一：同一个人有两条台账。** 真实 `@handle` 一条（有破冰/广告/催加历史），
  另一条是早期无 handle 探测留下的临时 `p<peerId>`（`round=0`、`watchOnly`）。
  `resolveLedgerHandleByPeerId` 与扫描期的 `pid2h` 映射都取“遍历到的第一条”，
  经常命中临时记录，于是被永久判成“没破冰 → 守箱不补破冰 → 不处理”。
- **修复：** 新增 `ledgerEntryEvidenceRank()` 证据强度排序——真实 handle、非 watchOnly、
  有 `iceSentAt`、有广告痕迹的条目优先。两处反查都改用它挑条目，临时记录再也顶不掉真实账号。
- **根因二：深扫快照冻结未读。** 深扫 3 分钟一次，中间拍复用文字快照，
  但快照里连 3 分钟前的 `unreadInfo` 一起缓存了。对方在可见区新发消息、蓝点亮起后，
  缓存拍仍报 `unread=false`，于是不打开。
- **修复：** 新增 `refreshSnapshotRowsUnread()`，缓存拍用当前可见 DOM 的未读状态覆盖同名行；
  可见行蓝点消失时同步清掉旧视觉未读。OPS 的 `scroll` 增加 `cache_unread_refreshed`。
- **测试：** `test/inbox-deep-scan-cache.test.js` 增加两条守卫；全量 **576 项通过**。

## 4.9.101–4.9.103 后台标签不再抢前台 / 台账终态 / CPU 占空比

- **「插件每分钟把窗口弹出来」根因：** 脉冲一开始就调用 `sg_activate_tab`，即使用户正在别的标签页工作，
  也会被切回 X；其实没有未读、没有待回复时完全不需要激活（列表在后台仍然可读）。
- **修复：** 后台标签先做 `hiddenInboxHasWork()` 预检（未读 + 已破冰且对方最后发言），
  没有活直接记 `no_task / scan.reason=hidden_no_work`，不激活、不切前台；
  只有真的有待回复会话才激活，激活后仍不可见则 `page_hidden_deferred`。
- **台账终态：** `inboxClosedAt`（对方关闭收件箱）计为已完结，不再永久占着 `kick_wait`；
  心跳新增 `inbox_closed` 计数。
- **CPU 矩阵化：** `scheduler-core` 新增 `coTickTimed()`，把每次 tick 同步耗时累加到
  `sg_work_tick_ms/n/max`；`content_chat` 把每次列表分类/深扫的同步耗时累加到 `sg_work_scan_*`。
  `chat.inbox_loop.work` 输出 `cpu_pct_est`、`tick_ms_avg/max`、`scan_ms_avg/total`、`work_ms_total`。
- **告警降噪：** 拉新阶段回本号主页读粉丝数从 `warn` 改为 `info`，不再每半小时刷一条假告警。
- **4.9.103：** 后台标签被 Chrome 节流（1 分钟一拍）不再判成 `system.pressure L2`；
  刚回到前台的第一拍同样跳过压力判定。心跳新增 `last_scan`（上一拍 rows/candidates/scan_drop），
  不用翻单独事件就能看到“这一拍为什么没有处理任何会话”。
- **测试：** 新增 `test/inbox-idle-no-raise.test.js`；全量 574 项通过。

## 4.9.104 状态机与旧闸门口径统一

- `canSendKickNow` 以前要求首次催加时 `round===2`；旧台账 `round` 停在 1、但 `adSentAt/adBubbleOk`
  已有广告痕迹时，状态机判 `kick_ready`、旧闸门却永远拦住，表现为“广告发了却永远不催加”。
  现在以发送痕迹为准：有广告痕迹即允许首次催加；没有广告痕迹仍然拦住。
- 台账没有 `iceSentAt` 但广告痕迹已存在（补认/旧数据）时，运行时状态机与契约镜像
  现在都返回 `ad_already_sent`，不再一边说“没破冰”、一边说“广告已发”。
- 文档同步修正：非两段式破冰后**下一轮轮询就发广告**（读不出年龄按默认发），
  不是无限等回复；“收口后来信”也改为重新打开、交回同一套状态机，而不是记 `closedInboundNoReply` 丢弃。

## 4.9.98 / 4.9.99 深扫停在列表底部 → 找不到行 → 整页直达 → 误判“没回复”

- **现场表现：** 每个 `chat.inbox_pulse` 都是 `reply_read_failed`、`dom_leaves=0`；
  手动看页面时，会话列表停在“15～18 周前”，最新会话全部不在可视区。
  于是脉冲选中了新目标却找不到对应行，只能整页直达 `/i/chat/<peer>-<my>`；
  直达后 X 回到列表或只画空壳，读 0 条气泡，台账又被记成“技术读失败”。
- **根因 1：滚动容器选错。** 深扫按 `overflow:auto + scrollHeight>clientHeight` 选容器，
  选中的是假容器，赋值 `scrollTop=0` 并不生效；扫完仍停在底部。
- **根因 2：直达地址不可用。** `/i/chat/<peer>-<my>` 整页打开 100% 读不到正文，
  每拍都变成一次刷新 + 一次读失败，越修越乱。
- **修复：**
  1. 选滚动容器时先做“能不能被 scrollTop 移动”实测；选不到就换下一个候选。
  2. 深扫结束必须验证 `scrollTop<=4` 才算回到顶部，否则用首行 `scrollIntoView` 纠正。
  3. 深扫从 25 秒一次降到 3 分钟一次；中间拍读**纯文字快照**，仍覆盖整份列表，
     既保留“按最新未读优先”的排序，也不再每 25 秒把 211 行滚一遍（内存从 1.3GB 的根因之一）。
  4. 普通目标找不到行时不再整页直达，只上报 `deep_row_gone` + 滚动容器诊断，
     90 秒内跳过该目标；直达仅保留给人工强制测试 `item.forced`。
- **OPS 新增：** `chat.inbox_pulse.scroller`（容器 tag/testid/scroll_top/scroll_height/client_height）、
  `scan.scroll.topResetOk`、`scan.scroll.scrollerVerified`。
- **4.9.99 追加：** 文字快照必须逐行保留换行。第一版把「显示名/时间/预览」压成一行，
  结果快照拍 211 行全部解析成 `unknown`、0 候选，等于整箱都漏；现在逐行规范化后再拼接，
  实测同一份 211 行列表恢复为 `peer=19 / own=192 / unknown=0`。

## 4.9.100 打开方式反馈 & 快照内存兜底

- `chat.inbox_tick.open_mode` 以前只要候选带拼接地址就写 `direct`，即使实际是点行打开；
  现在上报真实模式：`resume` / `click` / `row_href` / `direct`（仅人工强制）。
- 整份列表的文字快照增加同页内存副本：`sessionStorage` 写入失败时，下一拍照样覆盖 211 行，
  不会退回“只看首屏 12 行”。
- 现场复核：手动点会话行可以正常打开右侧聊天记录（URL 变为 `/i/chat/<对方>-<本号>`，气泡可见）；
  X 标签页内存从 1.3 GB 降到约 490 MB。

## 4.9.97 换页后主引擎失联（拉新卡死、脉冲不动）

- **现场表现：** 08:43:59 进入拉新阶段跳到本号主页后，`system.page_alive` 一直在，
  但 `chat.inbox_loop` / `chat.inbox_pulse` 全部停止，`last_pulse_at` 永远停在 08:43:56，
  `next_pulse_in_ms=0` 却不再有任何动作。守箱看起来“引擎在、但没检测”。
- **根因：** 主引擎只靠 `content_chat.js` 内部的 5 秒自愈循环维持。整页跳到其它 X 页面后，
  该页若不 tick（初始化异常/定时器丢失），拉新阶段没人推进，守箱也不会回来。
- **修复：** 新增独立 content script `chat/engine-watchdog.js`，不依赖主引擎：
  - 拉新阶段停留超过 90 秒 → 复位 `phase=watch`，`reason=watchdog_roster_stale`，不在私信页则导航回 `/i/chat`；
  - 守箱脉冲逾期超过 3 分钟 → 主引擎在就主动唤醒，主引擎不在就回列表页重载；
  - 两次导航至少间隔 2 分钟，避免来回跳；所有动作上报 `chat.engine_watchdog`。
- **验收：** `build=4.9.97`；全量 **564 项通过、0 失败**；
  OPS 应看到一次 `chat.engine_watchdog`，随后 `chat.inbox_loop` 恢复、`last_pulse_at` 继续前进。

## 4.9.96 无 @handle 的临时台账每拍重开空壳

- **现场表现：** `p1678252254997147655`、`p1134754206068482048`、`p2080596656433528832`
  每 60–90 秒被打开一次，全部 `dom_leaves=0 / identity_pending / reply_read_failed`，
  真正有回复的客户被挤到后面。
- **根因：** 临时台账的“同一预览只探测一次”只在**读成功**时记录预览；读失败什么都不记，
  下一拍照样算“预览变了”，于是同一空壳无限重试。
- **修复：**
  - 读失败写 `lastProbeAttemptPreview` 并累加 `probeFailCount`；
  - 同一预览最多再试一次（`probeFailCount < 2`），之后只有列表预览真的变化才重新探测；
  - 读成功仍写 `lastProbePreview` 并清零计数，不会因为读失败把真回复永久跳过。
- **验收：** `build=4.9.96`；全量 **557 项通过、0 失败**；
  OPS 中同一无句柄目标不再每拍出现 `reply_read_failed`。

## 4.9.95 已完结会话被旧气泡误判 → 重复发广告

- **现场表现：** `p1593973575232495617` 在 08:22 已发完首次催加与终催并收口；
  08:25 又被判 `revived(legacy_unchecked_inbound)`，重新发了一次广告，轮次从 3 回到 2，
  08:27 又开始新一轮催加。同一人 5 分钟内收到 4 条消息，其中广告是重复的。
- **根因：**
  1. `hasReply` 的语义是「会话里存在对方气泡」，不是「收口后对方又说了话」。已完结会话里
     历史对方消息永远存在，所以打开后必然判成有回复。
  2. 旧台账里的 `closedInboundNoReply` 标记被当成复活理由；它本来的含义恰恰是
     「已核对过、没有新回复」。
  3. `closedInboundPendingAt` 由扫描阶段自己写入，不校验真实入站时会自我续命。
- **修复：**
  - 复活必须有真实入站证据：`lastInboundAt / replySeenAt` 晚于收口时间，或精确未读；
    不再单独凭 `closedInboundNoReply` 复活。
  - 状态机新增闸门：复活会话读完后若最后一条仍是我方 → `reopen_no_new_peer_last`，
    不重发广告，本次来信按已核对结案。
  - `planAction` 与 `decideInboxAction` 同步实现，逐项比对 action/route/reason。
- **验收：** `build=4.9.95`；全量 **556 项通过、0 失败**。

## 4.9.94 OPS 补记 round_gap 永久重试刷屏

- **现场表现：** OPS 每约 4 分钟重复出现同一条 `chat.inbox_ledger_reconcile_fail`，`reason=round_gap`，
  目标一直是 `p1593973575232495617` 等几条；日志被同一条淹没，看不到别的反馈。
- **根因：** 本地台账轮次比 OPS 高时走补记；OPS 侧缺前轮、早期轮次不可重建，于是同一目标永远补不进去，
  既没有次数上限，也没有“放弃”状态。
- **修复：**
  - 失败累计 `opsReconcileAttempts`，并记 `opsReconcileLastFailAt / LastFailReason`；
  - 满 5 次写 `opsReconcileGiveUpAt / opsReconcileGiveUpReason`，只上报一条 `reason=gave_up`（带 `last_reason`、`attempts`）；
  - `pendingOpsReconcile` 跳过已隔离目标，并带回 `attempts` 便于核对；
  - 补记只改 OPS 轮次，不发任何消息。
- **验收：** `build=4.9.94`；全量 **553 项通过、0 失败**；OPS 不再按固定间隔重复同一失败。

## 4.9.90–4.9.93 深度下滑 / 临时台账 / 我方文案 / 台账 miss 收口

- **4.9.90 深度下滑：** 修 `dbDirty is not defined`；脉冲从只扫顶部 12 行恢复为真的滑到底
  （现场 211 行，`stopped_reason=bottom_reached`）。
- **4.9.90 / 4.9.91 临时台账：** 不再用 `^p\d{5,}$` 正则误伤真实账号 `p89089212`，
  改为只认显式 `watchOnly` 或 `dn_` 前缀；核对按证据触发，同一预览只核对一次，读失败不记“已核对”。
- **4.9.92 我方文案归属：** X 有时不给自己的消息加“你:”前缀，过去会把我们发过的广告/催加当成对方回复。
  现在只和台账真实记录过的 `lastAdText / lastKick1Text / lastFinalKickText` 比对；广告发送时写入 `lastAdText`。
  同时补认历史破冰：会话里已有含 `line.me` / `LINE ID` 的我方气泡 → 直接补 `adSentAt` 与 `round≥2`，不重复发广告。
- **4.9.93 台账 miss 收口：** 完整扫到底后仍找不到的台账目标累计 `ledgerMissCount`；
  连续 12 次完整扫描都没出现、且距破冰超过 24 小时，才写 `closedWhy=conversation_not_in_inbox`。
  扫描明细新增 `not_seen_in_list / not_seen_closed`。

## 4.9.84 / 4.9.85 空壳会话 / 假“对方先私信” / 复活空转

- **现场表现（2026-11-13 07:0x–07:3x，OPS 实测）：**
  1. `reeveelonmu16`、`p1593973575232495617（🍓「何歳ですか?」）`、`p117276382`、`p1678252254997147655`
     打开后一律 `dom_leaves=0 / dom_articles=0 / reply_read_failed`，看起来像“对方没回”，其实是会话正文没渲染；
  2. `hzwi83tf0zcuka5`、`4od4kre1mcuutfo` 每拍都以 `revived(legacy_unchecked_inbound)` 占住队首，打开后却是 `no_new_reply`。
- **根因：**
  1. 按 peerId 整页直达 `/i/chat/<对方>-<本号>` 时，X 只渲染左侧列表，右侧停在“开始对话”；`isDmConversationRendered()` 只看输入框/会话头，把空壳判成“已打开”。
  2. 页面没渲染 → 我方气泡数也是 0 → 旧逻辑据此写 `peerDmBeforeIceAt`（当成陌生人先私信），该会话被永久跳过。
  3. 收口会话的“未核对来信”标记没有结案，扫描层每拍都会重新判 `legacy_unchecked_inbound`。
- **修复：**
  - 地址对但 0 气泡、且台账已发过消息 → 判为没渲染，本拍退回点击列表行重开；事件 `chat.inbox_resume_empty`。
  - 只有 `domProbe.rootFound && (leaves>0 || articles>0)` 时才允许写 `peerDmBeforeIceAt`；读到我方气泡会清掉旧结论。
  - 临时台账 `p<peerId>` 不再永久丢弃：对方最后发言 +（未读或预览变化）可带预算（≤3 次）重新核对（`no_ice_synthetic_recheck`）。
  - 复活冷却：复活一次且读回 `no_new_reply` 后记录 `lastRevivePreview`；30 分钟内同预览不再复活（`revive_cooldown_same_preview`），预览变化立即恢复。
- **验收：**
  - `build=4.9.85`；
  - 全量 **540 项通过、0 失败**；

## 4.9.82 私信漏处理 / 关闭收件箱 / 老粉校准

- **现场表现：**
  1. `れん「40です」`、`青りんご「今年25の代です！」` 这类对方回复一直在列表里，却永远不处理；
  2. `t57qjwc2tmeyeva` 页面明确显示「收件箱已关闭」，OPS 却一直是 `no_composer` 并反复重开；
  3. 脉冲有时只扫顶部 12 行就报 `no_task`，明明还有几十个候选；
  4. `chat.inbox_scan_drop` 事件经常被整条瘦身，现场看不到是谁、为什么。
- **根因：**
  1. 名册首次建账把老粉写成 `round=0`，守箱一律按 `no_ice` 丢弃；其中一部分其实早就发过破冰，只是台账重建后丢了 `iceSentAt`。
  2. 关闭收件箱横幅在多层 shadowRoot 里；深度限制虽改成 12 层，但**全页文本先被主页时间线吃满 200000 字符**，根本没走到私信面板。
  3. 深扫 45 秒阈值与 40–48 秒实际脉冲间隔接近，出现“这一拍深扫、下一拍只看顶部 12 行”的交替；积压标记又依赖 inbox state 写入顺序，下一拍偶尔读不到。
  4. 事件样本带了整份台账证据，超过 6000 字符后被瘦身成汇总数字。
- **修复：**
  - 未破冰但对方最后发言的真实 @handle 会话，允许打开一次做历史校准：有我方气泡 → 补认破冰并继续；没有 → `peer_dm_before_ice` 明确不发。
  - `p<peerId>` / `dn_` 合成键排除，不再当老粉反复打开；无 handle 的陌生会话只有未读才探测一次。
  - 关闭横幅优先只扫消息列表根 / `dm-container` / `DMDrawer` 并向上爬祖先，再回退全页；同时收集横幅按钮文案。
  - 深扫阈值 45 秒 → 25 秒；新增独立积压标记 `sg_inbox_backlog_mark`，上一拍有候选就强制下一拍深扫。
  - `chat.inbox_scan_drop` 样本压缩到 6000 字符内（字段 `h/pid/p/r/st/rd/ice/ad/k/cl/li/rs`）。
  - 同一目标 60 分钟内最多 3 次按 peerId 直开，避免一次失败锁一小时。
- **验收：**
  - `build=4.9.82`；
  - 全量 **536 项通过、0 失败**；
  - `chat.inbox_scan_drop` 能看到真实 handle / 预览 / 原因；
  - 老粉被打开后出现 `ice_adopted=true`（有我方气泡）或 `peer_dm_before_ice`（没有）；
  - 关闭收件箱会话落 `decision=peer_inbox_closed` / `send_error=peer_inbox_closed`，之后不再重试。

## 4.9.57 私信漏回复根因修复

- **现场表现：** 列表里明明有 `40です`、`何が？` 这类对方回复，台账里也有这个人，但脉冲一直不回复；OPS 有时出现 `peer_id_mismatch`，有时打开会话读到 0 条气泡。
- **三个根因：**
  1. 搜索结果行只有一段 `row.id`，两段 ID 实际在 `href` 里；旧逻辑把第一段直接当对方，导致打开/记账串号。
  2. 回复收集器只取“最后一条我方气泡之后的对方文本”。会话变成「破冰 → 对方回复 → 我方广告 → 两次催加」后，中间那句真回复被永久遮住。
  3. X 消息区是虚拟滚动，旧滚动函数只认固定 testid；找不到真实滚动容器时不会贴底，也不会回翻历史，破冰气泡不在 DOM 就得到 0 条。
- **修复：**
  - 单段 `row.id` 用 `href` 补齐两段，再按本号 ID 反推对方；两段都不等于本号时判 `unresolved`，不再猜。
  - 破冰气泡之后的**全部对方文本**都纳入判定；同一批文本用 `peer_hash` 指纹只执行一次动作，发送失败不写指纹，下一拍继续重试。
  - 从消息区向上寻找真实滚动祖先；等待渲染时持续贴底；读取前最多向上回翻 4 次找破冰文案，再回到底部。OPS 新增 `history_scroll / history_scroll_zh`。
  - 打开后核对候选行与实际 URL；不一致记 `open_target_mismatch`，不读回复、不写台账、不发送，立即换目标。
- **验收：** `build=4.9.57`；`chat.inbox_tick` 能看到 `peer_texts_sample` 含真实回复、`history_scroll.foundIce=true`（能找到破冰时）；不再出现 `peer_id_mismatch`；`open_target_mismatch>0` 时有中文说明且不是“对方没回”。
- 当前全量 **496 项通过、0 失败**（新增 `inbox-v2-adapter-ids.test.js`、`inbox-reply-full-history.test.js`）。

## 4.9.52 收口复活 / 脉冲真下滑 / 催加节奏

- **现场表现：**
  1. 列表里明明有「40です」「何が？」这类对方回复，却一直没人处理；
  2. 脉冲每拍都 `deep_scan_throttled`、`scrolledPx=0`，看起来根本没下滑；
  3. 首次催加和终催在几十秒内连发；
  4. OPS 出现「选了某人」但连续 `no_actionable_rows`，队列停在原地。
- **根因：**
  1. 收口会话读到新回复后只写 `reopenedAt`，动作判定却一律 `stage_closed`；下一拍判 `already_surfaced`，这条回复永久消失。
  2. 深度扫描节流阈值 55s 与 60s 脉冲间隔几乎相等，每拍都被判“节流中”，只读缓存。
  3. 催加默认时间下限为 0，积压排水是 8 秒一拍，两步催加自然连发。
  4. 执行脉冲时只从“当前可视 12 行”重新收集候选；深度扫描选中的目标已滚出首屏 → 候选为空 → 整拍放弃。
- **修复：**
  - 收口后真入站（`inbound_after_close / peer_last_after_close / precise_unread_after_close`）→ 按广告段重开一轮：年龄合格发广告、不合格发婉拒；发送成功后清掉 `finalKickSentAt / kickCount / chatClosedAt` 并记 `reopenCycleSeq`。真婉拒/拉黑永不复活。
  - 读到回复但没发出去（无联系方式/输入框失败/业务闸门）**不写** `reopenedAt / closedInboundCheckedAt`，下一拍继续。
  - 一次性修复 `sg_inbox_reopen_cycle_v4950`：把“上次读到真回复、但只标了已读”的目标重新放回队列一次。
  - 扫描节流阈值 55s → 30s；`scan.peerLast` 改为整张列表的对方最后发言行数。
  - 脉冲带 `pickKey/pickItem` 时，首屏没有候选也继续用快照目标，交给 `revealInboxRowForItem` 滚回去点击。
  - 催加时间下限默认 1 分钟（`chat_inbox_kick_min_minutes=1`），即“下一次轮询”。
  - 广告/催加只要求文案里存在 LINE 联系方式（`line.me` 或「LINE ID：@xxx」或「ライン」）；完全没有才 `send_error=no_promo_link`。
  - 窗口最小化时不还原窗口，记 `page_minimized_deferred`；不再强行弹 Chrome。
  - OPS 轮次新增第二轮对话：5=再次广告、6=首次催加、7=终催、8…（需要 OPS 服务重启后生效）。
- **验收：**
  - `build=4.9.52`；
  - `chat.inbox_pulse.scan.scroll.steps > 0`（至少 30 秒一次真下滑）；
  - 收口会话出现新回复时，`chat.inbox_tick.revived=true` 且 `reply_reason=reopen_inbound`，`sent=true`；
  - 同一目标两次催加的 `kickSentAt` 间隔 ≥ 60 秒；
  - 不再出现连续多拍 `no_actionable_rows` 卡住。

## 隔离要求

1. 只加载到独立 Chrome / 比特浏览器测试配置。
2. 同一个浏览器配置里必须停用或卸载正式版「智能调度中心」。
3. 只使用测试账号，不使用生产账号。
4. 不将此目录同步、覆盖或复制到正式版扩展目录。
5. 测试结束后，从 `chrome://extensions` 移除此副本。

## 为什么不能和正式版同配置共存

- 不同扩展 ID 会隔离 `chrome.storage`、service worker 和扩展内部状态。
- 但两个扩展都运行在 `x.com`，页面 `localStorage` / `sessionStorage` 属于网站同源状态，可能互相读取或覆盖。
- 两个调度器同时运行还可能竞争导航、定时器、DNR 规则和业务动作。

因此，测试副本与正式版必须用不同的浏览器配置文件隔离。

## 4.9.44–4.9.45 身份误判与队列饥饿（P0）

- **现场表现：** OPS 每个脉冲都打开 `ken_sky8`，每次都 `identity_unproven / header_handle_mismatch`；列表上有大量未回复，但后面的 `れん`（`rinzkumk9`）等目标一直轮不到。
- **根因（两条叠加）：**
  1. 新版 `/i/chat` 会话头不在 `<main>` 里。旧逻辑取 `<main>` 内第一个单段链接，拿到的是左侧导航栏的本号 `/jakelu133969`，于是把“打开的就是目标本人”判成 `header_handle_mismatch`。
  2. 身份失败只在“非未读”时冷却，未读会绕过。这个目标列表上有蓝点，于是每 30 秒重开一次，永远排第一；其余目标被活活饿死。
- **修复：**
  - 新增 `role="log"` 消息区定位；会话头只取“消息区上方、非气泡内、非导航栏、非本号”的对方资料链接，标记为 `panel_header` 高可信。
  - 4.9.45：新版私信面板在 shadow DOM 内，会话头/消息区/输入框全部改为深度查询，避免只能退回 `<main>` 读到别人的资料链接。
  - `<main>` 兜底只作为低可信线索，不再单独判“点错人”；高可信会话头不一致才阻断。
  - 身份连续失败 2 次 → 冷却 30 分钟，未读也不能绕过；列表预览变化立即解除冷却并重试。
  - `chat.inbox_tick` 增加 `header_handle / header_source / header_confident`，能直接看出识别的是谁、依据是什么。
  - `chat.inbox.match_repair` 只在 peerId/显示名真正回写台账时上报，不再每次扫描刷 10 条噪音。
  - 气泡读取补上 `div[role="article"]` 内最长 `[dir="auto"]`，兼容没有 `message-text-*` 的新版结构。
  - 台账轮次修正：OPS `dm_records` 口径为 `1=破冰 / 2=广告或婉拒 / 3=首次催加 / 4=终催`。第二次催加不能再复用第 3 轮——OPS 对 `(bot,target,round)` 的 success 有唯一键，复用会被 `round_duplicate` 吞掉，台账就缺终催。婉拒在第 2 轮发完后补第 3 轮 `[age_reject_done]` / `[job_intent_reject_done]` 标记，OPS 才会显示“婉拒”而不是“广告”。首次催加与终催文案分开存（`lastKick1Text / lastFinalKickText`），补记时不会把终催填到第 3 轮。
- **验收：** `build=4.9.45`；`ken_sky8` 第一次身份失败后，下一拍必须换目标，30 分钟内不再反复打开；`chat.inbox_tick.header_source=panel_header` 且 `header_handle` 等于目标；`match_repair` 不再成批出现；第二次催加在 OPS 必须出现 `round=4`，且不能是 `round_gap / round_duplicate`。

## 4.9.46 本地台账 → OPS 补账（历史终催缺口）

- **现场表现：** `rinzkumk9`、`aochan__app1e` 本地台账已经是“两次催加、会话收口”，OPS `dm_records` 最大轮次却停在 3；看板上像“没有终催”。
- **根因：** 4.9.44 之前两次催加都按第 3 轮上报，OPS 对 `(bot,target,round)` 的 success 有唯一键，第二次被 `round_duplicate` 吞掉；修复后新发终催会写第 4 轮，但**已经发过的人不会再有发送动作**，所以历史缺口永远补不上。
- **修复：**
  - 新增 `SgInboxState.localOpsRound()`：从本地标志推导应到的 OPS 轮次（4=终催 / 3=首催 / 2=广告或婉拒 / 1=破冰）。
  - 新增 `SgInboxState.pendingOpsReconcile()`：只选“本地有发送证据、本地轮次高于 OPS、且未补记成功”的目标，轮次高的先补。
  - 守箱心跳每 5 分钟最多补 2 条；首屏拿到最新 OPS 轮次后立即强制补一次。补记成功写 `opsReconciledRound / opsReconciledAt`，失败留待下一轮。
  - 心跳新增 `ops_ledger_pending`，可直接看到还有几笔 OPS 缺账。
  - 事件：`chat.inbox_ledger_reconciled`（成功）/ `chat.inbox_ledger_reconcile_fail`（失败，含 `reason`）。
- **不变量：** 补账只补历史，不发消息；没有本地发送证据的台账不会被 OPS 反向造账。
- **验收：** `build=4.9.46`；`rinzkumk9` 在 OPS 出现 `round=4`；`ops_ledger_pending` 逐步归零；不出现新的 `round_gap / round_duplicate` 堆积。

## 4.9.47 拉新读粉丝数被“非本号主页”误挡

- **现场表现：** 进入 roster 阶段后停在 `/jakelu133969`，`chat.fan_roster_check` 每 5–6 秒一条 `count_unreadable`，`count=0 / baseline=63 / delta=-63`，连续 8 次后退出拉新；这一轮等于没查粉。
- **根因：** `readOwnFollowerCount()` 先判断“当前是不是本号主页”，判据只认 `getMyHandle()` 的结果。`getMyHandle()` 在导航栏未渲染/只拿到 worker id 时会是空或 `jake`，与路径 `jakelu133969` 不一致 → 判定“不是本号主页” → 不读 DOM、直接返回 0，被上游当成“读不到粉丝数”。
- **修复：**
  - 本号自证增加导航栏链接 `a[data-testid="AppTabBar_Profile_Link"]` 兜底：`my || nav_handle` 任一与路径一致即认定为本号主页。
  - 单段路径且 `my`/导航栏都未知时，仍按“路径 handle = 粉丝链接 handle”读取，避免完全依赖登录态缓存。
  - `chat.fan_roster_check` 新增 `read_detail`：`my / nav_handle / path / path_handle / is_profile / links / best / reject`，下次读不到可直接定位是“没进主页”“找不到链接”还是“handle 对不上”。
- **验收：** `build=4.9.47`；roster 阶段事件 `read_detail.is_profile=true`、`links>=1`、`best=63`；`result` 为 `no_growth / growth` 而不是 `count_unreadable`。

## 4.9.48 矩阵化资源指标

- `chat.inbox_loop` 心跳新增 `heap_mb`（本页 JS 堆）、`dom_nodes`（DOM 节点数）、`timers`（挂在页面上的定时器数）。
- 用途：多开矩阵前先量清单标签页的真实占用。Chrome 内容脚本读不到进程级 CPU，用“堆 + DOM + 定时器 + `system.pressure.lag`”作为代理指标；同一台机器上按 N 个标签页线性估算前，先用这三个值确认单页基线。
- 只读，不改变任何发送/判定逻辑；每 60 秒一次。

## 4.9.49 无推广链不得发广告/催加

- **现场证据：** 02:26:00–02:26:01 刚重载完，`hide0521ht1233` 的广告 + 两次催加在 2 秒内发出，三条内容都没有 `line.me` 链接（同一时段稍后发送的 `odaharu_0405` 广告是带 `https://line.me/R/ti/p/...` 的）。发完 4 轮，对方也没有可点的入口。
- **根因：** `buildInboxRouteMessage('kick')` 在没有推广链时仍然返回模板原文；广告分支会因无链返回空，但催加分支没有同样的硬闸。启动最初几秒话术池/推广链还没同步完，就会把“无链文案”发出去。
- **修复：**
  - 催加：模板既没有 `{LINK}`、也不含 `line.me`，且当前无推广链 → 返回空，不发送。
  - 发送入口区分失败原因：广告/催加缺链记 `send_error=no_promo_link`，文案缺失仍记 `no_message_text`。
  - `chat.inbox_tick` 新增 `send_error_zh`：`no_promo_link` = “推广链还没同步到本页，广告/催加暂不发送（不是对方没回）”。
- **验收：** `build=4.9.49`；断链状态下 tick 出现 `send_error=no_promo_link` 且 `sent=false`，恢复链接后的下一拍正常发送；不会再出现无 `line.me` 的广告/催加。

## 4.9.38 修复 Chrome 窗口反复自己弹出来

- **现场表现：** 人不在电脑前、Chrome 在后台时，窗口每隔几十秒自己跳到前台。
- **根因（两条叠加）：**
  1. 守箱每拍向后台发 3 次 `sg_activate_tab`，旧版带 `focusWindow:true`，后台执行 `chrome.windows.update({focused:true})` 抢焦点。
  2. 后台标签页被 Chrome 暂停渲染 → 白屏探针把它当成“白屏” → `sg_request_heal` 升级 `recreate` → `chrome.tabs.create({active:true})` → 新标签激活，窗口被顶到前台；新页在后台又“白屏”，于是循环。
- **修复：**
  - 白屏探针先判 `document.visibilityState`：`hidden` 时不自愈，并把健康计时重新起算。
  - 后台 `sg_request_heal` 对 `hidden:true` 的 white_screen 直接回 `hidden_no_heal`。
  - `recreateXTab` 只有窗口本来就在前台才 `active:true`，否则后台新建，不抢焦点。
  - 守箱激活只激活窗口内标签，`focusWindow` 默认禁用。
- **验收：** Chrome 切后台/最小化后，OPS 不应再出现 `Heal 白屏≥45s`；`chat.inbox_loop.hidden=true` 时 `chat.inbox_pulse.reason=page_hidden_deferred`，窗口不动。

## 4.9.38 白屏恢复不再永久停摆

- **现场问题：** 页面空白时刷新预算（1 小时 2 次）用尽后，脉冲只会 `reload_suppressed` 空转，OPS 上等于“插件停了”。
- **修复：** 空白页先做软重挂（`/home` → `/i/chat`，不刷新不抢焦点）；软重挂连续 2 次无效才整页刷新；预算用尽后每 3 分钟允许一次保底重试；连续空白再整页换 `/home` 重置路由。
- **反馈：** 新增 `blank_soft_remount / blank_remount_wait / blank_remount_settle / blank_go_home`，能在 OPS 直接看出恢复走到哪一步。

## 4.9.26 脉冲事务边界：异常不能把目标永久跳过

- **现场根因：** 扫描阶段就把 `reopenedAt` 写成“已提醒”，但此时会话还没打开。`rinzkumk9` 打开后抛 `result is not defined`，目标已经被标成 `already_surfaced`，之后每一拍都跳过它，看起来像“没轮到”。
- **状态契约：** 扫描只写 `closedInboundPendingAt`（排队）；只有真正读到正文、身份确认后，才写 `reopenedAt`（已处理）。全文件现在只保留 after-read 这一处 `reopenedAt =`。
- **整拍事务：** “已核对” `closedInboundCheckedAt` 也推迟到整拍末尾（判定、发送、回列表、事件上报都走完）才写；中途异常保留 pending，下一拍重试。
- **一次迁移：** `sg_inbox_recheck_closed_inbound_v4926` 会把旧版异常留下的 `reopenedAt / closedInboundCheckedAt` 清一次，让 `rinzkumk9`、`hide0521ht1233` 等重新进入一次核对，并上报 `chat.inbox_ledger_recheck`。
- **异常契约：** `pulse_exception` 保留 pending、记录 `stage`、5 秒后重试；连续失败再由既有 `retry_exhausted / pending_expired` 放弃，不会静默跳过。
- **验收：** OPS `build` 必须为 `4.9.26`；`rinzkumk9` 必须出现 `chat.inbox_tick`，不能再出现 `already_surfaced` 抢先拦截。

## 4.9.25 回列表结果写错变量导致脉冲中断

- **现场问题：** 4.9.24 打开 `rinzkumk9` 时抛 `pulse_exception`，错误原文是 `result is not defined`。原因是回列表结果写到了 tick 函数里不存在的 `result` 变量上，异常把整拍中断，后续会话不再处理。
- **修复：** 回列表方式先存到 `returnToListMode`，再放进 tick 的返回对象；脉冲层从 `tick.returnMode` 平铺到事件。这样既能继续处理下一拍，也能在 OPS 看到 `return_mode`。
- **验收：** OPS `build` 必须为 `4.9.25`；打开 `rinzkumk9` 后必须出现 `chat.inbox_tick`，不能再出现 `pulse_exception / result is not defined`。

## 4.9.24 回列表必须点真实返回

- **现场问题：** 4.9.23 处理完 `hide0521ht1233` 后，`inboxSoftGo('/i/chat')` 只改了地址，X 没有重绘列表；下一拍看到 0 行，`reload_suppressed` 预算耗尽后页面停在空白列表。
- **修复：** 回列表顺序改为：点会话页真实返回按钮 → `history.back()` → 最后才软跳地址。删除硬刷新兜底，避免刷新预算被一次空白列表用光。
- **反馈：** `chat.inbox_pulse.return_mode` 会写明 `back_btn / history_back / soft_go`，能直接看出这一拍是怎么回列表的。
- **验收：** OPS `build` 必须为 `4.9.24`；每次处理完会话后，下一拍仍能扫到 211 行，不能出现 `reload_suppressed` 后长期空白。

## 4.9.23 尾斜杠不再整页卸载

- **现场问题：** 4.9.22 在 `masa1990766` 处理完后回到 `/i/chat/`（尾斜杠），旧逻辑用 `location.href` 整页纠正，页面直接卸载，21:32:10 之后连心跳都没有了。
- **修复：** 尾斜杠改为 `history.replaceState` + `popstate` 软纠正，5 秒后重试；不再用整页跳转。
- **长退避：** 页面重新加载后，如果旧版本把 `nextPulseAt` 推到 5–10 分钟后，新页面首拍会收回为 5 秒后，不再出现“版本更新了但脉冲不动”。
- **验收：** OPS `build` 必须为 `4.9.23`；出现 `/i/chat/` 时应看到 `slash_route_fix`，并且 5 秒内继续有心跳和下一拍，页面不能卸载。

## 4.9.22 收口复活必须能进脉冲

- **现场根因：** 21:12 的 OPS 里，`宮路正範` 已经有视觉蓝点、预览是对方的「何が？」，但被记成 `closed_inbound_queued_for_reply_check` 后没有打开。脉冲的 `selectTarget` 只要看到 `closed=true` 就跳过，连 `revived=true` 的复活会话也一起跳过，所以表现为“有未读但永远不回”。
- **修复：** 只有 `closed && !revived` 才跳过；已复活会话按原有状态机打开、读正文、再判定发不发。硬拒绝/拉黑仍然不处理。
- **刷新预算：** 地址直达和点击失败后的整页跳转都收紧为 60 分钟内最多 1 次、最小间隔 5 分钟；回列表硬跳也从 2 次降为 1 次。超限只记 `nav_suppressed`，不再反复刷新。
- **验收：** OPS `build` 必须为 `4.9.22`；选中 `revived` 会话时事件里应出现 `revived=true`，并且随后有 `chat.inbox_tick` 的回复结论，不能只有 `closed_inbound_queued_for_reply_check`。
- **测试：** 全量 **385 项通过，0 失败**。

## 4.9.21 加载保护只作用于信箱

- **现场问题：** 4.9.20 在 `/home` 连续报 `page_loading_wait`。原因是首页进度条命中了 X 加载保护，导致没有执行回 `/i/chat`。
- **修复：** 只有在 `/i/chat` 或 `/messages` 路径才等待加载；首页和其他路径会清掉加载计时并继续回收件箱。
- **验收：** OPS `build` 必须为 `4.9.21`；在 `/home` 的下一拍应出现 `navigate_to_list` 或进入信箱扫描，不能连续 `page_loading_wait`。

## 4.9.20 会话 SPA 打开与整页刷新预算

- **现场根因：** 20:58:33 已扫到 21 行，但选中会话仍走 `open_direct_nav` 整页跳转；随后连续出现 `page_hidden_deferred`，21:00:08 又出现 `blank_page_reload`。这说明恢复路径仍在频繁销毁页面。
- **打开会话：** 有列表行时先点击行，让 X 走 SPA；只有无行或点击 12 秒仍未渲染，才用地址直达。
- **续跑校验：** 21:05:29 现场在 `/i/chat/` 列表根上按 `resume` 进入，读到 0 气泡并误报 `identity_pending`。现在续跑前最多等 6 秒，必须同时满足会话路由和真实气泡；否则回列表重新点击。
- **刷新预算：** 白屏 5 分钟最小间隔、每小时最多 2 次；列表为空 5 分钟最小间隔、30 分钟最多 2 次；地址直达 20 秒最小间隔、30 分钟最多 4 次。hidden 时禁止整页刷新。
- **反馈：** 超限上报 `reload_suppressed` / `nav_suppressed`，并明确说明没有扫描或判定回复。事件增加 `nav_guard_reason`、`reload_guard_reason`。
- **验收：** 重载后 OPS `build` 必须为 `4.9.20`；连续三拍内最多一次整页跳转；每次真正打开会话都要有 `chat.inbox_tick` 的唯一回复结论。
- **测试：** 全量 **384 项通过，0 失败**。
- 详细计划见 `docs/私信守箱修复计划-4.9.20.md`。

## 4.9.19 X 加载页保护

- **本次现场判断：** Chrome 已加载 4.9.18，但当前 `x.com/i/chat` 只有 React 加载指示器。OPS 有 `blank_page_reload`，却没有 `scan` 或 `chat.inbox_tick`；这说明信箱没有被扫描，不能得出“没有对方回复”的结论。
- **刚查到的最新运行态（20:55:48）：** 最新 build 仍是 `4.9.18`。连续脉冲为 `page_hidden_deferred`，`hidden=true`、`opened=false`；其中一次列表读到 `rows=12 / scanned=12`，但随后因为 hidden 取消处理，没有进入任何会话。20:52:45 另有一次 `open_nav_failed`，结论 `reply_read_failed`。所以现在的首要现场阻塞是 Chrome 页面处于 hidden/最小化状态；目前仍没有证据证明 4.9.19 已加载，也没有新的回复检测结果。
- **修复：** 检测到可见的加载指示器或“加载中 / Loading”时不走白屏刷新，不扫描、不打开会话、不发消息；前 2 分钟每 10 秒重试，超过 2 分钟记为 `page_loading_stuck`，每分钟重试并以警告级别上报。
- **验收依据：** 先恢复并保持 Chrome 窗口可见，再重载扩展；OPS `build` 必须变为 `4.9.19`。X 未恢复时应看到 `page_loading_wait` 或 `page_loading_stuck` 与 `loading_age_ms`，不能看到同一加载页持续 `blank_page_reload`。页面恢复后才应出现完整 `scan`，随后对所选会话出现 `chat.inbox_tick` 和回复结论。
- **测试状态：** `node --check chat/content_chat.js`、manifest JSON 解析通过；全量回归 **382 项通过，0 失败**。本机代码通过不代表浏览器已加载，也不代表已完成现场信箱扫描。

## 4.9.18 全信箱扫描与漏回修复

- **全信箱确实扫到底。** 现场 OPS 显示 `rows=128 / scrollSteps=12 / reachedBottom=false / stoppedReason=max_steps`，旧固定 12 步会截断长列表。现在按滚动容器剩余高度动态计算步数，最多 100 步；`scan.complete / remainingPx` 明确证明有没有到底。到不了底会报不完整，不再伪装成全量扫描。
- **未读统计来自全量快照。** `latestUnread` 不再只从“通过业务筛选的候选”里选；蓝点目标即使被终态/身份等规则挡下，也会保留 handle、peerId、预览、来源和具体 drop reason。
- **收口后来信先打开检查。** 旧逻辑在列表阶段把普通收口后来信标成 `closedInboundNoReply` 并永久跳过。现在硬拒绝/拉黑仍终止；普通收口的新来信和旧版遗留的“从未检查”记录会进入候选，打开后读正文、解析年龄、交给既有状态机。读取完成后再记 `closedInboundCheckedAt`；导航/渲染失败继续保留待检查。
- **本次真实 OPS 根因。** 图中蓝点 `宫路正範＠DAYBREAKこころの相談室 / masa1990766 / 何が？` 在 20:25 的扫描中被认成未读（`unread=true`, `unread_source=icon-circle-fill`），但旧逻辑以 `closed_after_inbound_no_reply` 丢掉；同时另选 `sana37_148` 直开失败。`れん / 40です` 则是旧逻辑已写 `already_surfaced`，之前并没有真正读取。这两类遗留目标会在本版恢复核对。
- **旧浏览器版本未更新。** OPS 在 20:25 仍是 `build=4.9.15`，所以 4.9.16–4.9.17 的后台恢复等待与消息方向审计都没有进入现场浏览器。新版本需重载扩展后，在 `chat.inbox_pulse.build` 看到 `4.9.18`。
- **测试：** 全量 381 项通过、0 失败；覆盖扫描到底证据、全快照未读识别、收口后来信重新进入检查、方向不明保护和既有年龄/轮次闸门。

## 4.9.17 私信方向确认修复

- 之前方向判定有一个危险回退：气泡无法从位置、发送者标签或已发话术确认时，代码默认当成对方发言。这可能把我方新文案当成回复。
- 现在只把有证据的气泡记为我方或对方；最后气泡方向无法证明时给出 `direction_unproven`，不发送，也不写成“对方没回”。
- `chat.inbox_tick` 增加 `bubble_own_count / bubble_peer_count / bubble_direction_unknown_count / last_bubble_direction / last_bubble_text`，可逐拍核对会话正文的方向分类。
- 若最后气泡明确是对方、而回复收集器漏掉正文，会用最后气泡文本补入回复检测，避免漏判。
- 本次版本为 **4.9.17**；扩展重载后，必须在事件的 `build` 字段看到 `4.9.17` 才算加载到本次改动。

## 副本一致性

除 `manifest.json` 的测试标识、本说明文件、只读适配器 `chat/inbox-v2-adapter.js`、`chat/inbox-watch.js` 的适配器接线、`chat/content_chat.js` 里新增的只读 `inboxV2Diag` 桥命令，以及 `scheduler-core.js` 里 `manualChatTest` 优先使用导航栏本号 handle 的测试修复外，其余业务文件应与当前 `unified-scheduler/` 保持逐文件一致。适配器只读，不点击、不发送。可执行：

```powershell
node --test dm-pulse-sandbox/test/production-copy-isolation.test.js
```

**2026-11-12 实测：这条一致性已经不成立。** 测试副本是 4.9.12，主线候选是 4.6.197；舰队租约 pending-start 已双向对齐，但主线仍没有副本的守箱脉冲 / 两阶段拉新模块，副本也没有主线的关注计数日期校正与 config-sync 新签名。合并前必须先选定一条基线，把两边差异逐项并回去，不能把当前副本当成“已验证主线”。

## 4.9.9–4.9.12 列表级判定与真实下滑（现场修复）

现场问题：脉冲每拍都报 `rows=12 / scanned=12`，但会话栏没有真的下滑；而且候选排序仍先信台账 `replySeenAt`，导致“列表最后一条明明是我方”的会话被反复打开，真正“对方最后发言”的会话反而排不到最前。

- **真的下滑。** 新增 `chat/inbox-list-scan.js`，从列表最深的祖先开始找 `overflow:auto/scroll` 容器；优先滚列表自己的滚动区，不再只调 `window.scrollBy`。每一步都重新采集行，滚到底/滚不动/滚轮无效分别记录 `bottom_reached / scroll_not_moved / wheel_no_new_rows`。
- **找不到滚动容器也不放弃。** 现场 4.9.9 第一版报 `no_scroll_container`：X 的 `role=listbox` 不是实际滚动区，真正容器只在行的祖先链上。现在同时从“第一行/最后一行/ listbox”三条链找容器；仍找不到就用最后一行 `scrollIntoView` + 滚轮事件兜底，并记录 `scrollMode=scroll_into_view` / `scroll_into_view_no_new_rows`。`scroll.scrollCandidates` 会列出候选节点的 `tag / testid / overflowY / scrollHeight / clientHeight`，下次能直接看出滚错在哪。
- **后台标签激活补强（现场 OPS 389/387 条证实）。** 连续两拍 `page_hidden_deferred`、`activated_tab=true` 但 `hidden=true`：`tabs.update(active)` 成功了，但 `windows.update(focused:true)` 不能把最小化窗口恢复出来。后台先 `windows.get` 查状态：只有 `minimized` 才 `state:'normal'`（对最大化窗口设 normal 会把它缩回去），然后 `focused:true`，再 `tabs.update(active)`；内容脚本把 `tab_active / window_state / activation_reason` 一并上报。连续 3 拍仍不可见时 `hidden_alert=true`、事件升 `error`，中文直接提示“窗口可能最小化/被遮挡”，不再每分钟静默 defer。
- **先激活，再扫描。** 之前是“先深度扫描 → 再激活”，hidden 状态下列表只挂载 9 行，扫描结果天然偏小。现在顺序改为“激活成功 → 才扫描/下滑”，hidden 直接返回 `page_hidden_deferred` 并标记 `scan.skipped=page_hidden`，不会再把后台空壳当成完整列表。
- **激活流程去定时器。** 后台标签页的 `setTimeout` 会被 Chrome 节流（可能 1 分钟才触发），旧激活流程等 1.5s/2s 实际会拖成几十秒，和 OPS 的 `system.pressure lag≈21s` 对得上。现在改成两次 `chrome.runtime.sendMessage` 回调串行推进（normal → focused → active ×2），不再用任何 `setTimeout`；hidden 时 20 秒后重试（`retryInMs` 覆盖 `finishPulse` 的整拍间隔）。
- **技术失败 5 秒换目标。** `reply_read_failed / open_nav_failed / open_unreachable / row_click_failed / open_timeout / tick_timeout` 不再等满 60 秒，`retryInMs=5000`，下一拍直接换下一个未读/债务目标；同一目标仍受 90 秒渲染冷却约束。
- **hidden→visible 清一次失败计数。** 之前 `x__xto__o / 12kaz02` 的 `renderFailCount`、`identityPendingCount` 是后台标签读不到正文造成的，不是会话坏了。首次激活成功后清一次这两类计数（`render_reset / identity_reset`），避免修好激活还让目标白等 30 分钟；真正坏掉的会话会重新累计。
- **直开后不再回列表空转。** 现场出现连续 6 拍 `open_direct_nav` 同一个 `12kaz02`：URL 已经到了会话页，但 `sessionStorage.pending` 整页跳转后丢了，下一拍把会话页当“滞留”送回 `/i/chat`。现在会话页上如果 `pending` 为空，会用 URL 里的 peerId 反查台账并重建 `pending`（`reconstructed=true`）；`chat.inbox_loop.pending` 会显示 handle / peer_id / tries / age_ms，直接看出待办在不在。
- **滚动证据进 OPS。** 每次深度扫描回传 `scroll.attempted / moved / steps / scrolledPx / rowsBefore / rowsAfter / uniqueRows / reachedBottom / stoppedReason / container`；`chat.inbox_pulse.scan` 同时有 `scrollSteps / scrolledPx / rowsDiscovered / scroller`。以后能直接区分“下滑了但只有这些行”和“根本没滑”。
- **行快照防串号。** 虚拟列表会复用 DOM 行；现在首次看到时就冻结 `id / href / testid / aria / innerText / 未读状态`，后续排序、预览、未读都读快照。打开会话前再换回当前活行（或按 `peerId` 地址直开），不会把 A 的预览算到 B 头上。
- **最后发言者是第一判据。** 候选新增 `lastSpeaker`：
  - 对方最后发言 + 未读 → 最优先；
  - 对方最后发言（已读但未处理）→ 第二优先；
  - 我方最后发言 → 视为已回复，只有广告债/催加到点才打开；
  - 只有草稿 → 不算对方发言，不因此打开；
  - 预览读不出 → 只有未读/台账到期动作/探测到期才打开。
- **台账 `replySeenAt` 不再单独放行。** 之前 `hasReply` 会让“我方最后发言”的会话一直进候选；现在它只作为历史记录，是否打开由列表最后发言者和到期债务决定。`chat.inbox_pulse` 增加 `last_speaker / preview / ledger_replied`，`scan` 增加 `lastSpeakerCounts`。
- **没打开也有明确原因。** `scan_drop` 新增 `ownLastReplied`（列表最后一条是我方、视为已回复）和 `unknownPreview`（列表读不到预览且无到期动作）；中文反馈会直接写出这两类数量。
- **版本可核对。** `chat.inbox_pulse` / `chat.inbox_tick` / `chat.inbox_loop` 都带 `build`（实际加载的 manifest 版本）。看到 `build=4.9.12` 才说明 Chrome 真的加载了新代码；仍是 4.9.11 及以下就是扩展没重载。
- **未读蓝点补识别（4.9.11–4.9.12）。** 右侧实心蓝点不再只认 `icon-circle-fill`：按钮容器、`use`、以及 `::after/::before` 伪元素都会检查；深度扫描对已经见过的行会补刷未读状态，避免蓝点在首帧之后才挂上时被永久记成未读=false。`scan_drop_samples` 同时带 `unread / unread_source`，能直接看出这一行为什么算/不算未读。
- **旧版本历史行为（4.9.12，4.9.121 起已取消）。** 当时测试副本默认忽略私信时段并上报 `test_24h:true`。当前测试副本已锁定正常时段；不要再按这段旧说明手动打开 24 小时模式。
- **测试：** 新增 `test/inbox-list-speaker.test.js`（17 条：滚动容器选择、快照去重、停止原因、最后发言者排序、日/中/英“你:”前缀、运行时接线）；全量 **345 项通过、0 失败**。

## 4.9.3 观测与私信卡点修复（现场数据回收）

- **OPS 上报中断根因：遥测补传队列无限重发。** `flushTelemetryQueue` 成功发送后没有把剩余队列写回 `chrome.storage`，下一次又从存储读到同一条旧批次，形成每秒约 165 次的重发；OPS 最新事件因此一直停在旧批次，页面新事件也进不来。已改为成功后先写回剩余队列再继续，并删除失败分支里会制造重复副本的 `unshift`。
- **OPS 地址 sticky 写风暴。** `markFailoverSuccess` 每个成功请求都会整包重写 `sg_failover_sticky`；现场 LevelDB 在 3 分钟内写入约 1.6 万次、日志涨到 3MB。已节流为同一组地址 10 秒最多写一次，地址变化立即写。
- **启动合并重复批次。** 旧 bug 会在补传队列里堆大量完全相同的批次；启动时按首个 `client_event_id` 合并，只保留一份，避免重载后补传很久。
- **面板新增「观测」状态。** 最近日志上方直接显示：正常 / 上报失败（原因）/ 待传条数，不再出现“页面在跑、OPS 全空”的无声失败。
- **待续跑目标过期回收。** 发送失败留下的 `pending` 超过 3 分钟且确实空闲时自动放弃（`pending_expired` 并上报 `chat.inbox_task_abandoned`），避免永久挡住回主页查粉丝数的拉新阶段。
- **测试：** 新增 `telemetry-queue-drain`（3 条）与 `ops-sticky-write-throttle`（2 条）；当前全量 **293 项通过、0 失败**。

## 4.9.0 私信两阶段（拉新 → 破冰 → 守箱）

把私信拆成两个明确阶段，由同一个调度循环驱动，`sg_run_mode` 全程保持 `inbox`：

- **拉新（roster）**：默认每 30 分钟（`sg_roster_check_min`，5–360）回**本号资料主页**读粉丝数。
  - 没涨粉（`no_growth`）/ 掉粉（`count_down`）→ 只记录或下调基线，立刻回守箱，**不滚粉丝列表**。
  - 涨粉（`growth`）→ 进粉丝列表登记新粉、排队破冰；扫完把基线对齐到本次读数。
  - 读不到粉丝数（`count_unreadable`）→ 停在主页重试，绝不带着 0 扫列表。
  - 还欠破冰（`drain_ice`）→ 先清队列再查数；队列里没有在跑的任务时允许重建队列重扫。
  - 没有基线（`first_scan`）→ 全量扫一次建台账。
- **破冰只有粉丝列表一个入口。** 粉丝列表点进主页 → 私信 → 发破冰，沿用原有出站动作，不改发送话术。
- **守箱（watch）**：只处理台账已有 `iceSentAt` 的会话——读回复、按年龄分流、发广告、按轮次催加。
  - 没破冰的会话一律不打开，计入 `scan_drop.noIce`（原因 `no_ice_from_roster`）；状态机返回 `ice_via_roster_only`，不再有 `need_ice` / `inbound_first` 这两条守箱路径。
- **拉新阶段只排破冰。** `iceQueueAdd` 在 roster 阶段把广告/催加写成 `deferred / handled_in_watch`，`reclassifyIceQueueFromOps` 也不会把它们抬回 pending；否则粉丝列表会把 ad/kick 排在 ice 前面先发掉。
- **切换不打断正在处理的事。** 只有脉冲空闲（`!busy`）、没有待续跑发送（`!pending`）、停在列表根时才切去拉新。
- **收工自动回守箱。** `finishIceOutboundAfterQueue` / `finishSoftRiskFanQueueDone` / `completeChatRound` 三个出口在 roster 阶段都会调用 `exitInboxRosterPhase`，不会走旧的“回关注/结束软窗”，也不会停掉主引擎。
- **守箱看门狗在 roster 阶段放行。** 本号主页与粉丝列表是合法页面，5 秒看门狗不会再把页面拉回 `/i/chat`。
- **新增可观测：** `chat.inbox_cycle`（阶段切换：from/to/why/scan_active/roster_check_min/baseline）、`chat.fan_roster_check`（每次查数结论 count/baseline/delta/result + 中文原因）；`inboxV2Diag` 新增 `cycle`。
- **新增测试：** `test/inbox-roster-cycle.test.js`（7 种判定 + 接线守卫）；`inbox-action-parity` 的破冰段改为“守箱一律不发”，整链回归从“已破冰”开始。

## 4.9.2 私信时段与年龄反馈

- **守箱只在私信时段运行（生产规则）。** 默认 09:00–18:00（`chatHours`，OPS 账号级可覆盖）。非私信时段三处全停：调度入口 `runInboxModeTick` 直接返回、脉冲 `runInboxPulse` 返回 `outside_chat_hours`、发送前还有硬闸（跨出时段也绝不发出）。夜间只跑关注/养号/手动转帖；`chat.inbox_paused` 每小时最多上报一次，带 `chat_hours`。**旧版本测试副本 4.9.12 曾默认 `test_24h=true`；4.9.121 起已取消并强制正常时段。**
- **年龄读不出照常发广告，但原因单独标出。** 运行时与契约两侧统一返回 `age_unknown_ad`，OPS 带 `age_known=false`，不再和“读出合格年龄”（`age_ok`）混在一起。
- **拉新跨进夜间自动收口。** 只把阶段切回守箱（`exitInboxRosterPhase('outside_chat_hours', {navigate:false})`），不导航、不打开收件箱。
- **诊断新增：** `cycle.chatWindowOpen` / `cycle.chatHours` / `cycle.pausedOutsideChatHours`、`chat.inbox_tick.age_known`。
- 测试追加 9 条，当前全量 **286 项通过、0 失败**。

## 4.9.1 产品口径修正（P0）

这三条不是技术 bug，是规则本身的冲突；4.9.1 按“默认保守、可配置”落地：

- **首扫只建台账，不再群发破冰。** 没有基线时全量扫粉丝列表只做 `discoverTarget`，不入破冰队列；存量粉丝不算破冰债（`isPreBaselineFollower`），也不会被灌回 pending。破冰只针对“基线之后新回关的人”。要给存量补破冰，必须显式设置 `sg_roster_first_scan_ice = all`。OPS：`chat.inbox_cycle.first_scan_ice = ledger_only|all`。
- **新粉不再被“扫不到的旧债”卡死。** `blockNewIce` 只看队列里是否还有待做破冰，不再因为台账里存在不可达的未破冰目标而挡住新粉；连续 7 天没在粉丝列表出现的未破冰目标按 `left_followers` 退出破冰债。
- **催加节奏 = 下一次轮询。** 到点的广告债 / 催加豁免 8 分钟会话复查冷却（`inboxWatcherInCooldown`），同一轮仍由 `pulseSeq` 闸保证不连发。实际节奏：广告 → 下一拍 60 秒 → 盾牌 → 再下一拍 → 终催。想放慢用 `chat_inbox_kick_min_minutes`（默认 0，可单独配终催）。诊断：`cycle.kickCadenceMin / revisitCooldownMin / kickBypassRevisitCooldown`。
- **4.9.1 当时曾把收口后来信设为终态。** 这个规则后来导致未读消息只在列表层记录、没有检查内容；4.9.18 已改为普通收口后来信先打开读取，再交给状态机判定，只有硬拒绝/拉黑仍直接结束。
- **读不到粉丝数的反馈不再被“卡住”覆盖。** `count_unreadable` 重试阈值从 12 拍（12 分钟）降到 8 拍（约 8 分钟），早于 10 分钟的 `roster_stuck` 闸，OPS 能看到真正原因。

新增测试 `test/inbox-p0-product-guards.test.js`（12 条）。当前全量 **277 项通过、0 失败**。

## 4.8.16 非两段式逻辑修复

- **年龄是唯一分流。** 非两段式下，对方先来信和正常回复走同一个 `adOrReject`：年龄低于门槛婉拒，否则发广告；年龄解析不出来按“未低于门槛”处理，照常发广告。此前“对方先来信”分支会绕过年龄判断直接发广告。
- **催加改为轮询轮次驱动。** 每轮轮询（一次脉冲 / 一次手动守箱循环）只对同一会话做一步：广告在第 A 轮发，第一次催加等下一轮轮到它，终催再等一轮。台账新增 `adPulseSeq` / `kickPulseSeq`，判定不满足时返回 `kick_wait` 且 `next_round=true`。实际间隔由轮询频率、队列优先级和会话复查间隔共同决定（会话复查默认 8 分钟，可用 `sg_inbox_revisit_min` 调大到 720 分钟）。OPS 仍可填 `chat_inbox_kick_min_minutes` 作为额外时间下限（默认 0 = 不加），终催可用 `chat_inbox_final_kick_min_minutes`。
- **破冰后没回复不再空转。** 非两段式原本把 `round=1` 一律当可处理，导致 8 分钟冷却一到就打开一次无回复会话（还会反复把对方标成已读）。现在必须满 `chat_ad_min_wait_min`（默认 60 分钟）才做一次探测，未到时间记 `scan_drop.adWait`。
- **台账丢破冰不再重发破冰。** 会话里已有我方气泡时返回 `ice_already_visible`，只补 `iceSentAt`；此前运行时状态机没有接这个证据，可能重复发一次破冰。
- **催加间隔未到不再占队首。** 未到间隔的目标记 `scan_drop.kickWait`，不打开、不发送。
- **复活会话一律放行。** 收口后按台账时间（`lastInboundAt` / `replySeenAt`）判定的复活，之前可能仍被“不可处理”挡掉；现在复活本身就是入站证据。
- **规则契约与运行时逐项对齐。** `inbox-decision` 的广告段改为与 `inbox-state` 完全一致（不再出现 `greeting_ad` / `ad_wait_elapsed` 这类只有契约侧使用的 route，也不再有“没回复也按年龄婉拒”的分叉）。一致性测试从“只比 action”升级为同时比 route、reason、waitLeftMs。
- 新增 `test/inbox-non-two-seg-flow.test.js`（运行时接线）与重写 `test/inbox-action-parity.test.js`（22 个逐项比对场景 + 年龄唯一分流 + 广告后只催加 + 按真实时间推进的整链回归）。
- 状态机改成“只看发送痕迹推导阶段”，不再看 `round`：`round` 与发送痕迹矛盾时，两边都以 `iceSentAt / adSentAt / kickCount` 为准（新增 3 个矛盾台账场景锁定）。
- 扫描证据放宽到“只要会话确实渲染出气泡（包括只有我方破冰/广告）就算读过”；否则“发了没人回”的目标永远攒不到证据，48h 清理会一直延后。

## 4.8.15 回复逻辑修复

- 修正 4.8.14 的错误设计：收口后新来信不再“转人工”，改为交回既有回复判定（`planAction`）；既有规则判定已完结就记 `stage_closed`，不再另开一条无回复路径。
- 舰队租约 pending-start 已从主线移植：申请期只写 `leasing`，被拒/20s 超时都会释放槽；停止后晚到的 token 不再拉起模块。修掉“台账显示在跑、实际没跑、之后不再启动”的静默停摆。
- 收口会话在对方发来新消息时不再静默丢弃：写 `reopenedAt` / `reopenedReason` 后交回既有回复判定；既有规则判定已完结就记 `stage_closed`，不另开人工分支、不重发广告。
- 列表里我方草稿不再当成对方最后发言（`pending_draft`），避免把自言自语误判为对方回复。
- 48h 清理改为“没有完整扫描证据只延后、不永久拉黑”，并新增 `chat.stale_prune` 上报清理/延后数量和原因。
- 白屏/空壳/身份未证明都不再写扫描证据；身份未证明时也不把页面上的回复写进台账，避免记错人。
- 同一批旧消息只复活一次（`already_surfaced`），之后真有新入站才再次触发；非文本入站单独发 `chat.inbox_non_text`。
- 复活依据补齐“列表最后一条明确是对方”（`peer_last_after_close`）：收口动作必是我方发出，所以最后一句变成对方就是之后又来消息；无未读圆点也能发现。
- 扫到但未处理的会话新增 `scan_drop_samples`（谁、为什么），OPS 不再只有一个汇总数字。
- 守箱模式下页面加载即自动挂主巡航，刷新后不会出现“脉冲再也不跑”。
- 会话页白屏刷新前也落一条 `chat.inbox_tick`，不会只剩一条没有目标的脉冲日志。
- 诊断命令 `inboxV2Diag` 增加 `followUps`（待人工/身份卡住/清理延后）、`scanDrop`、`pulseState`。
- 新增“规则契约 vs 运行时状态机”动作一致性测试，防止两边规则各自漂移。
- 发送失败后的待办会优先续跑（`pending_resume`），不会被别的未读会话顶掉；重试次数跨页面恢复保留。
- 放弃待办不再静默：`retry_exhausted` / `pending_expired` / `pending_target_mismatch` 都会写 `sendAbandonedAt` 并上报 `chat.inbox_task_abandoned`。
- 台账单调性：已完结会话再被补发破冰/广告/催加时，不会把 `round` 打回 1 或清掉 `chatClosedAt`，避免重复广告。
- 新回复会刷新 `replySeenAt` 到最新一次，收口后回复不再漏判。

- 48h 清理增加保护：最近一次我方消息之后有 `lastInboundAt` / `replySeenAt` / `unreadSeenAt` / `lastNonTextInboundAt` 的目标，不再被误拉黑；守箱模式下没真正扫过的会话也不清理。
- 对方只发图片/贴纸/语音时，区分 `peer_non_text_unhandled` 与 `dom_empty`，不再当成“空会话/没回复”。
- 每个会话上报 `chat.inbox_tick`，每个脉冲上报 `chat.inbox_pulse`，带中文 `reason_zh`；发送失败、身份未证明、DOM 未渲染都能在 OPS 直接看到。

## 4.9.4 打开会话 / 身份 / 假活修复（2026-11-12 现场）

现场症状：守箱能扫到未读、也能“打开”，但随即 `dom_leaves=0` → `identity_pending` → `header_handle_mismatch`，最后被调度按 `tick_progress_stale` 回收。OPS 看板则像停更在 11-09。

- **打开成功的判据改了。** 以前只要 URL 变成 `/i/chat/<id>` 就算打开；但 `pushState` 只改地址、X 不会重绘，页面其实还停在列表，后面自然读到 0 条气泡。现在必须“会话真的挂载”（读到气泡 / 读到会话头 / 输入框就绪任一）才算打开。
- **点击不行就整页导航。** 行点击后先补 pointerdown/mousedown/pointerup/mouseup 事件序列；6 秒仍未挂载就直接 `location.href` 打开该会话，并上报 `open_hard_nav`。不再用 `pushState` 假装打开。
- **空壳页不再误报“会话头不一致”。** 会话头只在“输入框在”或“确实读到气泡”时才读；列表页/Start Conversation 空壳不读会话头，避免把导航或推荐链接当成对方 handle。
- **peerId 不再乱回写。** 只有“行自带 peerId 与 URL 一致”或“会话头证明是目标本人”才把 URL peerId 写进台账；否则留空并记 `identity_pending`，防止点错会话把别人的 peerId 写到这个人名下（串号）。
- **硬刷新改成每目标 10 分钟一次。** 旧实现用一个全局 `dan_inbox_hard_reload` 闩锁，第一次刷新后所有会话都不再重试，空壳会被永久跳过。
- **长等待补进度心跳。** 等气泡/等输入框期间每 5 秒写一次 `sg_chat_last_progress_at`，不再因为一次 30 秒等待被调度判成“假活”回收（现场曾出现 46 秒 `tick_progress_stale`）。
- **OPS 看板“停在 11-09”不是上报断了。** 实测 14:58 仍有 `chat.inbox_tick` 入库。原因是历史数据 `created_at` 是 `2026/11/9 23:58:56`（斜杠、不补零），新数据是 `2026-11-12 14:58:25`，按字符串倒序时 `2026/11/9` 永远排最前。OPS 源码已改为按 `ts_ms` 排序与过滤，展示时统一成横杠格式。
- **拉新扫描被打断后会退避 3 分钟。** 现场出现“浅扫 13/66 → 封口 → 45 秒没进度被回收 → `lastCheckAt` 没更新 → 90 秒后又重进”的死循环。现在进入拉新先写 `lastAttemptAt`，被打断后 3 分钟内不再重进；同时扫描期间每拍打 `roster_scan_active` 心跳，封口上传期间每 5 秒打心跳，不再被当成 chat 假活。
- **战报 `log_action` 真正能入库了。** 内容页把参数放在 `payload`，后台只读顶层字段，OPS 一直回 `bot_id, target, action_type are required`；现在两种形态都兼容，并且只有 OPS 真返回 `ok` 才回 success，否则进补发队列。

## 4.9.5 独立测试 OPS（不写生产库）

测试副本从 4.9.5 起固定连接本机独立测试 OPS：`http://127.0.0.1:15681`，数据目录 `D:\下载\智能调度\test-env\ops-test-data`。

- **硬锁，不可在面板改回生产。** `background.js` 的 `DEFAULT_OPS_SERVER` 指向 15681，`TEST_OPS_LOCKED=true`；读取、写入、启动恢复、故障切换 sticky 四条路径都会强制回到 15681，存储里残留的 `192.168.0.100:15680` 会被写回。
- **回环地址按局域网处理。** `isLanUrl()` 识别 `127.0.0.1 / localhost / [::1]`，否则“关闭外网兜底”的旧逻辑会把测试地址改写成生产地址。
- **测试 OPS 独立库、推送关闭。** 使用独立 `x-ops-console.sqlite` / `x-ops-log.sqlite`；`telemetry_push_enabled=false`、`push_alerts_enabled=0`，不会因为测试 error 触发 PushPlus。
- **生产 OPS 不部署任何本轮改动。** OPS 日志排序修复只留在 `test-env/x-ops-console` 源码，等并主线后再上生产。
- **验证入口。** 重载扩展后，SW 控制台应打印 `[调度-SW] servers ... ops= http://127.0.0.1:15681`；测试 OPS 的 `/api/monitor/logs` 应开始出现新事件。

## 4.9.6 破冰来源收口与重载自动刷新

现场发现：扩展从 4.9.3 重载到 4.9.5 后，已经打开的 X 页面仍跑旧 content script；旧脚本在重载前一刻从生产 OPS 拉了 132 条台账，灌入 21 条 `ledger_ops_ice` 破冰任务，随后才被新 SW 当作遥测补传到测试库。这不是新代码连了生产，而是旧页面脚本没刷新。

- **破冰只能由粉丝列表产生。** `seedOpsRosterDebtToQueue` 不再把 OPS 的未破冰 pending 转成 `ice` 任务；OPS 只续跑已破冰后的 `probe / ad / kick`。被跳过的数量写入 `chat.fan_roster_seed_ops` 的 `skipped_ice`。
- **重载自动刷新页面。** 测试副本 SW 启动时比较 `chrome.runtime.getManifest().version` 与 `sg_test_build_seen`；版本变化后自动 `chrome.tabs.reload` 所有 X 页面，避免旧 content script 继续连生产。
- **测试：** 新增“OPS 不得反向生成破冰”“重载后自动刷新页面”两条守卫；当前全量 **307 项通过、0 失败**。

## 4.9.7 “只私信”按钮修复

- **现象：** 面板“只私信”能点，但点击后没有任何反应，也不报错。
- **原因：** `guardChatDayOrFlash()` 被改成恒返回 `true`（拦截），而按钮处理函数第一行是 `if (guard(...)) return;`，所以命令永远发不出去。不是 CSS 遮挡，也不是按钮禁用。
- **修复：** 守卫改为 `false`（放行）；日限额与冷却仍由内容脚本发送闸门负责。新增 `panel-chat-button.test.js` 锁定“只私信”和“私信测试”都必须能走到命令。
- **测试：** 当前全量 **310 项通过、0 失败**。

## 4.9.8 后台标签页不渲染 / 回复结论 / 渲染失败隔离

现场症状（2026-11-12 16:17–16:29）：脉冲每拍都能扫到 `rows=12 / scanned=12 / unread=1`，但打开会话后 `dom_leaves=0 / dom_articles=0`，随后 `needs_render_reload` → 整页刷新 → `blank_page_reload`；同时 `system.page_alive` 反复记录 `hidden=true`。结论不是“对方没回”，而是**后台标签页里 X 不渲染会话正文**。

- **先激活标签再打开。** 后台（`hidden`）时向 SW 发 `sg_activate_tab` 激活当前标签，1.5 秒仍不可见再请求置前窗口；3 秒仍不可见就整拍延后为 `page_hidden_deferred`，不打开、不标已读、不写台账。
- **打开必须有地址证据。** 台账有 `peerId` 时直接打开 `/i/chat/<peerId>-<myId>`（历史 probe 已确认该路由可用）；缺 myId/peerId 才点击列表行，点击失败再按 href 直开。仍停在 `/i/chat` 列表根一律不算打开。
- **每次打开都有唯一回复结论。** 新增 `SgInboxDecision.replyVerdict()`：`reply_detected / no_new_reply / reply_read_failed / identity_unproven / non_text_inbound`。读到回复但业务闸门不允许发时另记 `send_gate`，不再把“读没读到”和“发不发”混在一起。`reply_read_failed` 禁止发送、禁止写 `inboxWatchedAt`。
- **不再整页刷新恢复空壳。** 读不到正文记 `renderFailCount/renderFailAt/renderFailPreview`；连续 2 次冷却 30 分钟，未读也不能绕过；列表预览变化（真来了新消息）立即清零重试。
- **失败后换目标。** 技术失败后 5 秒下一拍继续，90 秒内不重复同一失败目标；冷却目标进 `scan_drop.renderFailedCooling` 并留样本，不再空手结束。
- **脉冲存活可见。** 新增 `chat.inbox_loop` 心跳（每 60 秒）与 `chat.inbox_pulse` 的 `hidden/activated_tab/reply_verdict/next_pulse_at/dom` 字段；`scan` 里增加 `latestUnreadHandle/latestUnreadRank`。
- **“私信测试”按钮真的会跑。** 之前只派发 `sg-chat-test-command` 但没有监听器，点击后实际什么都不发生；现在会打开守箱、立即排一拍，并把本次结论写回 `localStorage.sg_inbox_test_result`，面板直接显示原因。
- **测试：** 当前全量 **328 项通过、0 失败**（新增 `inbox-render-verdict.test.js`）。

## 测试

```powershell
node --test --test-force-exit test/*.test.js
```

2026-11-12：328 项全部通过（含新增 `inbox-render-verdict.test.js`、`inbox-non-two-seg-flow.test.js`、重写的 `inbox-action-parity.test.js`，以及 `scheduler-start-lease.test.js`、`inbox-closed-reopen.test.js`、`inbox-ledger-consistency.test.js`、`inbox-open-render-guard.test.js`、`panel-chat-button.test.js` 和“每个判定原因必须有中文解释”的覆盖率校验）。

## 4.9.13 时段单一真相源 + 主循环自愈

现场：夜间点“私信测试”，破冰债用 `TimeUtil`、守箱用 `isChatWorkWindowNow()`，两套时钟给出相反结论；X 同文档跳转还会清掉主循环 timer，会话页留下 `busy` 假状态。

- 私信时段只认 `isChatWorkWindowNow()`；`chat.inbox_paused` 带 `build/test_24h`。
- “私信测试”和强制守箱会打开 24h 测试，不再被 08:00–18:00 直接挡掉。
- 守箱看门狗每 5 秒补挂主循环；会话页 `busy` 超过 60 秒且本页没有脉冲时自动释放，并上报 `chat.inbox_busy_reset`。

## 4.9.14 手动测试跨整页跳转存活 + 心跳提前

现场（2026-11-12 19:39–19:50）：19:39:27 脉冲按 peerId 直开会话，之后 11 分钟没有 `inbox_tick`、也没有 `inbox_loop`。页面其实不是“死了”，而是整页跳转后 `shared/config-sync.js` 按 OPS 的 `stagePolicy.test24h=false` 把 `sg_test_24h` 改回 false；19:47 已过私信时段，主循环在发心跳之前就 `return`。

- **手动测试改为 2 小时持久覆盖** `sg_manual_test_24h_until`，OPS 配置同步不会清掉，整页跳转后仍有效；面板关掉 24h 时同步清除。
- **心跳提前到时段判断之前**，并带 `paused_reason=outside_chat_hours`、`test_24h_until`，从此“引擎停了”和“引擎活着但被时段挡住”能直接区分。
- **夜间停在会话页会主动回列表**，不再挂着 pending 假装在跑。
- 历史实测：19:50:57 心跳 `build=4.9.14 / paused_reason=outside_chat_hours`；当时点“私信测试”后曾出现 `test_24h=true`。4.9.121 起该测试覆盖已移除，正常时段恢复。

## 4.9.15 扫描从顶部开始 + 打开优先行 href + 翻译不误判

现场（19:51–19:56）继续暴露三个问题：

1. 会话栏停在中段时只往下滑，最上面最新会话可能漏扫；
2. 按“peerId + 本号 id”拼接直开，某些会话白屏——例如 `アカウント変えます` 的行 href 是 `本号id-对方id`，顺序与拼接假设相反；
3. X 自动翻译把我的消息译文单独显示成一行，丢掉“你:”前缀，被误判成“对方最后发言”。

- **深度扫描先 `scrollTop=0` 回顶部**，再采集 `rowsBefore` 并向下滑，保证最新会话一定在扫描范围；证据里增加 `resetToTop`。
- **打开会话优先用行内 href**，拼接地只是兜底；`open_mode` 记 `row_href` / `direct`。
- **会话页白屏不再整页 reload**：记 `blank_conversation`、回 `/i/chat`、给 `reply_read_failed`，5 秒后换目标。
- **无 handle 的目标按 peerId 冷却**（`sg_inbox_peer_open_fail`）：同预览 90 秒内不重试，连续 2 次冷却 30 分钟；预览变化立即解除；读到回复后清零。
- **中文“你:”纳入我方前缀**，并识别“原文 + 译文”两行结构，译文不再把我方消息翻成“对方回复”。
- **直开跳转中的那拍给 `pending_navigation`**，下一拍必须落最终 `reply_verdict`，OPS 不再出现空白结论。
- 实测（4.9.14）：`12kaz02` 读到对方回复、解析年龄 54、判定 `age_ok`，广告已发出（`reply_verdict=reply_detected`，`sent=true`），说明“读取 → 年龄分流 → 发送”主链路已打通。
- 当前全量 **378 项通过、0 失败**（含新增 `inbox-scan-open-robust.test.js`、`inbox-hours-unify.test.js`）。

## 4.9.16 窗口恢复等待 + 脉冲路径

现场（20:06）：4.9.15 已生效（`top=True`、128 行、`pending_navigation`），但窗口从最小化恢复后，content script 立刻检查 `visibilityState` 仍是 `hidden`，连续三拍 `page_hidden_deferred`，第三拍直接 `hidden_alert`。

- `sg_activate_tab` 在 `normal → focused → active` 后等待 **700ms** 再回包，给渲染进程一拍把 `visibilityState` 翻成 `visible`；content script 会连发两次，实际约 1.4 秒后判定。
- `chat.inbox_pulse` 补 `path` 字段，白屏时能直接看出是 `/i/chat` 列表还是会话页。
- 当前全量 **378 项通过、0 失败**。

## 4.9.27–4.9.30 主引擎保活 + 积压连续排水 + 后台标签页先激活 + 复活优先

现场（22:21 之后）：拉新阶段一切换，`chat.inbox_loop` 就彻底消失，页面停在 `/home`。扩展上下文里 `tick` 函数存在，但 `_sgChatMainEngineId=false`、`_matrixTimers=0`。根因不是业务规则，而是文件末尾第二个 IIFE 直接调用第一个 IIFE 的私有函数（`ensureChatMainEngine` / `loadInboxState`），每次抛 `ReferenceError` 被空 `catch` 吞掉，看门狗从未工作。

- 第一个 IIFE 末尾暴露 `window.__sgInboxApi`；第二个 IIFE 的看门狗和“私信测试”按钮全部改走这个桥。
- 主引擎自己的作用域里增加 **5 秒保活**：只要 `dan_auto_run=true` 或“守箱开且模式=inbox”，timer 被清掉后会自动重新挂上。
- 拉新阶段也打 `chat.inbox_loop` 心跳，带 `roster_reason / scan_active / count_tries / nav_tries`，不再“后台全空”。
- 拉新阶段保持 `dan_chat_phase=inbox`，不再让养号/关注抢走页面；主页导航最多 3 次并留 `chat.fan_roster_check` 证据。
- **4.9.28 积压排水：** 一次脉冲仍只操作 1 个会话，但扫描结果还有多个待处理候选时，下一拍改为 8 秒后，不再等满 60 秒。OPS 新增 `remaining_candidates` / `backlog_drain`。
- **tick 带出台账阶段：** `chat.inbox_tick` 新增 `ledger_stage / ledger_round / ledger_ice_sent / ledger_ad_sent / ledger_kick_count / ledger_closed / ledger_closed_at`，`stage_closed` 这类结论能直接对应到“广告已发、催加已发几次、什么时候收口”，不用再猜。
- **4.9.29 后台标签页顺序修正：** 旧顺序先判断“X 页面加载中”，再激活标签页。Chrome 后台标签页只要还挂着 `progressbar`，就会永远返回 `page_loading_wait`，既不激活也不扫描。现在先激活并等待可见，再做加载中/白屏判断；仍不可见就明确记 `page_hidden_deferred`。
- **4.9.30 复活会话不能被选目标再次过滤：** `closed_inbound_queued_for_reply_check` 的会话即使没有未读、预览也不是对方文本，`revived=true` 也必须进入候选。之前它一直“已排队”却永远选不中，表现就是大量停在待核对。
- **4.9.30 打开失败冷却缩短：** 连续 2 次打开失败从 30 分钟降到 10 分钟；后台标签页转前台时清空打开失败冷却，给被 hidden/白屏误伤的目标一次立即重试机会。
- 当前全量 **403 项通过、0 失败**。

验收时应看到：`chat.inbox_loop(build=4.9.28)` 持续存在；有积压时 `chat.inbox_pulse` 的 `backlog_drain=true`、`next_pulse_at` 约 8 秒后；每个真正打开的会话都有 `chat.inbox_tick`，并带 `reply_verdict` 与（如被业务拦下）`send_gate`。如果某个会话从未出现 `chat.inbox_tick`，只能说明“从未成功打开”，不能解释成“对方没回”。

## 风险提示

此副本仍然包含当前插件的真实业务逻辑、真实网络接口和自动化能力，不是只读插件。加载后不要直接开启全部自动任务；按测试步骤逐项启用，并观察页面导航和日志。
