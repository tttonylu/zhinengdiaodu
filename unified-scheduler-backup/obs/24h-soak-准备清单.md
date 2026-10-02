# 24 小时 Soak 测试准备清单（v3.7.29）

配合 [`实机验收记录.md`](实机验收记录.md)、[`运维说明.md`](运维说明.md)、[`现场排障SOP.md`](现场排障SOP.md)。

## 0. 本次要验什么（默认）

全自动 **关注 + 软风控填窗私信 + 路线 A 守箱**（年龄分流 / 广告 / 等待期重开）。  
面板 **24h测试 ON** = 私信与工作时间窗全天放开（不定格、不 18:00 硬停）。

| 项 | 期望 |
|----|------|
| 扩展版本 | **3.7.30** |
| 干跑 | **OFF**（真发） |
| 24h测试 | **ON** |
| 日志常态 | **ON**（加载即采；面板显示「日志常态ON」） |
| SCRM | 放行（见下；24h 建议关闸或多次紧急 +6h） |

---

## 1. 开跑前（约 10 分钟）

### 1.1 扩展与账号

- [ ] `chrome://extensions` 重载「智能调度中心」，版本 **3.7.30**
- [ ] 打开目标 X 账号页（已登录、可进 `/i/chat`）
- [ ] OPS：该 bot 已注册（日私信条数上限已废除）
- [ ] 话术池已加载；**推广/直播链接**已保存（无链接则广告轮卡住）
- [ ] DM PIN 已知（默认 `2546`，或 OPS `chat_dm_pin`）
- [ ] 面板 **干跑预览 OFF**（不要「干跑ON」）

### 1.2 面板开关

1. 打开调度面板  
2. **干跑预览** → 确认显示「干跑预览」（不是「干跑ON」）  
3. 点 **24h测试** → 显示 **24h测试ON**  
4. 确认 **日志常态ON**；若未开：点「日志常态」恢复  
5. 模块开关：关注 / 私信按需打开（建议都开）  
6. 点 **自动** 启动

### 1.3 SCRM 放行（必做）

OPS 仪表盘二选一：

- **关闭闸门**（适合满 24h），或  
- **紧急强制 +6h**（每约 5–6 小时续一次，共约 4 次）

### 1.4 控制台开跑快照（复制一次执行）

在 **x.com** 任意页控制台：

```javascript
(async () => {
  const ver = chrome?.runtime?.getManifest?.()?.version
    || document.documentElement.getAttribute('data-sg-ext')
    || window.__sgDiagBridgeVer;
  const mon = (typeof __sgTestMonitor !== 'undefined')
    ? { active: await __sgTestMonitor.isActive(), session: (await __sgTestMonitor.export?.())?.session_id }
    : { active: false };
  // 打标签，便于导出对照
  if (typeof __sgTestMonitor !== 'undefined' && !(await __sgTestMonitor.isActive())) {
    await __sgTestMonitor.start('24h-soak-' + new Date().toISOString().slice(0, 10));
  }
  const diag = (typeof __sgDiag === 'function') ? await __sgDiag() : null;
  const out = {
    at: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    extension_version: ver,
    test_24h: localStorage.getItem('sg_test_24h'),
    dry_run: sessionStorage.getItem('sg_chat_dry_run'),
    monitor: mon,
    opsGate: diag && diag.chatDiag && diag.chatDiag.opsGateReason,
    softRisk: diag && diag.softRisk,
    debts: diag && diag.chatDiag && {
      ad: diag.chatDiag.actionableAdDebt,
      kick: diag.chatDiag.actionableKickDebt
    },
    liveLink: !!(localStorage.getItem('dan_promo_links') || localStorage.getItem('dan_my_promo_links'))
  };
  console.log('[24h-soak boot]', out);
  copy(JSON.stringify(out, null, 2));
  return out;
})();
```

**通过条件：**

- `extension_version` = `3.7.29`
- `test_24h` = `"true"`
- `dry_run` ≠ `"true"`
- `opsGate` 为空或含 `force:`
- `liveLink` = true
- `monitor.active` = true  

把打印结果贴进 [`实机验收记录.md`](实机验收记录.md)「基本信息 / 证据」。

### 1.5 年龄路由自检（可选 30 秒）

```javascript
await __sgPredictAgeRoute(['20'])
await __sgPredictAgeRoute(['私は25歳ですよ'])
await __sgPredictAgeRoute(['学生さん？'])
// 期望：reject / ad / ad
```

---

## 2. 跑中巡检（建议时刻）

| 时刻 | 做什么 | 红旗（立刻停或排障） |
|------|--------|----------------------|
| T+0 | 确认自动在跑；关注开始点粉或填窗私信 | 扩展未注入、SCRM 挡、干跑仍 ON |
| T+1h | `__sgDiag()`；看有无破冰/填窗 | 连续 error、私信 0、关注卡死 |
| T+6h | **续 SCRM +6h**（若未关闸）；面板导出或上报一次 | PushPlus 告警刷屏 |
| T+12h | 再导出/上报；抽 1 个 round1 目标看守箱 | 广告无回复就发；婉拒乱飞 |
| T+18h | 再续 SCRM（若需要） | 日配额打满后行为异常 |
| T+24h | **停止自动** → 导出 JSON → 上报 OPS → 关 24h测试 | — |

中途控制台（任意时刻）：

```javascript
await __sgDiag()
await __sgTestMonitor.getRecent(10)
// 有具体 handle 时：
// await __sgAcceptRouteA('handle')
```

---

## 3. 观察重点（对照 3.7.29）

1. **等回复再广告**：无对方气泡不发广告；等待期内可重开；到期后能发  
2. **仅年龄分流**：`<25`（含整句 `20` / 句中 `20歳`）婉拒；无年龄 / 反问 → 广告  
3. **inbox_done**：探空后若预览变回复/未读，同窗仍能打开  
4. **轮次不降**：婉拒/广告后不会被 OPS 滞后 round 打回重发  
5. **让路/填窗**：关注进行中私信让路；SOFT/扫完 → 15–18min 填窗可私信  

Telemetry / 日志里可搜：`ad_sent`、`reject_sent`、`parse_age_result`、`scheduler.chat_blocked`、`sg-soft-risk-entered`。

---

## 4. 收束

1. 面板点停自动（或协调器停止）  
2. **导出测试** 下载 JSON；**上报测试** 记 `snapshot_id`  
3. 点 **24h测试** → OFF（恢复正常时间窗）  
4. 填写 [`实机验收记录.md`](实机验收记录.md) 场景 A–F + 导出摘要  
5. 异常用 [`现场排障SOP.md`](现场排障SOP.md) 的 `__sgAcceptRouteA` / 回复链路  

```javascript
await __sgTestMonitor.download()
await __sgTestMonitor.upload()
localStorage.setItem('sg_test_24h', 'false')  // 或面板关
```

---

## 5. 已知勿慌

| 现象 | 说明 |
|------|------|
| 无推广链接时广告轮不推进 | 预期；先补链接 |
| `高校生です` 也走广告 | 3.7.29 只认年龄数字/〇歳，不认关键词 |
| 探空目标短暂不再打开 | 防空转；有 replied/unread 应能覆盖重开 |
| SCRM +6h 到期后突然不发 | 续强制或关闸 |
| 日志记录很大 | 正常；定时导出/清空前先上报 |

---

## 6. 一页开跑口令

```
重载 3.7.29 → 干跑OFF → 24h测试ON → 日志常态ON → SCRM放行 → 自动
控制台跑 §1.4 boot 快照 → 复制结果存档
T+6/12/18 续闸门 + 导出
T+24 停机导出上报 → 24h测试OFF
```
