# 通宵监控报告 · 2026-09-13 → 09-14 早

> 开始：2026-09-13 00:35（上海）· 扩展目标 **4.1.25**  
> 明早看：本文件「早间结论」+ [`overnight-ticks.jsonl`](overnight-ticks.jsonl) + [`overnight-ticks.md`](overnight-ticks.md)

## 0. 开跑前请你确认（浏览器侧）

- [ ] 扩展已重载为 **4.1.25**
- [ ] 面板 **自动 ON**；干跑 **OFF**
- [ ] 转帖来源号已配（资料克隆依赖）
- [ ] 头像横幅若仍错：控制台 `ProfileClone.resetMedia()` 后再「纯养号」
- [ ] 面板「测试监控」建议 **ON**（明早导出）

## 1. 今晚重点

| 项 | 正常 | 异常 |
|----|------|------|
| 调度 | 关注/私信/养号轮转 | 长时间空闲、诊断冻结 |
| 私信 | 有发送；no_bubble 拉黑跳过 | 同一人反复进 |
| 资料克隆 | 头像/横幅来自源号且不反 | 本号图 / 对调 |
| OPS | 两号在线、err 不暴涨 | overview 挂 |

## 2. 基线（00:35）

| 账号 | 状态 |
|------|------|
| leilab19556 | 在线·自动·S3·**chat** |
| malika38675 | 在线·自动·S1·idle · 关注 15/50 |
| KPI | online=2 auto=2 alerts=0 · 近3h warn=388 err=0 |

巡检：**每 30 分钟** 写 `overnight-ticks.*`，约跑到早 8 点；Cursor 会收到 tick 唤醒摘要。

## 3. 早间结论（2026-09-13 08:06 自动汇总）

| 问题 | 有无 | 说明 |
|------|------|------|
| 调度空转 | 否 | 通宵持续在线、自动开；chat/follow/nurture 有轮转 |
| 私信异常 | 未见致命 | 全程 err3h=0；warn 有积压属常态日志量 |
| 资料克隆 | 未从 OPS 可判 | 需浏览器看面板「资料」/源号头像横幅（见下方快照） |
| OPS/错误暴涨 | 否 | alerts=0；两号 last_seen 新鲜 |
| **总评** | | **大体正常可上线观察**；留意 `leilab` 07:06–08:06 关注卡在 236/250（follow 旗标在、计数未涨） |

### 通宵曲线摘要

| 账号 | 起点关注 | 终点关注 | 终态 |
|------|----------|----------|------|
| leilab19556 | 0 → | 236/250 | S3 · follow（可能软窗/等页） |
| malika38675 | 15 → | 45/50 | S1 · idle（近日帽） |

完整 ticks：[`overnight-ticks.md`](overnight-ticks.md) · [`overnight-ticks.jsonl`](overnight-ticks.jsonl)

### 明早控制台快照（x.com）

```javascript
(async () => {
  const ver = (typeof __sgExtVer === 'function') ? await __sgExtVer() : null;
  const pc = (typeof ProfileClone !== 'undefined') ? ProfileClone.getState() : null;
  const diag = (typeof __sgDiag === 'function') ? await __sgDiag() : null;
  const out = {
    at: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    ext: ver,
    profileClone: pc,
    engine: diag && { stage: diag.stage, runningModule: diag.runningModule, whyIdle: diag.whyIdle, softRisk: diag.softRisk },
  };
  console.log('[morning]', out);
  copy(JSON.stringify(out, null, 2));
  return out;
})();
```
| 2026-09-13 01:05:10 | online=2 auto=2 alerts=0 | warn3h=495 err3h=0 | leilab19556:S3/chat/m=chat f=15/250; malika38675:S1/idle/m= f=15/50 |
| 2026-09-13 01:35:11 | online=2 auto=2 alerts=0 | warn3h=566 err3h=0 | leilab19556:S3/idle/m= f=24/250; malika38675:S1/idle/m= f=15/50 |
| 2026-09-13 02:05:11 | online=2 auto=2 alerts=0 | warn3h=472 err3h=0 | malika38675:S1/idle/m= f=30/50; leilab19556:S3/chat/m=chat f=39/250 |
| 2026-09-13 02:35:11 | online=2 auto=2 alerts=0 | warn3h=380 err3h=0 | malika38675:S1/idle/m= f=45/50; leilab19556:S3/idle/m= f=69/250 |
| 2026-09-13 03:05:11 | online=2 auto=2 alerts=0 | warn3h=389 err3h=0 | leilab19556:S3/follow/m=follow f=78/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 03:35:11 | online=2 auto=2 alerts=0 | warn3h=455 err3h=0 | leilab19556:S3/idle/m= f=108/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 04:05:11 | online=2 auto=2 alerts=0 | warn3h=523 err3h=0 | malika38675:S1/idle/m= f=45/50; leilab19556:S3/idle/m= f=130/250 |
| 2026-09-13 04:35:11 | online=2 auto=2 alerts=0 | warn3h=617 err3h=0 | leilab19556:S3/idle/m= f=158/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 05:05:11 | online=2 auto=2 alerts=0 | warn3h=772 err3h=0 | leilab19556:S3/idle/m= f=173/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 05:35:11 | online=2 auto=2 alerts=0 | warn3h=927 err3h=0 | malika38675:S1/idle/m= f=45/50; leilab19556:S3/idle/m= f=189/250 |
| 2026-09-13 06:05:11 | online=2 auto=2 alerts=0 | warn3h=1049 err3h=0 | leilab19556:S3/chat/m=chat f=210/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 06:35:11 | online=2 auto=2 alerts=0 | warn3h=1124 err3h=0 | leilab19556:S3/idle/m= f=225/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 07:05:11 | online=2 auto=2 alerts=0 | warn3h=1187 err3h=0 | leilab19556:S3/follow/m=follow f=230/250; malika38675:S1/idle/m= f=45/50 |
| 2026-09-13 07:35:11 | online=2 auto=2 alerts=0 | warn3h=1186 err3h=0 | malika38675:S1/idle/m= f=45/50; leilab19556:S3/coor/m= f=236/250 |
| 2026-09-13 08:05:11 | online=2 auto=2 alerts=0 | warn3h=1174 err3h=0 | malika38675:S1/idle/m= f=45/50; leilab19556:S3/follow/m=follow f=236/250 |
