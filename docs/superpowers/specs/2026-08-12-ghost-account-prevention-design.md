# 防幽灵账号设计

日期：2026-08-12  
状态：已落地（插件 3.2.2 + OPS）

## 原则

**只有 `/api/plugin/account/register` 可以建号。**  
心跳、配置保存、业务上报一律不得 `ensureAccount`。

## 规则

| 入口 | 行为 |
|------|------|
| register | 唯一建号；`extractHandle` 拒保留字 / 4–5 位数字 / 非法字符 |
| heartbeat | 未注册 → `account_not_registered`，不建号 |
| POST /api/config/account/:handle | 未注册 → 报错，不建号 |
| dm / follow / log 等 | 已是未注册拒绝（既有） |
| 插件 | 无合法 handle 不发 register / heartbeat |

## 存量

账号页「清理幽灵」：从未上线且无业务；有机位序号跳过。

## 插件配合

- `background.js`：`isRegistrableBotId` 与 OPS 规则对齐  
- `scheduler-core`：`getWorkerId()` 空则跳过注册与心跳  
