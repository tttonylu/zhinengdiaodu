#!/bin/bash
# 测试环境种子数据脚本
# 用途：往两个空数据库插入测试数据，让插件能正常跑起来
# 运行方式：放到 test-env/ 目录下，在 NAS 上执行 bash seed-data.sh

echo "=== 智能调度中心 - 测试数据初始化 ==="

# ================ 号池后台（15678）==============
echo ""
echo "[号池] 添加测试博主到任务池..."

BLOGGERS=(
  "elonmusk" "BarackObama" "BillGates" "tim_cook" "satyanadella"
  "jack" "vitalikbuterin" "cz_binance" "sundarpichai" "neiltyson"
  "naval" "pmarca" "sama" "paulg" "ycombinator"
  "cdixon" "brian_armstrong" "balajis" "a16z" "techcrunch"
  "verge" "wired" "mashable" "fastcompany" "harvardbiz"
  "tedtalks" "bbcearth" "natgeo" "historyinmemes" "fasc1nate"
  "dogefather" "dogeofficial" "ShibaInuCoin" "FLOKI" "pepecoineth"
  "watcherguru" "unusual_whales" "stocktwits" "bespokeinvest" "marketwatch"
  "business" "cnnbrk" "bbcbreaking" "reuters" "ap"
  "nasa" "spacex" "blueorigin" "virgingalactic" "iss_research"
)

for handle in "${BLOGGERS[@]}"; do
  curl -s -X POST "http://localhost:15678/pool/push" \
    -H "Content-Type: application/json" \
    -d "{\"handle\":\"$handle\",\"source\":\"test-seed\"}" \
    > /dev/null
  echo "  + $handle"
done

echo "[号池] 完成，共添加 ${#BLOGGERS[@]} 个博主"

# ================ 运营后台（15680）===============
echo ""
echo "[运营后台] 添加测试推广链接..."

curl -s -X POST "http://localhost:15680/api/links" \
  -H "Content-Type: application/json" \
  -d '{"links":["https://line.me/ti/p/test123","https://example.com/dm"]}' \
  > /dev/null

echo "  + line.me 测试链接"
echo "  + example.com 测试链接"

echo ""
echo "[运营后台] 添加测试话术..."

# 直接通过 Docker exec 操作数据库，因为话术 API 需要更多参数
docker exec x-ops-console-x-ops-console-test-1 node -e "
const db = require('better-sqlite3')('/data/x-ops-console-test.sqlite');
db.prepare(\`INSERT OR REPLACE INTO script_settings (key, value, updated_at) VALUES ('promo_links', '[\"https://line.me/ti/p/test123\",\"https://example.com/dm\"]', datetime('now'))\`).run();
console.log('链接已写入数据库');
"
echo "  + 话术数据库已初始化（link-manager 会自动写入默认话术）"

echo ""
echo "[运营后台] 添加测试账号..."

docker exec x-ops-console-x-ops-console-test-1 node -e "
const db = require('better-sqlite3')('/data/x-ops-console-test.sqlite');
const now = new Date().toISOString();
const accounts = [
  ['test_bot_01', '测试Bot-01', 'active', 200, 50],
  ['test_bot_02', '测试Bot-02', 'active', 200, 50],
];
for (const [handle, name, status, fl, dl] of accounts) {
  db.prepare('INSERT OR IGNORE INTO accounts (x_handle, display_name, status, daily_follow_limit, daily_dm_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(handle, name, status, fl, dl, now, now);
}
console.log('已添加 ' + accounts.length + ' 个测试账号');
"

echo "  + 2 个测试 Bot 账号已创建"

echo ""
echo "[运营后台] 添加测试 Leads（模拟回关粉丝）..."

docker exec x-ops-console-x-ops-console-test-1 node -e "
const db = require('better-sqlite3')('/data/x-ops-console-test.sqlite');
const now = new Date().toISOString();
const leads = [
  ['fan_001', 'chat_plugin', 'new'],
  ['fan_002', 'chat_plugin', 'new'],
  ['fan_003', 'chat_plugin', 'new'],
  ['fan_004', 'chat_plugin', 'ice_sent'],
  ['fan_005', 'chat_plugin', 'ice_sent'],
  ['fan_006', 'chat_plugin', 'ad_sent'],
  ['fan_007', 'chat_plugin', 'new'],
  ['fan_008', 'chat_plugin', 'closed'],
];
for (const [handle, src, stage] of leads) {
  db.prepare('INSERT OR IGNORE INTO leads (platform, target_handle, source, current_stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('x', handle, src, stage, now, now);
}
console.log('已添加 ' + leads.length + ' 个测试 Leads');
"

# 绑定部分 leads 到测试账号
docker exec x-ops-console-x-ops-console-test-1 node -e "
const db = require('better-sqlite3')('/data/x-ops-console-test.sqlite');
const now = new Date().toISOString();
db.prepare('UPDATE leads SET bound_account_id = 1 WHERE target_handle IN (?, ?, ?)').run('fan_001', 'fan_002', 'fan_003');
db.prepare('UPDATE leads SET bound_account_id = 2 WHERE target_handle IN (?, ?, ?)').run('fan_004', 'fan_005', 'fan_006');
console.log('Leads 已绑定到测试账号');
"

echo "  + 8 个测试粉丝 Leads 已创建（含不同阶段：new/ice_sent/ad_sent/closed）"

echo ""
echo "=== 初始化完成 ==="
echo ""
echo "验证："
echo "  curl http://localhost:15678/pool/status  查看池子状态"
echo "  curl http://localhost:15680/api/links    查看链接列表"
