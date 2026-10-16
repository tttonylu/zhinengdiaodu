# x-pool-service

号池后端服务，负责任务分配、状态流转、自动清理与 assigned 超时回收。

## 新增能力

### assigned 超时自动回收

- 当任务被 pop 后，如果长时间没有 done/dead/fail，系统会自动把它回收为 pending。
- 这样即使前端插件中断，任务也不会一直卡在 assigned。

## 接口

### 现有接口

- GET /pool/status
- GET /pool/pop
- POST /pool/push
- POST /pool/push_batch
- POST /pool/done
- POST /pool/done_by_handle
- POST /pool/fail
- POST /pool/dead
- POST /pool/dead_by_handle
- POST /pool/revive

### 新增接口

- POST /pool/expire_assigned
  - body: { minutes?: number }
  - 手动触发一次 assigned 超时回收
- GET /pool/expire_preview
  - query: minutes
  - 预览当前有多少 assigned 任务已经超过阈值

## 配置

环境变量：

- PORT：服务端口，默认 5678
- DATA_DIR：数据目录
- DB_PATH：数据库路径
- ASSIGN_EXPIRE_MINUTES：assigned 超时回收阈值，默认 60
- EXPIRE_INTERVAL_MS：定时回收间隔，默认 300000（5 分钟）

## 启动方式

```bash
node src/server.js
```

## 测试

```bash
node --test
```
