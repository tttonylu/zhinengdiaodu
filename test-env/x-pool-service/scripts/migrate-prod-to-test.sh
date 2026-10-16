#!/bin/bash
set -euo pipefail

PROD_DATA=/vol2/1000/Awork/x-pool-service/data
TEST_DATA=/vol2/1000/test/x-pool-service/data
STAMP=$(date +%Y%m%d_%H%M%S)
SCRIPT_DIR=/vol2/1000/test/x-pool-service/scripts

echo "[1] Checkpoint prod DB via better-sqlite3..."
docker cp "$SCRIPT_DIR/sqlite-backup.js" x-pool-service-x-pool-service-1:/app/scripts-sqlite-backup.js
docker exec -w /app x-pool-service-x-pool-service-1 node /app/scripts-sqlite-backup.js /data/x-pool.sqlite /data/migrate-to-test.sqlite
ls -la "$PROD_DATA/migrate-to-test.sqlite"

echo "[2] Verify row counts in checkpoint"
docker exec -w /app x-pool-service-x-pool-service-1 node -e '
const Database=require("better-sqlite3");
const db=new Database("/data/migrate-to-test.sqlite",{readonly:true});
const rows=db.prepare("SELECT status, COUNT(*) c FROM pool_tasks GROUP BY status").all();
console.log(JSON.stringify(rows));
db.close();
'

echo "[3] Stop test pool..."
docker stop x-pool-service-x-pool-service-test-1

echo "[4] Backup current test DB -> backup_$STAMP"
mkdir -p "$TEST_DATA/backup_$STAMP"
cp -a "$TEST_DATA/x-pool-test.sqlite" "$TEST_DATA/backup_$STAMP/" 2>/dev/null || true
cp -a "$TEST_DATA/x-pool-test.sqlite-wal" "$TEST_DATA/backup_$STAMP/" 2>/dev/null || true
cp -a "$TEST_DATA/x-pool-test.sqlite-shm" "$TEST_DATA/backup_$STAMP/" 2>/dev/null || true

echo "[5] Replace test DB"
rm -f "$TEST_DATA/x-pool-test.sqlite" "$TEST_DATA/x-pool-test.sqlite-wal" "$TEST_DATA/x-pool-test.sqlite-shm"
cp -a "$PROD_DATA/migrate-to-test.sqlite" "$TEST_DATA/x-pool-test.sqlite"
chmod 600 "$TEST_DATA/x-pool-test.sqlite"

echo "[6] Copy accounts.json cookies"
cp -a "$PROD_DATA/accounts.json" "$TEST_DATA/accounts.json"
chmod 600 "$TEST_DATA/accounts.json"
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/vol2/1000/test/x-pool-service/data/accounts.json')
data = json.loads(p.read_text())
print('cookies:', len(data), [c.get('name') for c in data])
for c in data:
    raw = c.get('cookie') or ''
    token = ''
    if 'auth_token=' in raw:
        token = raw.split('auth_token=',1)[1].split(';',1)[0].strip()
    print(' -', c.get('name'), 'auth_len=' + str(len(token)))
PY

echo "[7] Recreate test container (compose already has proxy)"
cd /vol2/1000/test/x-pool-service
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --force-recreate
else
  docker-compose up -d --force-recreate
fi

echo "[8] Cleanup"
rm -f "$PROD_DATA/migrate-to-test.sqlite"
docker exec x-pool-service-x-pool-service-1 rm -f /app/scripts-sqlite-backup.js || true

echo "DONE stamp=$STAMP"
