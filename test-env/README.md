# 测试环境

## 目录结构

```
test-env/
├── x-pool-service/      号池后台（测试版，端口 15678）
├── x-ops-console/       运营后台（测试版，端口 15680）
└── plugin/              智能调度中心插件（指向测试服务器）
```

## 部署到 NAS

### 1. 上传代码到 NAS（只传 src，禁止覆盖 data）

```bash
rsync -av --exclude data test-env/x-ops-console/src/ user@nas:/vol2/1000/test/x-ops-console/src/
```

### 2. 启动两个后台服务

```bash
cd /vol2/1000/test/x-pool-service
docker compose up -d

cd /volume1/docker/test-env/x-ops-console
docker compose up -d
```

> **数据目录唯一**：`x-ops-console` 的 compose 必须挂载绝对路径
> `/vol2/1000/test/x-ops-console/data:/data`，禁止使用 `./data:/data`。
> 否则在另一个部署目录执行 `docker compose up` 会挂载到该目录下的空库，表现为「数据丢失」。
> 同理 `x-pool-service` 也必须挂载固定的绝对数据路径。

### 3. 验证服务

```
http://NAS_IP:15678/health   → {"ok":true,"service":"x-pool-service"}
http://NAS_IP:15680/health   → {"ok":true,"service":"x-ops-console"}
http://NAS_IP:15678/         → 号池管理面板
http://NAS_IP:15680/dashboard → 运营大屏
```

### 4. 安装插件

1. Chrome → 扩展程序 → 开发者模式 → 加载已解压的扩展程序
2. 选择 `test-env/plugin/` 目录

### 5. 测试完后切回生产

修改 `智能调度中心/config.js` 中 SERVER 的两个地址为生产地址即可。

## 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| x-pool-service-test | 15678 | 号池后台 |
| x-ops-console-test | 15680 | 运营后台 |
