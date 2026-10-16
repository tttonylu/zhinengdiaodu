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

  /**
   * X GraphQL 观察/重放探针（4.6.110+）。
   *
   * 思路（替代已废弃的 txid 逆向）：
   * 本脚本 document_start MAIN world 注入，在 X main.js 之前链式 patch fetch/XHR，
   * 被动记录 X 自己发出的真实 GraphQL 请求（真实 queryId / 完整头 / 是否带 txid）。
   *
   * 控制台用法：
   *   __sgGetCapturedGraphQL()        查看捕获到的 X 真实请求摘要
   *   await __sgReplayGraphQL()       双路重放对照实验（决定直发技术路线）
   */

  /** 查看捕获到的 X 真实 GraphQL 请求（最近 limit 条） */
  window.__sgGetCapturedGraphQL = function (limit) {
    var store = window.__sgCapturedGraphQL || [];
    return store.slice(0, limit || 30).map(function (r) {
      var txid = r.reqHeaders['x-client-transaction-id'] || '';
      return {
        t: r.t,
        origin: r.origin,        // x = X 自己发的；sg = 我们的重放
        via: r.via,              // fetch / xhr
        op: r.op,
        qid: r.qid,
        method: r.method,
        status: r.status,
        hasTxid: !!txid,
        txidLen: txid.length,
        headerNames: Object.keys(r.reqHeaders),
        respTxid: r.respTxid || null,
        rateRemaining: r.respRateRemaining || null,
        reqBodyHead: r.reqBody || ''
      };
    });
  };

  /**
   * 双路重放对照：拿 X 自己成功过的一个 GET 读请求（优先 Viewer），
   * A 路 = 原生 fetch 全头照搬（含旧 txid）→ 验证 txid 是否可重用
   * B 路 = 当前 window.fetch（若 X 包装过则会自动补 txid）且故意删掉 txid
   *       → 验证能否借 X 自己的签名管道直发
   */
  window.__sgReplayGraphQL = async function (which) {
    var store = window.__sgCapturedGraphQL || [];
    if (!store.length) {
      return {
        ok: false,
        reason: 'no_capture',
        hint: '请先在 x.com 正常浏览几秒（刷新首页即可），让 X 自己发出 GraphQL 请求后再运行'
      };
    }

    function findRec(pred) {
      for (var i = 0; i < store.length; i++) {
        if (pred(store[i])) return store[i];
      }
      return null;
    }

    var tpl = null;
    if (typeof which === 'number') tpl = store[which] || null;
    else if (typeof which === 'string') {
      tpl = findRec(function (r) { return r.origin === 'x' && r.op === which; });
    } else {
      var prefs = ['Viewer', 'Viewer_v2', 'UserByScreenName', 'UserBy', 'HomeLatestTimeline'];
      for (var p = 0; p < prefs.length && !tpl; p++) {
        var op = prefs[p];
        tpl = findRec(function (r) { return r.origin === 'x' && r.status === 200 && r.method === 'GET' && r.op === op; });
      }
      if (!tpl) {
        tpl = findRec(function (r) { return r.origin === 'x' && r.status === 200 && r.method === 'GET'; });
      }
    }
    if (!tpl) {
      return { ok: false, reason: 'no_template', captured: store.length, hint: '没有 X 自己成功(200)的 GET 请求可作模板' };
    }

    var out = {
      pickedOp: tpl.op,
      pickedQid: tpl.qid,
      templateStatus: tpl.status,
      templateAgeSec: Math.round((Date.now() - new Date(tpl.t).getTime()) / 1000),
      templateHeaderNames: Object.keys(tpl.reqHeaders),
      templateHadTxid: !!(tpl.reqHeaders['x-client-transaction-id'] || ''),
      pathA_nativeFullHeaders: null,
      pathB_windowFetchNoTxid: null,
      verdict: ''
    };

    function txidShort(h) {
      var v = h['x-client-transaction-id'] || '';
      return v ? v.slice(0, 14) + '…(len=' + v.length + ')' : '(none)';
    }

    // ── A 路：原生 fetch + 全头照搬（浏览器会静默丢弃 content-length/host 等禁改头）──
    try {
      var t0 = Date.now();
      var rA = await window.__sgNativeFetch(tpl.url, {
        method: tpl.method,
        headers: tpl.reqHeaders,
        credentials: 'include'
      });
      var txtA = await rA.text();
      out.pathA_nativeFullHeaders = {
        status: rA.status,
        ms: Date.now() - t0,
        txidSent: txidShort(tpl.reqHeaders),
        bodyHead: txtA.slice(0, 240)
      };
    } catch (e) {
      out.pathA_nativeFullHeaders = { error: String(e && e.message || e) };
    }

    // ── B 路：window.fetch（X wrapper 若存在则在其外层）+ 去掉 txid ──
    var hB = {};
    Object.keys(tpl.reqHeaders).forEach(function (k) {
      if (k === 'x-client-transaction-id') return;
      if (k.indexOf(':') !== -1) return; // 跳过异常键
      hB[k] = tpl.reqHeaders[k];
    });
    var captureLenBefore = store.length;
    try {
      var t1 = Date.now();
      window.__sgSgDepthEnter();
      var rB = await window.fetch(tpl.url, {
        method: tpl.method,
        headers: hB,
        credentials: 'include'
      });
      var txtB = await rB.text();
      window.__sgSgDepthExit();

      // 从观察器回读 B 路实际发出的头：判断 X wrapper 是否自动补了 txid
      var sentRec = null;
      for (var i = 0; i < Math.min(store.length, captureLenBefore + 3); i++) {
        if (store[i].origin === 'sg' && store[i].op === tpl.op) { sentRec = store[i]; break; }
      }
      out.pathB_windowFetchNoTxid = {
        status: rB.status,
        ms: Date.now() - t1,
        wrapperAutoAddedTxid: !!(sentRec && sentRec.reqHeaders['x-client-transaction-id']),
        sentHeaderNames: sentRec ? Object.keys(sentRec.reqHeaders) : [],
        bodyHead: txtB.slice(0, 240)
      };
    } catch (e) {
      window.__sgSgDepthExit();
      out.pathB_windowFetchNoTxid = { error: String(e && e.message || e) };
    }

    // ── 结论 ──
    var aOk = out.pathA_nativeFullHeaders && out.pathA_nativeFullHeaders.status === 200;
    var bOk = out.pathB_windowFetchNoTxid && out.pathB_windowFetchNoTxid.status === 200;
    if (aOk && bOk) {
      out.verdict = '两条路都 200：模板头可重用，且 window.fetch 直发也通。直发可行，优先 B 路（自动签名最省心）';
    } else if (bOk) {
      out.verdict = 'B 路 200：X 的 window.fetch 包装管道会自动补 txid，CreateTweet 走 window.fetch 直发即可，无需逆向算法';
    } else if (aOk) {
      out.verdict = 'A 路 200：捕获到的完整头（含 txid）在有效期内可重用，走「捕获模板→改 body 重放」路线';
    } else {
      out.verdict = '两路均非 200：查看 status/bodyHead 进一步判断（403=签名/queryId 问题，429=限频，400=参数问题）';
    }
    out.ok = aOk || bOk;
    console.log('[__sgReplayGraphQL]', out);
    return out;
  };

  /** 旧函数名兼容：直接等价于双路重放 */
  window.__sgProbeXGraphQL = function () {
    return window.__sgReplayGraphQL();
  };

  /**
   * 等待 X 自己发出指定 op（默认 CreateTweet）。
   * 用法：在控制台先 await __sgWaitForOp('CreateTweet')，然后手动在页面上发一条推文，
   * Promise 会在 X 真实请求发出时自动 resolve 出模板摘要。
   */
  window.__sgWaitForOp = function (opName, timeoutMs) {
    opName = opName || 'CreateTweet';
    timeoutMs = timeoutMs || 120000;
    function matchRec(r) { return r.origin === 'x' && r.op === opName; }
    function summarize(r) {
      return {
        captured: true,
        op: r.op,
        qid: r.qid,
        via: r.via,
        method: r.method,
        status: r.status,
        url: r.url,
        hasTxid: !!(r.reqHeaders['x-client-transaction-id'] || ''),
        headerNames: Object.keys(r.reqHeaders),
        bodyKeys: r.bodyObj ? Object.keys(r.bodyObj) : [],
        variableKeys: r.bodyObj && r.bodyObj.variables ? Object.keys(r.bodyObj.variables) : [],
        featureCount: r.bodyObj && r.bodyObj.features ? Object.keys(r.bodyObj.features).length : 0
      };
    }
    var existing = (window.__sgCapturedGraphQL || []).filter(matchRec)[0];
    if (existing) return Promise.resolve(summarize(existing));

    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        window.__sgSgOnCapture.__noop = null;
        resolve({ captured: false, reason: 'timeout', hint: '超时：请确认你确实在页面上手动发了一条推文（不是仅打开弹窗）' });
      }, timeoutMs);
      window.__sgSgOnCapture(function (rec) {
        if (done || !matchRec(rec)) return;
        done = true;
        clearTimeout(timer);
        // 等响应状态回来
        setTimeout(function () { resolve(summarize(rec)); }, 600);
      });
    });
  };

  /**
   * CreateTweet 写接口零副作用探针。
   * 前置：先手动发过一条真实推文（观察器已捕获真实 CreateTweet 模板）。
   * 做法：深拷贝真实 body，把推文文本改成空字符串（服务端业务层必拒，不会产生推文），
   * A 路 = 原生 fetch 全头（含捕获的 txid）
   * B 路 = window.fetch 去掉 txid
   * 若返回业务错误 JSON（如 code 186/354/326）而非 403 空响应，
   * 说明请求穿过了反自动化层 → 写接口不强制 txid，CreateTweet 可直发。
   */
  window.__sgProbeCreateTweet = async function () {
    var store = window.__sgCapturedGraphQL || [];
    var tpl = null;
    for (var i = 0; i < store.length; i++) {
      if (store[i].origin === 'x' && store[i].op === 'CreateTweet' && store[i].bodyObj) { tpl = store[i]; break; }
    }
    if (!tpl) {
      return {
        ok: false,
        reason: 'no_createtweet_template',
        hint: '先运行 await __sgWaitForOp("CreateTweet")，然后在页面手动发一条真实推文完成捕获'
      };
    }

    function cloneBodyWithEmptyText() {
      var b = JSON.parse(JSON.stringify(tpl.bodyObj));
      function walk(node) {
        if (!node || typeof node !== 'object') return false;
        if (Object.prototype.hasOwnProperty.call(node, 'tweet_text')) {
          node.tweet_text = '';
          return true;
        }
        if (Object.prototype.hasOwnProperty.call(node, 'text') && typeof node.text === 'string') {
          node.text = '';
          return true;
        }
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length; k++) {
          if (walk(node[keys[k]])) return true;
        }
        return false;
      }
      var replaced = walk(b.variables || b);
      return { json: JSON.stringify(b), replaced: replaced };
    }

    var made = cloneBodyWithEmptyText();
    var emptyBody = made.json;
    var out = {
      templateQid: tpl.qid,
      templateStatus: tpl.status,
      templateAgeSec: Math.round((Date.now() - new Date(tpl.t).getTime()) / 1000),
      templateHadTxid: !!(tpl.reqHeaders['x-client-transaction-id'] || ''),
      textFieldReplaced: made.replaced,
      pathA_nativeFullHeaders: null,
      pathB_windowFetchNoTxid: null,
      verdict: ''
    };

    function classify(status, text) {
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (e) {}
      var bizErr = null;
      if (parsed && parsed.errors && parsed.errors[0]) {
        bizErr = { code: parsed.errors[0].code, message: parsed.errors[0].message };
      }
      if (status === 403 && !parsed) return { kind: 'blocked_403_empty', detail: '反自动化层拦截（空 403）' };
      if (status === 401) return { kind: 'blocked_401', detail: '鉴权失败' };
      if (status === 429) return { kind: 'rate_limited', detail: '限频' };
      if (bizErr) return { kind: 'business_error', detail: bizErr };
      if (status >= 200 && status < 300) return { kind: 'unexpected_2xx', detail: '居然成功了？检查是否误发推文' };
      return { kind: 'http_' + status, detail: text.slice(0, 200) };
    }

    async function oneRound(useNative, stripTxid, tag) {
      var headers = {};
      Object.keys(tpl.reqHeaders).forEach(function (k) {
        if (stripTxid && k === 'x-client-transaction-id') return;
        if (k.indexOf(':') !== -1) return;
        headers[k] = tpl.reqHeaders[k];
      });
      // content-length 由浏览器自动重算；accept-encoding/host/cookie 等禁改头浏览器自动丢弃
      var t0 = Date.now();
      try {
        if (!useNative) window.__sgSgDepthEnter();
        var r = await (useNative ? window.__sgNativeFetch : window.fetch)(tpl.url, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: emptyBody
        });
        if (!useNative) window.__sgSgDepthExit();
        var txt = await r.text();
        return { status: r.status, ms: Date.now() - t0, classification: classify(r.status, txt), bodyHead: txt.slice(0, 300) };
      } catch (e) {
        if (!useNative) window.__sgSgDepthExit();
        return { error: String(e && e.message || e) };
      }
    }

    // A 路先跑（旧 txid，可能因时效失败）
    out.pathA_nativeFullHeaders = await oneRound(true, false, 'A');
    // 间隔 800ms 避免瞬时重复请求触发限频
    await new Promise(function (res) { setTimeout(res, 800); });
    out.pathB_windowFetchNoTxid = await oneRound(false, true, 'B');

    var a = out.pathA_nativeFullHeaders;
    var b = out.pathB_windowFetchNoTxid;
    var aBiz = a && a.classification && a.classification.kind === 'business_error';
    var bBiz = b && b.classification && b.classification.kind === 'business_error';
    var aBlocked = a && a.classification && /blocked/.test(a.classification.kind);
    var bBlocked = b && b.classification && /blocked/.test(b.classification.kind);

    if (bBiz) {
      out.verdict = '【写接口不强制 txid】B 路无 txid 到达业务层并被业务规则拒绝（' +
        (b.classification.detail && b.classification.detail.message) +
        '）。CreateTweet 可直接用 window.fetch 直发，无需签名算法/模板重放。';
      out.ok = true;
    } else if (aBiz && bBlocked) {
      out.verdict = '【写接口强制 txid】只有带有效 txid 才能穿过。路线：捕获真实模板→秒级改 body 重放（注意时效），或 hook X 内部请求函数。';
      out.ok = false;
    } else if (aBlocked && bBlocked) {
      out.verdict = '【两路都被拦】模板 txid 可能已过期（templateAgeSec=' + out.templateAgeSec +
        '）。请重新手动发一条推文后立刻（10 秒内）再跑本探针。';
      out.ok = false;
    } else {
      out.verdict = '【结果混合】查看 A/B 两路 classification 进一步判断。';
      out.ok = bBiz || aBiz;
    }
    console.log('[__sgProbeCreateTweet]', out);
    return out;
  };

  installBridgeApis();
  if (oneTimeReady) return;

  window.__sgDiagBridgeOneTime = true;
  window.__sgDiagInstalled = true;

  // ─────────────────────────────────────────────────────────────
  // GraphQL 链式观察器（document_start 先于 X main.js 安装）
  // 我们只做透传记录；X 之后若再包装 fetch，它的包装层在我们外层，
  // 于是它补的 txid 等最终头会流经本观察器，可被完整记录。
  // ─────────────────────────────────────────────────────────────
  (function installSgGraphQLObserver() {
    if (window.__sgGraphQLObserverInstalled) return;
    window.__sgGraphQLObserverInstalled = true;

    var store = window.__sgCapturedGraphQL = window.__sgCapturedGraphQL || [];
    var MAX_RECORDS = 80;
    var MAX_BODY_FULL = 30000;
    var sgDepth = 0;
    var captureListeners = [];
    window.__sgSgDepthEnter = function () { sgDepth++; };
    window.__sgSgDepthExit = function () { sgDepth = Math.max(0, sgDepth - 1); };
    window.__sgSgOnCapture = function (fn) {
      if (typeof fn === 'function') captureListeners.push(fn);
    };
    function tryParseJson(s) {
      try { return JSON.parse(s); } catch (e) { return null; }
    }

    function isGraphQLUrl(u) {
      return typeof u === 'string' && u.indexOf('/i/api/graphql/') !== -1;
    }
    function opFromUrl(u) {
      var m = String(u).match(/\/i\/api\/graphql\/(?:[^/?]+)\/([A-Za-z0-9_]+)/);
      return m ? m[1] : '';
    }
    function qidFromUrl(u) {
      var m = String(u).match(/\/i\/api\/graphql\/([A-Za-z0-9_-]+)\//);
      return m ? m[1] : '';
    }
    function absUrl(u) {
      try { return new URL(u, location.href).href; } catch (e) { return String(u); }
    }
    function headersToObj(h) {
      var o = {};
      if (!h) return o;
      try {
        if (typeof h.forEach === 'function' && (h instanceof Headers || (typeof Headers !== 'undefined' && h.constructor && h.constructor.name === 'Headers'))) {
          h.forEach(function (v, k) { o[String(k).toLowerCase()] = v; });
        } else if (Array.isArray(h)) {
          h.forEach(function (pair) { if (pair && pair[0]) o[String(pair[0]).toLowerCase()] = pair[1]; });
        } else if (typeof h === 'object') {
          Object.keys(h).forEach(function (k) { o[String(k).toLowerCase()] = h[k]; });
        }
      } catch (e) { o.__headerParseError = String(e); }
      return o;
    }
    function pushRecord(rec) {
      store.unshift(rec);
      if (store.length > MAX_RECORDS) store.length = MAX_RECORDS;
      for (var i = 0; i < captureListeners.length; i++) {
        try { captureListeners[i](rec); } catch (e) {}
      }
    }
    function attachRespInfo(rec, resp) {
      try {
        rec.status = resp.status;
        rec.respTxid = resp.headers.get('x-client-transaction-id');
        rec.respRateRemaining = resp.headers.get('x-rate-limit-remaining');
      } catch (e) {}
    }

    // ── 自动播种：X 前端自己成功发出一条真实推文后，持久化 CreateTweet 模板 ──
    // 存 qid / features / variables 骨架（清空文本与媒体）/ Bearer。
    // 之后插件纯文本转帖直接复用该模板直发；qid 轮换导致 403/404 时由 RPC 侧自动清种子回退 UI。
    var SEED_KEY = 'sg_x_createtweet_seed_v1';
    function maybeSeed(rec) {
      if (rec.op !== 'CreateTweet' || rec.origin !== 'x' || rec.method !== 'POST') return;
      if (rec.status !== 200 || !rec.bodyObj || !rec.bodyObj.variables) return;
      try {
        var v = JSON.parse(JSON.stringify(rec.bodyObj.variables));
        v.tweet_text = '';
        if (v.media) v.media = { media_entities: [], possibly_sensitive: false };
        if (Array.isArray(v.semantic_annotation_ids)) v.semantic_annotation_ids = [];
        var seed = {
          v: 1,
          qid: rec.qid,
          features: rec.bodyObj.features || {},
          authz: rec.reqHeaders['authorization'] || '',
          varBase: v,
          at: Date.now()
        };
        localStorage.setItem(SEED_KEY, JSON.stringify(seed));
        window.__sgCreateTweetSeedAt = seed.at;
      } catch (e) {}
    }
    function readSeed() {
      try { return JSON.parse(localStorage.getItem(SEED_KEY) || 'null'); } catch (e) { return null; }
    }
    function getCt0() {
      var m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
      return m ? m[1] : '';
    }

    // ── 隔离世界 → 主世界 RPC：createTweet / seedStatus / clearSeed ──
    async function handleXApi(req) {
      var action = req.action;
      if (action === 'seedStatus') {
        var sNow = readSeed();
        return sNow
          ? { ok: true, seeded: true, ageSec: Math.round((Date.now() - sNow.at) / 1000), qid: sNow.qid, featureCount: Object.keys(sNow.features || {}).length }
          : { ok: true, seeded: false };
      }
      if (action === 'clearSeed') {
        try { localStorage.removeItem(SEED_KEY); } catch (e) {}
        return { ok: true, cleared: true };
      }
      if (action !== 'createTweet') return { ok: false, reason: 'unknown_action' };

      var payload = req.payload || {};
      var text = String(payload.text || '');
      var seed = readSeed();
      if (!seed || !seed.qid || !seed.authz || !seed.varBase) return { ok: false, reason: 'need_seed' };
      if (payload.maxAgeMs && Date.now() - seed.at > payload.maxAgeMs) return { ok: false, reason: 'seed_expired' };
      var ct0 = getCt0();
      if (!ct0) return { ok: false, reason: 'no_ct0' };

      var variables;
      try {
        variables = JSON.parse(JSON.stringify(seed.varBase));
        variables.tweet_text = text;
      } catch (e) {
        return { ok: false, reason: 'seed_corrupt' };
      }
      var body = JSON.stringify({ variables: variables, features: seed.features, queryId: seed.qid });
      var url = 'https://x.com/i/api/graphql/' + seed.qid + '/CreateTweet';
      var t0 = Date.now();
      var resp;
      try {
        // 不带 txid（实测写接口不强制）；凭证/cookie 浏览器自动带
        resp = await nativeFetchRef(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'authorization': seed.authz,
            'x-twitter-auth-type': 'OAuth2Session',
            'x-csrf-token': ct0,
            'x-twitter-client-language': (navigator.language || 'zh-CN').toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en',
            'x-twitter-active-user': 'yes'
          },
          body: body
        });
      } catch (e) {
        return { ok: false, reason: 'network', error: String(e && e.message || e) };
      }
      var txt = '';
      try { txt = await resp.text(); } catch (e) {}
      var parsed = null;
      try { parsed = JSON.parse(txt); } catch (e) {}

      // qid/features 失效：清种子，让引擎回退 UI 重新播种
      if (resp.status === 403 || resp.status === 404) {
        try { localStorage.removeItem(SEED_KEY); } catch (e) {}
        return { ok: false, reason: 'seed_invalid', status: resp.status, bodyHead: txt.slice(0, 160) };
      }
      if (resp.status === 429) return { ok: false, reason: 'rate_limited', status: 429 };
      if (resp.status === 401) return { ok: false, reason: 'auth_401', status: 401 };

      if (parsed && parsed.errors && parsed.errors.length) {
        var e0 = parsed.errors[0] || {};
        var code = e0.code || 0;
        var msg = String(e0.message || '');
        var spam = code === 326 ||
          /automat|spam|malicious|自动|垃圾|恶意|稍后再试|try again later/i.test(msg);
        if (code === 344) return { ok: false, reason: 'daily_limit', code: code, message: msg.slice(0, 200), antispam: spam, status: resp.status };
        return { ok: false, reason: 'business', code: code, message: msg.slice(0, 200), antispam: spam, status: resp.status };
      }
      if (resp.status >= 200 && resp.status < 300 && parsed && parsed.data) {
        var restId = '';
        try {
          var result = parsed.data.create_tweet &&
            parsed.data.create_tweet.tweet_results &&
            parsed.data.create_tweet.tweet_results.result;
          restId = (result && (result.rest_id || (result.tweet && result.tweet.rest_id))) || '';
        } catch (e) {}
        return { ok: true, restId: restId, ms: Date.now() - t0 };
      }
      return { ok: false, reason: 'unexpected', status: resp.status, bodyHead: txt.slice(0, 200) };
    }
    // nativeFetch 在 fetch patch 段创建；用引用容器保证 RPC 调用时一定可用
    var nativeFetchRef = null;

    window.addEventListener('message', function (ev) {
      if (ev.source !== window || !ev.data || ev.data.type !== '__sg_xapi_request') return;
      var req = ev.data;
      Promise.resolve().then(function () { return handleXApi(req); }).then(function (value) {
        window.postMessage({ type: '__sg_xapi_response', id: req.id, value: value }, '*');
      }).catch(function (err) {
        window.postMessage({ type: '__sg_xapi_response', id: req.id, value: { ok: false, reason: 'rpc_exception', error: String(err && err.message || err) } }, '*');
      });
    });
    window.__sgXApiDebug = {
      readSeed: readSeed,
      seedKey: SEED_KEY,
      // 干跑：查看最近一条 X 自己的 CreateTweet 是否满足播种条件（不写 localStorage）
      dryRunSeed: function () {
        var recs = (window.__sgCapturedGraphQL || []).filter(function (r) {
          return r.op === 'CreateTweet' && r.origin === 'x';
        });
        var rec = recs[0];
        if (!rec) return { found: false, hint: '本页面加载后还没捕获到 X 自己发的 CreateTweet' };
        return {
          found: true,
          ageSec: Math.round((Date.now() - new Date(rec.t).getTime()) / 1000),
          via: rec.via,
          method: rec.method,
          status: rec.status,
          qid: rec.qid,
          hasBodyObj: !!rec.bodyObj,
          hasVariables: !!(rec.bodyObj && rec.bodyObj.variables),
          hasFeatures: !!(rec.bodyObj && rec.bodyObj.features),
          featureCount: rec.bodyObj && rec.bodyObj.features ? Object.keys(rec.bodyObj.features).length : 0,
          hasAuthz: !!rec.reqHeaders['authorization'],
          wouldSeed: rec.status === 200 && !!rec.bodyObj && !!rec.bodyObj.variables
        };
      },
      // 手动强制播种（诊断用：从最近捕获的记录写种子）
      forceSeed: function () {
        var rec = (window.__sgCapturedGraphQL || []).filter(function (r) {
          return r.op === 'CreateTweet' && r.origin === 'x' && r.status === 200 && r.bodyObj && r.bodyObj.variables;
        })[0];
        if (!rec) return { ok: false, reason: 'no_usable_record' };
        maybeSeed(rec);
        return { ok: !!readSeed() };
      }
    };

    // ── fetch 链式 patch ──
    if (window.fetch) {
      var nativeFetch = window.fetch.bind(window);
      nativeFetchRef = nativeFetch;
      window.__sgNativeFetch = nativeFetch;
      window.fetch = function (input, init) {
        var url = '';
        var method = 'GET';
        var hObj = {};
        var bodyPreview = '';
        var bodyFull = '';
        try {
          if (typeof input === 'string') {
            url = input;
          } else if (input) {
            url = input.url || '';
            method = input.method || 'GET';
            if (input.headers) hObj = headersToObj(input.headers);
          }
          if (init) {
            if (init.method) method = init.method;
            if (init.headers) {
              var ho2 = headersToObj(init.headers);
              Object.keys(ho2).forEach(function (k) { hObj[k] = ho2[k]; });
            }
            if (typeof init.body === 'string') {
              bodyPreview = init.body.slice(0, 400);
              bodyFull = init.body.slice(0, MAX_BODY_FULL);
            }
          }
        } catch (e) {}

        var wantRecord = isGraphQLUrl(url);
        var rec = null;
        if (wantRecord) {
          rec = {
            t: new Date().toISOString(),
            via: 'fetch',
            origin: sgDepth > 0 ? 'sg' : 'x',
            op: opFromUrl(url),
            qid: qidFromUrl(url),
            method: String(method).toUpperCase(),
            url: absUrl(url),
            reqHeaders: hObj,
            reqBody: bodyPreview,
            bodyFull: bodyFull || '',
            bodyObj: bodyFull ? tryParseJson(bodyFull) : null,
            status: 0,
            respTxid: null,
            respRateRemaining: null
          };
          pushRecord(rec);
        }

        var p = nativeFetch(input, init);
        if (rec) {
          p.then(function (resp) { attachRespInfo(rec, resp); maybeSeed(rec); }, function () { rec.status = -1; });
        }
        return p;
      };
    }

    // ── XMLHttpRequest 链式 patch（X 少数接口仍可能用 XHR）──
    try {
      var XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (XHRProto && XHRProto.open) {
        var origOpen = XHRProto.open;
        var origSetHeader = XHRProto.setRequestHeader;
        var origSend = XHRProto.send;
        XHRProto.open = function (method, url) {
          this.__sgXhr = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), headers: {} };
          return origOpen.apply(this, arguments);
        };
        XHRProto.setRequestHeader = function (k, v) {
          try {
            if (this.__sgXhr) this.__sgXhr.headers[String(k).toLowerCase()] = v;
          } catch (e) {}
          return origSetHeader.apply(this, arguments);
        };
        XHRProto.send = function (body) {
          var meta = this.__sgXhr;
          if (meta && isGraphQLUrl(meta.url)) {
            var bodyStr = typeof body === 'string' ? body : '';
            var rec = {
              t: new Date().toISOString(),
              via: 'xhr',
              origin: sgDepth > 0 ? 'sg' : 'x',
              op: opFromUrl(meta.url),
              qid: qidFromUrl(meta.url),
              method: meta.method,
              url: absUrl(meta.url),
              reqHeaders: meta.headers,
              reqBody: bodyStr.slice(0, 400),
              bodyFull: bodyStr.slice(0, MAX_BODY_FULL),
              bodyObj: bodyStr ? tryParseJson(bodyStr) : null,
              status: 0,
              respTxid: null,
              respRateRemaining: null
            };
            pushRecord(rec);
            this.addEventListener('loadend', function () {
              try {
                rec.status = this.status;
                rec.respTxid = this.getResponseHeader('x-client-transaction-id');
                rec.respRateRemaining = this.getResponseHeader('x-rate-limit-remaining');
              } catch (e) {}
              maybeSeed(rec);
            });
          }
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) {}
  })();

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
    }, 200);
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
