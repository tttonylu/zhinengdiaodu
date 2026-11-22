'use strict';

try {
  importScripts('bridge-config.js');
} catch (error) {
  // 未生成桥配置时保持完全禁用。
}

const HEARTBEAT_MS = 15000;
const RECONNECT_MS = 3000;
const HELLO_WAIT_MS = 5000;
const PROBE_FILES = [
  'src/selectors.js',
  'src/inbox-parser.js',
  'src/pulse.js',
  'src/report.js',
  'src/conversation.js',
  'probe.js'
];
const CHAT_TAB_PATTERN = 'https://x.com/i/chat*';
const ANY_X_TAB_PATTERN = 'https://x.com/*';

let socket = null;
let sessionId = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let helloWaitTimer = null;
let connecting = false;

function bridgeConfig() {
  const config = self.DM_PULSE_BRIDGE_CONFIG;
  if (!config || config.enabled !== true) return null;
  if (!config.token || !Number.isInteger(config.port)) return null;
  return config;
}

function extensionError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function send(frame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function clearTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (helloWaitTimer) clearTimeout(helloWaitTimer);
  heartbeatTimer = null;
  helloWaitTimer = null;
  sessionId = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!bridgeConfig()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  const config = bridgeConfig();
  if (!config) return;
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  connecting = true;
  try {
    socket = new WebSocket('ws://127.0.0.1:' + config.port + '/bridge');
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    connecting = false;
    send({
      type: 'hello',
      token: config.token,
      client: {
        extensionVersion: chrome.runtime.getManifest().version,
        schema: 'xchat-v2'
      }
    });
    helloWaitTimer = setTimeout(() => {
      if (!sessionId) {
        try { socket.close(); } catch {}
      }
    }, HELLO_WAIT_MS);
  });

  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  socket.addEventListener('close', () => {
    connecting = false;
    clearTimers();
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    connecting = false;
    try { socket.close(); } catch {}
  });
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return;

  if (frame.type === 'hello_ok') {
    if (helloWaitTimer) clearTimeout(helloWaitTimer);
    helloWaitTimer = null;
    sessionId = frame.sessionId;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send({ type: 'heartbeat', sessionId });
    }, HEARTBEAT_MS);
    return;
  }

  if (frame.type === 'request') {
    handleRequest(frame);
  }
}

async function handleRequest(frame) {
  try {
    const result = await dispatch(String(frame.method || ''), frame.params || {});
    send({ type: 'response', id: frame.id, ok: true, result });
  } catch (error) {
    send({
      type: 'response',
      id: frame.id,
      ok: false,
      error: {
        code: (error && error.code) || 'EXTENSION_ERROR',
        message: String((error && error.message) || error)
      }
    });
  }
}

async function dispatch(method, params) {
  if (method === 'run_pulse') return runPulse(params);
  if (method === 'read_unread_conversation') return readUnreadConversation(params);
  if (method === 'get_coexistence_state') return readCoexistence();
  if (method === 'chat_cmd') return runChatCmd(params);
  if (method === 'chat_ops') return runChatOps(params);
  throw extensionError('UNKNOWN_METHOD', 'unsupported method: ' + method);
}

// ==================== 守箱脉冲驱动（alarms，绕过页面定时器节流）====================
try {
  chrome.alarms.create('inbox_pulse_tick', { periodInMinutes: 1 });
} catch (eAlarmCreate) {}

try {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || alarm.name !== 'inbox_pulse_tick') return;
    try {
      const tabs = await chrome.tabs.query({ url: ['https://*.x.com/*', 'https://*.twitter.com/*'] });
      if (!tabs.length) return;
      const tab = tabs.find((t) => /\/i\/chat/i.test(String(t.url || ''))) || tabs[0];
      if (!tab || tab.id == null) return;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          try {
            if (typeof window.__sgChatCmd !== 'function') return;
            window.__sgChatCmd('inboxTickOnce', [], 5000);
          } catch (e) {}
        }
      });
    } catch (eAlarm) {}
  });
} catch (eAlarmBind) {}

/** 页面内操作：composer / fill / buttons / clickSend（测试副本专用） */
async function runChatOps(params) {
  const op = String((params && params.op) || '');
  if (!op) throw extensionError('BAD_PARAMS', 'op required');
  const tab = await pickTab('any-x');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (operation, payload) => {
      const out = { op: operation };
      try {
        function deepAll(root, selector, acc) {
          acc = acc || [];
          if (!root) return acc;
          try {
            const direct = root.querySelectorAll(selector);
            for (let i = 0; i < direct.length; i++) acc.push(direct[i]);
          } catch (eD) {}
          try {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n;
            while ((n = walker.nextNode())) {
              if (n && n.shadowRoot) deepAll(n.shadowRoot, selector, acc);
            }
          } catch (eW) {}
          return acc;
        }
        function findComposer() {
          const sels = [
            '[data-testid="dm-composer-textarea"]',
            'textarea[aria-label*="私信"]',
            'textarea[placeholder*="私信"]',
            '[contenteditable="true"][role="textbox"]',
            '[role="textbox"]'
          ];
          for (let i = 0; i < sels.length; i++) {
            const hits = deepAll(document, sels[i]);
            if (hits.length) return hits[0];
          }
          return null;
        }
        const composer = findComposer();
        if (operation === 'composer') {
          out.found = !!composer;
          if (composer) {
            const r = composer.getBoundingClientRect();
            out.rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
            out.value = String(composer.value || composer.innerText || '').slice(0, 60);
          }
          return out;
        }
        if (operation === 'fill') {
          if (!composer) { out.error = 'no_composer'; return out; }
          const text = String((payload && payload.text) || '');
          composer.focus();
          try { document.execCommand('selectAll', false); } catch (e1) {}
          try { document.execCommand('delete', false); } catch (e2) {}
          try { document.execCommand('insertText', false, text); } catch (e3) {}
          out.value = String(composer.value || composer.innerText || '');
          out.ok = out.value.indexOf(text.slice(0, 6)) >= 0;
          // 强制 React 状态同步（execCommand 只改 DOM，状态可能没更新）
          try {
            const proto = composer.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter && setter.set) setter.set.call(composer, text);
            composer.dispatchEvent(new InputEvent('input', {
              bubbles: true, cancelable: true, inputType: 'insertText', data: text
            }));
            composer.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (eSync) {}
          return out;
        }
        if (operation === 'buttons') {
          const scope = (composer && composer.closest('form')) || document.body;
          const nodes = deepAll(scope, 'button, [role="button"]');
          out.buttons = [];
          for (let i = 0; i < nodes.length; i++) {
            const b = nodes[i];
            const r = b.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            out.buttons.push({
              testid: b.getAttribute('data-testid') || '',
              aria: String(b.getAttribute('aria-label') || '').slice(0, 30),
              disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true'),
              w: Math.round(r.width),
              h: Math.round(r.height),
              left: Math.round(r.left),
              top: Math.round(r.top)
            });
          }
          out.count = out.buttons.length;
          return out;
        }
        if (operation === 'clickSend') {
          const scope = (composer && composer.closest('form')) || document.body;
          const nodes = deepAll(scope, 'button, [role="button"]');
          let btn = nodes.find((b) => /send/i.test(b.getAttribute('data-testid') || ''))
            || nodes.find((b) => /send|送信|发送/i.test(b.getAttribute('aria-label') || ''));
          if (!btn) {
            for (let i = nodes.length - 1; i >= 0; i--) {
              const b = nodes[i];
              const meta = (b.getAttribute('data-testid') || '') + ' ' + (b.getAttribute('aria-label') || '');
              if (/voice|media|gif|emoji|image|photo|attach|录制|语音|画像|絵文字/i.test(meta)) continue;
              if (b.disabled) continue;
              btn = b;
              break;
            }
          }
          out.found = !!btn;
          if (btn) {
            out.testid = btn.getAttribute('data-testid') || '';
            out.aria = String(btn.getAttribute('aria-label') || '');
            try { btn.click(); out.clicked = true; } catch (e4) { out.error = String(e4); }
          }
          return out;
        }
        if (operation === 'pausePulse' || operation === 'resumePulse') {
          const raw = localStorage.getItem('sg_inbox_state');
          let st = {};
          try { st = raw ? JSON.parse(raw) : {}; } catch (eSt) { st = {}; }
          if (operation === 'pausePulse') {
            st.running = false;
            st.busy = false;
          } else {
            st.running = true;
            st.busy = false;
            st.nextPulseAt = Date.now();
          }
          localStorage.setItem('sg_inbox_state', JSON.stringify(st));
          // 保持守箱模式，避免调度器接管
          localStorage.setItem('sg_run_mode', 'inbox');
          sessionStorage.setItem('sg_run_mode', 'inbox');
          sessionStorage.setItem('sg_test_inbox_watch', 'true');
          localStorage.setItem('sg_test_inbox_watch', 'true');
          out.running = st.running;
          out.runMode = 'inbox';
          return out;
        }
        if (operation === 'send') {
          const el = findComposer();
          if (!el) { out.error = 'no_composer'; return out; }
          const all = deepAll(document, 'button, [role="button"]');
          let btn = all.find((b) => /send/i.test(b.getAttribute('data-testid') || ''))
            || all.find((b) => /send|送信|发送/i.test(b.getAttribute('aria-label') || ''));
          if (btn) {
            out.method = 'button';
            out.testid = btn.getAttribute('data-testid') || '';
            out.aria = String(btn.getAttribute('aria-label') || '');
            try { btn.click(); out.clicked = true; } catch (eBtn) { out.error = String(eBtn); }
            return out;
          }
          el.focus();
          const opts = {
            bubbles: true, cancelable: true, composed: true,
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13
          };
          ['keydown', 'keypress', 'keyup'].forEach((t) => {
            el.dispatchEvent(new KeyboardEvent(t, opts));
          });
          out.method = 'enter';
          out.valueAfter = String(el.value || el.innerText || '').slice(0, 40);
          return out;
        }
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      return out;
    },
    args: [op, params || {}]
  });
  return (results && results[0] && results[0].result) || { ok: false, error: 'no_result' };
}

/** 诊断转发：在活动 x.com 标签页里调用 window.__sgChatCmd(name, args, timeout) */
async function runChatCmd(params) {
  const name = String((params && params.name) || '');
  if (!name) throw extensionError('BAD_PARAMS', 'name required');
  const args = Array.isArray(params && params.args) ? params.args : [];
  const timeoutMs = Number((params && params.timeoutMs) || 20000);
  const tab = await pickTab('any-x');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (cmdName, cmdArgs, cmdTimeout) => {
      if (typeof window.__sgChatCmd !== 'function') {
        return { ok: false, error: 'sg_chat_bridge_missing', href: location.href };
      }
      try {
        const value = await window.__sgChatCmd(cmdName, cmdArgs, cmdTimeout);
        return { ok: true, value, href: location.href };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), href: location.href };
      }
    },
    args: [name, args, timeoutMs]
  });
  return (results && results[0] && results[0].result) || { ok: false, error: 'no_result' };
}

async function countTabs(pattern) {
  try {
    const tabs = await chrome.tabs.query(pattern ? { url: [pattern] } : {});
    return tabs.length;
  } catch {
    return -1;
  }
}

async function pickTab(scope) {
  const pattern = scope === 'any-x' ? ANY_X_TAB_PATTERN : CHAT_TAB_PATTERN;
  const tabs = await chrome.tabs.query({ url: [pattern] });
  if (!tabs.length) {
    const total = await countTabs(null);
    const xCount = await countTabs(ANY_X_TAB_PATTERN);
    throw extensionError(
      'NO_TAB',
      '没有找到 ' + pattern + ' 标签页（浏览器总标签 ' + total + '，x.com 标签 ' + xCount + '）'
    );
  }
  const active = tabs.filter((tab) => tab.active);
  return active[0] || tabs[0];
}

async function ensureProbe(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: PROBE_FILES,
    world: 'MAIN'
  });
}

async function runPulse(params) {
  const tab = await pickTab('chat');
  await ensureProbe(tab.id);

  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (options) => window.__dmPulseRun(options),
    args: [{
      budgetMs: Number(params.budgetMs) || 15000,
      intervalMs: Number(params.intervalMs) || 500,
      deep: params.deep !== false,
      maxScrolls: params.maxScrolls == null ? 3 : Number(params.maxScrolls),
      scrollStepPx: Number(params.scrollStepPx) || 600,
      settleMs: Number(params.settleMs) || 700
    }]
  });

  const result = injection && injection[0] ? injection[0].result : null;
  if (!result) {
    throw extensionError('PULSE_NO_RESULT', '页面未返回脉冲结果，可能已导航');
  }
  return result;
}

async function readUnreadConversation(params) {
  if (!params || params.allowOpen !== true) {
    throw extensionError('OPEN_NOT_ALLOWED', 'read_unread_conversation requires allowOpen=true');
  }
  const tab = await pickTab('chat');
  await ensureProbe(tab.id);

  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (options) => window.__dmPulseRun(options),
    args: [{
      action: 'read_unread',
      allowOpen: true,
      maxWaitMs: Number(params.maxWaitMs) || 10000
    }]
  });

  const result = injection && injection[0] ? injection[0].result : null;
  if (!result) {
    throw extensionError('CONVERSATION_NO_RESULT', '页面未返回会话探针结果，可能已导航');
  }
  return result;
}

async function readProductionExtensionFlags() {
  const flags = {
    productionExtensionDetected: false,
    productionTestCopyDetected: false,
    productionExtensionVersion: '',
    productionTestCopyVersion: '',
    productionTestCopyName: ''
  };
  try {
    const all = await chrome.management.getAll();
    for (const entry of all) {
      if (entry.id === chrome.runtime.id) continue;
      const name = String(entry.name || '');
      if (name.indexOf('智能调度中心') === -1) continue;
      if (name.indexOf('测试副本') !== -1) {
        flags.productionTestCopyDetected = true;
        flags.productionTestCopyVersion = String(entry.version || '');
        flags.productionTestCopyName = name;
      } else {
        flags.productionExtensionDetected = true;
        flags.productionExtensionVersion = String(entry.version || '');
      }
    }
  } catch {
    // 没有 management 权限时只返回页面内可观察状态。
  }
  return flags;
}

async function readCoexistence() {
  let tab;
  try {
    tab = await pickTab('chat');
  } catch (error) {
    if (!error || error.code !== 'NO_TAB') throw error;
    tab = await pickTab('any-x');
  }
  const flags = await readProductionExtensionFlags();

  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      function classifySurface(pathname) {
        const path = String(pathname || '').replace(/\/+$/, '') || '/';
        if (path === '/i/chat') return 'list';
        if (/^\/i\/chat\/\d+(?:-\d+)?$/.test(path)) return 'conversation';
        return 'other';
      }

      function findListbox(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot) {
            const found = node.shadowRoot.querySelector('[role="listbox"]');
            if (found) return found;
            const nested = findListbox(node.shadowRoot);
            if (nested) return nested;
          }
        }
        return null;
      }

      let listbox = null;
      try {
        listbox = document.querySelector('[role="listbox"]') || findListbox(document);
      } catch {
        listbox = null;
      }

      let visibleRows = 0;
      if (listbox) {
        visibleRows = listbox.querySelectorAll('a[role="option"][id^="dm-conversation-option-"]').length;
      }

      let sgKeyCount = 0;
      let pageLog = [];
      try {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key && key.indexOf('sg_') === 0) sgKeyCount++;
        }
      } catch {
        sgKeyCount = 0;
      }
      try {
        const rawLog = localStorage.getItem('sg_log');
        pageLog = rawLog ? JSON.parse(rawLog).slice(0, 60) : [];
      } catch {
        pageLog = [];
      }

      const pageDiagBridge = typeof window.__sgChatCmd === 'function';
      let isolatedBridgeReachable = false;
      let isolatedReportsDmPath = null;
      let inboxV2Diag = null;
      let chatTickState = null;

      if (pageDiagBridge) {
        try {
          const answer = await Promise.race([
            window.__sgChatCmd('isDmPath', [location.pathname], 900),
            new Promise((resolve) => setTimeout(() => resolve({ error: 'probe_timeout' }), 1200))
          ]);
          isolatedBridgeReachable = !(answer && typeof answer === 'object' && answer.error);
          if (typeof answer === 'boolean') isolatedReportsDmPath = answer;
        } catch {
          isolatedBridgeReachable = false;
        }
        try {
          inboxV2Diag = await Promise.race([
            window.__sgChatCmd('inboxV2Diag', [], 1200),
            new Promise((resolve) => setTimeout(() => resolve({ error: 'diag_timeout' }), 1600))
          ]);
        } catch {
          inboxV2Diag = { error: 'diag_failed' };
        }
        try {
          chatTickState = await Promise.race([
            window.__sgChatCmd('chatTickState', [], 1200),
            new Promise((resolve) => setTimeout(() => resolve({ error: 'tick_timeout' }), 1600))
          ]);
        } catch {
          chatTickState = { error: 'tick_failed' };
        }
      }

      return {
        urlPath: location.pathname,
        surface: classifySurface(location.pathname),
        sandboxInjected: typeof window.__dmPulseRun === 'function',
        listboxReady: !!listbox,
        visibleRows,
        productionMainWorldBridgePresent: pageDiagBridge,
        productionIsolatedBridgeReachable: isolatedBridgeReachable,
        productionReportsDmPath: isolatedReportsDmPath,
        productionInboxV2: inboxV2Diag,
        productionChatTick: chatTickState,
        pageLog: pageLog,
        productionGlobalsVisibleInMainWorld: !!window.SgInboxWatch || !!window.SgChatGates,
        pageSgKeyCount: sgKeyCount
      };
    }
  });

  const page = (injection && injection[0] ? injection[0].result : null) || {};
  return Object.assign({ readOnly: true, observedAt: Date.now() }, page, flags);
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.alarms.create('dm-pulse-bridge-reconnect', { periodInMinutes: 1 });
  } catch {}
  connect();
});

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'dm-pulse-bridge-reconnect') connect();
  });
} catch {}

connect();
