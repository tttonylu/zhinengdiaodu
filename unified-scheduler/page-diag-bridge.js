// 注入到页面主世界（不受 x.com CSP 挡内联 script 影响）
// 通过 postMessage 向扩展隔离世界请求诊断数据
(function () {
  'use strict';
  var BRIDGE_VER = '3.7.29';
  var oneTimeReady = !!window.__sgDiagBridgeOneTime;

  /** 跨世界调用：主世界控制台无法直接访问隔离世界的 __sgChatBridge，经 postMessage 中转 */
  function __sgChatCmd(fnName, args, timeoutMs) {
    timeoutMs = timeoutMs || 4000;
    return new Promise(function (resolve) {
      var id = Date.now() + '_' + Math.random();
      var done = false;
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.type !== '__sg_chat_cmd_result' || e.data.id !== id) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(e.data.value);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: '__sg_chat_cmd_request', id: id, fn: String(fnName || ''), args: args || [] }, '*');
      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        resolve({ error: '__sgChatCmd timeout — 请确认已重载「智能调度中心」且 content_chat.js 已注入' });
      }, timeoutMs);
    });
  }
  window.__sgChatCmd = __sgChatCmd;

  /** 闭环诊断（含 OPS 步；必要时自动导航，跨页 resume 最长约 20s） */
  window.__sgTraceReplyChainAsync = function (handle, options) {
    return __sgChatCmd('debugTraceReplyChainAsync', [handle, options || {}], 20000);
  };

  /** 实机验收：bridge 接线 + 持久化 + SOP 场景归类 */
  window.__sgVerifyReplyChain = function (handle) {
    return __sgChatCmd('debugVerifyReplyChainSetup', [handle || ''], 6000);
  };

  /** 收件箱未读/预览实机采样（handle 或 handle 数组） */
  window.__sgCalibrateInboxUnread = function (handles) {
    return __sgChatCmd('debugCalibrateInboxUnread', [handles || []], 8000);
  };

  /** 路线 A 分层验收：A1 收件箱 / A2 气泡 / A3 闸门 */
  window.__sgAcceptRouteA = function (handle) {
    return __sgChatCmd('debugAcceptRouteA', [handle || ''], 8000);
  };

  /** 跨世界强制扫箱脉冲（等列表就绪再 tick，最长约 10s+二次tick） */
  window.__sgForceInboxPulse = function (mins) {
    return __sgChatCmd('forceInboxPulse', [mins || 20], 22000);
  };

  /** 当前扩展版本（隔离世界 manifest） */
  window.__sgExtVer = function () {
    return __sgChatCmd('getExtensionVersion', [], 3000);
  };

  /** 一键解卡：私信解冻+续跑 */
  window.__sgUnstickInbox = function (mins) {
    return __sgChatCmd('unstickInboxAndPulse', [mins || 20], 25000);
  };

  /**
   * 清误杀拉黑（主世界可用）。
   * 用法：await __sgClearFalseDmBlocks({dryRun:true})  再  await __sgClearFalseDmBlocks()
   */
  window.__sgClearFalseDmBlocks = function (opts) {
    return __sgChatCmd('clearFalseDmBlocks', [opts || {}], 8000);
  };

  /** 解除诊断冻结（冻结时 coTick 会持续停引擎） */
  window.__sgDiagUnfreeze = function (why) {
    return __sgChatCmd('clearDiagFreeze', [why || 'console'], 3000);
  };

  /** 当前可见收件箱行：replied / unread / fromSelf */
  window.__sgDumpInboxSignals = function (limit) {
    return __sgChatCmd('debugDumpVisibleInboxSignals', [limit || 12], 8000);
  };

  /** 年龄分流预览（不发送）：await __sgPredictAgeRoute(['20歳']) */
  window.__sgPredictAgeRoute = function (texts) {
    return __sgChatCmd('debugPredictAgeRoute', [texts || []], 4000);
  };

  /** 会话页气泡 dump */
  window.__sgDumpConversation = function (handle) {
    return __sgChatCmd('debugDumpConversationState', [handle || ''], 6000);
  };

  /** 可发三态：can_send / hard_closed / pending（正向标记） */
  window.__sgDmSendability = function () {
    return __sgChatCmd('debugDmSendability', [], 4000);
  };

  /** 一键验收：接线检查 + 路线 A 分层（无需粘贴 reply-chain-verify.js） */
  window.__sgReplyChainVerify = function (handle) {
    return __sgChatCmd('resolveActiveChatHandle', [handle || ''], 3000).then(function (resolved) {
      var h = (typeof resolved === 'string' ? resolved : '') || handle || '';
      return __sgVerifyReplyChain(h).then(function (report) {
        return __sgAcceptRouteA(h).then(function (routeA) {
          report = report || {};
          report.handle = h || report.handle || '';
          report.routeA = routeA;
          report.routeAPass = !!(routeA && routeA.pass);
          if (routeA && routeA.blockers && routeA.blockers.length) {
            report.routeABlockers = routeA.blockers;
          }
          console.log('[__sgReplyChainVerify] pass=' + !!report.pass + ' routeA=' + !!report.routeAPass + ' handle=' + (report.handle || ''), report);
          return report;
        });
      });
    });
  };

  /** 解析当前目标 handle（current_target 为空时自动推断） */
  window.__sgResolveHandle = function (preferred) {
    return __sgChatCmd('resolveActiveChatHandle', [preferred || ''], 3000);
  };

  function installBridgeApis() {
    window.__sgDiag = function () {
      return new Promise(function (resolve) {
        var id = Date.now() + '_' + Math.random();
        var done = false;
        function onMsg(e) {
          if (e.source !== window || !e.data || e.data.type !== '__sg_diag_result' || e.data.id !== id) return;
          done = true;
          window.removeEventListener('message', onMsg);
          resolve(e.data.payload);
        }
        window.addEventListener('message', onMsg);
        window.postMessage({ type: '__sg_diag_request', id: id }, '*');
        setTimeout(function () {
          if (done) return;
          window.removeEventListener('message', onMsg);
          resolve({
            error: 'diag timeout — 扩展未响应。请确认已重载「智能调度中心」且在 x.com 页面。'
          });
        }, 4000);
      });
    };

    window.__sgParseAge = function (text) {
      return new Promise(function (resolve) {
        var id = Date.now() + '_' + Math.random();
        var done = false;
        function onMsg(e) {
          if (e.source !== window || !e.data || e.data.type !== '__sg_parse_age_result' || e.data.id !== id) return;
          done = true;
          window.removeEventListener('message', onMsg);
          resolve(e.data.value);
        }
        window.addEventListener('message', onMsg);
        window.postMessage({ type: '__sg_parse_age_request', id: id, text: String(text || '') }, '*');
        setTimeout(function () {
          if (done) return;
          window.removeEventListener('message', onMsg);
          resolve(null);
        }, 3000);
      });
    };

    /** 一键复验 DM 流程：返回当前会话的检测快照（选择器命中数/对方气泡/未读/输入框/流程trace） */
    window.__sgRunDmDebug = function () {
      return new Promise(function (resolve) {
        var id = Date.now() + '_' + Math.random();
        var done = false;
        function onMsg(e) {
          if (e.source !== window || !e.data || e.data.type !== '__sg_dm_debug_result' || e.data.id !== id) return;
          done = true;
          window.removeEventListener('message', onMsg);
          var payload = e.data.payload || {};
          try {
            console.log('[DM调试] url:', payload.url);
            console.log('[DM调试] 根容器:', payload.rootTestid, '| messageEntry=', payload.entryCount, '| messageBubble=', payload.bubbleCount, '| 对方气泡=', (payload.peerTexts || []).length);
            if (payload.trace && payload.trace.length) {
              console.table(payload.trace.map(function (t, i) { return { i: i, stage: t.label || t.stage, time: t.time, text: (t.detail && (t.detail.text || t.detail.reason || t.detail.decision || t.detail.action || '')) }; }));
            }
            if (payload.peerTexts && payload.peerTexts.length) {
              console.table(payload.peerTexts.map(function (t, i) { return { i: i, text: t }; }));
            } else {
              console.warn('[DM调试] 未检出对方气泡 — 请确认已打开具体会话且对方有回复，若 DOM 结构特殊请截图告知');
            }
            console.log('[DM调试] 快照:', payload);
          } catch (eLog) {}
          resolve(payload);
        }
        window.addEventListener('message', onMsg);
        window.postMessage({ type: '__sg_dm_debug_request', id: id }, '*');
        setTimeout(function () {
          if (done) return;
          window.removeEventListener('message', onMsg);
          resolve({ error: 'DM debug timeout — 扩展未响应。请确认已重载「智能调度中心」并在 /i/chat（或 /messages）会话页。' });
        }, 4000);
      });
    };

    /** 兼容旧名：页面控制台早期脚本习惯用 __sgDmDebug */
    window.__sgDmDebug = window.__sgRunDmDebug;

    function callTestMonitor(action, args) {
      return new Promise(function (resolve) {
        var id = Date.now() + '_' + Math.random();
        var done = false;
        function onMsg(e) {
          if (e.source !== window || !e.data || e.data.type !== '__sg_test_monitor_result' || e.data.id !== id) return;
          done = true;
          window.removeEventListener('message', onMsg);
          resolve(e.data.payload);
        }
        window.addEventListener('message', onMsg);
        window.postMessage({ type: '__sg_test_monitor_request', action: action, args: args || {}, id: id }, '*');
        setTimeout(function () {
          if (done) return;
          window.removeEventListener('message', onMsg);
          resolve({ error: 'test monitor timeout — 扩展未响应。请确认已重载「智能调度中心」。' });
        }, 8000);
      });
    }

    window.__sgTestMonitor = {
      start: function (label) { return callTestMonitor('start', { label: label }); },
      stop: function () { return callTestMonitor('stop', {}); },
      isActive: function () { return callTestMonitor('isActive', {}); },
      getSession: function () { return callTestMonitor('getSession', {}); },
      export: function () { return callTestMonitor('exportJson', {}); },
      download: function () { return callTestMonitor('downloadJson', {}); },
      copy: function () { return callTestMonitor('copyJson', {}); },
      upload: function () { return callTestMonitor('uploadOps', {}); },
      clear: function () { return callTestMonitor('clear', {}); },
      getRecent: function (n) { return callTestMonitor('getRecent', { n: n || 3 }); }
    };

    function __sgNormalizeHandle(raw) {
      var h = String(raw || '').replace(/^@+/, '').replace(/#guard$/i, '').toLowerCase().trim();
      var reserved = {
        home: 1, explore: 1, notifications: 1, messages: 1, settings: 1,
        compose: 1, search: 1, i: 1, intent: 1, share: 1, login: 1,
        signup: 1, logout: 1, bookmarks: 1, lists: 1, followers: 1,
        following: 1, verified_followers: 1, followers_you_follow: 1,
        status: 1, account: 1, admin: 1, root: 1, guest: 1, unknown: 1
      };
      return /^[a-z0-9_]{1,15}$/.test(h) && !reserved[h] ? h : '';
    }

    function __sgClassifyPage() {
      var path = (window.location.pathname || '').toLowerCase().replace(/\/+$/, '');
      var segs = path.split('/').filter(Boolean);
      var page = { kind: 'other', handle: '', path: path };
      if (!path || path === '/' || path === '/home') page.kind = 'home';
      else if (path.indexOf('/messages') === 0 || path.indexOf('/i/chat') === 0) page.kind = 'messages';
      else if (segs.length === 2 && (segs[1] === 'followers' || segs[1] === 'verified_followers' || segs[1] === 'followers_you_follow')) {
        page.kind = 'followers'; page.handle = segs[0];
      } else if (segs.length >= 1) {
        page.kind = 'profile'; page.handle = segs[0];
      }
      if (!__sgNormalizeHandle(page.handle)) {
        page.kind = 'other';
        page.handle = '';
      }
      return page;
    }

    function __sgExpectedPageFor(cr, step) {
      var handle = __sgNormalizeHandle(cr);
      if (!handle) return null;
      if (String(step || '').toUpperCase() === 'PROFILE') return { kind: 'profile', handle: handle };
      return { kind: 'followers', handle: handle };
    }

    function __sgIsAtFollowTarget(url) {
      try {
        var target = new URL(String(url || ''), window.location.origin);
        var current = new URL(window.location.href);
        var targetPath = target.pathname.replace(/\/+$/, '') || '/';
        var currentPath = current.pathname.replace(/\/+$/, '') || '/';
        return (target.hostname === current.hostname ||
          (target.hostname === 'x.com' && current.hostname.endsWith('.x.com')) ||
          (target.hostname === 'twitter.com' && current.hostname.endsWith('.twitter.com'))) &&
          targetPath === currentPath;
      } catch (e) {
        return false;
      }
    }

    window.classifyPage = __sgClassifyPage;
    window.expectedPageFor = __sgExpectedPageFor;
    window.isAtFollowTarget = __sgIsAtFollowTarget;
    window.normalizeBloggerHandle = __sgNormalizeHandle;
    window.RESERVED_PAGE_HANDLES = window.RESERVED_PAGE_HANDLES || {
      home: true, explore: true, notifications: true, messages: true,
      settings: true, compose: true, search: true, i: true,
      intent: true, share: true, login: true, signup: true, logout: true,
      bookmarks: true, lists: true, followers: true, following: true,
      verified_followers: true, followers_you_follow: true, status: true,
      account: true, admin: true, root: true, guest: true, unknown: true
    };

    window.__sgFollowDebug__ = window.__sgFollowDebug__ || {};
    window.__sgFollowDebug__.classifyPage = __sgClassifyPage;
    window.__sgFollowDebug__.expectedPageFor = __sgExpectedPageFor;
    window.__sgFollowDebug__.isAtFollowTarget = __sgIsAtFollowTarget;
    window.__sgFollowDebug__.normalizeBloggerHandle = __sgNormalizeHandle;
    window.__sgFollowDebug__.RESERVED_PAGE_HANDLES = window.RESERVED_PAGE_HANDLES;

    window.__sgDiagBridgeVer = BRIDGE_VER;
    try {
      document.documentElement.setAttribute('data-sg-ext', BRIDGE_VER);
    } catch (e) {}
  }

  installBridgeApis();
  if (oneTimeReady) return;

  window.__sgDiagBridgeOneTime = true;
  window.__sgDiagInstalled = true;

  var _suppressTimer = null;
  var _onbeforeunloadBlocked = false;
  var _realOnbeforeunloadDesc = null;

  function isSuppressOn() {
    try {
      return document.documentElement.getAttribute('data-sg-suppress-unload') === '1';
    } catch (e) {
      return false;
    }
  }

  function clearNativeHandler() {
    try { window.onbeforeunload = null; } catch (e1) {}
  }

  /** 抑制窗口内：挡住页面再挂 onbeforeunload */
  function blockOnbeforeunloadProp() {
    if (_onbeforeunloadBlocked) return;
    try {
      _realOnbeforeunloadDesc = Object.getOwnPropertyDescriptor(window, 'onbeforeunload')
        || Object.getOwnPropertyDescriptor(Window.prototype, 'onbeforeunload');
      Object.defineProperty(window, 'onbeforeunload', {
        configurable: true,
        enumerable: true,
        get: function () { return null; },
        set: function () { /* swallow while suppress */ }
      });
      _onbeforeunloadBlocked = true;
    } catch (e2) {
      clearNativeHandler();
    }
  }

  function unblockOnbeforeunloadProp() {
    if (!_onbeforeunloadBlocked) return;
    try {
      if (_realOnbeforeunloadDesc) {
        Object.defineProperty(window, 'onbeforeunload', _realOnbeforeunloadDesc);
      } else {
        delete window.onbeforeunload;
      }
    } catch (e3) {
      try { window.onbeforeunload = null; } catch (e4) {}
    }
    _onbeforeunloadBlocked = false;
    _realOnbeforeunloadDesc = null;
  }

  function armSuppress() {
    clearNativeHandler();
    blockOnbeforeunloadProp();
    if (_suppressTimer) return;
    _suppressTimer = setInterval(function () {
      if (!isSuppressOn()) {
        clearInterval(_suppressTimer);
        _suppressTimer = null;
        unblockOnbeforeunloadProp();
        return;
      }
      clearNativeHandler();
    }, 40);
    // 防止属性残留导致后续正常跳页也被吞
    setTimeout(function () {
      try {
        if (isSuppressOn()) document.documentElement.removeAttribute('data-sg-suppress-unload');
      } catch (e5) {}
      if (_suppressTimer) {
        clearInterval(_suppressTimer);
        _suppressTimer = null;
      }
      unblockOnbeforeunloadProp();
    }, 10000);
  }

  // 捕获阶段：抑制时拦住其它 beforeunload 监听（切勿 preventDefault / 切勿写 returnValue，否则反而弹窗）
  try {
    window.addEventListener('beforeunload', function (e) {
      if (!isSuppressOn()) return;
      try { e.stopImmediatePropagation(); } catch (e6) {}
      try { delete e.returnValue; } catch (e7) {}
    }, true);
  } catch (eBu) {}

  try {
    var mo = new MutationObserver(function () {
      if (isSuppressOn()) armSuppress();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sg-suppress-unload'] });
  } catch (eMo) {}

  // 若隔离世界已先打上标记
  if (isSuppressOn()) armSuppress();

})();
