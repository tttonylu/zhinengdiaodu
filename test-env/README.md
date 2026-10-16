# 测试环境

## 目录结构

```
test-env/
├── x-pool-service/      号池后台（测试版，端口 15678）
├── x-ops-console/       运营后台（测试版，端口 15680）
└── plugin/              智能调度中心插件（指向测试服务器）
```

## 部署到 NAS

### 1. 上传整个 test-env 目录到 NAS

```
scp -r test-env/ user@nas:/volume1/docker/
```

### 2. 启动两个后台服务

```bash
cd /volume1/docker/test-env/x-pool-service
docker compose up -d

cd /volume1/docker/test-env/x-ops-console
docker compose up -d
```

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
