/* Pure checks for SCRM chat-gate rules (no native sqlite required) */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createScrmStatusRepo } = require('../src/repositories/scrm-status-repo');

const dbPath = path.join(__dirname, '_verify_scrm_gate.db');
try { fs.unlinkSync(dbPath); } catch (e) {}
const db = new Database(dbPath);
db.exec(fs.readFileSync(path.join(__dirname, '../src/db/migrations/025_scrm_gate.sql'), 'utf8'));
const repo = createScrmStatusRepo(db);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// leftover online agent must NOT allow when whitelist is another id
repo.upsertSnapshot({
  timestamp: new Date().toISOString(),
  agents: {
    '@596zvuzi': { agentId: '@596zvuzi', online: true, statusText: '在线', todayDone: 2, todayTarget: 0 },
  },
  notFound: [],
  summary: { onlineAppCount: 1, totalAppCount: 10 },
});
let g = repo.evaluateGate({ expectedAgentIds: ['@947hbqtk'] });
assert(g.allow_chat === false && g.reason === 'SCRM客服号未找到', 'whitelist miss ' + g.reason);
assert(g.agents.length === 1 && g.agents[0].agent_id === '@947hbqtk' && g.agents[0].not_found, 'only whitelist row');

// whitelist online → allow
repo.upsertSnapshot({
  timestamp: new Date().toISOString(),
  agents: {
    '@947hbqtk': { agentId: '@947hbqtk', online: true, statusText: '在线', todayDone: 0, todayTarget: 0 },
    '@596zvuzi': { agentId: '@596zvuzi', online: true, statusText: '在线', todayDone: 9, todayTarget: 0 },
  },
  notFound: [],
});
g = repo.evaluateGate({ expectedAgentIds: ['@947hbqtk'] });
assert(g.allow_chat === true, 'whitelist online should allow');
assert(g.agents.length === 1 && g.agents[0].agent_id === '@947hbqtk', 'ignore leftover in view');
assert(g.online_count === 1 && g.found_count === 1, 'counts only whitelist');

// all offline (whitelist)
repo.upsertSnapshot({
  timestamp: new Date().toISOString(),
  agents: {
    '@947hbqtk': { agentId: '@947hbqtk', online: false, statusText: '离线', todayDone: 0, todayTarget: 0 },
  },
  notFound: [],
});
g = repo.evaluateGate({ expectedAgentIds: ['@947hbqtk'] });
assert(g.allow_chat === false && g.reason === 'SCRM客服离线', 'offline ' + g.reason);

// not found in scrape list
repo.upsertSnapshot({
  timestamp: new Date().toISOString(),
  agents: {},
  notFound: ['@598rblau'],
  summary: { onlineAppCount: 0, totalAppCount: 433 },
});
g = repo.evaluateGate({ expectedAgentIds: ['@598rblau'] });
assert(g.allow_chat === false && g.reason === 'SCRM客服号未找到', 'notFound ' + g.reason);

// inbound numbers must NOT gate: todayDone=0 but online → allow
repo.upsertSnapshot({
  timestamp: new Date().toISOString(),
  agents: {
    '@596zvuzi': { online: true, statusText: '在线', todayDone: 0, todayTarget: 0 },
  },
  notFound: [],
});
g = repo.evaluateGate({ expectedAgentIds: ['@596zvuzi'] });
assert(g.allow_chat === true, 'todayDone=0 must still allow when online');

// empty whitelist → block
g = repo.evaluateGate({ expectedAgentIds: [] });
assert(g.allow_chat === false && g.reason === 'SCRM未配置监控号', 'empty whitelist');

// stale
repo.upsertSnapshot({
  timestamp: '2020-01-01T00:00:00+08:00',
  agents: { '@x': { online: true, statusText: '在线' } },
  notFound: [],
});
g = repo.evaluateGate({ expectedAgentIds: ['@x'] });
assert(g.allow_chat === false && g.stale, 'stale should block');

// fallback to link_sync when expectedAgentIds omitted
repo.saveLinkSync(['@947hbqtk']);
repo.upsertSnapshot({
  timestamp: new Date().toISOString(),
  agents: {
    '@596zvuzi': { online: true, statusText: '在线' },
  },
  notFound: [],
});
g = repo.evaluateGate();
assert(g.allow_chat === false && g.expected_agent_ids[0] === '@947hbqtk', 'fallback sync ids');

console.log('OK scrm-gate checks passed');
db.close();
try { fs.unlinkSync(dbPath); } catch (e) {}
