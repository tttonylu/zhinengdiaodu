# 实施状态 · 2026-07-29

> 替代原「控制面收口 Implementation Plan」中的任务清单。  
> 原 S0–S2 分阶段升级路线已废止；以 `ROADMAP.md` 为准。

---

## 代码已完成

- [x] `scheduler-gate.js` 自动模式门禁
- [x] follow/chat/nurture 自启收口 + command 真启停
- [x] `coEngineAlive` 幽灵 running 纠正
- [x] 池空 / terminal phase → `coStop`
- [x] 软导航 `coRehydrateEngines`
- [x] `startFollow` 有任务则恢复、不重复 pop
- [x] 关注：多语言识别、号池切换、进度持久化、runEngine 单飞锁
- [x] 养号：评论弹层/详情页对齐号池版
- [x] `config-sync` + `RemoteSettings` 后台配置驱动

---

## 待现场验收（阻塞矩阵扩机）

- [ ] S1 不假死 ≥4h
- [ ] S2 不互抢 ≥30min
- [ ] S3 刷新 / 软导航 resume
- [ ] S4 OPS 改限额/间隔 → 插件生效

---

## 矩阵下一阶段

见 `ROADMAP.md` §3.2：按账号配置、服务器地址可配、心跳打 OPS、诊断 whyIdle。

---

## 手测口令

```javascript
await __sgDiag()
```
