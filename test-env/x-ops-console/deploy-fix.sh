#!/bin/bash
# === x-ops-console UTF-8 编码修复部署脚本 ===
# 在 NAS 上执行: bash deploy-fix.sh

set -e
cd /vol2/1000/Awork/x-ops-console

echo "=== 1. 停止旧容器 ==="
docker compose down

echo "=== 2. 重建容器 (含 UTF-8 locale 修复) ==="
docker compose up -d --build --force-recreate

echo "=== 3. 等待服务启动 ==="
sleep 5

echo "=== 4. 验证健康 ==="
curl -s http://127.0.0.1:5680/health

echo ""
echo "=== 5. 验证话术池 ==="
curl -s http://127.0.0.1:5680/api/scripts/pool | head -c 500

echo ""
echo "=== 部署完成 ==="
