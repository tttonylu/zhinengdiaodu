'use strict';
/**
 * 话术池双池同步 QA（4.6.146）
 * 覆盖：fetchScriptsFromServer 透传 pool；applyServerScripts 按池写 dan_scripts/dan_scripts_job；
 *       版本数值比较（OPS 整数计数器 vs 本地 x.y）；job 不做 soft-ice 守卫；
 *       syncScriptsFromServer 双池各 fetch+apply。
 * 运行：unified-scheduler 下 node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(seed) {
  const obj = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'string' ? obj[k] : null; },
    setItem(k, v) { obj[k] = String(v); },
    removeItem(k) { delete obj[k]; },
  };
  Object.assign(obj, seed || {});
  return obj;
}

/** 从 content_chat.js 巨石中切出话术同步函数片段，vm 沙箱加载（mock localStorage/chrome.runtime） */
function loadScriptsSync(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'chat', 'content_chat.js'), 'utf8');
  const startMark = '    async function fetchScriptsFromServer';
  const endMark = '    // 启动时加载';
  const s = src.indexOf(startMark);
  const e = src.indexOf(endMark, s);
  assert.ok(s > 0 && e > s, '应能切出话术同步片段');
  const slice = src.slice(s, e) + '\n;this.__api = { fetchScriptsFromServer, applyServerScripts, syncScriptsFromServer, startScriptSync };\n';

  const local = makeStorage(opts.local);
  const sent = [];
  const responses = opts.responses || {};
  let loadCount = 0;
  const toasts = [];
  const sandbox = {
    console,
    setInterval: () => 0,
    SCRIPTS_SYNC_KEY: 'dan_scripts_last_sync',
    SCRIPTS_SYNC_INTERVAL: 30 * 60 * 1000,
    SCRIPTS_LS_KEY_DATING: 'dan_scripts',
    SCRIPTS_LS_KEY_JOB: 'dan_scripts_job',
    localStorage: local,
    loadScripts() { loadCount++; },
    showToast(msg, color) { toasts.push({ msg, color }); },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          sent.push(msg);
          const res = typeof responses === 'function' ? responses(msg) : responses[msg.action];
          if (cb) cb(res === undefined ? null : res);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(slice, sandbox, { filename: 'content_chat.js#scripts-sync' });
  return { api: sandbox.__api, local, sent, toasts, getLoadCount: () => loadCount };
}

const poolPayload = (version, ice) => ({
  version: String(version),
  scripts: {
    v1: {
      name: 'v1',
      icebreaker: ice || 'こんにちは',
      ad_template: 'AD {LINK}',
      kick_message: 'kick',
      final_kick_message: 'final',
      reject_message: 'reject',
      foreigner_reject: 'foreign',
    },
  },
  random_pool: ['v1'],
  mode: 'random',
});

test('fetchScriptsFromServer 透传 pool（缺省 dating）', async () => {
  const { api, sent } = loadScriptsSync({ responses: () => poolPayload(3) });
  await api.fetchScriptsFromServer('job');
  await api.fetchScriptsFromServer();
  assert.equal(sent[0].action, 'scripts_pool');
  assert.equal(sent[0].pool, 'job');
  assert.equal(sent[1].pool, 'dating');
});

test('applyServerScripts 按池分写：job → dan_scripts_job，dating → dan_scripts', () => {
  const { api, local, getLoadCount } = loadScriptsSync();
  assert.equal(api.applyServerScripts(poolPayload(3), 'job'), true);
  assert.equal(api.applyServerScripts(poolPayload(4), 'dating'), true);

  const job = JSON.parse(local.getItem('dan_scripts_job'));
  const dating = JSON.parse(local.getItem('dan_scripts'));
  assert.equal(job.version, '3');
  assert.equal(job.source, 'server');
  assert.deepEqual(Object.keys(job.scripts.v1), ['name', 'icebreaker', 'ad_template', 'kick_message', 'final_kick_message', 'reject_message', 'foreigner_reject']);
  assert.deepEqual(job.random_pool, ['v1']);
  assert.equal(job.mode, 'random');
  assert.ok(job.updated_at > 0);
  assert.equal(dating.version, '4');
  assert.ok(local.getItem('dan_scripts_last_sync'), '双池写入后都应记同步时间戳');
  assert.equal(getLoadCount(), 2);
});

test('数值版本比较：server "3" > 本地 "1.9" 应用；server "10" > 本地 "9" 应用（字符串比较会误判）', () => {
  // job 池：本地 bootstrap v1.9，OPS 计数器 v3 下发应应用
  const job = loadScriptsSync({
    local: { dan_scripts_job: JSON.stringify({ version: '1.9', imported_from_json: true, scripts: { old: {} } }) },
  });
  assert.equal(job.api.applyServerScripts(poolPayload(3), 'job'), true);
  assert.equal(JSON.parse(job.local.getItem('dan_scripts_job')).version, '3');

  // dating 池：本地 v9（imported_from_json），OPS v10 —— 数值 10>9 应用；字符串 "10"<"9" 会误跳过
  const dating = loadScriptsSync({
    local: { dan_scripts: JSON.stringify({ version: '9', imported_from_json: true, scripts: { old: {} } }) },
  });
  assert.equal(dating.api.applyServerScripts(poolPayload(10), 'dating'), true);
  assert.equal(JSON.parse(dating.local.getItem('dan_scripts')).version, '10');
});

test('数值版本比较：版本不新则跳过（job serverVer<=localVer；dating 防回滚）', () => {
  // job：server v2 <= 本地 v2 → 跳过
  const job = loadScriptsSync({
    local: { dan_scripts_job: JSON.stringify({ version: '2', scripts: { old: {} } }) },
  });
  assert.equal(job.api.applyServerScripts(poolPayload(2), 'job'), false);
  assert.equal(JSON.parse(job.local.getItem('dan_scripts_job')).version, '2');

  // dating：本地 v2.1 imported_from_json，server v2 < 2.1 → 防回滚跳过
  const dating = loadScriptsSync({
    local: { dan_scripts: JSON.stringify({ version: '2.1', imported_from_json: true, scripts: { old: {} } }) },
  });
  assert.equal(dating.api.applyServerScripts(poolPayload(2), 'dating'), false);
  assert.equal(JSON.parse(dating.local.getItem('dan_scripts')).version, '2.1');
});

test('版本优先：服务器更新时必须覆盖本地 soft-ice 旧池；旧服务器版本仍跳过', () => {
  const softLocal = JSON.stringify({
    version: '2',
    imported_from_json: true,
    templates: { icebreaker: '大人の余裕です' },
    scripts: { v1: { icebreaker: '大人の余裕です' } },
  });
  const dating = loadScriptsSync({ local: { dan_scripts: softLocal } });
  assert.equal(dating.api.applyServerScripts(poolPayload(3, 'こんにちは'), 'dating'), true, '服务器 v3 > 本地 v2 → 必须覆盖');
  assert.equal(JSON.parse(dating.local.getItem('dan_scripts')).version, '3');

  const job = loadScriptsSync({ local: { dan_scripts_job: softLocal } });
  assert.equal(job.api.applyServerScripts(poolPayload(3, 'こんにちは'), 'job'), true, 'job 不做 soft-ice 守卫');

  const oldServer = loadScriptsSync({ local: { dan_scripts: softLocal } });
  assert.equal(oldServer.api.applyServerScripts(poolPayload(2, 'こんにちは'), 'dating'), false, '服务器不新于本地 → 保留本地');
});

test('syncScriptsFromServer 双池同步：dating+job 各 fetch+apply，任一成功即 toast 成功', async () => {
  const { api, local, sent, toasts } = loadScriptsSync({
    responses: (msg) => (msg.pool === 'dating' ? poolPayload(5) : poolPayload(6)),
  });
  const ok = await api.syncScriptsFromServer(false);
  assert.equal(ok, true);
  assert.deepEqual(sent.map((m) => m.pool), ['dating', 'job']);
  assert.equal(JSON.parse(local.getItem('dan_scripts')).version, '5');
  assert.equal(JSON.parse(local.getItem('dan_scripts_job')).version, '6');
  assert.ok(toasts.some((t) => t.msg.indexOf('✅') >= 0));
});

test('syncScriptsFromServer 单池可达也算成功；双不可达 toast 警告', async () => {
  const onlyJob = loadScriptsSync({
    responses: (msg) => (msg.pool === 'job' ? poolPayload(7) : null),
  });
  assert.equal(await onlyJob.api.syncScriptsFromServer(false), true);
  assert.equal(JSON.parse(onlyJob.local.getItem('dan_scripts_job')).version, '7');
  assert.equal(onlyJob.local.getItem('dan_scripts'), null);

  const none = loadScriptsSync({ responses: () => null });
  assert.equal(await none.api.syncScriptsFromServer(false), false);
  assert.ok(none.toasts.some((t) => t.msg.indexOf('⚠️') >= 0));
});
