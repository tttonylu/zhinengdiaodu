# 私信回扫读错 SOP（后台一眼定责）

> 基线：扩展 **≥ 3.7.45**  
> 目的：用 OPS 日志直接判断「错在哪」，禁止无事件盲改 C3/C9。  
> 范围：当前仅私信；关注/养号后续可仿 `*.*_verdict` 模式扩展。

---

## 0. 改代码前硬纪律

1. 先确认插件版本 ≥ 3.7.45 并已重载。  
2. 等目标号至少完成 **一次软风控短扫**（不是全天盯箱）。  
3. 拉取该号 `chat.inbox_scan_verdict` / `chat.session_verdict`。  
4. **无 verdict → 先查遥测/版本，禁止改 pick 逻辑。**  
5. 按下方判决表只动对应板块；改完看下一脉冲 verdict 是否变化。

---

## 1. 后台入口

| 方式 | 地址 |
|------|------|
| 监控页 | `http://192.168.0.100:15680/monitor#logs` |
| 回扫结论 API | `GET /api/monitor/logs?account=@handle&event_id=chat.inbox_scan_verdict&limit=20` |
| 会话结论 API | `GET /api/monitor/logs?account=@handle&event_id=chat.session_verdict&limit=20` |
| 业务轮次 | `GET /api/plugin/dm/rounds/<handle>` |

公网 OPS 同源路径：`https://kongzhi1.kooldns.cn/...`（若已映射）。

---

## 2. `chat.inbox_scan_verdict` 判决表

每脉冲结束（或本轮结束且脉冲有数据）上报 **一条**。看 `meta.verdict`：

| verdict | 含义 | 改哪里 |
|---------|------|--------|
| `opened_urgent` | 未读/强回复已打开 | 正常；再看 session_verdict |
| `opened_adopt` | 宇宙外收养打开 | 正常；再看 session_verdict |
| `opened_probe` | 仅探测打开 | 若期望开蓝点却只有 probe → **C3** |
| `saw_unread_no_open` | 看见未读却未打开 | **只动 C3**（error） |
| `no_unread_scan_done` | 无未读，扫描正常结束 | 正常 |
| `no_debt` | 无可处理债结束 | 正常或查目标库 |
| `cap_exit` | 守箱时长/日帽退出 | 看阈值 / C8；若同时有未读却没 open 会优先判 `saw_unread_no_open` |

常用附属字段：`unread_dom` / `unread_visual` / `urgent` / `open_via` / `open_target` / `adopt_miss_reason` / `exit_reason`。

辅助碎事件（可忽略拼故事，有 verdict 优先）：  
`inbox.list_signal` · `inbox.unread_outside_debt` · `inbox.unread_adopt` · `inbox.unread_adopt_miss` · `inbox_open`。

---

## 3. `chat.session_verdict` 判决表

进会话后发送或放弃时上报。看 `meta.verdict`：

| verdict | 含义 | 改哪里 |
|---------|------|--------|
| `ice_sent` / `ad_sent` / `kick_sent` / `reject_sent` / `greeting_ad` | 已成功发送（寒暄无年龄用 greeting_ad） | 正常 |
| `need_age` / `need_age_reask*` | **3.7.46 起废弃**；若仍出现请升版本 | — |
| `composer_not_ready` | 输入框不可用 | **C9** / DOM |
| `pin_blocked` | PIN 门挡发送 | **C6** |
| `missing_ice` | 无破冰证据 | C9 / 目标库 |
| `gate_blocked` | 发送闸门未过 | C5/C9；看 `gate_reason` |

碎事件 `parse_age_result` 仍保留，与 session_verdict **并存**。

---

## 4. Agent / 人排障顺序

```text
OPS 拉 verdict → 定板块（C3 或 C9/C4/C6）→ 只改白名单 → 重载 → 再拉同号 verdict 验收
```

- `saw_unread_no_open` → 只动 C3  
- `opened_*` + `session_verdict=need_age|composer_*|gate_*` → 不动列表 pick，只动会话链  
- 本机补充：面板 `debugTraceReplyChain(handle)`（仅 OPS 已定责到会话内仍不清时）

---

## 5. 验收三板斧（单号一轮）

1. 有蓝点 → 必须出现 `opened_*` **或** `saw_unread_no_open`（禁止只有 `list_signal`）。  
2. 打开后无年龄寒暄 → 必须出现 `session_verdict=greeting_ad` 或 `ad_sent`（不应再有 `need_age_reask`）。  
3. 正常无未读结束 → `no_unread_scan_done` 或 `no_debt`。  
4. 有蓝点脉冲 → `inbox_open via` 不得为 `probe_queue`。

---

## 6. 不做

- 不把短扫改成全天气泡监听。  
- 不以 GitHub Actions 替代 OPS 现场读错。  
- 无 verdict 不扩大改面。
