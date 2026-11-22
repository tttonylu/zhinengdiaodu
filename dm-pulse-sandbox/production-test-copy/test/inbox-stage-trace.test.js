// 现场：一拍实际 225–255 秒，CPU 只占 0.1%，说明时间全在等待里。
// 旧日志只有 dan_inbox_stage（当前卡在哪），回答不了“这 250 秒花在哪”。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'chat', 'content_chat.js'), 'utf8');

test('阶段标记要顺带记录上一阶段的耗时', () => {
  assert.match(chatSrc, /dan_inbox_stage_trace/);
  assert.match(chatSrc, /dan_inbox_stage_prev/);
  assert.match(chatSrc, /trace\.push\(\{ s: prevName, ms: dur \}\)/);
});

test('阶段耗时只保留本拍，不能无限累积', () => {
  assert.match(chatSrc, /trace\.length > 20/);
  assert.match(chatSrc, /\(nowAt - firstAt\) > 10 \* 60 \* 1000/);
});

test('异常大的间隔要丢弃（页面卡死/系统休眠不算某阶段耗时）', () => {
  assert.match(chatSrc, /dur < 10 \* 60 \* 1000/);
});

test('tick 事件要上报阶段耗时摘要', () => {
  assert.match(chatSrc, /stage_trace: inboxStageTraceRead\(\)/);
  assert.match(chatSrc, /slowest: top\.slice\(0, 5\)/);
  assert.match(chatSrc, /total_ms: Math\.round\(total\)/);
});
