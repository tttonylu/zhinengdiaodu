(function () {
  'use strict';
  var runBtn = document.getElementById('run');
  var deepBtn = document.getElementById('deep');
  var readBtn = document.getElementById('read');
  var inboxTestBtn = document.getElementById('inboxTest');
  var inboxLoopBtn = document.getElementById('inboxLoop');
  var startChatBtn = document.getElementById('startChat');
  var reloadBtn = document.getElementById('reload');
  var status = document.getElementById('status');
  var output = document.getElementById('output');

  status.textContent = '就绪（v' + chrome.runtime.getManifest().version + '）。请在 x.com/i/chat 页面点击运行。';

  (async function reloadIfDiskVersionDiffers() {
    try {
      const response = await fetch(chrome.runtime.getURL('manifest.json'));
      const disk = await response.json();
      const loaded = chrome.runtime.getManifest().version;
      if (disk.version && disk.version !== loaded) {
        status.textContent = '发现磁盘版本 v' + disk.version + '，正在重载扩展…';
        setTimeout(function () { chrome.runtime.reload(); }, 700);
      }
    } catch (e) {
      // 读不到磁盘清单时保持当前版本，不自动重载。
    }
  })();

  async function run(deep) {
    runBtn.disabled = true;
    deepBtn.disabled = true;
    readBtn.disabled = true;
    inboxTestBtn.disabled = true;
    inboxLoopBtn.disabled = true;
    startChatBtn.disabled = true;
    status.textContent = deep ? '深扫运行中…' : '脉冲运行中…';
    output.textContent = '采样中…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        status.textContent = '找不到当前标签页';
        runBtn.disabled = false;
        deepBtn.disabled = false;
        readBtn.disabled = false;
        inboxTestBtn.disabled = false;
        inboxLoopBtn.disabled = false;
        startChatBtn.disabled = false;
        return;
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'src/selectors.js',
          'src/inbox-parser.js',
          'src/pulse.js',
          'src/report.js',
          'src/conversation.js',
          'probe.js'
        ],
        world: 'MAIN'
      });

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (options) => window.__dmPulseRun(options),
        args: [{ deep: deep === true }],
        world: 'MAIN'
      });

      const report = results && results[0] && results[0].result;
      status.textContent = '完成：' + (report && report.verdict || 'unknown');
      output.textContent = JSON.stringify(report, null, 2);
      try {
        await fetch('http://127.0.0.1:47322/report', {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify(report)
        });
      } catch (ePost) {
        // 本地回传服务未启动时忽略，不影响弹窗展示。
      }
    } catch (e) {
      status.textContent = '错误：' + e.message;
      output.textContent = String(e);
    }
    runBtn.disabled = false;
    deepBtn.disabled = false;
    readBtn.disabled = false;
    inboxTestBtn.disabled = false;
    inboxLoopBtn.disabled = false;
    startChatBtn.disabled = false;
  }

  async function readUnread() {
    if (!confirm('将打开首条未读会话并标记为已读，不会发送消息。继续？')) return;
    runBtn.disabled = true;
    deepBtn.disabled = true;
    readBtn.disabled = true;
    inboxTestBtn.disabled = true;
    inboxLoopBtn.disabled = true;
    startChatBtn.disabled = true;
    status.textContent = '会话探针运行中…';
    output.textContent = '正在打开首条未读会话…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('找不到当前标签页');

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'src/selectors.js',
          'src/inbox-parser.js',
          'src/pulse.js',
          'src/report.js',
          'src/conversation.js',
          'probe.js'
        ],
        world: 'MAIN'
      });

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (options) => window.__dmPulseRun(options),
        args: [{ action: 'read_unread', allowOpen: true, maxWaitMs: 10000 }],
        world: 'MAIN'
      });

      const report = results && results[0] && results[0].result;
      status.textContent = '完成：' + (report && report.verdict || 'unknown');
      output.textContent = JSON.stringify(report, null, 2);
      try {
        await fetch('http://127.0.0.1:47322/report', {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify(report)
        });
      } catch (ePostRead) {
        // 本地回传服务未启动时忽略，不影响弹窗展示。
      }
    } catch (e) {
      status.textContent = '错误：' + e.message;
      output.textContent = String(e);
    }
    runBtn.disabled = false;
    deepBtn.disabled = false;
    readBtn.disabled = false;
    inboxTestBtn.disabled = false;
    inboxLoopBtn.disabled = false;
    startChatBtn.disabled = false;
  }

  async function runInboxTest() {
    runBtn.disabled = true;
    deepBtn.disabled = true;
    readBtn.disabled = true;
    inboxTestBtn.disabled = true;
    inboxLoopBtn.disabled = true;
    startChatBtn.disabled = true;
    status.textContent = '收箱脉冲测试中…';
    output.textContent = '正在设置测试开关并打开会话…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('找不到当前标签页');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (options) => {
          if (typeof window.__sgChatCmd !== 'function') {
            return { ok: false, reason: 'sg_chat_bridge_missing' };
          }
          const set = await window.__sgChatCmd('setTestInboxWatch', [true], 3000);
          const tick = await window.__sgChatCmd('runInboxWatchTick', [options], 15000);
          return { set, tick };
        },
        args: [{ allowOpen: true, forceFirstRow: false, testMode: true, allowSend: false }]
      });
      const report = results && results[0] && results[0].result;
      status.textContent = '完成：' + (report && report.tick && report.tick.reason || 'unknown');
      output.textContent = JSON.stringify(report, null, 2);
      try {
        await fetch('http://127.0.0.1:47322/report', {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify(report)
        });
      } catch (ePostInbox) {}
    } catch (e) {
      status.textContent = '错误：' + e.message;
      output.textContent = String(e);
    }
    runBtn.disabled = false;
    deepBtn.disabled = false;
    readBtn.disabled = false;
    inboxTestBtn.disabled = false;
    inboxLoopBtn.disabled = false;
    startChatBtn.disabled = false;
  }

  async function runInboxLoop() {
    if (!confirm('将强制跳过剩余破冰，直接进 DM 会话栏跑守箱循环（会打开会话、可能发送）。继续？')) return;
    runBtn.disabled = true;
    deepBtn.disabled = true;
    readBtn.disabled = true;
    inboxTestBtn.disabled = true;
    inboxLoopBtn.disabled = true;
    startChatBtn.disabled = true;
    status.textContent = '守箱循环运行中…';
    output.textContent = '强制跳过破冰 → 进入 /i/chat → 逐个处理会话…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('找不到当前标签页');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (options) => {
          if (typeof window.__sgChatCmd !== 'function') {
            return { ok: false, reason: 'sg_chat_bridge_missing' };
          }
          const skip = await window.__sgChatCmd('forceEnterInboxWatch', [{ navigate: true }], 8000);
          await new Promise((r) => setTimeout(r, 3000));
          const state = await window.__sgChatCmd('inboxPulseState', [], 3000);
          const diag = await window.__sgChatCmd('inboxV2Diag', [], 3000);
          return { skip, state, diag };
        },
        args: [{ maxTargets: 6, gapMs: 4000 }]
      });
      const report = results && results[0] && results[0].result;
      const running = !!(report && report.state && report.state.running);
      status.textContent = running ? '守箱脉冲已启动' : '守箱脉冲未启动';
      output.textContent = JSON.stringify(report, null, 2);
      try {
        await fetch('http://127.0.0.1:47322/report', {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify(report)
        });
      } catch (ePostLoop) {}
    } catch (e) {
      status.textContent = '错误：' + e.message;
      output.textContent = String(e);
    }
    runBtn.disabled = false;
    deepBtn.disabled = false;
    readBtn.disabled = false;
    inboxTestBtn.disabled = false;
    inboxLoopBtn.disabled = false;
    startChatBtn.disabled = false;
  }

  async function startRealChat() {
    if (!confirm('将关闭干跑并启动一次真实私信测试，可能发送破冰/私信。确认当前是测试账号？')) return;
    runBtn.disabled = true;
    deepBtn.disabled = true;
    readBtn.disabled = true;
    inboxTestBtn.disabled = true;
    startChatBtn.disabled = true;
    status.textContent = '启动真实私信测试…';
    output.textContent = '重载测试副本并刷新页面…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('找不到当前标签页');

      const pre = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          let ownHandle = '';
          try {
            const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
              || document.querySelector('a[aria-label*="个人资料"]')
              || document.querySelector('a[aria-label*="Profile"]');
            if (profile) {
              const href = String(profile.getAttribute('href') || '');
              const seg = href.split('?')[0].split('/').filter(Boolean).pop() || '';
              if (seg && !/^\d+$/.test(seg)) ownHandle = seg.toLowerCase();
            }
          } catch (eHandle) {}
          if (ownHandle) {
            try {
              localStorage.setItem('matrix_my_handle', '@' + ownHandle + '#guard');
              sessionStorage.setItem('dan_target_username', ownHandle);
              sessionStorage.setItem('sg_chat_dry_run', 'false');
              localStorage.setItem('sg_test_24h', 'true');
            } catch (eStore) {}
          } else {
            // 测试账号兜底：导航栏选择器失效时仍能启动测试副本
            ownHandle = 'jakelu133969';
            try {
              localStorage.setItem('matrix_my_handle', '@' + ownHandle + '#guard');
              sessionStorage.setItem('dan_target_username', ownHandle);
              sessionStorage.setItem('sg_chat_dry_run', 'false');
              localStorage.setItem('sg_test_24h', 'true');
            } catch (eStoreFallback) {}
          }
          // 沙盒测试默认进入守箱脉冲模式（要测出站请先关掉守箱）
          try {
            localStorage.setItem('sg_run_mode', 'inbox');
            sessionStorage.setItem('sg_run_mode', 'inbox');
            localStorage.setItem('sg_test_inbox_watch', 'true');
            sessionStorage.setItem('sg_test_inbox_watch', 'true');
          } catch (eModeInbox) {}
          return { ownHandle };
        }
      });
      const ownHandle = (pre && pre[0] && pre[0].result && pre[0].result.ownHandle) || '';

      let reloadedTestCopy = false;
      try {
        const all = await chrome.management.getAll();
        const testCopy = all.find(function (entry) {
          return entry && entry.id !== chrome.runtime.id && String(entry.name || '').indexOf('测试副本') >= 0;
        });
        if (testCopy) {
          await chrome.management.setEnabled(testCopy.id, false);
          await new Promise(function (resolve) { setTimeout(resolve, 700); });
          await chrome.management.setEnabled(testCopy.id, true);
          reloadedTestCopy = true;
          await new Promise(function (resolve) { setTimeout(resolve, 900); });
        }
      } catch (eMgmt) {
        // management 不可用时仍继续刷新页面。
      }

      await chrome.tabs.reload(tab.id, { bypassCache: true });
      for (let i = 0; i < 40; i++) {
        await new Promise(function (resolve) { setTimeout(resolve, 300); });
        try {
          const current = await chrome.tabs.get(tab.id);
          if (current && current.status === 'complete') break;
        } catch (eWait) {}
      }
      await new Promise(function (resolve) { setTimeout(resolve, 1200); });

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (options) => {
          if (typeof window.__sgChatCmd !== 'function') {
            return { ok: false, reason: 'sg_chat_bridge_missing' };
          }
          const set = await window.__sgChatCmd('setTestInboxWatch', [true], 3000);
          const recover = await window.__sgChatCmd('recoverStuckIceQueue', [], 4000);
          const start = await window.__sgChatCmd('startTestChat', [options], 5000);
          return { set, recover, start };
        },
        args: [{ dryRun: false, ownHandle }]
      });
      const started = results && results[0] && results[0].result;
      const report = {
        ownHandle: ownHandle,
        reloadedTestCopy: reloadedTestCopy,
        set: started && started.set,
        start: started && started.start
      };
      await new Promise(function (resolve) { setTimeout(resolve, 6000); });
      try {
        const diagResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: async () => {
            if (typeof window.__sgChatCmd !== 'function') return { error: 'bridge_missing' };
            return window.__sgChatCmd('inboxV2Diag', [], 3000);
          }
        });
        report.diag = (diagResult && diagResult[0] && diagResult[0].result) || null;
      } catch (eDiagRead) {
        report.diag = { error: String((eDiagRead && eDiagRead.message) || eDiagRead) };
      }
      try {
        const logResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => {
            try {
              return JSON.parse(localStorage.getItem('sg_log') || '[]').slice(0, 80);
            } catch (eLog) {
              return [];
            }
          }
        });
        report.recentLog = (logResult && logResult[0] && logResult[0].result) || [];
      } catch (eLogRead) {
        report.recentLog = [];
      }
      status.textContent = '完成：' + (report.start && report.start.ok ? '已启动' : '未知');
      output.textContent = JSON.stringify(report, null, 2);
      try {
        await fetch('http://127.0.0.1:47322/report', {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify(report)
        });
      } catch (ePostStart) {}
    } catch (e) {
      status.textContent = '错误：' + e.message;
      output.textContent = String(e);
    }
    runBtn.disabled = false;
    deepBtn.disabled = false;
    readBtn.disabled = false;
    inboxTestBtn.disabled = false;
    startChatBtn.disabled = false;
  }

  runBtn.addEventListener('click', function () { run(false); });
  deepBtn.addEventListener('click', function () { run(true); });
  readBtn.addEventListener('click', readUnread);
  inboxTestBtn.addEventListener('click', runInboxTest);
  inboxLoopBtn.addEventListener('click', runInboxLoop);
  startChatBtn.addEventListener('click', startRealChat);
  reloadBtn.addEventListener('click', function () {
    status.textContent = '正在重载扩展…';
    chrome.runtime.reload();
  });
})();
