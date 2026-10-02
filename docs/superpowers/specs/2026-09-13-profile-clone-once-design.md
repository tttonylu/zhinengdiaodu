# 资料克隆（首日一次）设计笔记

日期：2026-09-13 · 版本：4.1.24

## 目标

新号 Day≤2 第一次启动养号前，用 **转帖来源号列表第一个 handle** 克隆本号资料（显示名 / 简介 / 头像 / 横幅），成功或无来源跳过后 **整号不再跑**。

## 触发

- [`scheduler-core.js`](../../unified-scheduler/scheduler-core.js) `startNurture` → `ProfileClone.ensureBeforeNurture`
- 克隆进行中不启动 nurture；结束后经 `__sgStartNurtureDirect` 放行
- `coTick` 在 `sg_profile_clone_running` 时不启动其它模块抢页

## 头像/横幅（4.1.24）

1. 刮源号：`profile_images` / `profile_banners` 升到 `_400x400` / `1500x500`
2. 编辑页：点 `[data-testid="editProfileAvatar|editProfileHeader"]` → 注入 `input[type=file]` → 点裁剪 **Apply** → 再 Save
3. 文本成功但图失败：`mediaPartial`，**不永久 done**，下次养号补图（可 `ProfileClone.resetMedia()`）

## 状态

- LS：`sg_profile_clone_state_{handle}`
- SS：`sg_profile_clone_job` 步进 `scrape` → `apply`

## 文件

| 板块 | 文件 |
|------|------|
| E3 | `unified-scheduler/repost/profile-clone.js` |
| A2 | `scheduler-core.js` 养号闸 |
| F3 | `shared/storage-keys.js` |
| A/Page | `scheduler/page-router.js` |
| G1 | `ui/panel.js` |
