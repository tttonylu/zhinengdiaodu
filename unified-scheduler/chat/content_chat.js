// X-Matrix-Bot 插件版 - 私信聊天 (V3.7.29 — 仅年龄分流/inbox_done可覆盖)
(function() {

    function safeAppendToHead(el) {
        if (!document.head) {
            setTimeout(() => safeAppendToHead(el), 100);
            return;
        }
        if (el && !document.getElementById(el.id)) document.head.appendChild(el);
    }

    'use strict';

    var REPLY_TRACE_PENDING_KEY = 'sg_reply_trace_pending';
    var REPLY_TRACE_RESULT_KEY = 'sg_reply_trace_result';

    // ==============================================================================
    // 【全局配置与存储引擎】
    // ==============================================================================
    // NAS地址已从config.js统一管理，此处不再硬编码


    // ================= 【诊断日志】 =================
    console.log('[诊断-注入] content_chat.js V3.7.29 已加载');
    localStorage.setItem('dan_chat_ready', 'true');
    sessionStorage.setItem('dan_tab_role', 'chat');
    restoreReplyStateFromStash();
    try { repairMissingIceSentAtInDb(); } catch (eIceRepair) {}
    setTimeout(function () { try { repairMissingIceSentAtInDb(); } catch (e2) {} }, 1500);

    function summarizeReplyTrace(trace) {
        if (!trace) return null;
        return {
            stuckAt: trace.stuckAt || '',
            verdict: trace.verdict || '',
            inboxListVisible: !!trace.inboxListVisible,
            onConversation: !!trace.onConversation,
            chain: trace.chain || []
        };
    }

    function appendOpsStepToTrace(trace, ops) {
        if (!trace) return trace;
        if (!trace.chain) trace.chain = [];
        var checked = ops != null;
        var allowed = checked && !!ops.allowed;
        var reason = (ops && ops.reason) || (checked ? '' : 'ops_unreachable');
        trace.ops = {
            checked: checked,
            allowed: allowed,
            reason: reason,
            current_round: ops && ops.current_round
        };
        trace.chain.push({
            step: 'ops',
            label: 'OPS 发送许可',
            ok: allowed,
            na: !checked,
            reason: allowed ? '' : (reason || 'OPS 未放行'),
            detail: checked ? ('allowed=' + allowed + ' round=' + (ops.current_round != null ? ops.current_round : '?')) : 'OPS 不可达',
            suggest: allowed ? '' : '检查 OPS 连接、日限额、fleet 封锁；本地 gate 通过不代表 OPS 放行'
        });
        if (!allowed && !trace.stuckAt) {
            trace.stuckAt = 'ops';
            trace.verdict = '卡在「OPS 发送许可」' + (reason ? ' — ' + reason : '');
        }
        return trace;
    }

    function saveReplyTracePending(payload) {
        try {
            sessionStorage.setItem(REPLY_TRACE_PENDING_KEY, JSON.stringify(payload || {}));
        } catch (e) {}
    }

    function loadReplyTracePending() {
        try {
            var raw = sessionStorage.getItem(REPLY_TRACE_PENDING_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function clearReplyTracePending() {
        try { sessionStorage.removeItem(REPLY_TRACE_PENDING_KEY); } catch (e) {}
    }

    function storeReplyTraceResult(result) {
        try {
            sessionStorage.setItem(REPLY_TRACE_RESULT_KEY, JSON.stringify(result || {}));
            window.__sgReplyTraceResult = result;
        } catch (e) {}
    }

    function debugNavigateForTrace(url) {
        if (!url) return false;
        try {
            var fullUrl = url.indexOf('http') === 0 ? url : ('https://x.com' + (url.indexOf('/') === 0 ? url : '/' + url));
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.prepareLeave) SchedulerGate.prepareLeave();
            window.location.replace(fullUrl);
            return true;
        } catch (e) { return false; }
    }

    function resumeReplyTraceIfPending() {
        var pending = loadReplyTracePending();
        if (!pending || !pending.handle || !pending.resumeAfterNav) return;
        setTimeout(function () {
            try {
                var bridge = window.__sgChatBridge || {};
                if (typeof bridge._continueReplyTraceAsync !== 'function') return;
                bridge._continueReplyTraceAsync(pending);
            } catch (eResume) {
                console.warn('[回复链路-async] 恢复失败', eResume);
                clearReplyTracePending();
            }
        }, pending.waitMs || 3500);
    }

    resumeReplyTraceIfPending();

    function chatGo(url, replace) {
        // 4.1.21：守箱废除 — 插件永不进入 CHAT（/i/chat|/messages）
        try {
            var u = String(url || '');
            if (/(?:i\/chat|messages)(?:\/|$|\?|#)/i.test(u)) {
                console.warn('[chatGo] 拦截：守箱已废除，禁止进入 CHAT → ' + u);
                return false;
            }
        } catch (eBanGo) {}
        var ok = false;
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) {
            ok = !!SchedulerGate.go('chat', url, { replace: !!replace });
        } else if (typeof SchedulerGate !== 'undefined' && SchedulerGate.goRaw) {
            ok = !!SchedulerGate.goRaw(url, { replace: !!replace, force: true });
        } else {
            try {
                if (replace) window.location.replace(url);
                else window.location.href = url;
                ok = true;
            } catch (e) { ok = false; }
        }
        // settle 由 Gate executeHref / queueNav 写入，勿在排队受理时提前写（旧页误等）
        return ok;
    }

    /** 粉丝列表白壳（URL 到了但无 UserCell/空态） */
    function pageLooksChatFollowersShell() {
        try {
            var path = String(window.location.pathname || '').toLowerCase();
            if (!/\/followers|\/verified_followers|\/followers_you_follow/.test(path)) return false;
            if (document.querySelector('[data-testid="UserCell"]')) return false;
            var empty = document.querySelector('[data-testid="emptyState"], [data-testid="emptyStateHeader"]');
            if (empty) {
                var et = String(empty.textContent || '');
                if (/关注者|followers|フォロワー/i.test(et)) return false;
            }
            return true;
        } catch (eSh) { return false; }
    }

    /** 三引擎共用软愈冷却（与 follow 同 key） */
    function requestSharedSoftHealChat(reason) {
        var CD = 60000;
        try {
            var last = parseInt(sessionStorage.getItem('sg_shared_soft_heal_at') || '0', 10) || 0;
            if (last > 0 && Date.now() - last < CD) {
                console.log('[私信] 共用软愈冷却中 (' + (reason || '') + ')');
                return false;
            }
        } catch (eCd) {}
        try {
            var main = document.querySelector('main') || document.body;
            if (main) {
                var btns = main.querySelectorAll('[role="button"]');
                for (var i = 0; i < btns.length; i++) {
                    var tx = String(btns[i].textContent || '');
                    if (/重试|重新加载|Retry|Reload|Try again/i.test(tx)) {
                        try { btns[i].click(); } catch (eClk) {}
                        try { sessionStorage.setItem('sg_shared_soft_heal_at', String(Date.now())); } catch (eS1) {}
                        console.log('[私信] 未灌水·点重试 (' + (reason || '') + ')');
                        return true;
                    }
                }
            }
        } catch (eBtn) {}
        try { sessionStorage.setItem('sg_shared_soft_heal_at', String(Date.now())); } catch (eS2) {}
        try {
            var pausedTill = 0;
            try { pausedTill = parseInt(sessionStorage.getItem('sg_paused_till') || '0', 10) || 0; } catch (eP) {}
            chrome.runtime.sendMessage({
                action: 'sg_request_heal',
                reason: reason || 'chat_shell',
                mode: 'soft_reload',
                pausedTill: pausedTill,
                challenge: false
            }, function () {});
            console.log('[私信] 未灌水·soft_reload (' + (reason || '') + ')');
        } catch (eHeal) {}
        return true;
    }

    console.log('[诊断-环境] chrome 对象:', typeof chrome);
    console.log('[诊断-环境] chrome.runtime:', typeof chrome !== 'undefined' ? typeof chrome.runtime : 'N/A');
    console.log('[诊断-环境] chrome.runtime.sendMessage:', typeof chrome !== 'undefined' && chrome.runtime ? typeof chrome.runtime.sendMessage : 'N/A');

    // 【V11.9.0】清除旧的 sessionStorage 缓存，强制使用 #guard 格式
    (function cleanupOldStorage() {
        const oldWorkerId = sessionStorage.getItem('dan_worker_id');
        if (oldWorkerId && !oldWorkerId.endsWith('#guard')) {
            console.log('[V11.9.0] 清除旧 worker_id:', oldWorkerId);
            sessionStorage.removeItem('dan_worker_id');
        }
        const oldWindowShortId = sessionStorage.getItem('dan_window_short_id');
        if (oldWindowShortId) {
            sessionStorage.removeItem('dan_window_short_id');
        }
        const oldInstanceId = sessionStorage.getItem('dan_instance_id');
        if (oldInstanceId) {
            sessionStorage.removeItem('dan_instance_id');
        }
    })();

    const GM_getValue = (key, def) => { let val = localStorage.getItem(key); return val !== null ? val : (def !== undefined ? def : null); };
    const GM_setValue = (key, val) => { localStorage.setItem(key, val); };

    // ================= 【V11.5.7 定时器与DOM管理 — 防止内存泄漏】 =================
    window._matrixTimers = [];
    window._matrixDOMs = [];
    
    function safeSetInterval(fn, delay) {
        const id = setInterval(fn, delay);
        window._matrixTimers.push(id);
        return id;
    }
    
    function safeCreateElement(tag, id) {
        const el = document.createElement(tag);
        if (id) el.id = id;
        window._matrixDOMs.push(el);
        return el;
    }
    
    function clearAllTimers() {
        window._matrixTimers.forEach(id => clearInterval(id));
        window._matrixTimers = [];
    }
    
    function cleanupInjectedDOM() {
        window._matrixDOMs.forEach(el => {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
        window._matrixDOMs = [];
    }
    
    // 页面跳转前清理所有资源
    window.addEventListener('beforeunload', () => {
        clearAllTimers();
        cleanupInjectedDOM();
    });

    function updateLocalStats(actionType) {
        // 兼容旧数据：把旧的 ignored 迁移到 corpse
        let raw = GM_getValue('dan_local_stats', '');
        let stats;
        if (raw) {
            stats = JSON.parse(raw);
            if (stats.ignored !== undefined && stats.corpse === undefined) {
                stats.corpse = stats.ignored;
                stats.reject = 0; stats.competitor = 0; stats.link_sender = 0;
                delete stats.ignored;
            }
        } else {
            stats = {ice:0, ad:0, corpse:0, reject:0, start_time:0};
        }
        if (stats.start_time === 0) stats.start_time = Date.now();
        if (actionType === 'ICEBREAKER') stats.ice++;
        if (actionType === 'AD') stats.ad++;
        if (actionType === 'IGNORED' || actionType === 'CORPSE') stats.corpse++;
        if (actionType === 'REJECT') stats.reject++;
    if (actionType === 'SKIP_COMPETITOR') stats.competitor++;
    if (actionType === 'SKIP_LINK_SENDER') stats.link_sender++;
        GM_setValue('dan_local_stats', JSON.stringify(stats));
        renderStats();
    }

    function renderStats() {
        let raw = GM_getValue('dan_local_stats', '');
        let stats = raw ? JSON.parse(raw) : {ice:0, ad:0, corpse:0, reject:0, start_time:0};
        // 兼容旧数据
        if (stats.ignored !== undefined && stats.corpse === undefined) {
            stats.corpse = stats.ignored; stats.reject = 0;
        }
        let days = stats.start_time > 0 ? Math.max(1, Math.ceil((Date.now() - stats.start_time) / (1000 * 60 * 60 * 24))) : 1;
        let poolStats = document.getElementById('matrix-pool-stats');
        if (poolStats) poolStats.innerText = `运行第${days}天 | 破冰:${stats.ice||0} | 广告:${stats.ad||0} | 尸体:${stats.corpse||0} | 拉黑:${stats.reject||0} 同行:${stats.competitor||0} 链接:${stats.link_sender||0}`;
    }

    // 【V11.9.0】统一使用 @handle#guard 格式；禁止随机假号（曾污染 OPS 账号中心）
    function getWorkerId() {
        let workerId = sessionStorage.getItem('dan_worker_id');
        if (workerId && (workerId.includes('null') || workerId.includes('undefined'))) {
            workerId = null;
        }
        // 已缓存的随机五位数 / 路径幽灵号一律作废
        if (workerId) {
            try {
                var cached = String(workerId).replace(/^@/, '').split('#')[0].toLowerCase();
                if (/^\d{4,5}$/.test(cached) || /^(account|home|explore|settings|i|unknown)$/i.test(cached)) {
                    workerId = null;
                    try { sessionStorage.removeItem('dan_worker_id'); } catch (eClr) {}
                }
            } catch (eChk) {}
        }
        if (!workerId) {
            let myHandleEl = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
            let myHandle = (myHandleEl && myHandleEl.href) ? myHandleEl.href.split('/').pop() : null;
            if (myHandle) myHandle = String(myHandle).toLowerCase().replace(/[^a-z0-9_]/g, '');
            if (!myHandle || /^\d{4,5}$/.test(myHandle) || /^(account|home|explore|settings|i|null|undefined)$/.test(myHandle)) {
                try {
                    var mh = localStorage.getItem('matrix_my_handle') || '';
                    myHandle = String(mh).replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
                } catch (eMh) { myHandle = ''; }
            }
            if (!myHandle || myHandle === 'unknown' || /^\d{4,5}$/.test(myHandle)) {
                // 宁可不报，也不要造假号污染 OPS
                return '';
            }
            workerId = '@' + myHandle + '#guard';
            sessionStorage.setItem('dan_worker_id', workerId);
        }
        return workerId;
    }

    // ================= 【战报本地队列缓存】 =================
    const PENDING_QUEUE_KEY = 'dan_pending_reports';
    
    function queueReport(payload) {
        try {
            let queue = JSON.parse(localStorage.getItem(PENDING_QUEUE_KEY) || '[]');
            queue.push({payload: payload, time: Date.now()});
            // 限制队列长度，防止无限增长
            if (queue.length > 100) {
                queue = queue.slice(-100);
            }
            localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(queue));
            console.log('[战报] 已加入待发送队列，当前队列长度:', queue.length);
        } catch(e) {
            console.error('[战报] 加入队列失败:', e);
        }
    }
    
    async function flushPendingReports() {
        try {
            let queue = JSON.parse(localStorage.getItem(PENDING_QUEUE_KEY) || '[]');
            if (queue.length === 0) return;
            
            console.log('[战报] 开始批量补发队列，长度:', queue.length);
            let failedItems = [];
            let successCount = 0;
            
            for (let item of queue) {
                try {
                    await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            action: "log_action",
                            payload: item.payload
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message));
                            } else if (!response || response.status !== "success") {
                                reject(new Error('上报失败'));
                            } else {
                                resolve(response);
                            }
                        });
                    });
                    successCount++;
                } catch(e) {
                    failedItems.push(item);
                }
            }
            
            localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(failedItems));
            console.log('[战报] 批量补发完成，成功:', successCount, '剩余:', failedItems.length);
        } catch(e) {
            console.error('[战报] 批量补发异常:', e);
        }
    }

    // 战报上报格式对接 V11.4 后端大屏（通过 background.js 避免 Mixed Content）
    function sendLogToNAS(targetHandle, actionType, detailMsg = '', message = '') {
        console.log('[战报-DEBUG] sendLogToNAS 被调用:', actionType, 'target=', targetHandle);
        updateLocalStats(actionType);
        let botId = getWorkerId();
        let payload = {
            bot_id: botId,
            target: targetHandle,
            action_type: actionType,
            detail: detailMsg,
            message: message
        };
        
        function trySend(attemptsLeft) {
            console.log('[战报-DEBUG] trySend 开始，剩余重试:', attemptsLeft);
            try {
                chrome.runtime.sendMessage({
                    action: "log_action",
                    payload: payload
                }, (response) => {
                    console.log('[战报-DEBUG] sendMessage callback 被调用');
                    if (chrome.runtime.lastError) {
                        console.log('[战报] Service Worker 未就绪，加入队列');
                        queueReport(payload);
                        return;
                    }
                    if (!response || response.status !== "success") {
                        console.warn('[战报] 上报失败:', response);
                        if (attemptsLeft > 0) {
                            setTimeout(() => trySend(attemptsLeft - 1), 2000);
                        } else {
                            queueReport(payload);
                        }
                    } else {
                        console.log('[战报] 上报成功:', actionType);
                    }
                });
                console.log('[战报-DEBUG] sendMessage 已发送');
            } catch(e) {
                console.error('[战报] 发送异常:', e);
                if (attemptsLeft > 0) {
                    setTimeout(() => trySend(attemptsLeft - 1), 2000);
                } else {
                    queueReport(payload);
                }
            }
        }
        
        trySend(2); // 最多重试2次
    }

    // ==============================================================================
    // 【V15.1.0 推广链接引擎】— 号池服务器统一管理 + 本地 fallback
    // ==============================================================================
    function __promoLinksArr() {
        return (window.SgPromoLinks && window.SgPromoLinks.getCurrentLinks) ? window.SgPromoLinks.getCurrentLinks() : [];
    }
    function __setPromoLinksArr(links) {
        if (window.SgPromoLinks && window.SgPromoLinks.setCurrentLinks) window.SgPromoLinks.setCurrentLinks(links || []);
    }
    // 兼容旧引用：代理到 SgPromoLinks
    var current_live_links = {
        get length() { return __promoLinksArr().length; },
        join: function (sep) { return __promoLinksArr().join(sep); },
        slice: function () { return __promoLinksArr().slice(); },
        0: undefined
    };
    try {
        Object.defineProperty(current_live_links, '0', {
            get: function () { var a = __promoLinksArr(); return a[0]; }
        });
    } catch (eProxy) {}

    const MY_LINKS_KEY = 'dan_promo_links';
    const LINKS_SYNC_KEY = 'dan_links_last_sync';
    const LINK_SYNC_INTERVAL = 5 * 60 * 1000;
    const SCRIPTS_SYNC_INTERVAL = 30 * 60 * 1000;
    const SCRIPTS_SYNC_KEY = 'dan_scripts_last_sync';

    function getPoolServer() {
        if (typeof MatrixConfig !== 'undefined' && MatrixConfig.getPoolServer) {
            return MatrixConfig.getPoolServer();
        }
        return 'https://2m74bne4.kooldns.cn';
    }
    const POOL_SERVER = getPoolServer();

    function getDefaultLinks() {
        return (window.SgPromoLinks && window.SgPromoLinks.getDefaultLinks) ? window.SgPromoLinks.getDefaultLinks() : [];
    }
    async function fetchLinksFromServer() {
        if (window.SgPromoLinks && window.SgPromoLinks.fetchLinksFromServer) return window.SgPromoLinks.fetchLinksFromServer();
        return null;
    }
    // 保存链接到 localStorage + 服务器
    async function saveMyLinks(links, syncToServer) {
        if (window.SgPromoLinks && window.SgPromoLinks.saveMyLinks) return window.SgPromoLinks.saveMyLinks(links, syncToServer);
        return false;
    }
    // 启动时加载：服务器 → 本地 → 默认
    async function loadMyLinks() {
        if (window.SgPromoLinks && window.SgPromoLinks.loadMyLinks) return window.SgPromoLinks.loadMyLinks();
        return false;
    }
    // 定时从服务器同步链接
    function startLinkSync() {
        if (window.SgPromoLinks && window.SgPromoLinks.startLinkSync) window.SgPromoLinks.startLinkSync();
    }
    function updateLinksUI() {
        let linksInput = document.getElementById('matrix-links-input');
        let linkStatus = document.getElementById('matrix-link-status');
        if (linksInput) {
            linksInput.value = current_live_links.join('\n');
        }
        if (linkStatus) {
            if (current_live_links.length > 0) {
                linkStatus.innerHTML = `<span style="color:#00ba7c;">✅ 已加载 ${current_live_links.length} 个链接</span>`;
            } else {
                linkStatus.innerHTML = `<span style="color:#f91880;">⚠️ 未设置链接！请在上方输入后点保存</span>`;
            }
        }
    }

    async function fetchScriptsFromServer() {
        try {
            const data = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: "scripts_pool" }, (response) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(response);
                });
            });
            if (data && data.scripts && data.version) return data;
        } catch (e) {
            console.warn('[话术同步] 服务器不可达:', e.message);
        }
        return null;
    }

    function localScriptsHasSoftIce(cfg) {
        if (!cfg) return false;
        var ice = (cfg.templates && cfg.templates.icebreaker) || '';
        if (!ice && cfg.scripts && cfg.scripts.v1) ice = cfg.scripts.v1.icebreaker || '';
        return ice.indexOf('大人') >= 0 || ice.indexOf('おいくつ') >= 0;
    }

    function applyServerScripts(poolData) {
        if (!poolData || !poolData.scripts) return false;
        try {
            const raw = localStorage.getItem('dan_scripts');
            let existing = raw ? JSON.parse(raw) : {};
            if (!existing.scripts) existing.scripts = {};

            var localVer = String(existing.version || '0');
            var serverVer = String(poolData.version || '0');
            // 本地 JSON bootstrap 2.1+ 时，禁止 OPS 旧池回滚
            if (existing.imported_from_json && localVer >= '2.1' && serverVer < localVer) {
                console.log('[话术同步] 跳过：服务器 v' + serverVer + ' < 本地 v' + localVer);
                return false;
            }
            if (localScriptsHasSoftIce(existing) && !localScriptsHasSoftIce({ scripts: poolData.scripts, templates: poolData.templates })) {
                console.log('[话术同步] 跳过：本地已是大人余裕话术，服务器仍为旧版');
                return false;
            }

            Object.keys(poolData.scripts).forEach(function(k) {
                existing.scripts[k] = {
                    name: poolData.scripts[k].name || k,
                    icebreaker: poolData.scripts[k].icebreaker || '',
                    ad_template: poolData.scripts[k].ad_template || '',
                    kick_message: poolData.scripts[k].kick_message || '',
                    final_kick_message: poolData.scripts[k].final_kick_message || '',
                    reject_message: poolData.scripts[k].reject_message || '',
                    foreigner_reject: poolData.scripts[k].foreigner_reject || ''
                };
            });
            existing.random_pool = poolData.random_pool || Object.keys(existing.scripts);
            existing.mode = poolData.mode || 'random';
            existing.version = poolData.version || '2.1';
            existing.updated_at = Date.now();
            existing.source = 'server';

            localStorage.setItem('dan_scripts', JSON.stringify(existing));
            localStorage.setItem(SCRIPTS_SYNC_KEY, String(Date.now()));
            loadScripts();
            console.log('[话术同步] ✅ 已从服务器同步 ' + poolData.random_pool.length + ' 套话术');
            return true;
        } catch (e) {
            console.warn('[话术同步] 应用失败:', e);
            return false;
        }
    }

    async function syncScriptsFromServer(silent) {
        const poolData = await fetchScriptsFromServer();
        if (poolData) {
            applyServerScripts(poolData);
            if (!silent) showToast('✅ 话术已从服务器同步', '#00ba7c');
            return true;
        }
        if (!silent) showToast('⚠️ 话术服务器不可达', '#f0883e');
        return false;
    }

    function startScriptSync() {
        setInterval(async () => {
            const poolData = await fetchScriptsFromServer();
            if (poolData) applyServerScripts(poolData);
        }, SCRIPTS_SYNC_INTERVAL);
    }

    // 启动时加载（异步，但立即执行）
    try {
        if (window.SgPromoLinks) {
            window.SgPromoLinks.bind({
                getBotKey: getBotKey,
                onLinksUpdated: typeof updateLinksUI === 'function' ? updateLinksUI : null
            });
            window.SgPromoLinks.bootstrap();
        } else {
            loadMyLinks().then(function () { startLinkSync(); });
        }
    } catch (ePromoBoot) {}

    setTimeout(() => { syncScriptsFromServer(true); startScriptSync(); }, 3000);

    function getLiveLink() {
        return (window.SgPromoLinks && window.SgPromoLinks.getLiveLink) ? window.SgPromoLinks.getLiveLink() : null;
    }
    function reportNoPromoLink(reason) {
        if (window.SgPromoLinks && window.SgPromoLinks.reportNoPromoLink) window.SgPromoLinks.reportNoPromoLink(reason);
    }
 
    // ==================== 粉丝目标数据库（chat_target_db） ====================
    // 按 bot 隔离: { "botHandle": { "target": { round, firstSeen, lastDM, done } } }
    // 旧扁平结构启动时迁移到当前 bot 下
    var TARGET_DB_KEY = 'chat_target_db';
    var FALLBACK_BOT_KEY = '_unknown_bot';
    var FLEET_HANDLES_KEY = 'sg_fleet_handles';

    function normalizeChatHandle(h) {
        return (window.SgTargetDb && window.SgTargetDb.normalizeChatHandle)
            ? window.SgTargetDb.normalizeChatHandle(h) : String(h || '').replace(/^@/, '').toLowerCase().trim();
    }
    function getBotKey() {
        return (window.SgTargetDb && window.SgTargetDb.getBotKey) ? window.SgTargetDb.getBotKey() : '';
    }
    function loadRootTargetDB() {
        return (window.SgTargetDb && window.SgTargetDb.loadRootTargetDB) ? window.SgTargetDb.loadRootTargetDB() : {};
    }
    function isFlatTargetEntry(v) {
        return !!(window.SgTargetDb && window.SgTargetDb.isFlatTargetEntry && window.SgTargetDb.isFlatTargetEntry(v));
    }
    function migrateRootTargetDB(root) {
        return (window.SgTargetDb && window.SgTargetDb.migrateRootTargetDB) ? window.SgTargetDb.migrateRootTargetDB(root) : root;
    }
    function loadTargetDB() {
        return (window.SgTargetDb && window.SgTargetDb.loadTargetDB) ? window.SgTargetDb.loadTargetDB() : {};
    }
    function saveTargetDB(db) {
        if (window.SgTargetDb && window.SgTargetDb.saveTargetDB) window.SgTargetDb.saveTargetDB(db);
    }
    function getFleetHandleSet() {
        return (window.SgTargetDb && window.SgTargetDb.getFleetHandleSet) ? window.SgTargetDb.getFleetHandleSet() : new Set();
    }
    function saveFleetHandles(list) {
        if (window.SgTargetDb && window.SgTargetDb.saveFleetHandles) window.SgTargetDb.saveFleetHandles(list);
    }
    function isFleetHandle(handle) {
        return !!(window.SgTargetDb && window.SgTargetDb.isFleetHandle && window.SgTargetDb.isFleetHandle(handle));
    }
    function rejectFleetHandle(handle) {
        if (window.SgTargetDb && window.SgTargetDb.rejectFleetHandle) window.SgTargetDb.rejectFleetHandle(handle);
    }
    function getUserRound(userHandle) {
        return (window.SgTargetDb && window.SgTargetDb.getUserRound) ? window.SgTargetDb.getUserRound(userHandle) : 0;
    }
    function ensureIceEvidenceOnEntry(entry) {
        return !!(window.SgTargetDb && window.SgTargetDb.ensureIceEvidenceOnEntry && window.SgTargetDb.ensureIceEvidenceOnEntry(entry));
    }
    function setUserRound(userHandle, round) {
        if (window.SgTargetDb && window.SgTargetDb.setUserRound) window.SgTargetDb.setUserRound(userHandle, round);
    }
    function repairMissingIceSentAtInDb() {
        return (window.SgTargetDb && window.SgTargetDb.repairMissingIceSentAtInDb) ? window.SgTargetDb.repairMissingIceSentAtInDb() : 0;
    }
    function applyOpsMaxRound(userHandle, opsMax) {
        if (window.SgTargetDb && window.SgTargetDb.applyOpsMaxRound) window.SgTargetDb.applyOpsMaxRound(userHandle, opsMax);
    }
    function mergeTargetRoundsMap(map) {
        if (window.SgTargetDb && window.SgTargetDb.mergeTargetRoundsMap) window.SgTargetDb.mergeTargetRoundsMap(map);
    }
    function loadOpsRoundMap() {
        try { return JSON.parse(sessionStorage.getItem('ops_target_rounds') || '{}') || {}; } catch (e) { return {}; }
    }

    function getOpsMaxRound(handle) {
        handle = normalizeChatHandle(handle);
        var map = loadOpsRoundMap();
        return Number(map[handle]) || 0;
    }

    function refreshOpsRoundMap(callback) {
        var h = '';
        try {
            h = sessionStorage.getItem('dan_target_username') || localStorage.getItem('matrix_my_handle') || '';
            h = h.replace('@', '').replace('#guard', '').toLowerCase();
        } catch (eH) { h = ''; }
        if (!h || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            if (callback) callback(false);
            return;
        }
        chrome.runtime.sendMessage({ action: 'ops_dm_rounds', handle: h }, function (r) {
            if (r && r.ok) {
                sessionStorage.setItem('dan_completed_targets', JSON.stringify(r.completed_targets || []));
                if (r.target_rounds) {
                    sessionStorage.setItem('ops_target_rounds', JSON.stringify(r.target_rounds));
                    mergeTargetRoundsMap(r.target_rounds);
                }
                if (Array.isArray(r.fleet_handles)) saveFleetHandles(r.fleet_handles);
            }
            if (callback) callback(!!(r && r.ok));
        });
    }

    /** OPS 轮次刷新：关注轮次结束后（尤其软风控 chat 窗）再拉，不与关注 5–8s 节拍并行 */
    var OPS_ROUND_REFRESH_MIN_MS = 90 * 1000;
    var FAN_SCAN_INTERVAL_MS = 30 * 1000;

    function isFollowPhaseTerminal(ph) {
        return ph === 'soft_cooldown' || ph === 'quota_exhausted' || ph === 'completed' || ph === 'done';
    }

    function isFollowRoundActive() {
        try {
            var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
            var ph = ms.phase || '';
            if (isFollowPhaseTerminal(ph)) return false;
            if (ms.running) return true;
            if (localStorage.getItem('matrix_follow_running') === 'true') return true;
            return false;
        } catch (e) {}
        return false;
    }

    function isSoftRiskChatWindow() {
        try {
            var sg = JSON.parse(localStorage.getItem('sg_state') || '{}');
            var ph = sg.softRiskPhase || '';
            if (ph === 'chat1' || ph === 'chat2') return true;
            if (ph === 'nurture') return false;
            var now = Date.now();
            if (!(sg.softRiskUntil > now)) return false;
            return !sg.softRiskChatDone;
        } catch (e) { return false; }
    }

    /** 软窗仍 open（含挂起养号段），用于收工勿走旧 completeChatRound 烧相位 */
    function isSoftRiskRoundOpen() {
        try {
            var st = JSON.parse(localStorage.getItem('sg_state') || '{}');
            return (st.softRiskUntil > Date.now()) && !st.softRiskChatDone;
        } catch (e) { return false; }
    }

    /** 4.6.81/85：软窗内或白天自动私信在跑 → 须与 OPS roster 同步 */
    function isLedgerOpsSyncPhase(sg) {
        try {
            sg = sg || loadSgState();
            var autoOn = false;
            try { autoOn = sessionStorage.getItem('dan_auto_run') === 'true'; } catch (eA) { autoOn = false; }
            // 白天主轴 / soft 正在开人
            if (autoOn) return true;
            // 软窗仍在（含挂起养号、下班只养号）— chat 可能已停仍须 POST
            if (!(Number(sg.softRiskUntil) > Date.now())) return false;
            var ph = String(sg.softRiskPhase || '');
            if (ph === 'chat1' || ph === 'chat2') return true;
            if (sg.softRiskChatSuspended) return true;
            if (ph === 'nurture' && sg.softRiskChatDone) return true;
            // 软窗活跃的其它相位也保链
            if (ph || sg.softRiskMode) return true;
            return false;
        } catch (e) { return false; }
    }

    /** 自动模式：关注轮次进行中私信侧让路；软风控 chat 窗放行；未 yield 的私信主轴不让路；手动只私信不挡 */
    function shouldDeferChatForFollow() {
        if (isSoftRiskChatWindow()) return false;
        // 4.6.83：私信时段且未 yield → 不给关注让路
        try {
            var sgY = loadSgState();
            if (!sgY.chatYieldToFollow) {
                var chatOnY = true;
                try {
                    if (typeof StageDetector !== 'undefined') {
                        if (StageDetector.detect) StageDetector.detect();
                        if (StageDetector.isChatTime) chatOnY = !!StageDetector.isChatTime();
                    } else if (typeof TimeUtil !== 'undefined' && TimeUtil.isWithinChatHours) {
                        chatOnY = !!TimeUtil.isWithinChatHours();
                    }
                } catch (eCt) {}
                if (chatOnY) return false;
            }
        } catch (eY) {}
        if (!isFollowRoundActive()) return false;
        // 与调度 shouldDeferChatForFollowCo：引擎未活不当真关注轮
        try {
            if (localStorage.getItem('matrix_follow_running') !== 'true') return false;
            if (sessionStorage.getItem('matrix_tab_running') === 'stopped_by_user') return false;
            var msAlive = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
            if ((msAlive.phase || '') === 'idle') return false;
        } catch (eAlive) { return false; }
        try {
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode && SchedulerGate.isAutoMode()) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    function canRunChatOutboundWork() {
        return !shouldDeferChatForFollow();
    }

    function opsRoundRefreshDue() {
        var last = parseInt(sessionStorage.getItem('dan_last_ops_round_refresh') || '0', 10) || 0;
        var jitter = 0;
        try {
            if (typeof SgChatStrategy !== 'undefined' && SgChatStrategy.fleetChatJitterMs) {
                jitter = SgChatStrategy.fleetChatJitterMs(getBotKey()) % (30 * 1000);
            }
        } catch (eJ) {}
        return Date.now() - last >= OPS_ROUND_REFRESH_MIN_MS + jitter;
    }

    /** force=true：outbound 开始 / 发信成功 / 软风控 chat 开窗；关注轮次中（自动）跳过 */
    function maybeRefreshOpsRoundMap(force, callback) {
        if (!force && shouldDeferChatForFollow()) return;
        if (!force && !opsRoundRefreshDue()) return;
        refreshOpsRoundMap(function (ok) {
            if (ok) sessionStorage.setItem('dan_last_ops_round_refresh', String(Date.now()));
            if (callback) callback(ok);
        });
    }

    function isIceCandidate(userHandle, completedBackend, rejectDB) {
        userHandle = normalizeChatHandle(userHandle);
        if (!userHandle) return false;
        if (rejectDB && rejectDB.has(userHandle)) return false;
        completedBackend = completedBackend || [];
        if (completedBackend.includes(userHandle)) return false;
        if (getOpsMaxRound(userHandle) >= 1 || getUserRound(userHandle) >= 1) return false;
        if (getUserRound(userHandle) >= 3) return false;
        if (!isChatTargetAllowed(userHandle, ensureChatFreeze())) return false;
        return true;
    }

    function advanceRound(userHandle) {
        try {
            userHandle = normalizeChatHandle(userHandle);
            var db = loadTargetDB();
            if (!db[userHandle]) db[userHandle] = { round: 0, firstSeen: Date.now(), lastDM: null };
            db[userHandle].round = (db[userHandle].round || 0) + 1;
            db[userHandle].lastDM = Date.now();
            var newRound = db[userHandle].round;
            if (newRound === 1) {
                db[userHandle].iceSentAt = Date.now();
                db[userHandle].slaDueAt = Date.now() + 90 * 60 * 1000;
            } else if (newRound === 2) {
                db[userHandle].adSentAt = Date.now();
            } else if (newRound === 3) {
                db[userHandle].kickSentAt = db[userHandle].kickSentAt || Date.now();
            }
            if (db[userHandle].round >= 3) db[userHandle].done = true;
            saveTargetDB(db);
        } catch(e) {}
    }

    function discoverTarget(userHandle, displayName) {
        try {
            userHandle = normalizeChatHandle(userHandle);
            if (!userHandle || isFleetHandle(userHandle)) {
                if (userHandle) rejectFleetHandle(userHandle);
                return false;
            }
            var db = loadTargetDB();
            var created = false;
            if (!db[userHandle]) {
                db[userHandle] = { round: 0, firstSeen: Date.now(), lastDM: null, lastSeenOnFollowersAt: Date.now() };
                created = true;
            } else {
                db[userHandle].lastSeenOnFollowersAt = Date.now();
            }
            var dn = String(displayName || '').trim();
            if (dn && String(db[userHandle].displayName || '').trim() !== dn) {
                db[userHandle].displayName = dn;
            }
            saveTargetDB(db);
            return created; // 新发现
        } catch(e) { return false; }
    }

    // ---- C2 破冰任务队列：先登记 → seal → 逐条完成核对 → 再下一条 ----
    var ICE_TASK_QUEUE_KEY = 'dan_ice_task_queue';
    var ICE_QUEUE_BATCH_MAX = 12;

    function iceQueuePulseId() {
        var id = sessionStorage.getItem('dan_ice_queue_pulse') || '';
        if (!id) {
            id = 'ice_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4);
            try { sessionStorage.setItem('dan_ice_queue_pulse', id); } catch (e) {}
        }
        return id;
    }

    function loadIceTaskQueue() {
        try {
            var q = JSON.parse(sessionStorage.getItem(ICE_TASK_QUEUE_KEY) || 'null');
            if (!q || typeof q !== 'object') {
                return { pulseId: iceQueuePulseId(), sealed: false, items: [] };
            }
            if (!Array.isArray(q.items)) q.items = [];
            if (!q.pulseId) q.pulseId = iceQueuePulseId();
            return q;
        } catch (e) {
            return { pulseId: iceQueuePulseId(), sealed: false, items: [] };
        }
    }

    function saveIceTaskQueue(q) {
        try { sessionStorage.setItem(ICE_TASK_QUEUE_KEY, JSON.stringify(q || { pulseId: '', sealed: false, items: [] })); } catch (e) {}
    }

    function clearIceTaskQueue(why) {
        try {
            sessionStorage.removeItem(ICE_TASK_QUEUE_KEY);
            sessionStorage.removeItem('dan_ice_queue_pulse');
            sessionStorage.removeItem('dan_ice_queue_seal_toast');
            sessionStorage.removeItem('dan_ice_seal_inflight');
            sessionStorage.removeItem('dan_ice_promoted_deferred');
            sessionStorage.removeItem('dan_ice_db_seeded');
            sessionStorage.removeItem('dan_ice_harvest_passes');
            sessionStorage.removeItem('dan_ice_shallow_idle');
            sessionStorage.removeItem('dan_ice_shallow_topped');
        } catch (e) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.task_queue_cleared', { kind: 'ice', why: why || '' });
            }
        } catch (eT) {}
    }

    function iceQueueStats(q) {
        q = q || loadIceTaskQueue();
        var s = { total: 0, pending: 0, doing: 0, done: 0, skipped: 0, failed: 0, deferred: 0, sealed: !!q.sealed };
        var items = q.items || [];
        s.total = items.length;
        for (var i = 0; i < items.length; i++) {
            var st = (items[i] && items[i].status) || 'pending';
            if (s[st] != null) s[st]++;
            else s.pending++;
        }
        return s;
    }

    function iceQueueFindIndex(q, handle) {
        handle = normalizeChatHandle(handle);
        for (var i = 0; i < (q.items || []).length; i++) {
            if (normalizeChatHandle(q.items[i].handle) === handle) return i;
        }
        return -1;
    }

    function iceQueueAdd(handle, displayName, status, reason, kind, createdAt, opsLocked) {
        handle = normalizeChatHandle(handle);
        if (!handle) return false;
        var q = loadIceTaskQueue();
        var idx = iceQueueFindIndex(q, handle);
        if (idx >= 0) return false;
        var item = {
            handle: handle,
            displayName: String(displayName || '').trim(),
            kind: kind || 'ice',
            status: status || 'pending',
            reason: reason || '',
            createdAt: (createdAt > 0) ? createdAt : Date.now(),
            doneAt: 0,
            pulseId: q.pulseId || iceQueuePulseId(),
            opsLockedKind: !!opsLocked
        };
        q.items.push(item);
        saveIceTaskQueue(q);
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.task_queue_item_add', {
                    kind: item.kind, handle: handle, status: item.status, reason: item.reason || '', pulseId: item.pulseId
                });
            }
        } catch (eT) {}
        return true;
    }

    function countPendingIceInQueue(q) {
        q = q || loadIceTaskQueue();
        var n = 0;
        for (var i = 0; i < (q.items || []).length; i++) {
            var it = q.items[i];
            if (!it) continue;
            if (it.kind !== 'ice') continue;
            if (it.status === 'pending' || it.status === 'doing') n++;
        }
        return n;
    }

    /** 台账里尚未破冰、应优先清掉的旧债人数（targetDB） */
    function countUnicedBacklogInDb() {
        var n = 0;
        try {
            var db = loadTargetDB() || {};
            var rejectDB = getDB('dan_reject_users');
            for (var raw in db) {
                if (!Object.prototype.hasOwnProperty.call(db, raw)) continue;
                var h = normalizeChatHandle(raw);
                if (!h) continue;
                var e = db[raw] || {};
                if (e.iceSentAt || e.adSentAt || e.blockedAt || e.rejectSentAt || e.done) continue;
                if (rejectDB && rejectDB.has && rejectDB.has(h)) continue;
                if ((parseInt(e.round, 10) || 0) > 0) continue;
                n++;
            }
        } catch (eC) { n = 0; }
        return n;
    }

    function iceQueueMark(handle, status, reason, kind) {
        handle = normalizeChatHandle(handle);
        if (!handle) return false;
        var q = loadIceTaskQueue();
        var idx = iceQueueFindIndex(q, handle);
        if (idx < 0) {
            iceQueueAdd(handle, '', status || 'done', reason || '', kind || 'ice');
            q = loadIceTaskQueue();
            idx = iceQueueFindIndex(q, handle);
            if (idx < 0) return false;
        }
        q.items[idx].status = status || 'done';
        if (reason) q.items[idx].reason = reason;
        if (kind) q.items[idx].kind = kind;
        if (status === 'done' || status === 'skipped' || status === 'failed' || status === 'deferred') {
            q.items[idx].doneAt = Date.now();
        }
        // 4.6.71：本地发送/拉黑/开做后解除 OPS kind 锁，允许后续 classify
        if (status === 'done' || status === 'skipped' || status === 'failed' || status === 'doing') {
            q.items[idx].opsLockedKind = false;
        }
        saveIceTaskQueue(q);
        try { markLedgerDirty('ice_queue_mark'); } catch (eDirty) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.task_item_done', {
                    kind: q.items[idx].kind || 'ice',
                    handle: handle,
                    status: q.items[idx].status,
                    reason: q.items[idx].reason || '',
                    pulseId: q.pulseId
                });
            }
        } catch (eT) {}
        return true;
    }

    /** 4.6.75：空扫只留列表滚；本窗已进 followers 相位后禁止回主页 */
    function forceRescanForRosterGap(why) {
        try { sessionStorage.removeItem(SOFT_ROSTER_SCAN_FOR_KEY); } catch (e0) {}
        try { sessionStorage.removeItem('dan_ice_shallow_topped'); } catch (e1) {}
        try { sessionStorage.setItem('dan_bottom_hit_count', '0'); } catch (e2) {}
        try { sessionStorage.setItem('dan_scroll_fail_count', '0'); } catch (e3) {}
        try { sessionStorage.removeItem('dan_ice_db_seeded'); } catch (e4) {}
        try { sessionStorage.removeItem('dan_need_scroll_down'); } catch (e4b) {}
        try { sessionStorage.removeItem('dan_need_scroll_down_count'); } catch (e4c) {}
        try {
            var qForce = loadIceTaskQueue();
            if (qForce && qForce.sealed) {
                qForce.sealed = false;
                saveIceTaskQueue(qForce);
            }
        } catch (e5) {}
        // 已进入 followers 相位或已有 F-ready：绝不再回主页（防乒乓）
        if (getRosterNavPhase() === 'followers' ||
            sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1') {
            console.warn('[粉丝队列] 强制再扫（留列表） why=' + (why || ''));
            return;
        }
        try {
            var myForce = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || '');
            if (myForce && isFollowersListPath(window.location.href)) {
                console.warn('[粉丝队列] 尚未读 F→回资料页 /' + myForce + ' why=' + (why || ''));
                chatGo('/' + myForce, true);
            }
        } catch (e7) {}
    }

    /**
     * 4.6.75：严格两段——profile 读 F → followers；followers 相位禁止回主页。
     */
    function gateFollowersBehindProfileF(why) {
        why = why || 'gate_followers';
        var phase = getRosterNavPhase();
        if (phase === 'followers' || sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1') {
            return true;
        }
        var g = { ready: false, needNav: false, handle: '' };
        try { g = ensureOwnProfileFollowerCount(); } catch (eG) { g = { ready: false }; }
        if (g && g.ready) return true;
        var h = (g && g.handle) || '';
        try {
            if (!h) h = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || '');
        } catch (eH) { h = ''; }
        if (h && !isMyProfilePage()) {
            try {
                var lastNav = parseInt(sessionStorage.getItem('sg_profile_f_nav_at') || '0', 10) || 0;
                if (Date.now() - lastNav < 5000) return false;
                sessionStorage.setItem('sg_profile_f_nav_at', String(Date.now()));
            } catch (eTh) {}
            console.log('[粉丝对账] ' + why + ' → 本号资料页读 F /' + h);
            try { showToast('📊 先停本号主页读关注者数', '#1d9bf0', 1800); } catch (eT) {}
            chatGo('/' + h, true);
        }
        return false;
    }

    /**
     * 4.6.71：先组快照 POST，成功或 12s 超时兜底后再 sealed；失败进出箱仍 seal 不卡死。
     * @param {string} reason
     * @param {function(object)=} callback sealed 后回调 (q)
     */
    function iceQueueSeal(reason, callback) {
        var done = typeof callback === 'function' ? callback : null;
        var q = loadIceTaskQueue();
        if (q.sealed) {
            if (done) done(q);
            return q;
        }
        var cellsSeenPre = 0;
        var profileFollowersPre = 0;
        try { cellsSeenPre = getSessionList().length; } catch (eSeen0) { cellsSeenPre = 0; }
        try { profileFollowersPre = readOwnFollowerCount() || 0; } catch (ePf0) { profileFollowersPre = 0; }
        // 4.6.67：绝对禁止 F>0 + cells=0 假封口（Armani 空跑根因）
        if (profileFollowersPre > 0 && cellsSeenPre === 0) {
            console.warn('[粉丝队列] 拒绝空扫封口 F=' + profileFollowersPre + ' cells=0 reason=' + (reason || ''));
            try { showToast('⚠ 未扫到粉丝格，暂缓封口（F=' + profileFollowersPre + '）', '#f85149', 2800); } catch (eT0) {}
            forceRescanForRosterGap('refuse_empty_seal');
            if (done) done(q);
            return q;
        }
        var st = iceQueueStats(q);
        var handles = (q.items || []).filter(function (it) { return it.status === 'pending'; }).map(function (it) { return it.handle; });
        var cellsSeen = cellsSeenPre;
        var opsMapSize = 0;
        try { opsMapSize = Object.keys(loadOpsRoundMap() || {}).length; } catch (eOps) { opsMapSize = 0; }
        var profileFollowers = profileFollowersPre;
        var expectedNew = 0;
        try {
            var base = loadFanRosterBaselineObj();
            if (base && base.followerCount > 0 && profileFollowers > 0) {
                expectedNew = Math.max(0, profileFollowers - (parseInt(base.followerCount, 10) || 0));
            }
        } catch (eEx) { expectedNew = 0; }
        var mismatch = st.total < cellsSeen;
        var isFullSeal = /^(bottom_reached|queue_empty|scroll_timeout)$/.test(String(reason || ''));
        var profileGap = isFullSeal && profileFollowers > 0 && cellsSeen + 2 < profileFollowers;
        var snap = null;
        try { snap = buildFanLedgerSnapshot(reason || 'seal'); } catch (eSnap) { snap = null; }
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.task_queue_built', {
                    kind: 'ice',
                    reason: reason || 'seal',
                    count: st.total,
                    pending: st.pending,
                    handles: handles.slice(0, 30),
                    pulseId: q.pulseId
                });
                SgTelemetry.emit('chat.fan_roster_seal', {
                    reason: reason || 'seal',
                    cellsSeen: cellsSeen,
                    queueTotal: st.total,
                    pending: st.pending,
                    skipped: st.skipped,
                    deferred: st.deferred,
                    doing: st.doing,
                    done: st.done,
                    opsMapSize: opsMapSize,
                    mismatch: !!mismatch,
                    profileFollowers: profileFollowers,
                    profileGap: !!profileGap,
                    expectedNew: expectedNew,
                    pulseId: q.pulseId
                });
                if (mismatch || profileGap) {
                    SgTelemetry.emit('chat.fan_roster_gap', {
                        cellsSeen: cellsSeen,
                        queueTotal: st.total,
                        gap: cellsSeen - st.total,
                        profileFollowers: profileFollowers,
                        profileGap: !!profileGap,
                        expectedNew: expectedNew,
                        reason: reason || 'seal',
                        pulseId: q.pulseId
                    });
                    console.warn('[粉丝队列] 对账缺口 cellsSeen=' + cellsSeen + ' queueTotal=' + st.total + ' profileFollowers=' + profileFollowers);
                }
            }
        } catch (eT) {}

        var sealDone = false;
        function finalizeSeal(uploadOk) {
            if (sealDone) return loadIceTaskQueue();
            sealDone = true;
            var qFin = loadIceTaskQueue();
            if (qFin.sealed) {
                if (done) done(qFin);
                return qFin;
            }
            qFin.sealed = true;
            saveIceTaskQueue(qFin);
            if (!uploadOk) {
                try { showToast('⚠ 台账上传进重试，本地已封口继续开人', '#faad14', 2800); } catch (eFail) {}
                console.warn('[粉丝队列] seal upload fail/timeout，仍 sealed reason=' + (reason || ''));
            }
            try {
                if (sessionStorage.getItem('dan_ice_queue_seal_toast') !== qFin.pulseId) {
                    sessionStorage.setItem('dan_ice_queue_seal_toast', qFin.pulseId);
                    var gapHint = '';
                    if (profileGap) gapHint = ' ⚠主页' + profileFollowers + '/见' + cellsSeen;
                    else if (mismatch) gapHint = ' ⚠漏' + (cellsSeen - st.total);
                    var icePend = 0;
                    try { icePend = countPendingIceInQueue(qFin); } catch (eIp) { icePend = 0; }
                    var iceHint = icePend > 0 ? (' · 先清旧破冰' + icePend) : '';
                    showToast('📋 关注者：待开 ' + st.pending + ' · 暂缓 ' + st.deferred + ' · 跳过 ' + st.skipped + ' · 浅扫见 ' + cellsSeen + (profileFollowers ? (' · 主页' + profileFollowers) : '') + iceHint + gapHint + '→ 逐条', '#1d9bf0', 3200);
                }
            } catch (eToast) {}
            try { markSoftWindowRosterScanDone(reason || 'seal'); } catch (eMk) {}
            console.log('[粉丝队列] seal reason=' + (reason || '') + ' pending=' + st.pending + ' total=' + st.total + ' seen=' + cellsSeen + ' followers=' + profileFollowers + ' mismatch=' + mismatch + ' profileGap=' + profileGap + ' uploadOk=' + !!uploadOk);
            if (done) done(qFin);
            return qFin;
        }

        if (!snap) {
            return finalizeSeal(false);
        }
        console.log('[台账] seal snapshot → roster sync items=' + (snap.itemCount || 0));
        var timer = setTimeout(function () {
            finalizeSeal(false);
        }, 12000);
        try {
            opsDmRosterSync(snap, function (ok) {
                try { clearTimeout(timer); } catch (eClr) {}
                // 4.6.116：封口上传结果遥测——OPS 可直接观测哪个号卡在上传环节
                try {
                    if (typeof SgTelemetry !== 'undefined') {
                        SgTelemetry.emit('chat.ledger_sync', {
                            why: 'seal:' + (reason || ''),
                            ok: !!ok,
                            itemCount: snap.itemCount || 0,
                            profileFollowers: snap.profileFollowers || 0,
                            cellsSeen: cellsSeen
                        });
                    }
                } catch (eT2) {}
                finalizeSeal(!!ok);
            });
        } catch (eUp) {
            try { clearTimeout(timer); } catch (eClr2) {}
            return finalizeSeal(false);
        }
        return q;
    }

    /** skipped 不可纠正（锁定）reason/kind */
    var ICE_SKIP_LOCKED = {
        fleet: 1, reject: 1, freeze: 1, protected: 1, no_dm: 1, corpse: 1,
        they_blocked_us: 1, protected_no_dm: 1,
        ui_unavailable: 1, x_number_gate: 1, closed_inbox: 1, hard_closed: 1,
        no_composer_after_send: 1, job_intent_no: 1, age_reject: 1, peer_blocked: 1,
        stale_48h_no_reply: 1, read_only: 1, dm_button_dead: 1
    };

    /** 拒绝/拉黑类 skipped 永不可 promote 回 pending */
    function isIceSkipPermanentlyLocked(item) {
        if (!item) return false;
        var lockKey = item.reason || item.kind || '';
        if (ICE_SKIP_LOCKED[lockKey] || ICE_SKIP_LOCKED[item.kind]) return true;
        var r = String(item.reason || '');
        if (/job_intent_no|age_reject|reject|blocked|hard_closed|peer_blocked|peer_stop|they_blocked_us|no_dm|protected|stale_48h|read_only|dm_button_dead/i.test(r)) return true;
        var h = normalizeChatHandle(item.handle);
        if (!h) return false;
        try {
            var ent = loadTargetDB()[h] || {};
            if (ent.rejectSentAt || ent.blockedAt) return true;
            var rejectDB = getDB('dan_reject_users');
            if (rejectDB && rejectDB.has && rejectDB.has(h)) return true;
        } catch (e) {}
        return false;
    }

    function iceQueueKindPriority(kind, reason) {
        // 4.6.64：kick → 待发广告 → 未破冰 → need_probe 复检
        // 旧序 kick→ad→ice 会让大量 need_probe 饿死 pending ice
        if (kind === 'kick') return 0;
        if (kind === 'ad' && reason === 'need_ad') return 1;
        if (kind === 'ice') return 2;
        if (kind === 'ad') return 3; // need_probe / 其它 ad 排 ice 后
        return 4;
    }

    /** 封口前一次定序：kick → need_ad → ice → need_probe；同档按 createdAt */
    function sortIceQueueForDrain() {
        var q = loadIceTaskQueue();
        if (!q.items || q.items.length < 2) return q;
        q.items.sort(function (a, b) {
            var pa = iceQueueKindPriority(a.kind, a.reason);
            var pb = iceQueueKindPriority(b.kind, b.reason);
            if (pa !== pb) return pa - pb;
            return (a.createdAt || 0) - (b.createdAt || 0);
        });
        saveIceTaskQueue(q);
        return q;
    }

    /**
     * seal 前 / promote：按最新 OPS+本地重分类队列。
     * pending→skip/deferred；deferred→pending/skip；skipped→pending 仅可纠正类。
     * 4.6.71：opsLockedKind 的 pending/deferred 禁止改 kind；仅本地终态证据可升 skipped。
     */
    function reclassifyIceQueueFromOps() {
        var rejectDB = getDB('dan_reject_users');
        var completedBackend = [];
        try { completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]'); } catch (eC) {}
        var sg = ensureChatFreeze();
        var q = loadIceTaskQueue();
        var changed = 0;
        var promoted = 0;
        var demoted = 0;
        for (var i = 0; i < (q.items || []).length; i++) {
            var it = q.items[i];
            if (!it || !it.handle) continue;
            var oldSt = it.status || 'pending';
            if (oldSt === 'doing' || oldSt === 'done' || oldSt === 'failed') continue;

            // 4.6.71：OPS 灌入的 kind 锁定 — 只允许本地终态证据升 skipped
            if (it.opsLockedKind && (oldSt === 'pending' || oldSt === 'deferred')) {
                var hasLocalTerminal = false;
                try {
                    var entLock = loadTargetDB()[normalizeChatHandle(it.handle)] || {};
                    if (entLock.blockedAt || entLock.rejectSentAt || entLock.done) hasLocalTerminal = true;
                    if (rejectDB && rejectDB.has && rejectDB.has(normalizeChatHandle(it.handle))) hasLocalTerminal = true;
                } catch (eLock) { hasLocalTerminal = false; }
                if (hasLocalTerminal) {
                    var clsTerm = classifyFanRosterAction(it.handle, rejectDB, completedBackend, sg);
                    if (clsTerm.status === 'skipped') {
                        it.status = 'skipped';
                        it.kind = clsTerm.kind || it.kind;
                        it.reason = clsTerm.reason || 'local_terminal';
                        it.doneAt = Date.now();
                        it.opsLockedKind = false;
                        changed++;
                        demoted++;
                    }
                }
                continue;
            }

            var cls = classifyFanRosterAction(it.handle, rejectDB, completedBackend, sg);
            var nextSt = cls.status;
            var nextKind = cls.kind || it.kind || 'ice';
            var nextReason = cls.reason || '';

            if (oldSt === 'pending') {
                if (nextSt === 'skipped' || nextSt === 'deferred') {
                    it.status = nextSt;
                    it.kind = nextKind;
                    it.reason = nextReason;
                    it.doneAt = Date.now();
                    changed++;
                    demoted++;
                } else if (nextSt === 'pending' && (it.kind !== nextKind || (nextReason && it.reason !== nextReason))) {
                    it.kind = nextKind;
                    if (nextReason) it.reason = nextReason;
                    changed++;
                }
                continue;
            }
            if (oldSt === 'deferred') {
                if (nextSt === 'pending') {
                    if (isIceSkipPermanentlyLocked(it)) continue;
                    it.status = 'pending';
                    it.kind = nextKind;
                    it.reason = nextReason || 'reclassified';
                    it.doneAt = 0;
                    changed++;
                    promoted++;
                } else if (nextSt === 'skipped') {
                    it.status = 'skipped';
                    it.kind = nextKind;
                    it.reason = nextReason;
                    it.doneAt = Date.now();
                    changed++;
                    demoted++;
                } else if (nextSt === 'deferred' && (it.kind !== nextKind || it.reason !== nextReason)) {
                    it.kind = nextKind;
                    it.reason = nextReason;
                    changed++;
                }
                continue;
            }
            if (oldSt === 'skipped') {
                if (isIceSkipPermanentlyLocked(it)) continue;
                if (nextSt === 'pending') {
                    it.status = 'pending';
                    it.kind = nextKind;
                    it.reason = nextReason || 'ops_corrected';
                    it.doneAt = 0;
                    changed++;
                    promoted++;
                }
            }
        }
        if (changed > 0) {
            saveIceTaskQueue(q);
            try {
                if (typeof SgTelemetry !== 'undefined') {
                    SgTelemetry.emit('chat.fan_roster_reclassify', {
                        changed: changed, promoted: promoted, demoted: demoted, pulseId: q.pulseId
                    });
                }
            } catch (eT) {}
            console.log('[粉丝队列] reclassify changed=' + changed + ' ↑' + promoted + ' ↓' + demoted);
        }
        return { changed: changed, promoted: promoted, demoted: demoted };
    }

    /** 软风控/Force：把可执行 deferred（及可纠正 skipped）抬回 pending */
    function iceQueuePromoteDeferred(why) {
        var r = reclassifyIceQueueFromOps();
        var n = (r && r.promoted) || 0;
        if (n > 0) {
            noteChatProgress('ice_promote_deferred');
            try {
                if (typeof SgTelemetry !== 'undefined') {
                    var q = loadIceTaskQueue();
                    SgTelemetry.emit('chat.task_queue_item_add', {
                        kind: 'ice', handle: '', item_kind: 'promote_deferred', status: 'pending',
                        reason: why || 'promoted', pulseId: q.pulseId, count: n
                    });
                }
            } catch (eT) {}
            console.log('[粉丝队列] promote deferred/skip→pending n=' + n + ' why=' + (why || ''));
        }
        return n;
    }

    /**
     * seal 前强制拉 OPS → 重分类 → 封口（防 OPS 迟到错分）。
     * @param {string} reason
     * @param {function(): void} [afterSeal]
     */
    function prepareAndSealIceQueue(reason, afterSeal) {
        if (sessionStorage.getItem('dan_ice_seal_inflight') === '1') return;
        sessionStorage.setItem('dan_ice_seal_inflight', '1');
        var finished = false;
        var rosterItems = null;
        function finish() {
            if (finished) return;
            finished = true;
            var deferredGap = false;
            var sealStarted = false;
            try {
                // 4.6.67：封口前先灌 OPS 台账债 + 本地 DB 债
                try { seedOpsRosterDebtToQueue('pre_seal_ops', rosterItems); } catch (eOpsSeed) {}
                try { seedUnfinishedFanDebtToQueue('pre_seal_db'); } catch (eDbSeed) {}
                reclassifyIceQueueFromOps();
                sortIceQueueForDrain();
                // 4.6.64：封口前 F 必须可读；否则回资料页，禁止上传 F=0 假快照
                var fGate = deferSealUntilFollowerCount(reason || 'seal');
                if (fGate && fGate.defer) {
                    deferredGap = true;
                    console.warn('[粉丝队列] 暂缓封口：等待主页 F reason=' + (reason || ''));
                }
                // 4.6.67：F>0 且 cells=0 → 持续暂缓（禁止 gap_retry 一次后放行空封口）
                var rGap = String(reason || '');
                if (!deferredGap && /^(bottom_reached|queue_empty|scroll_timeout|shallow_new_fans|shallow_empty|shallow_reuse)$/.test(rGap)) {
                    var F = (fGate && fGate.f) || 0;
                    var cells = 0;
                    try { if (!(F > 0)) F = readOwnFollowerCount() || 0; } catch (eF) { F = 0; }
                    try { cells = getSessionList().length; } catch (eC) { cells = 0; }
                    if (F > 0 && cells === 0) {
                        deferredGap = true;
                        forceRescanForRosterGap('cells0_hard');
                        try {
                            if (typeof SgTelemetry !== 'undefined') {
                                SgTelemetry.emit('chat.fan_roster_gap', {
                                    cellsSeen: 0,
                                    queueTotal: iceQueueStats().total,
                                    gap: F,
                                    profileFollowers: F,
                                    profileGap: true,
                                    reason: 'defer_seal_cells0',
                                    pulseId: (loadIceTaskQueue() || {}).pulseId || ''
                                });
                            }
                        } catch (eT0) {}
                        try {
                            showToast('📋 主页关注者 ' + F + ' · 已见 0 → 必须再扫，禁止空封口', '#f85149', 3000);
                        } catch (eToast0) {}
                        console.warn('[粉丝队列] cells=0 硬暂缓封口 F=' + F);
                    } else if (F > 0 && cells + 2 < F &&
                        sessionStorage.getItem('dan_roster_profile_gap_retry') !== '1') {
                        // 有部分 cells 的轻度缺口：仍允许一次补滚
                        deferredGap = true;
                        try { sessionStorage.setItem('dan_roster_profile_gap_retry', '1'); } catch (eR) {}
                        try { sessionStorage.setItem('dan_bottom_hit_count', '0'); } catch (eB) {}
                        try { sessionStorage.setItem('dan_scroll_fail_count', '0'); } catch (eS) {}
                        // 4.6.125：置下滚补登标记——下一拍真正下滚补收（旧逻辑只 return 不滚动＝假补登）
                        try { sessionStorage.setItem('dan_need_scroll_down', '1'); } catch (eNS) {}
                        try { sessionStorage.removeItem('dan_need_scroll_down_count'); } catch (eNC) {}
                        try {
                            if (typeof SgTelemetry !== 'undefined') {
                                SgTelemetry.emit('chat.fan_roster_gap', {
                                    cellsSeen: cells,
                                    queueTotal: iceQueueStats().total,
                                    gap: F - cells,
                                    profileFollowers: F,
                                    profileGap: true,
                                    reason: 'defer_seal_retry',
                                    pulseId: (loadIceTaskQueue() || {}).pulseId || ''
                                });
                            }
                        } catch (eT) {}
                        try {
                            showToast('📋 主页关注者 ' + F + ' · 已见 ' + cells + ' → 再滚补登', '#faad14', 2800);
                        } catch (eToast) {}
                        console.warn('[粉丝队列] 关注者缺口暂缓封口 F=' + F + ' seen=' + cells);
                    }
                }
                if (deferredGap) return;
                // 4.6.71：先 POST 台账再 sealed；afterSeal 仅在 sealed 后跑
                sealStarted = true;
                iceQueueSeal(reason || 'seal', function (sealedQ) {
                    try {
                        if (!sealedQ || !sealedQ.sealed) return;
                        var r = String(reason || '');
                        if (r.indexOf('shallow') === 0) {
                            /* no baseline write */
                        } else if (r === 'bottom_reached' || ((!hasFanRosterBaseline()) && (r === 'scroll_timeout' || r === 'queue_empty'))) {
                            var seen = 0;
                            try { seen = getSessionList().length; } catch (eSeen) { seen = 0; }
                            markFanRosterBaseline(r, seen);
                        }
                        if (typeof afterSeal === 'function') {
                            try { afterSeal(); } catch (eA) {}
                        }
                    } finally {
                        try { sessionStorage.removeItem('dan_ice_seal_inflight'); } catch (eR2) {}
                    }
                });
                return;
            } finally {
                if (!sealStarted) {
                    try { sessionStorage.removeItem('dan_ice_seal_inflight'); } catch (eR) {}
                }
            }
        }
        // 4.6.67：并行拉 OPS rounds + roster；最多等 2.5s
        var left = 2;
        var timer = setTimeout(function () {
            left = 0;
            finish();
        }, 2500);
        function tick() {
            left -= 1;
            if (left <= 0) {
                try { clearTimeout(timer); } catch (eClr) {}
                finish();
            }
        }
        try {
            refreshOpsRoundMap(function () { tick(); });
        } catch (eRef) {
            tick();
        }
        try {
            opsDmRosterFetch(function (r) {
                if (r && r.ok && Array.isArray(r.items)) rosterItems = r.items;
                tick();
            });
        } catch (eRoster) {
            tick();
        }
    }

    /** 当前进行中的破冰任务（同一时刻最多一人） */
    function iceQueueCurrentDoing() {
        var q = loadIceTaskQueue();
        for (var i = 0; i < (q.items || []).length; i++) {
            if (q.items[i] && q.items[i].status === 'doing') return q.items[i];
        }
        return null;
    }

    /**
     * 下一破冰目标：有 doing 只返回此人（禁止未完成就开下一人）；
     * 无 doing 才取队首 pending。
     */
    function iceQueueNextPending() {
        var doing = iceQueueCurrentDoing();
        if (doing) return doing;
        var q = loadIceTaskQueue();
        for (var i = 0; i < (q.items || []).length; i++) {
            if (q.items[i] && q.items[i].status === 'pending') return q.items[i];
        }
        return null;
    }

    function iceQueueHasOpenWork() {
        var st = iceQueueStats();
        return (st.pending + st.doing) > 0;
    }

    function findUserCellLinkByHandle(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return null;
        try {
            var cells = document.querySelectorAll('[data-testid="UserCell"]');
            for (var i = 0; i < cells.length; i++) {
                var profileLink = cells[i].querySelector('a[role="link"]');
                if (!profileLink) continue;
                var rawHref = profileLink.getAttribute('href');
                if (!rawHref) continue;
                var userHandle = normalizeChatHandle(rawHref.split('?')[0].split('/').pop());
                if (userHandle === handle) return profileLink;
            }
        } catch (e) {}
        return null;
    }

    /** 有效轮次 = max(本地, OPS)，只升不降口径 */
    function getEffectiveFanRound(handle) {
        handle = normalizeChatHandle(handle);
        var local = getUserRound(handle) || 0;
        var ops = getOpsMaxRound(handle) || 0;
        return Math.max(local, ops);
    }

    /**
     * 粉丝列表登记分类（4.1.1）：全员入队；完结 skipped 不开人；待办按轮次 pending。
     * @returns {{ status: string, kind: string, reason: string }}
     */
    function classifyFanRosterAction(handle, rejectDB, completedBackend, sg) {
        handle = normalizeChatHandle(handle);
        var entry = {};
        try { entry = loadTargetDB()[handle] || {}; } catch (eE) { entry = {}; }
        var eff = getEffectiveFanRound(handle);
        var maxK = (window.SgChatGates && window.SgChatGates.KICK_MAX_COUNT) || 2;
        var kc = getKickCountLocal(entry);

        if (isFleetHandle(handle)) {
            return { status: 'skipped', kind: 'fleet', reason: 'fleet' };
        }
        if (rejectDB && rejectDB.has && rejectDB.has(handle)) {
            return { status: 'skipped', kind: 'reject', reason: 'reject' };
        }
        if (entry.rejectSentAt || entry.blockedAt || entry.chatClosedAt || entry.done || kc >= maxK) {
            return { status: 'skipped', kind: 'completed', reason: 'completed' };
        }
        // OPS/有效轮次标完结须有本地发送证据；否则按未知待核验（禁止「没发过却 completed」）
        if (completedBackend && completedBackend.includes && completedBackend.includes(handle) && hasLocalDmSendEvidence(entry)) {
            return { status: 'skipped', kind: 'completed', reason: 'completed' };
        }
        if ((isChatFullyClosed(entry) || eff >= 3) && hasLocalDmSendEvidence(entry)) {
            return { status: 'skipped', kind: 'completed', reason: 'completed' };
        }
        if ((completedBackend && completedBackend.includes && completedBackend.includes(handle)) ||
            eff >= 3 || isChatFullyClosed(entry)) {
            if (!hasLocalDmSendEvidence(entry)) {
                eff = Math.min(getUserRound(handle) || 0, 1);
            }
        }

        if (eff <= 0) {
            if (!isChatTargetAllowed(handle, sg || ensureChatFreeze())) {
                return { status: 'skipped', kind: 'ice', reason: 'freeze' };
            }
            return { status: 'pending', kind: 'ice', reason: '' };
        }
        if (eff === 1) {
            // 4.1.37：守箱废后，无 lastInboundAt 不能挡开人——证据只在再开的会话里
            if (isActionableAdEntry(handle, entry)) {
                return { status: 'pending', kind: 'ad', reason: 'need_ad' };
            }
            // 4.6.79：单段一轮；每人每软窗一次动作（刚破冰→done，复检下窗）
            return { status: 'pending', kind: 'ad', reason: 'need_probe' };
        }
        // eff === 2：催加
        if (canSendKickNow(handle, entry)) {
            return { status: 'pending', kind: 'kick', reason: 'kick_ready' };
        }
        return { status: 'deferred', kind: 'kick', reason: 'kick_not_ready' };
    }

    /**
     * 从目标库灌未完成债：ad/kick + **台账旧未破冰 ice**（4.6.65）。
     * 首扫未建 baseline 前不灌 ice（仍靠列表全量 harvest）；baseline 后旧 ice 优先入队清掉。
     * 禁止「只进新人、旧破冰永远不动」。
     */
    function seedUnfinishedFanDebtToQueue(why) {
        why = why || 'db_debt';
        // 4.1.64：非私信时段不加债、不赶债
        try {
            var inChatHours = true;
            if (typeof TimeUtil !== 'undefined' && TimeUtil.isWithinChatHours) {
                inChatHours = !!TimeUtil.isWithinChatHours();
            } else if (typeof StageDetector !== 'undefined') {
                if (StageDetector.detect) StageDetector.detect();
                if (StageDetector.isChatTime) inChatHours = !!StageDetector.isChatTime();
            }
            if (!inChatHours) {
                try {
                    if (typeof SgTelemetry !== 'undefined') {
                        SgTelemetry.emit('chat.fan_roster_seed_db', {
                            why: why,
                            pending: 0,
                            deferred: 0,
                            scanned: 0,
                            unfinished_only: true,
                            skipped_outside_chat_hours: true
                        });
                    }
                } catch (eT0) {}
                console.log('[粉丝队列] 非私信时段，跳过灌债 why=' + why);
                return 0;
            }
        } catch (eHours) {}
        var rejectDB = getDB('dan_reject_users');
        var completedBackend = [];
        try { completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]'); } catch (eC) {}
        var sg = ensureChatFreeze();
        var baselineOk = false;
        try { baselineOk = hasFanRosterBaseline(); } catch (eBl) { baselineOk = false; }
        var dbAll = {};
        try { dbAll = loadTargetDB() || {}; } catch (eDb) { dbAll = {}; }
        var addedPending = 0;
        var addedDeferred = 0;
        var addedIce = 0;
        var scanned = 0;
        for (var raw in dbAll) {
            if (!Object.prototype.hasOwnProperty.call(dbAll, raw)) continue;
            var handle = normalizeChatHandle(raw);
            if (!handle) continue;
            scanned++;
            var entry = dbAll[raw] || {};
            var cls = classifyFanRosterAction(handle, rejectDB, completedBackend, sg);
            if (!cls || cls.status === 'skipped') continue;
            if (cls.status !== 'pending' && cls.status !== 'deferred') continue;
            if (cls.kind === 'ice') {
                // 首扫未建台账：冰粉只靠列表 harvest；建账后必须把库里旧未破冰灌回队列
                if (!baselineOk) continue;
                if (entry.iceSentAt) continue;
                var iceAt = Number(entry.firstSeen || entry.discoveredAt || 0) || 1;
                if (iceQueueAdd(handle, entry.displayName || '', 'pending', cls.reason || 'ledger_old_ice', 'ice', iceAt)) {
                    addedPending++;
                    addedIce++;
                }
                continue;
            }
            // ad/kick 债
            if (iceQueueAdd(handle, entry.displayName || '', cls.status, cls.reason || why, cls.kind || 'ad',
                Number(entry.firstSeen || entry.iceSentAt || 0) || 0)) {
                if (cls.status === 'pending') addedPending++;
                else addedDeferred++;
            }
        }
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.fan_roster_seed_db', {
                    why: why,
                    pending: addedPending,
                    deferred: addedDeferred,
                    ice: addedIce,
                    scanned: scanned,
                    unfinished_only: true,
                    seed_old_ice: !!baselineOk,
                    require_session_seen: false
                });
            }
        } catch (eT) {}
        if (addedPending || addedDeferred || addedIce) {
            console.log('[粉丝队列] DB债 pending=' + addedPending + ' deferred=' + addedDeferred + ' ice=' + addedIce + ' why=' + why);
        }
        return addedPending;
    }

    /** @deprecated 兼容旧名 → seedUnfinishedFanDebtToQueue */
    function seedIceQueueFromTargetDb(why) {
        return seedUnfinishedFanDebtToQueue(why || 'legacy_seed');
    }

    /** 4.6.67：GET OPS 台账 items（pending ice / need_probe 回灌） */
    function opsDmRosterFetch(callback) {
        var done = typeof callback === 'function' ? callback : function () {};
        try {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
                done({ ok: false, msg: 'no_runtime' });
                return;
            }
            var h = '';
            try {
                h = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || localStorage.getItem('matrix_my_handle') || '');
            } catch (eH) { h = ''; }
            if (!h) {
                done({ ok: false, msg: 'no_handle' });
                return;
            }
            var timer = setTimeout(function () { done({ ok: false, msg: 'timeout' }); }, 8000);
            chrome.runtime.sendMessage({ action: 'ops_dm_roster_get', handle: h }, function (r) {
                clearTimeout(timer);
                if (chrome.runtime.lastError) {
                    done({ ok: false, msg: chrome.runtime.lastError.message });
                    return;
                }
                done(r || { ok: false });
            });
        } catch (e) {
            done({ ok: false, msg: String(e && e.message || e) });
        }
    }

    /**
     * 4.6.70/71：OPS pending 可覆盖本地仍为 pending/deferred 的 kind（doing/终态不碰）；写入 opsLockedKind。
     * @returns {boolean} 是否新增或改写
     */
    function upsertOpsQueueItem(handle, displayName, status, reason, kind, createdAt) {
        handle = normalizeChatHandle(handle);
        if (!handle) return false;
        var q = loadIceTaskQueue();
        var idx = iceQueueFindIndex(q, handle);
        if (idx < 0) {
            return iceQueueAdd(handle, displayName, status || 'pending', reason || '', kind || 'ice', createdAt, true);
        }
        var it = q.items[idx];
        if (!it) return false;
        var oldSt = it.status || 'pending';
        if (oldSt === 'doing' || oldSt === 'done' || oldSt === 'failed') return false;
        if (oldSt === 'skipped' && isIceSkipPermanentlyLocked(it)) return false;
        // 本地终态优先：已拉黑/拒绝不让 OPS 陈旧 pending 救活
        try {
            var ent = loadTargetDB()[handle] || {};
            if (ent.blockedAt || ent.rejectSentAt || ent.done) return false;
        } catch (eEnt) {}
        var changed = false;
        var wantSt = (status === 'deferred') ? 'deferred' : 'pending';
        if (oldSt === 'deferred' && wantSt === 'pending') {
            it.status = 'pending';
            it.doneAt = 0;
            changed = true;
        } else if (oldSt === 'skipped' && wantSt === 'pending') {
            it.status = 'pending';
            it.doneAt = 0;
            changed = true;
        }
        if (kind && it.kind !== kind) { it.kind = kind; changed = true; }
        if (reason && it.reason !== reason) { it.reason = reason; changed = true; }
        if (displayName && !it.displayName) { it.displayName = String(displayName).trim(); changed = true; }
        if (!it.opsLockedKind) { it.opsLockedKind = true; changed = true; }
        if (changed) {
            saveIceTaskQueue(q);
            try { markLedgerDirty('ops_upsert'); } catch (eD) {}
        }
        return changed;
    }

    /** 4.6.71：OPS 终态（done/skipped/blocked）对齐本地非 doing 队列项 */
    function alignLocalQueueFromOpsTerminal(why, items) {
        why = why || 'ops_terminal';
        if (!items || !items.length) return 0;
        var aligned = 0;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it) continue;
            var handle = normalizeChatHandle(it.handle);
            if (!handle) continue;
            var st = String(it.queue_status || it.queueStatus || '').toLowerCase();
            var isTerminal = !!(it.blocked || it.rejected || it.done ||
                st === 'done' || st === 'skipped' || st === 'failed');
            if (!isTerminal) continue;
            var q = loadIceTaskQueue();
            var idx = iceQueueFindIndex(q, handle);
            if (idx < 0) continue;
            var local = q.items[idx];
            if (!local) continue;
            var localSt = local.status || 'pending';
            if (localSt === 'doing') continue;
            if (localSt === 'done' || localSt === 'skipped' || localSt === 'failed') continue;
            var wantSt = (it.blocked || it.rejected || st === 'skipped') ? 'skipped' : 'done';
            var wantReason = String(it.queue_reason || it.queueReason || it.blockReason || it.block_reason || wantSt);
            var wantKind = String(it.queue_kind || it.queueKind || local.kind || 'ice');
            local.status = wantSt;
            local.reason = wantReason;
            local.kind = wantKind;
            local.doneAt = Date.now();
            local.opsLockedKind = false;
            saveIceTaskQueue(q);
            try {
                var db = loadTargetDB();
                if (!db[handle]) db[handle] = { round: 0, firstSeen: Date.now(), lastDM: null };
                var entry = db[handle];
                if (it.blocked || it.blockedAt || it.blocked_at) {
                    entry.blockedAt = entry.blockedAt || parseInt(it.blockedAt || it.blocked_at, 10) || Date.now();
                    entry.blockReason = entry.blockReason || String(it.blockReason || it.block_reason || wantReason);
                }
                if (it.rejected || it.rejectSentAt) {
                    entry.rejectSentAt = entry.rejectSentAt || Date.now();
                }
                if (it.done || wantSt === 'done') {
                    entry.done = true;
                }
                db[handle] = entry;
                saveTargetDB(db);
            } catch (eDb) {}
            aligned++;
            try { markLedgerDirty('ops_terminal_align'); } catch (eD) {}
        }
        if (aligned) {
            console.log('[粉丝队列] OPS终态对齐 n=' + aligned + ' why=' + why);
        }
        return aligned;
    }

    /**
     * 4.6.67/70/71：OPS 终态对齐 + pending 灌队（opsLockedKind）；已有 pending 则覆盖 kind。
     * @returns {number} 新入队或改写数（含终态对齐）
     */
    function seedOpsRosterDebtToQueue(why, items) {
        why = why || 'ops_roster';
        if (!items || !items.length) return 0;
        var rejectDB = getDB('dan_reject_users');
        var added = 0;
        var addedIce = 0;
        var addedProbe = 0;
        var aligned = 0;
        try { aligned = alignLocalQueueFromOpsTerminal(why + '_term', items) || 0; } catch (eAl) { aligned = 0; }
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it) continue;
            var handle = normalizeChatHandle(it.handle);
            if (!handle) continue;
            var st = String(it.queue_status || it.queueStatus || '').toLowerCase();
            var kd = String(it.queue_kind || it.queueKind || '').toLowerCase();
            var rs = String(it.queue_reason || it.queueReason || '').toLowerCase();
            if (st !== 'pending' && st !== 'deferred') continue;
            if (it.blocked || it.rejected || it.done) continue;
            if (rejectDB && rejectDB.has && rejectDB.has(handle)) continue;
            if (isFleetHandle(handle)) continue;
            try {
                discoverTarget(handle, it.display_name || it.displayName || '');
            } catch (eDisc) {}
            var opsRound = parseInt(it.round, 10) || 0;
            var opsIceAt = parseInt(it.ice_sent_at || it.iceSentAt, 10) || 0;
            try {
                var db = loadTargetDB();
                if (!db[handle]) db[handle] = { round: 0, firstSeen: Date.now(), lastDM: null };
                var entry = db[handle];
                if (entry.blockedAt || entry.rejectSentAt || entry.done) continue;
                if (opsRound >= 1 || opsIceAt || kd === 'ad' || rs === 'need_probe' || rs === 'need_ad') {
                    entry.round = Math.max(Number(entry.round) || 0, opsRound || 1);
                    if (!entry.iceSentAt) entry.iceSentAt = opsIceAt || entry.lastDM || Date.now() - 3600000;
                    if (!entry.lastDM) entry.lastDM = entry.iceSentAt;
                    if (opsRound >= 2 && !entry.adSentAt) entry.adSentAt = entry.lastDM || Date.now();
                    db[handle] = entry;
                    saveTargetDB(db);
                }
            } catch (eDb) {}

            var disp = it.display_name || it.displayName || '';
            var wantSt = st === 'deferred' ? 'deferred' : 'pending';

            if (kd === 'ice' || (opsRound <= 0 && !opsIceAt && rs !== 'need_probe' && rs !== 'need_ad' && kd !== 'ad' && kd !== 'kick')) {
                var localNow = {};
                try { localNow = loadTargetDB()[handle] || {}; } catch (eLn) { localNow = {}; }
                if (opsIceAt || (parseInt(localNow.round, 10) || 0) >= 1) {
                    if (upsertOpsQueueItem(handle, disp, 'pending', 'need_probe', 'ad',
                        opsIceAt || Number(localNow.firstSeen) || 0)) {
                        added++;
                        addedProbe++;
                    }
                } else if (upsertOpsQueueItem(handle, disp, 'pending', 'ledger_ops_ice', 'ice',
                    Number(localNow.firstSeen) || 1)) {
                    added++;
                    addedIce++;
                }
                continue;
            }
            if (kd === 'kick' || rs === 'kick_ready') {
                if (upsertOpsQueueItem(handle, disp, 'pending', rs || 'kick_ready', 'kick', opsIceAt || 0)) {
                    added++;
                }
                continue;
            }
            var adReason = rs === 'need_ad' ? 'need_ad' : 'need_probe';
            if (upsertOpsQueueItem(handle, disp, wantSt, adReason, 'ad', opsIceAt || 0)) {
                added++;
                if (adReason === 'need_probe') addedProbe++;
            }
        }
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.fan_roster_seed_ops', {
                    why: why,
                    pending: added,
                    ice: addedIce,
                    probe: addedProbe,
                    aligned: aligned,
                    scanned: items.length
                });
            }
        } catch (eT2) {}
        if (added || aligned) {
            try { sortIceQueueForDrain(); } catch (eSort) {}
            console.log('[粉丝队列] OPS台账回灌 pending=' + added + ' ice=' + addedIce + ' probe=' + addedProbe + ' aligned=' + aligned + ' why=' + why);
        }
        return added + aligned;
    }

    /** 异步拉 OPS 台账并回灌；完成后可选 callback(added) */
    function pullOpsRosterIntoQueue(why, callback) {
        opsDmRosterFetch(function (r) {
            var n = 0;
            try {
                if (r && r.ok && Array.isArray(r.items)) n = seedOpsRosterDebtToQueue(why || 'ops_pull', r.items);
            } catch (e) { n = 0; }
            if (typeof callback === 'function') {
                try { callback(n); } catch (eCb) {}
            }
        });
    }

    var FAN_ROSTER_BASELINE_KEY = 'sg_fan_roster_baseline';
    var SOFT_ROSTER_SCAN_FOR_KEY = 'sg_roster_scan_for';
    var FAN_LEDGER_SNAP_KEY = 'sg_fan_ledger_snapshot';
    var MORNING_FULL_SCAN_DAY_KEY = 'sg_fan_roster_morning_day';
    var OWN_PROFILE_F_READY_KEY = 'dan_own_profile_f_ready';
    /** 4.6.75：本软窗导航相位 profile|followers，禁止主页↔列表乒乓 */
    var ROSTER_NAV_PHASE_KEY = 'sg_roster_nav_phase';

    function getRosterNavPhase() {
        try {
            var p = sessionStorage.getItem(ROSTER_NAV_PHASE_KEY) || '';
            if (p === 'followers' || p === 'profile') return p;
        } catch (e) {}
        try {
            if (sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1') return 'followers';
        } catch (e2) {}
        return 'profile';
    }

    function setRosterNavPhase(phase, why) {
        try {
            sessionStorage.setItem(ROSTER_NAV_PHASE_KEY, phase === 'followers' ? 'followers' : 'profile');
            console.log('[粉丝对账] nav_phase=' + phase + ' why=' + (why || ''));
        } catch (e) {}
    }

    function markProfileFReady(f, why) {
        try { sessionStorage.setItem(OWN_PROFILE_F_READY_KEY, '1'); } catch (e0) {}
        try { sessionStorage.removeItem('dan_profile_f_read_waits'); } catch (e1) {}
        setRosterNavPhase('followers', why || 'f_ready');
        if (f > 0) {
            try {
                var my = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || '');
                localStorage.setItem('sg_own_follower_count', JSON.stringify({
                    n: f, handle: my || '', at: Date.now()
                }));
            } catch (eC) {}
        }
    }
    var STALE_NO_REPLY_MS = 48 * 60 * 60 * 1000;

    function rosterShanghaiDateKey() {
        try {
            if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiDateKey) return TimeUtil.shanghaiDateKey();
        } catch (eTu) {}
        try {
            var d = new Date(Date.now() + 8 * 3600000);
            return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
        } catch (eD) { return ''; }
    }

    function hasLocalDmSendEvidence(entry) {
        if (!entry || typeof entry !== 'object') return false;
        return !!(entry.iceSentAt || entry.adSentAt || entry.kickSentAt);
    }

    /** 每日早间（私信工作窗内首次 outbound）强制全量扫 + OPS 对账 */
    function maybeMorningFullScanReset() {
        try {
            var today = rosterShanghaiDateKey();
            if (!today) return false;
            if (localStorage.getItem(MORNING_FULL_SCAN_DAY_KEY) === today) return false;
            var inChatHours = true;
            try {
                if (typeof TimeUtil !== 'undefined' && TimeUtil.isWithinChatHours) inChatHours = !!TimeUtil.isWithinChatHours();
            } catch (eH) {}
            if (!inChatHours) return false;
            localStorage.setItem(MORNING_FULL_SCAN_DAY_KEY, today);
            clearFanRosterBaseline('morning_full_scan');
            clearIceTaskQueue('morning_full_scan');
            try { sessionStorage.removeItem('dan_roster_profile_gap_retry'); } catch (eR) {}
            try { sessionStorage.removeItem(SOFT_ROSTER_SCAN_FOR_KEY); } catch (eS) {}
            clearOwnProfileFollowerReady('morning_full_scan');
            try {
                showToast('📋 早间全量扫：对齐主页关注者并与 OPS 对账', '#1d9bf0', 3200);
            } catch (eT) {}
            console.log('[粉丝队列] 早间全量扫 reset @' + today);
            return true;
        } catch (e) { return false; }
    }

    function markDmVerified(handle, note) {
        handle = normalizeChatHandle(handle);
        if (!handle) return;
        try {
            var db = loadTargetDB();
            if (!db[handle]) db[handle] = { round: 0, firstSeen: Date.now() };
            db[handle].dmVerifiedAt = Date.now();
            if (note) db[handle].dmVerifyNote = String(note);
            saveTargetDB(db);
        } catch (eM) {}
    }

    /**
     * C2 文案检测多语言词表（简中/繁中/英/日）。优先 data-testid，文案仅兜底。
     * 日文避免过短裸词（勿单独匹配「ブロック」）。
     */
    var CHAT_I18N = {
        followersLabel: /关注者|關注者|跟隨者|Followers|フォロワー/i,
        followingLabel: /正在关注|正在關注|正在跟隨|Following|フォロー中|フォローしています/i,
        theyBlockedUs: /已屏蔽你|已封鎖你|已屏蔽您|has\s+blocked\s+you|blocked\s+you|Blocks\s+you|あなたをブロック|ブロックされています|このアカウントはあなたをブロック/i,
        protectedPosts: /这些帖子已?受到?保护|這些貼文已?受保護|這些帖子已?受保護|貼文已?受保護|受到保护|受到保護|已受保護|These posts are protected|Posts are protected|This account.?s posts are protected|Only approved followers|只有经过批准的关注者|只有獲批准的跟隨者|只有已核准的跟隨者|このアカウントのポストは保護|このアカウントは非公開|承認されたフォロワー/i,
        accountGone: /此账号不存在|此帳號不存在|账号不存在|帳號不存在|账号已?被?(?:冻结|停用|封禁|暂停)|帳號已?被?(?:凍結|停用|封禁|暫停)|已被(?:冻结|凍結|停用|封禁|暂停|暫停)|This account (?:doesn'?t|does not) exist|Account (?:doesn'?t|does not) exist|account\s+(?:(?:has been|was|is|is being)\s+)?(?:permanently\s+)?suspended|permanently suspended|account is temporarily unavailable|temporarily unavailable|アカウントは存在しません|このアカウントは存在しません|アカウント(?:は|が)凍結|凍結されています/i,
        dmAria: /^(Message|私信|訊息|メッセージ|Send a message|ダイレクトメッセージ)/i
    };

    function parseCompactCount(raw) {
        var s = String(raw || '').replace(/,/g, '').replace(/\s+/g, '').trim();
        if (!s) return 0;
        var m = s.match(/^([\d.]+)\s*([KkMm万萬])?$/);
        if (!m) {
            var digits = s.replace(/[^\d]/g, '');
            return digits ? (parseInt(digits, 10) || 0) : 0;
        }
        var n = parseFloat(m[1]);
        if (!(n >= 0)) return 0;
        var u = m[2] || '';
        if (/[Kk]/.test(u)) n *= 1000;
        else if (/[Mm]/.test(u)) n *= 1000000;
        else if (/万|萬/.test(u)) n *= 10000;
        return Math.round(n) || 0;
    }

    function clearOwnProfileFollowerReady(why) {
        try { sessionStorage.removeItem(OWN_PROFILE_F_READY_KEY); } catch (e0) {}
        try { sessionStorage.removeItem('dan_profile_f_read_waits'); } catch (e1) {}
        try { sessionStorage.removeItem('sg_followers_nav_at'); } catch (e2) {}
        try { sessionStorage.removeItem('sg_profile_f_nav_at'); } catch (e3) {}
        setRosterNavPhase('profile', why || 'clear_f');
        if (why) console.log('[粉丝对账] 清资料页 F 标记 why=' + why);
    }

    /** 本号资料主页（非粉丝列表）：读 F 必须停在此页 */
    function isMyProfilePage() {
        try {
            if (isFollowersListPath(window.location.pathname)) return false;
            var segs = String(window.location.pathname || '').split('/').filter(Boolean);
            if (segs.length !== 1) return false;
            if (/^(home|explore|search|i|settings|messages|notifications|compose)$/i.test(segs[0])) return false;
            var my = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || '');
            return !!my && normalizeChatHandle(segs[0]) === my;
        } catch (e) { return false; }
    }

    /**
     * 关注者 F 须在资料主页读到正数才 ready。
     * 禁止 waits 满就带 F=0 进粉丝列表（否则封口上传 F=0，OPS 黄标）。
     * @returns {{ ready: boolean, f: number, needNav?: boolean, handle?: string }}
     */
    function ensureOwnProfileFollowerCount() {
        var my = '';
        try { my = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || ''); } catch (e0) { my = ''; }
        if (!my) return { ready: false, f: 0, needNav: false };
        var cachedOnly = 0;
        try {
            var c0 = JSON.parse(localStorage.getItem('sg_own_follower_count') || 'null');
            if (c0 && c0.n > 0 && (!c0.handle || normalizeChatHandle(c0.handle) === my)) {
                if (Date.now() - (c0.at || 0) < 36 * 3600 * 1000) cachedOnly = parseInt(c0.n, 10) || 0;
            }
        } catch (eC0) { cachedOnly = 0; }
        if (sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1' && cachedOnly > 0) {
            setRosterNavPhase('followers', 'cached_ready');
            return { ready: true, f: cachedOnly };
        }
        if (sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1' && cachedOnly <= 0) {
            // 假 ready（曾 F=0 放行）→ 清掉重读
            clearOwnProfileFollowerReady('stale_zero');
        }
        if (!isMyProfilePage()) {
            return { ready: false, f: 0, needNav: true, handle: my };
        }
        var f = 0;
        try { f = readOwnFollowerCount() || 0; } catch (eF) { f = 0; }
        var waits = (parseInt(sessionStorage.getItem('dan_profile_f_read_waits') || '0', 10) || 0) + 1;
        sessionStorage.setItem('dan_profile_f_read_waits', String(waits));
        if (f > 0) {
            markProfileFReady(f, 'profile_dom');
            try { showToast('📊 主页关注者 ' + f + '，进粉丝列表登记', '#1d9bf0', 2200); } catch (eT) {}
            console.log('[粉丝对账] 资料页读到 F=' + f);
            return { ready: true, f: f };
        }
        // 仍 0：软愈重载一次 DOM，禁止带 0 进粉丝列表
        if (waits === 6 && sessionStorage.getItem('dan_profile_f_reloaded') !== '1') {
            sessionStorage.setItem('dan_profile_f_reloaded', '1');
            try { requestSharedSoftHealChat('profile_f_zero'); } catch (eH) {}
            try { showToast('⏳ 主页关注者未挂上，刷新再读…', '#faad14', 1800); } catch (eT2) {}
            return { ready: false, f: 0 };
        }
        if (waits >= 18) {
            // 极端：DOM 始终无数字 —— 仍禁止假 ready；允许用近期缓存若有
            if (cachedOnly > 0) {
                markProfileFReady(cachedOnly, 'profile_cache_fallback');
                console.warn('[粉丝对账] 资料页 DOM 无 F，用缓存 F=' + cachedOnly);
                return { ready: true, f: cachedOnly };
            }
            try { showToast('⚠ 主页关注者读不到，停在资料页重试', '#f85149', 2500); } catch (eT3) {}
            console.warn('[粉丝对账] 资料页 F 仍为 0 waits=' + waits + '，不进粉丝列表');
            return { ready: false, f: 0 };
        }
        try { showToast('⏳ 读主页关注者…(' + waits + ')', '#faad14', 1000); } catch (eTw) {}
        return { ready: false, f: 0 };
    }

    /** 封口前：F>0 用缓存；本窗已进 followers 相位禁止回主页 */
    function deferSealUntilFollowerCount(reason) {
        var F = 0;
        try { F = readOwnFollowerCount() || 0; } catch (eF) { F = 0; }
        if (F > 0) return { defer: false, f: F };
        // 4.6.75：已读过 F / 已在列表相位 → 绝不回主页（列表 DOM 读 F=0 是常态）
        if (getRosterNavPhase() === 'followers' ||
            sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1') {
            try {
                var cached = JSON.parse(localStorage.getItem('sg_own_follower_count') || 'null');
                if (cached && cached.n > 0) F = parseInt(cached.n, 10) || 0;
            } catch (eC) {}
            return { defer: false, f: F };
        }
        var tried = sessionStorage.getItem('dan_seal_need_f') === '1';
        if (tried && isMyProfilePage()) {
            var waits = (parseInt(sessionStorage.getItem('dan_seal_f_waits') || '0', 10) || 0) + 1;
            sessionStorage.setItem('dan_seal_f_waits', String(waits));
            try { F = readOwnFollowerCount() || 0; } catch (e2) { F = 0; }
            if (F > 0) {
                markProfileFReady(F, 'pre_seal_profile');
                sessionStorage.removeItem('dan_seal_need_f');
                sessionStorage.removeItem('dan_seal_f_waits');
                return { defer: false, f: F };
            }
            if (waits < 12) {
                try { showToast('⏳ 封口前读主页关注者…', '#faad14', 1200); } catch (eT) {}
                return { defer: true, f: 0 };
            }
            console.warn('[粉丝对账] 封口前 F 仍 0，带 0 封口（OPS 将黄标） reason=' + reason);
            sessionStorage.removeItem('dan_seal_need_f');
            return { defer: false, f: 0 };
        }
        sessionStorage.setItem('dan_seal_need_f', '1');
        sessionStorage.setItem('dan_seal_f_waits', '0');
        var my = '';
        try { my = normalizeChatHandle(getMyHandle() || sessionStorage.getItem('dan_target_username') || ''); } catch (eM) { my = ''; }
        if (my && !isMyProfilePage()) {
            console.warn('[粉丝对账] 封口前尚未读 F → 资料页 reason=' + reason);
            try { showToast('📋 封口前先读主页关注者', '#faad14', 2200); } catch (eT) {}
            try { chatGo('/' + my, true); } catch (eGo) {}
        }
        return { defer: true, f: 0 };
    }

    function getFanQueueItemForHandle(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return null;
        var doing = iceQueueCurrentDoing();
        if (doing && normalizeChatHandle(doing.handle) === handle) return doing;
        try {
            var q = loadIceTaskQueue();
            var idx = iceQueueFindIndex(q, handle);
            if (idx >= 0) return q.items[idx];
        } catch (e) {}
        return null;
    }

    function isFanLedgerOutboundMode() {
        try {
            if (sessionStorage.getItem('dan_dm_entry_via') === 'fan_roster') return true;
            var ph = getChatPhase();
            if (ph === 'outbound' || ph === 'followup') return true;
        } catch (e) {}
        return false;
    }

    /** DM 内按台账执法：先同步对方文本，再判 48h / 拒 / 已屏蔽 → 写台账终态 */
    function enforceLedgerOnDmOpen(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return { action: 'continue' };
        if (pageLooksTheyBlockedUs()) {
            return { action: 'skip', reason: 'they_blocked_us', block: true };
        }
        var peers = [];
        try { peers = collectExtraPeerTexts(handle) || []; } catch (eP) { peers = []; }
        if (peers.length) {
            try {
                var db = loadTargetDB();
                if (!db[handle]) db[handle] = { round: getUserRound(handle) || 0, firstSeen: Date.now() };
                if (!db[handle].lastInboundAt) db[handle].lastInboundAt = Date.now();
                saveTargetDB(db);
            } catch (eUp) {}
        }
        try {
            if (peerTextsIndicateStop(peers)) {
                return { action: 'skip', reason: 'peer_stop_text', block: true };
            }
        } catch (eSt) {}
        // 48h：必须在同步 peers/lastInboundAt 之后，避免会话里已有回复却被误拉黑
        var entry = {};
        try { entry = loadTargetDB()[handle] || {}; } catch (eE) { entry = {}; }
        if (entry.iceSentAt && !entry.lastInboundAt) {
            var lastOut = Number(entry.lastDM) || Number(entry.iceSentAt) || 0;
            if (lastOut && Date.now() - lastOut >= STALE_NO_REPLY_MS) {
                return { action: 'skip', reason: 'stale_48h_no_reply', block: true };
            }
        }
        return { action: 'continue', peers: peers };
    }

    function applyLedgerSkipFromEnforce(handle, en) {
        if (!en || en.action !== 'skip') return false;
        if (en.block) {
            try { markPeerBlocked(handle, en.reason); } catch (eB) {}
        }
        try { iceQueueMark(handle, 'skipped', en.reason, 'reject'); } catch (eIq) {}
        try { markDmVerified(handle, en.reason); } catch (eV) {}
        return true;
    }

    /** 本号「关注者」数：须在资料主页读；优先 /followers 链接数字，排除 Following；读到则缓存 */
    function readOwnFollowerCount() {
        var my = '';
        try { my = normalizeChatHandle(getMyHandle() || ''); } catch (e0) { my = ''; }
        if (!my) {
            try {
                my = normalizeChatHandle(
                    sessionStorage.getItem('dan_target_username') ||
                    localStorage.getItem('matrix_my_handle') || ''
                );
            } catch (e1) { my = ''; }
        }
        var best = 0;
        var bestAnySelfPath = 0;
        try {
            var pathHandle = '';
            try {
                var segs = String(window.location.pathname || '').split('/').filter(Boolean);
                if (segs[0] && !/^(home|explore|search|i|settings|messages|notifications)$/i.test(segs[0])) {
                    pathHandle = normalizeChatHandle(segs[0]);
                }
            } catch (ePh) { pathHandle = ''; }
            var selfKey = my || pathHandle;
            var links = document.querySelectorAll('a[href*="/followers"]');
            for (var i = 0; i < links.length; i++) {
                var a = links[i];
                if (!a) continue;
                var href = String(a.getAttribute('href') || '');
                if (/\/following(?:[/?#]|$)/i.test(href)) continue;
                if (!/\/followers(?:[/?#]|$)/i.test(href)) continue;
                if (/\/verified_followers|\/followers_you_follow/i.test(href)) continue;
                var mPath = href.match(/\/([A-Za-z0-9_]+)\/followers(?:[/?#]|$)/i);
                var linkHandle = mPath ? normalizeChatHandle(mPath[1]) : '';
                var txt = String(a.textContent || a.innerText || '').replace(/\s+/g, ' ').trim();
                if (CHAT_I18N.followingLabel.test(txt) && !CHAT_I18N.followersLabel.test(txt)) continue;
                var numEl = a.querySelector('span span, span');
                var numTxt = numEl ? String(numEl.textContent || '').trim() : '';
                var aria = String(a.getAttribute('aria-label') || '');
                var n = parseCompactCount(numTxt) || parseCompactCount(txt) || parseCompactCount(aria);
                if (!(n > 0) && aria) {
                    var mAria = aria.match(/([\d,.]+)\s*(?:Followers|关注者|關注者|跟隨者|フォロワー)/i)
                        || aria.match(/(?:Followers|关注者|關注者|跟隨者|フォロワー)[^\d]*([\d,.]+)/i);
                    if (mAria) n = parseCompactCount(mAria[1]);
                }
                if (!(n > 0)) continue;
                if (selfKey && linkHandle && linkHandle === selfKey) {
                    if (n > best) best = n;
                } else if (!selfKey || !linkHandle) {
                    if (n > bestAnySelfPath) bestAnySelfPath = n;
                }
            }
            if (best <= 0 && bestAnySelfPath > 0 && selfKey) {
                // 路径已是本号粉丝页时，侧栏/头可能无精确 handle 匹配
                try {
                    if (pathHandle && pathHandle === selfKey) best = bestAnySelfPath;
                } catch (ePath) {}
            }
            if (best <= 0 && bestAnySelfPath > 0 && !my) best = bestAnySelfPath;
        } catch (eL) {}
        if (best <= 0) {
            try {
                var body = String(document.body && document.body.innerText || '');
                var re = /(\d[\d,.]*\s*[KkMm万萬]?)\s*(关注者|關注者|跟隨者|Followers|フォロワー)/i;
                var m2 = body.match(re);
                if (m2) best = parseCompactCount(m2[1]) || 0;
            } catch (eB) {}
        }
        if (best > 0) {
            try {
                localStorage.setItem('sg_own_follower_count', JSON.stringify({
                    n: best,
                    handle: my || '',
                    at: Date.now()
                }));
            } catch (eC) {}
            return best;
        }
        // 封口时常停在粉丝列表，头像区数字偶发未挂：用近期缓存（≤36h）
        try {
            var cached = JSON.parse(localStorage.getItem('sg_own_follower_count') || 'null');
            if (cached && cached.n > 0 && (!my || !cached.handle || normalizeChatHandle(cached.handle) === my)) {
                if (Date.now() - (cached.at || 0) < 36 * 3600 * 1000) return parseInt(cached.n, 10) || 0;
            }
        } catch (eCache) {}
        return 0;
    }

    function loadFanRosterBaselineObj() {
        try { return JSON.parse(localStorage.getItem(FAN_ROSTER_BASELINE_KEY) || 'null') || null; } catch (e) { return null; }
    }

    function pageLooksTheyBlockedUs(pageText) {
        var t = String(pageText || '');
        if (!t) {
            try { t = String(document.body && document.body.innerText || ''); } catch (e) { t = ''; }
        }
        return CHAT_I18N.theyBlockedUs.test(t);
    }

    function pageLooksProtectedAccount(pageText) {
        var t = String(pageText || '');
        if (!t) {
            try { t = String(document.body && document.body.innerText || ''); } catch (e) { t = ''; }
        }
        return CHAT_I18N.protectedPosts.test(t);
    }

    function pageLooksAccountGone(pageText) {
        var t = String(pageText || '');
        if (!t) {
            try { t = String(document.body && document.body.innerText || ''); } catch (e) { t = ''; }
        }
        return CHAT_I18N.accountGone.test(t);
    }

    /** 台账单行：队列 ∪ targetDB；无队列也必须带 status 反馈 */
    function buildFanLedgerRow(handle, queueItem) {
        handle = normalizeChatHandle(handle);
        if (!handle) return null;
        var entry = {};
        try { entry = loadTargetDB()[handle] || {}; } catch (eE) { entry = {}; }
        var qIt = queueItem || null;
        if (!qIt) {
            try {
                var q = loadIceTaskQueue();
                var idx = iceQueueFindIndex(q, handle);
                if (idx >= 0) qIt = q.items[idx];
            } catch (eQ) { qIt = null; }
        }
        var rejectDB = null;
        try { rejectDB = getDB('dan_reject_users'); } catch (eR) { rejectDB = null; }
        var rejected = !!(entry.rejectSentAt || (rejectDB && rejectDB.has && rejectDB.has(handle)));
        var blocked = !!entry.blockedAt;
        var round = 0;
        try { round = getEffectiveFanRound(handle); } catch (eRd) {
            round = parseInt(entry.round, 10) || 0;
        }
        var dmVerifiedAt = entry.dmVerifiedAt || 0;
        var needsVerify = !blocked && !rejected && !entry.done && !dmVerifiedAt;
        var queueStatus = qIt ? String(qIt.status || '') : '';
        var queueKind = qIt ? String(qIt.kind || '') : '';
        var queueReason = qIt ? String(qIt.reason || '') : '';
        // 4.6.70：库存粉无队列行时也要有明确反馈，禁止空 status
        if (!queueStatus) {
            if (blocked) {
                queueStatus = 'skipped';
                queueKind = queueKind || 'block';
                queueReason = queueReason || String(entry.blockReason || 'blocked');
            } else if (rejected) {
                queueStatus = 'skipped';
                queueKind = queueKind || 'reject';
                queueReason = queueReason || 'reject';
            } else if (entry.done || round >= 3) {
                queueStatus = 'done';
                queueKind = queueKind || 'kick';
                queueReason = queueReason || 'completed';
            } else {
                try {
                    var completedBackend = [];
                    try { completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]'); } catch (eC) {}
                    var sg = ensureChatFreeze();
                    var cls = classifyFanRosterAction(handle, rejectDB, completedBackend, sg);
                    queueStatus = cls.status || 'pending';
                    queueKind = cls.kind || 'ice';
                    queueReason = cls.reason || 'inventory';
                } catch (eCls) {
                    queueStatus = 'pending';
                    queueKind = queueKind || 'ice';
                    queueReason = queueReason || 'inventory';
                }
            }
        }
        return {
            handle: handle,
            displayName: String((qIt && qIt.displayName) || entry.displayName || '').trim(),
            round: round,
            queueStatus: queueStatus,
            queueKind: queueKind,
            queueReason: queueReason,
            blocked: blocked,
            blockReason: String(entry.blockReason || ''),
            rejected: rejected,
            done: !!entry.done,
            firstSeen: entry.firstSeen || 0,
            iceSentAt: entry.iceSentAt || 0,
            adSentAt: entry.adSentAt || 0,
            kickSentAt: entry.kickSentAt || 0,
            blockedAt: entry.blockedAt || 0,
            lastInboundAt: entry.lastInboundAt || 0,
            dmVerifiedAt: dmVerifiedAt,
            needsVerify: !!needsVerify
        };
    }

    /** 4.6.70：全量台账 = 本号 DB ∪ sessionSeen ∪ queue；每人必有 status */
    function buildFanLedgerSnapshot(reason) {
        var q = loadIceTaskQueue();
        var st = iceQueueStats(q);
        var seen = [];
        try { seen = getSessionList() || []; } catch (eS) { seen = []; }
        var map = {};
        var items = [];
        var i;
        function pushRow(h, qIt) {
            h = normalizeChatHandle(h);
            if (!h || map[h]) return;
            var row = buildFanLedgerRow(h, qIt || null);
            if (!row) return;
            map[h] = 1;
            items.push(row);
        }
        for (i = 0; i < (q.items || []).length; i++) {
            var it = q.items[i];
            if (!it || !it.handle) continue;
            pushRow(it.handle, it);
        }
        for (i = 0; i < seen.length; i++) {
            pushRow(seen[i], null);
        }
        // 本号目标库全员（防浅扫漏传旧粉）
        try {
            var db = loadTargetDB() || {};
            for (var raw in db) {
                if (!Object.prototype.hasOwnProperty.call(db, raw)) continue;
                pushRow(raw, null);
            }
        } catch (eDb) {}
        // 4.6.116：botHandle 与 currentLedgerBotHandle 共用同一链，禁止各写一套
        var bot = '';
        try {
            bot = normalizeChatHandle(
                getMyHandle() ||
                sessionStorage.getItem('dan_target_username') ||
                localStorage.getItem('matrix_my_handle') ||
                localStorage.getItem('matrix_extracted_handle') ||
                ''
            );
        } catch (eB) { bot = ''; }
        var profileFollowers = 0;
        try { profileFollowers = readOwnFollowerCount(); } catch (eF) { profileFollowers = 0; }
        var cellsSeen = seen.length;
        var mismatch = st.total < cellsSeen;
        var profileGap = profileFollowers > 0 && cellsSeen + 2 < profileFollowers;
        var ledgerIncomplete = profileFollowers > 0 && items.length + 2 < profileFollowers;
        var expectedNew = 0;
        try {
            var base = loadFanRosterBaselineObj();
            if (base && base.followerCount > 0 && profileFollowers > 0) {
                expectedNew = Math.max(0, profileFollowers - (parseInt(base.followerCount, 10) || 0));
            }
        } catch (eEx) { expectedNew = 0; }
        var verifiedCount = 0;
        for (i = 0; i < items.length; i++) {
            if (items[i] && items[i].dmVerifiedAt) verifiedCount++;
        }
        // 4.6.109：当日私信时长帽随台账上报，OPS 后台可观测出站/箱/总分钟数（原只有本地面板可见）
        var chatMin = { total: 0, outbound: 0, inbox: 0 };
        try {
            var sgT = ensureChatDayStats(JSON.parse(localStorage.getItem('sg_state') || '{}'));
            chatMin.total = Math.round((sgT.chatTotalToday || 0) / 60);
            chatMin.outbound = Math.round((sgT.chatOutboundToday || 0) / 60);
            chatMin.inbox = Math.round((sgT.chatInboxToday || 0) / 60);
        } catch (eMin) { chatMin = { total: 0, outbound: 0, inbox: 0 }; }
        var snap = {
            botHandle: bot,
            bot_id: bot,
            pulseId: q.pulseId || '',
            reason: String(reason || ''),
            sealed: !!q.sealed,
            sealedAt: Date.now(),
            profileFollowers: profileFollowers,
            cellsSeen: cellsSeen,
            queueTotal: st.total,
            itemCount: items.length,
            pending: st.pending,
            skipped: st.skipped,
            deferred: st.deferred,
            doing: st.doing,
            done: st.done,
            failed: st.failed || 0,
            mismatch: !!mismatch,
            profileGap: !!profileGap,
            ledgerIncomplete: !!ledgerIncomplete,
            expectedNew: expectedNew,
            verifiedCount: verifiedCount,
            chatTotalTodayMin: chatMin.total,
            chatOutboundTodayMin: chatMin.outbound,
            chatInboxTodayMin: chatMin.inbox,
            items: items
        };
        try { sessionStorage.setItem(FAN_LEDGER_SNAP_KEY, JSON.stringify({
            botHandle: snap.botHandle,
            pulseId: snap.pulseId,
            profileFollowers: snap.profileFollowers,
            cellsSeen: snap.cellsSeen,
            queueTotal: snap.queueTotal,
            itemCount: snap.itemCount,
            pending: snap.pending,
            skipped: snap.skipped,
            sealedAt: snap.sealedAt,
            ledgerIncomplete: snap.ledgerIncomplete
        })); } catch (eC) {}
        if (ledgerIncomplete) {
            try {
                console.warn('[台账] 不全 F=' + profileFollowers + ' items=' + items.length + ' cells=' + cellsSeen + ' why=' + (reason || ''));
                if (typeof SgTelemetry !== 'undefined') {
                    SgTelemetry.emit('chat.ledger_incomplete', {
                        profileFollowers: profileFollowers,
                        itemCount: items.length,
                        cellsSeen: cellsSeen,
                        reason: reason || '',
                        pulseId: q.pulseId || ''
                    });
                }
            } catch (eInc) {}
        }
        return snap;
    }

    /** 4.6.71：主页 F 可靠且台账行数明显不足 → 视为不全 */
    function isLedgerIncompleteNow() {
        var F = 0;
        try { F = readOwnFollowerCount() || 0; } catch (eF) { F = 0; }
        if (!(F > 0)) return false;
        var itemCount = 0;
        var cells = 0;
        try {
            var snap = buildFanLedgerSnapshot('incomplete_check');
            if (snap && snap.ledgerIncomplete) return true;
            itemCount = (snap && snap.itemCount) || 0;
        } catch (eS) { itemCount = 0; }
        try { cells = getSessionList().length; } catch (eC) { cells = 0; }
        if (itemCount + 2 < F) return true;
        if (cells + 2 < F && !hasFanRosterBaseline()) return true;
        return false;
    }

    var LEDGER_DIRTY_KEY = 'sg_ledger_dirty';
    var LEDGER_SYNC_INTERVAL_MS = 180000;
    var LEDGER_DIRTY_DEBOUNCE_MS = 5000;
    var LEDGER_ROSTER_CHUNK = 400;
    var _ledgerSyncTimer = null;
    var _ledgerSyncInflight = false;
    var _ledgerDirtyTimer = null;

    function markLedgerDirty(why) {
        try { sessionStorage.setItem(LEDGER_DIRTY_KEY, String(Date.now()) + '|' + String(why || '')); } catch (e) {}
        try { scheduleLedgerDirtyFlush(why || 'dirty'); } catch (eSch) {}
    }

    function clearLedgerDirty() {
        try { sessionStorage.removeItem(LEDGER_DIRTY_KEY); } catch (e) {}
    }

    /** 4.6.71：dirty 后 5s 防抖轻量 POST（不 GET）；软窗外跳过；inflight/seal 再延 */
    function scheduleLedgerDirtyFlush(why) {
        if (_ledgerDirtyTimer) {
            try { clearTimeout(_ledgerDirtyTimer); } catch (eClr) {}
            _ledgerDirtyTimer = null;
        }
        _ledgerDirtyTimer = setTimeout(function () {
            _ledgerDirtyTimer = null;
            flushLedgerDirty(why || 'dirty_flush');
        }, LEDGER_DIRTY_DEBOUNCE_MS);
    }

    function flushLedgerDirty(why) {
        try {
            if (!isLedgerOpsSyncPhase()) return;
        } catch (eGate) { return; }
        if (_ledgerSyncInflight || sessionStorage.getItem('dan_ice_seal_inflight') === '1') {
            scheduleLedgerDirtyFlush(why || 'dirty_retry');
            return;
        }
        var snap = null;
        try { snap = buildFanLedgerSnapshot(why || 'dirty_flush'); } catch (eSnap) { snap = null; }
        if (!snap) return;
        console.log('[台账] dirty flush why=' + (why || '') + ' items=' + (snap.itemCount || 0));
        opsDmRosterSync(snap);
    }

    function currentLedgerBotHandle() {
        try {
            // 4.6.116：与遥测 getBotId 对齐，补 matrix_extracted_handle 兜底（scheduler-core 换号绑定时写入，DOM/dan_worker_id 失效时的最可靠来源）
            return normalizeChatHandle(
                getMyHandle() ||
                sessionStorage.getItem('dan_target_username') ||
                localStorage.getItem('matrix_my_handle') ||
                localStorage.getItem('matrix_extracted_handle') ||
                ''
            );
        } catch (e) { return ''; }
    }

    /** 失败进出箱，由 SW failover 重试 */
    function enqueueOpsOutbox(type, payload) {
        try {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
            chrome.runtime.sendMessage({
                action: 'ops_outbox_enqueue',
                entry: {
                    type: type,
                    payload: payload,
                    botHandle: currentLedgerBotHandle(),
                    enqueuedAt: Date.now()
                }
            }, function () {
                try { if (chrome.runtime.lastError) console.warn('[台账] outbox enqueue', chrome.runtime.lastError.message); } catch (e) {}
            });
        } catch (eEnq) {
            console.warn('[台账] outbox enqueue 异常', eEnq && eEnq.message);
        }
    }

    /**
     * 4.6.70：全量台账分片上传；botKey=本号 handle；失败进出箱。
     * @param {object} snapshot
     * @param {function(boolean)=} callback
     */
    function opsDmRosterSync(snapshot, callback) {
        var done = typeof callback === 'function' ? callback : function () {};
        try {
            if (!snapshot || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
                done(false);
                return;
            }
            var bot = normalizeChatHandle(snapshot.botHandle || currentLedgerBotHandle());
            if (!bot) {
                console.warn('[台账] roster 上传跳过：无本号 handle');
                // 4.6.116：禁止静默跳过——无 handle 也必须遥测，OPS 可观测
                try {
                    if (typeof SgTelemetry !== 'undefined') {
                        SgTelemetry.emit('chat.ledger_sync', {
                            why: 'roster_skip',
                            ok: false,
                            reason: 'no_bot_handle',
                            itemCount: (snapshot && snapshot.itemCount) || 0
                        });
                    }
                } catch (eT0) {}
                done(false);
                return;
            }
            var items = Array.isArray(snapshot.items) ? snapshot.items : [];
            var allHandles = [];
            for (var hi = 0; hi < items.length; hi++) {
                var hh = normalizeChatHandle(items[hi] && items[hi].handle);
                if (hh) allHandles.push(hh);
            }
            var chunks = [];
            if (!items.length) {
                chunks = [[]];
            } else {
                for (var c = 0; c < items.length; c += LEDGER_ROSTER_CHUNK) {
                    chunks.push(items.slice(c, c + LEDGER_ROSTER_CHUNK));
                }
            }
            var chunkTotal = chunks.length;
            var idx = 0;
            var anyFail = false;

            function sendOne() {
                if (idx >= chunkTotal) {
                    if (anyFail) {
                        enqueueOpsOutbox('dm_roster', Object.assign({}, snapshot, {
                            bot_id: bot,
                            botHandle: bot,
                            items: items,
                            allHandles: allHandles,
                            chunkIndex: 0,
                            chunkTotal: 1,
                            finalize_stale: true
                        }));
                        done(false);
                        return;
                    }
                    clearLedgerDirty();
                    done(true);
                    return;
                }
                var isFinal = (idx === chunkTotal - 1);
                var payload = Object.assign({}, snapshot, {
                    bot_id: bot,
                    botHandle: bot,
                    items: chunks[idx],
                    allHandles: isFinal ? allHandles : [],
                    chunkIndex: idx,
                    chunkTotal: chunkTotal,
                    finalize_stale: !!isFinal,
                    itemCount: items.length,
                    truncated: false
                });
                var sentIdx = idx;
                idx += 1;
                var timer = setTimeout(function () {
                    anyFail = true;
                    console.warn('[台账] roster chunk timeout', sentIdx, '/', chunkTotal);
                    sendOne();
                }, 12000);
                chrome.runtime.sendMessage({
                    action: 'ops_dm_roster',
                    bot_id: bot,
                    payload: payload
                }, function (r) {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) {
                        anyFail = true;
                        console.warn('[台账] roster 上传失败', chrome.runtime.lastError.message);
                    } else if (!r || r.ok === false) {
                        anyFail = true;
                        console.warn('[台账] roster 上传拒收', r && (r.msg || r.error));
                    }
                    sendOne();
                });
            }
            sendOne();
        } catch (eSync) {
            console.warn('[台账] roster 上传异常', eSync && eSync.message);
            try {
                if (snapshot) {
                    enqueueOpsOutbox('dm_roster', Object.assign({}, snapshot, {
                        bot_id: currentLedgerBotHandle(),
                        botHandle: currentLedgerBotHandle()
                    }));
                }
            } catch (e2) {}
            done(false);
        }
    }

    /**
     * 4.6.70：拉 OPS → 灌债/重分类 → 可选全量 POST。封口/心跳/排空共用。
     */
    function syncLedgerWithOps(opts, callback) {
        opts = opts || {};
        var done = typeof callback === 'function' ? callback : function () {};
        if (_ledgerSyncInflight) {
            done({ ok: false, busy: true });
            return;
        }
        _ledgerSyncInflight = true;
        var why = String(opts.reason || 'sync');
        var allowPost = opts.allowPost !== false;
        var finished = false;
        function finish(res) {
            if (finished) return;
            finished = true;
            _ledgerSyncInflight = false;
            done(res || { ok: false });
        }
        var timer = setTimeout(function () {
            console.warn('[台账] sync timeout why=' + why);
            finish({ ok: false, msg: 'timeout' });
        }, 15000);
        try {
            opsDmRosterFetch(function (r) {
                var added = 0;
                try {
                    if (r && r.ok && Array.isArray(r.items)) {
                        added = seedOpsRosterDebtToQueue(why, r.items) || 0;
                        try { reclassifyIceQueueFromOps(); } catch (eRc) {}
                        try { sortIceQueueForDrain(); } catch (eSo) {}
                    }
                } catch (eSeed) {}
                if (!allowPost) {
                    clearTimeout(timer);
                    finish({ ok: true, posted: false, added: added });
                    return;
                }
                var snap = null;
                try { snap = buildFanLedgerSnapshot(why); } catch (eSnap) { snap = null; }
                if (!snap) {
                    clearTimeout(timer);
                    finish({ ok: true, posted: false, added: added });
                    return;
                }
                opsDmRosterSync(snap, function (ok) {
                    clearTimeout(timer);
                    try {
                        if (typeof SgTelemetry !== 'undefined') {
                            SgTelemetry.emit('chat.ledger_sync', {
                                why: why,
                                ok: !!ok,
                                added: added,
                                itemCount: snap.itemCount || 0,
                                profileFollowers: snap.profileFollowers || 0,
                                incomplete: !!snap.ledgerIncomplete
                            });
                        }
                    } catch (eT) {}
                    console.log('[台账] sync why=' + why + ' ok=' + !!ok + ' added=' + added + ' items=' + (snap.itemCount || 0));
                    finish({ ok: !!ok, posted: true, added: added, incomplete: !!snap.ledgerIncomplete });
                });
            });
        } catch (eSync) {
            clearTimeout(timer);
            finish({ ok: false, msg: String(eSync && eSync.message || eSync) });
        }
    }

    function ensureLedgerSyncHeartbeat() {
        if (_ledgerSyncTimer) return;
        _ledgerSyncTimer = setInterval(function () {
            try {
                var sg = loadSgState();
                if (!isLedgerOpsSyncPhase(sg)) return;
                var allowPost = sessionStorage.getItem('dan_ice_seal_inflight') !== '1';
                // 4.6.81：挂起/下班只养号 → 只 POST 本地快照，勿 GET 覆盖 doing
                if (sg.softRiskChatSuspended || (String(sg.softRiskPhase || '') === 'nurture' && sg.softRiskChatDone)) {
                    if (!allowPost) return;
                    var snapHb = null;
                    try { snapHb = buildFanLedgerSnapshot('heartbeat_soft_post'); } catch (eSn) { snapHb = null; }
                    if (snapHb) opsDmRosterSync(snapHb);
                    return;
                }
                syncLedgerWithOps({ reason: 'heartbeat_180s', allowPost: allowPost });
            } catch (eHb) {}
        }, LEDGER_SYNC_INTERVAL_MS);
        console.log('[台账] 心跳已启动 interval=' + LEDGER_SYNC_INTERVAL_MS);
    }

    /** 当前软风控窗 id（softRiskUntil）；无软窗则空 */
    function softRiskWindowId() {
        try {
            var u = (JSON.parse(localStorage.getItem('sg_state') || '{}').softRiskUntil) || 0;
            return u ? String(u) : '';
        } catch (e) { return ''; }
    }

    /** 本软窗是否已做过粉丝登记/浅扫封口（避免同窗反复清队重扫） */
    function hasSoftWindowRosterScanDone() {
        try {
            var wid = softRiskWindowId();
            if (!wid) return false;
            return sessionStorage.getItem(SOFT_ROSTER_SCAN_FOR_KEY) === wid;
        } catch (e) { return false; }
    }

    function markSoftWindowRosterScanDone(why) {
        try {
            var wid = softRiskWindowId();
            if (!wid) return;
            sessionStorage.setItem(SOFT_ROSTER_SCAN_FOR_KEY, wid);
            try {
                if (typeof SgTelemetry !== 'undefined') {
                    SgTelemetry.emit('chat.fan_roster_scan_once', { softRiskUntil: wid, why: why || '' });
                }
            } catch (eT) {}
        } catch (e) {}
    }

    /** 本账号是否已做过首趟全量粉丝登记（之后每窗只浅扫新粉） */
    function hasFanRosterBaseline() {
        try {
            var b = JSON.parse(localStorage.getItem(FAN_ROSTER_BASELINE_KEY) || 'null');
            if (b && b.at) {
                var h = '';
                try { h = normalizeChatHandle(getMyHandle() || ''); } catch (eH) { h = ''; }
                if (h && b.handle) {
                    var bh = normalizeChatHandle(b.handle);
                    if (bh && bh === h) return true;
                    /* 换号或 handle 不符：不算本号台账 */
                }
                /* 本号未知 / baseline 无 handle：不算，避免脏台账跳过首扫 */
            }
        } catch (e) {}
        // 升级兼容：目标库已有足够登记痕迹 → 视为已首扫，免再滚全表
        try {
            var db = loadTargetDB() || {};
            var n = 0;
            for (var k in db) {
                if (!Object.prototype.hasOwnProperty.call(db, k)) continue;
                var e = db[k];
                if (!e) continue;
                if (e.iceSentAt || e.adSentAt || e.kickSentAt || e.discoveredAt || (parseInt(e.round, 10) || 0) > 0) {
                    n++;
                    if (n >= 8) {
                        markFanRosterBaseline('infer_existing_db', n);
                        return true;
                    }
                }
            }
        } catch (eInf) {}
        return false;
    }

    /** 首扫触底/全量超时封口后落盘；Force 可清掉重做全量 */
    function markFanRosterBaseline(reason, cellsSeen) {
        var payload = {
            at: Date.now(),
            reason: String(reason || ''),
            cellsSeen: Number(cellsSeen) || 0,
            followerCount: 0,
            handle: ''
        };
        try { payload.handle = normalizeChatHandle(getMyHandle() || '') || ''; } catch (eH) {}
        try { payload.followerCount = readOwnFollowerCount() || 0; } catch (eF) { payload.followerCount = 0; }
        try { localStorage.setItem(FAN_ROSTER_BASELINE_KEY, JSON.stringify(payload)); } catch (eS) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.fan_roster_baseline', payload);
            }
        } catch (eT) {}
        console.log('[粉丝队列] 首扫台账已建 cells=' + payload.cellsSeen + ' followers=' + payload.followerCount + ' reason=' + payload.reason);
    }

    function clearFanRosterBaseline(why) {
        try { localStorage.removeItem(FAN_ROSTER_BASELINE_KEY); } catch (e) {}
        try { sessionStorage.removeItem('dan_roster_profile_gap_retry'); } catch (e2) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.fan_roster_baseline_clear', { why: why || '' });
            }
        } catch (eT) {}
    }

    /**
     * 换号对账：live handle 与 dan_target_username 不一致时清破冰会话脏数据，强制本号重扫。
     * @returns {{changed:boolean, live:string, prev:string}}
     */
    function reconcileChatHostIdentity(why) {
        var live = '';
        try { live = normalizeChatHandle(getMyHandle() || ''); } catch (eG) { live = ''; }
        if (!live) {
            try {
                live = normalizeChatHandle(
                    localStorage.getItem('matrix_my_handle') || localStorage.getItem('matrix_extracted_handle') || ''
                );
            } catch (eM) { live = ''; }
        }
        var prev = '';
        try { prev = normalizeChatHandle(sessionStorage.getItem('dan_target_username') || ''); } catch (eP) { prev = ''; }
        if (!live) return { changed: false, live: '', prev: prev };
        // 4.6.75：首次绑定本号 ≠ 换号，禁止清 F-ready / 相位（否则主页↔列表乒乓）
        if (!prev) {
            try { sessionStorage.setItem('dan_target_username', live); } catch (eSet0) {}
            return { changed: false, live: live, prev: '' };
        }
        if (prev === live) {
            try { sessionStorage.setItem('dan_target_username', live); } catch (eSet) {}
            return { changed: false, live: live, prev: prev };
        }
        console.warn('[换号对账] ' + (why || '') + ' prev=@' + (prev || '?') + ' → live=@' + live);
        try { sessionStorage.setItem('dan_target_username', live); } catch (eW) {}
        try { localStorage.setItem('matrix_my_handle', live); } catch (eMh) {}
        try {
            clearIceTaskQueue('host_reconcile_' + (why || ''));
            clearFanRosterBaseline('host_reconcile');
            sessionStorage.setItem('dan_session_scanned', '[]');
            sessionStorage.removeItem(SOFT_ROSTER_SCAN_FOR_KEY);
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.removeItem('current_target');
            sessionStorage.removeItem('dan_ice_seek_scroll');
            sessionStorage.removeItem('dan_fans_back_phase');
            sessionStorage.removeItem('dan_ops_round_refreshed_this_round');
            sessionStorage.removeItem('ops_target_rounds');
            sessionStorage.removeItem('dan_completed_targets');
            clearOwnProfileFollowerReady('host_reconcile');
        } catch (eClr) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.host_reconcile', { why: why || '', prev: prev, live: live });
            }
        } catch (eT) {}
        return { changed: true, live: live, prev: prev };
    }

    /** 可视区全员登记入队（不点进）；返回本屏新增 pending 数 */
    function harvestIceCandidatesToQueue(rejectDB, completedBackend) {
        var added = 0;
        var sg = ensureChatFreeze();
        try {
            if (sessionStorage.getItem('sg_debt_only') === 'true') return 0;
        } catch (eD) {}
        // 4.6.65：有旧未破冰 backlog 时只写库，不把新人塞进 pending ice
        var blockNewIce = false;
        try {
            var baselineOkH = hasFanRosterBaseline();
            var pendingIce = countPendingIceInQueue();
            var dbIce = baselineOkH ? countUnicedBacklogInDb() : 0;
            blockNewIce = baselineOkH && (pendingIce > 0 || dbIce > 0);
        } catch (eBlk) { blockNewIce = false; }
        var stat = { pending: 0, skipped: 0, deferred: 0, freeze: 0, fleet: 0, reject: 0, completed: 0, already: 0, other: 0, ice_deferred_backlog: 0 };
        var cells = document.querySelectorAll('[data-testid="UserCell"]');
        for (var i = 0; i < cells.length; i++) {
            var profileLink = cells[i].querySelector('a[role="link"]');
            if (!profileLink) continue;
            var rawHref = profileLink.getAttribute('href');
            if (!rawHref) continue;
            var userHandle = normalizeChatHandle(rawHref.split('?')[0].split('/').pop());
            if (!userHandle) continue;
            if (getSessionList().includes(userHandle)) continue;
            addSessionList(userHandle);

            if (isFleetHandle(userHandle)) {
                rejectFleetHandle(userHandle);
                iceQueueAdd(userHandle, extractUserCellDisplayName(cells[i]), 'skipped', 'fleet', 'fleet');
                stat.fleet++;
                stat.skipped++;
                continue;
            }
            try { discoverTarget(userHandle, extractUserCellDisplayName(cells[i])); } catch (eDisc) {}

            var cls = classifyFanRosterAction(userHandle, rejectDB, completedBackend, sg);
            if (blockNewIce && cls && cls.status === 'pending' && cls.kind === 'ice') {
                stat.ice_deferred_backlog++;
                continue;
            }
            if (iceQueueAdd(userHandle, extractUserCellDisplayName(cells[i]), cls.status, cls.reason, cls.kind)) {
                if (cls.status === 'pending') { added++; stat.pending++; }
                else if (cls.status === 'skipped') { stat.skipped++; stat[cls.reason] = (stat[cls.reason] || 0) + 1; }
                else if (cls.status === 'deferred') { stat.deferred++; }
                if (cls.reason === 'freeze') stat.freeze++;
            }
        }
        console.log('[粉丝队列] 本屏登记 ' + cells.length + ' 人 → pending=' + stat.pending + ' skipped=' + stat.skipped + '（freeze=' + stat.freeze + '/fleet=' + stat.fleet + '/reject=' + (stat.reject||0) + '/completed=' + (stat.completed||0) + '） deferred=' + stat.deferred + (blockNewIce ? (' · 旧冰优先跳过新人ice=' + stat.ice_deferred_backlog) : ''));
        return added;
    }

    function startIceTaskFromQueueItem(item) {
        if (!item || !item.handle) return false;
        var handle = normalizeChatHandle(item.handle);
        // skipped / deferred：绝不点进
        if (item.status === 'skipped' || item.status === 'deferred') {
            return false;
        }
        // 铁律：doing 未终态前禁止开第二人
        var curDoing = iceQueueCurrentDoing();
        if (curDoing && normalizeChatHandle(curDoing.handle) !== handle) {
            console.warn('[粉丝队列] 拒开 @' + handle + '：当前仍在做 @' + curDoing.handle);
            try { showToast('⏳ 等人 @' + curDoing.handle + ' 完成', '#faad14', 1800); } catch (eToast) {}
            return false;
        }
        // 已在飞：仅当「已不在粉丝列表」才跳过重开；停在列表上必须再点进（防 step 残留假飞）
        try {
            var stepFly = sessionStorage.getItem('dan_auto_step') || '';
            var ctFly = normalizeChatHandle(sessionStorage.getItem('current_target') || '');
            var onFansList = isFollowersListPath(window.location.href);
            if (curDoing && ctFly === handle && stepFly && !onFansList) {
                return true;
            }
            if (curDoing && ctFly === handle && !onFansList) {
                if (!stepFly) {
                    sessionStorage.setItem('dan_auto_step', item.kind === 'ice' ? '1' : '2');
                    sessionStorage.setItem('dan_wait_count', '0');
                }
                return true;
            }
        } catch (eFly) {}

        // 开人前再按 OPS+本地分类：完结则 skipped，禁止 click
        var rejectDB = getDB('dan_reject_users');
        var completedBackend = [];
        try { completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]'); } catch (eC) {}
        var cls = classifyFanRosterAction(handle, rejectDB, completedBackend, ensureChatFreeze());
        if (cls.status !== 'pending') {
            iceQueueMark(handle, cls.status, cls.reason, cls.kind);
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.removeItem('current_target');
            console.log('[粉丝队列] 开人前复核不开 @' + handle + ' → ' + cls.status + '/' + cls.reason);
            return false;
        }

        iceQueueMark(handle, 'doing', '', cls.kind);
        sessionStorage.setItem('current_target', handle);
        try { sessionStorage.setItem('dan_dm_entry_via', 'fan_roster'); } catch (eVia) {}
        try { sessionStorage.removeItem('dan_dm_click_n'); } catch (eCn0) {}
        try { sessionStorage.removeItem('dan_dm_stay_profile'); } catch (eSp0) {}
        try { markDmVerified(handle, 'opened_' + (cls.kind || 'pending')); } catch (eVfOpen) {}
        // 一窗一遍：始终 outbound，按 kind/round 分类单发（不再 fork followup）
        try { setChatPhase('outbound'); } catch (ePhSet) {}
        sessionStorage.setItem('dan_wait_count', '0');
        sessionStorage.setItem('dan_mem_cleaner_count', '0');
        sessionStorage.setItem('dan_profile_wait', String(Math.floor(Math.random() * 2)));
        sessionStorage.setItem('dan_scroll_fail_count', '0');
        sessionStorage.setItem('dan_bottom_hit_count', '0');

        // 发完/换人前若仍停在旧 DM：先回粉丝页，禁止在旧会话上开下一人（防「会话不一致」）
        try {
            if (isDmPath(window.location.pathname || '') && !isFollowersListPath(window.location.href)) {
                var hostLeave = sessionStorage.getItem('dan_target_username') || getMyHandle();
                if (hostLeave) {
                    try { sessionStorage.removeItem('dan_auto_step'); } catch (eStL) {}
                    console.warn('[粉丝队列] 开人前先离旧 DM → /' + hostLeave + '/followers @' + handle);
                    chatGo('/' + hostLeave + '/followers', true);
                    return true;
                }
            }
        } catch (eLeaveDm) {}

        // 4.1.52/53：toast 按「此人此刻动作」；kickCount0=盾牌、1=催加
        var tip = '📋 跟进';
        if (cls.kind === 'ice') tip = '❄️ 破冰';
        else if (cls.kind === 'kick') {
            var kcOpen = 0;
            try { kcOpen = getKickCountLocal(loadTargetDB()[handle] || {}); } catch (eKo) { kcOpen = 0; }
            tip = kcOpen >= 1 ? '📣 催加' : '🛡️ 盾牌';
        } else if (cls.kind === 'ad') {
            tip = (cls.reason === 'need_ad') ? '🎣 发广告' : '📋 跟进';
        }
        showToast(tip + ' → @' + handle, '#1d9bf0', 1500);
        try {
            if (typeof Logger !== 'undefined' && Logger.info) {
                Logger.info('私信', '队列' + cls.kind + (cls.reason ? '/' + cls.reason : '') + ' → @' + handle);
            }
        } catch (eLg) {}

        // 粉丝队列一律：资料页 → 点 DM（step1/2/4）→ 回 /followers。
        // 禁止 ad/kick 直跳 /i/chat/…（单 ID 常落「Start Conversation」空壳，且与 4.1.3 原路冲突）。
        var link = findUserCellLinkByHandle(handle);
        if (link) {
            try { sessionStorage.removeItem('dan_ice_seek_scroll'); } catch (eSk0) {}
            sessionStorage.setItem('dan_auto_step', '1');
            try { link.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (eSv) {}
            link.click();
            return true;
        }
        // 列表虚拟化：滚几屏再找，仍无才 URL 兜底（减握手）
        var seek = 0;
        try { seek = parseInt(sessionStorage.getItem('dan_ice_seek_scroll') || '0', 10) || 0; } catch (eSk) { seek = 0; }
        // 白壳：停 seek、软愈，禁止立刻 URL 开人叠握手
        if (pageLooksChatFollowersShell()) {
            requestSharedSoftHealChat('ice_seek_shell');
            showToast('⏳ 列表未灌水，等愈…', '#faad14', 1200);
            return true;
        }
        if (seek < 10) {
            try { sessionStorage.setItem('dan_ice_seek_scroll', String(seek + 1)); } catch (eSk2) {}
            try { sessionStorage.removeItem('dan_auto_step'); } catch (eStSeek) {}
            try {
                if (seek === 0) {
                    try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (eTop) { window.scrollTo(0, 0); }
                } else if (seek % 3 === 0) {
                    window.scrollBy({ top: -500, behavior: 'smooth' });
                } else {
                    window.scrollBy({ top: 600, behavior: 'smooth' });
                }
            } catch (eScr) {}
            showToast('📜 列表找 @' + handle + '…', '#1d9bf0', 800);
            return true;
        }
        try { sessionStorage.removeItem('dan_ice_seek_scroll'); } catch (eSk3) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.ice_open_url_fallback', { target: handle, seek: seek });
            }
        } catch (eTel) {}
        console.warn('[粉丝队列] 列表未找到 @' + handle + '，URL 兜底开资料');
        sessionStorage.setItem('dan_auto_step', '1');
        chatGo('/' + handle, false);
        return true;
    }

    function finishIceOutboundAfterQueue(reason) {
        reason = reason || 'queue_empty';
        var st = iceQueueStats();
        // 同队列仍有 pending（ad/kick）时不应到这里；若误入则继续 drain
        if (iceQueueHasOpenWork()) {
            var nextLeft = iceQueueNextPending();
            if (nextLeft) {
                startIceTaskFromQueueItem(nextLeft);
                return;
            }
        }
        // 4.6.67：本地仍有未破冰债 → 禁止宣布完工（空队列假完工）
        var backlogIce = 0;
        try { backlogIce = countUnicedBacklogInDb(); } catch (eBk) { backlogIce = 0; }
        if (backlogIce > 0 && (reason === 'shallow_empty' || reason === 'queue_empty' || reason === 'all_skipped')) {
            forceRescanForRosterGap('finish_blocked_db_ice');
            try {
                showToast('📋 台账仍有未破冰 ' + backlogIce + '，禁止空完工→再扫', '#faad14', 2800);
            } catch (eTBk) {}
            console.warn('[粉丝队列] 完工被拦：DB未破冰=' + backlogIce + ' reason=' + reason);
            return;
        }
        // 4.6.71：台账不全（F≫items）禁止空完工转养号
        if (reason === 'shallow_empty' || reason === 'queue_empty' || reason === 'all_skipped') {
            if (isLedgerIncompleteNow()) {
                forceRescanForRosterGap('finish_blocked_incomplete');
                try {
                    var Finc = 0, Ninc = 0;
                    try { Finc = readOwnFollowerCount() || 0; } catch (eF) {}
                    try {
                        var snapInc = buildFanLedgerSnapshot('incomplete_gate');
                        Ninc = (snapInc && snapInc.itemCount) || 0;
                    } catch (eN) {}
                    showToast('📋 台账不全：主页' + Finc + ' / 库' + Ninc + ' → 禁止空完工再扫', '#faad14', 3000);
                } catch (eTInc) {}
                console.warn('[粉丝队列] 完工被拦：ledgerIncomplete reason=' + reason);
                return;
            }
        }
        if (isSoftRiskOutboundSegment() || isSoftRiskInboxSegment()) {
            finishSoftRiskFanQueueDone(reason);
            return;
        }
        if (!isInboxWatchEnabled()) {
            finishSoftRiskFanQueueDone(reason);
            return;
        }
        // 守箱开且有债才进收件箱；粉丝队列默认不进 CHAT（chatGo 亦会闸）
        if (!isInboxCapReached() && hasDebtForInboxPivot()) {
            setChatPhase('inbox');
            var goOk = chatGo('/i/chat', false);
            if (!goOk) {
                console.warn('[私信] 进 CHAT 被拦截，改粉丝队列完结');
                finishSoftRiskFanQueueDone(reason || 'chat_nav_blocked');
            }
            return;
        }
        completeChatRound(st.done > 0 ? 'bottom_reached' : (reason || 'queue_empty'));
    }

    /** 4.6.77：台账一轮队空 → 清窗回关注（无中间养号/chat2） */
    function finishSoftRiskFanQueueDone(reason) {
        reason = reason || 'fan_queue_done';
        try {
            if (typeof window.__sgMarkSoftRiskChatPass1Done === 'function') {
                window.__sgMarkSoftRiskChatPass1Done(reason);
            } else if (typeof window.__sgMarkSoftRiskChatPass2Done === 'function') {
                window.__sgMarkSoftRiskChatPass2Done(reason);
            } else if (typeof window.__sgMarkSoftRiskOutboundDone === 'function') {
                window.__sgMarkSoftRiskOutboundDone(reason);
            }
        } catch (eMk) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('scheduler.soft_outbound_done', {
                    reason: reason,
                    next: 'follow',
                    pass: 1,
                    round_end: true
                });
            }
        } catch (eT) {}
        var iceSt = iceQueueStats();
        showToast('一轮完成 → 回关注', '#1d9bf0', 2200);
        console.log('[私信] 台账一轮完成 reason=' + reason + ' done=' + iceSt.done);
        completeChatRound(iceSt.done > 0 ? 'fan_queue_done' : reason, { softFivePhase: true, softPass: 1 });
    }

    /**
     * chat2：复活 done/failed/deferred 中 round1 须再开检测的人 + promote deferred
     * 4.1.37：不要求先有 lastInboundAt；破冰 done 也强制 pending(chat2_probe)
     */
    function prepareSoftRiskChat2Queue(why) {
        why = why || 'chat2';
        try {
            var prepKey = sessionStorage.getItem('sg_soft_chat2_prepared') || '';
            var untilKey = '';
            try { untilKey = String((JSON.parse(localStorage.getItem('sg_state') || '{}').softRiskUntil) || ''); } catch (eU) {}
            if (prepKey && untilKey && prepKey === untilKey) {
                console.log('[私信] chat2 已准备过，跳过重复 prepare');
                return 0;
            }
            if (untilKey) sessionStorage.setItem('sg_soft_chat2_prepared', untilKey);
        } catch (eOnce) {}
        var rejectDB = getDB('dan_reject_users');
        var completedBackend = [];
        try { completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]'); } catch (eC) {}
        var sg = ensureChatFreeze();
        try {
            // 确保 classify 走 chat2 分支（need_probe）
            if (!sg.softRiskPhase || sg.softRiskPhase === 'nurture' || sg.softRiskPhase === 'chat1') {
                sg.softRiskPhase = 'chat2';
                try { localStorage.setItem('sg_state', JSON.stringify(sg)); } catch (eSv) {}
            }
        } catch (ePh2) {}
        try { maybeRefreshOpsRoundMap(true); } catch (eOps) {}
        var dbAll = {};
        try { dbAll = loadTargetDB() || {}; } catch (eDb) { dbAll = {}; }
        // 4.1.39：chat2 不依赖本窗列表滚完；先从目标库灌未完成债再 revive
        try { seedUnfinishedFanDebtToQueue('chat2_prepare'); } catch (eSeed2) {}
        var q = loadIceTaskQueue();
        var revived = 0;
        for (var i = 0; i < (q.items || []).length; i++) {
            var it = q.items[i];
            if (!it || !it.handle) continue;
            var oldSt = it.status || '';
            if (oldSt !== 'done' && oldSt !== 'failed' && oldSt !== 'deferred' && oldSt !== 'skipped') continue;
            if (oldSt === 'skipped') {
                if (isIceSkipPermanentlyLocked(it)) continue;
            }
            var h = normalizeChatHandle(it.handle);
            var entry = dbAll[h] || dbAll[it.handle] || {};
            var effR = getEffectiveFanRound(h);
            var forceProbe = false;
            try {
                forceProbe = !!(
                    effR === 1
                    && entry.iceSentAt
                    && !entry.adSentAt
                    && !entry.adBubbleOk
                    && !entry.rejectSentAt
                    && !entry.blockedAt
                    && !entry.chatClosedAt
                    && !(rejectDB && rejectDB.has && rejectDB.has(h))
                );
            } catch (eFp) { forceProbe = false; }
            if (forceProbe) {
                it.status = 'pending';
                it.kind = 'ad';
                it.reason = 'chat2_probe';
                it.doneAt = 0;
                revived++;
                continue;
            }
            var cls = classifyFanRosterAction(it.handle, rejectDB, completedBackend, sg);
            if (cls.status === 'pending') {
                it.status = 'pending';
                it.kind = cls.kind || it.kind || 'ad';
                it.reason = cls.reason || 'chat2_revive';
                it.doneAt = 0;
                revived++;
            }
        }
        if (revived > 0) saveIceTaskQueue(q);
        var promoted = 0;
        try { promoted = iceQueuePromoteDeferred(why) || 0; } catch (eP) {}
        try {
            var pulse2 = 'ice2_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4);
            sessionStorage.setItem('dan_ice_queue_pulse', pulse2);
            sortIceQueueForDrain();
            q = loadIceTaskQueue();
            q.pulseId = pulse2;
            q.sealed = true;
            saveIceTaskQueue(q);
        } catch (ePu) {}
        try { setChatPhase('outbound'); } catch (ePh) {}
        try { sessionStorage.setItem('dan_auto_run', 'true'); } catch (eAr) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.soft_chat2_prepare', {
                    revived: revived, promoted: promoted, why: why
                });
            }
        } catch (eT) {}
        console.log('[私信] chat2 准备 revived=' + revived + ' promoted=' + promoted);
        showToast('chat2 续排（按人状态混发）', '#1d9bf0', 2000);
        return revived + promoted;
    }

    /** @deprecated 4.1.1：改同队列 drain，不再 DB 跟进开人 */
    function finishSoftRiskOutboundToFollowup(reason) {
        finishSoftRiskFanQueueDone(reason || 'outbound_done');
    }

    // ---- 4.1.1：旧 DB 跟进队列废止；API 保留为粉丝队列薄封装 ----
    function clearFollowupTaskQueue(why) {
        try { sessionStorage.removeItem('dan_followup_task_queue'); } catch (e) {}
        try {
            if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.task_queue_cleared', { kind: 'followup', why: why || 'retired' });
        } catch (eT) {}
    }
    function followupQueueMark(handle, status, reason) {
        return iceQueueMark(handle, status, reason);
    }
    function harvestFollowupFromDb() {
        return 0;
    }
    function runFollowupQueueTick() {
        // 薄封装：与粉丝列表同一 ice drain（进度名走 queue_ 白名单）
        try { noteChatProgress('queue_drain'); } catch (eN) {}
        if (iceQueueHasOpenWork()) {
            var next = iceQueueNextPending();
            if (next) {
                var ok = startIceTaskFromQueueItem(next);
                if (!ok && !iceQueueCurrentDoing()) {
                    var next2 = iceQueueNextPending();
                    if (next2) startIceTaskFromQueueItem(next2);
                }
            }
            return;
        }
        finishSoftRiskFanQueueDone('queue_drain_empty');
    }

    /** @deprecated 名字保留：无守箱时走粉丝队列完结 */
    function finishSoftRiskOutboundToInbox(reason) {
        if (!isInboxWatchEnabled()) {
            finishSoftRiskFanQueueDone(reason);
            return;
        }
        reason = reason || 'outbound_done';
        try {
            var st = JSON.parse(localStorage.getItem('sg_state') || '{}');
            if (st.softRiskUntil > Date.now() && !st.softRiskOutboundDone) {
                st.softRiskOutboundDone = true;
                localStorage.setItem('sg_state', JSON.stringify(st));
            }
        } catch (eSt) {}
        try {
            if (typeof window.__sgMarkSoftRiskOutboundDone === 'function') {
                window.__sgMarkSoftRiskOutboundDone(reason);
            }
        } catch (eMk) {}
        try {
            if (typeof window.__sgBeginSoftRiskChatSession === 'function') {
                window.__sgBeginSoftRiskChatSession();
            }
        } catch (eSess) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('scheduler.soft_outbound_done', { reason: reason });
            }
        } catch (eT) {}
        setChatPhase('inbox');
        try {
            resetChatHandoffState('soft_outbound_to_inbox');
        } catch (eSs) {}
        showToast('破冰完成 → 扫箱（兼容开关）', '#faad14', 2200);
        try { ensureInboxListRootView(); } catch (eRoot) {}
        var goInb = chatGo('/i/chat', true);
        if (!goInb) {
            console.warn('[私信] 扫箱跳转 CHAT 被拦截，改完结');
            finishSoftRiskFanQueueDone(reason || 'inbox_nav_blocked');
        }
    }

    var CHAT_PROGRESS_KEY = 'sg_chat_last_progress_at';
    var CHAT_LEASE_KEY = 'sg_chat_lease';

    function noteChatProgress(why) {
        try {
            sessionStorage.setItem(CHAT_PROGRESS_KEY, String(Date.now()));
            sessionStorage.setItem('sg_chat_last_progress_why', String(why || ''));
        } catch (e) {}
        try {
            if (typeof SgDiagContract !== 'undefined' && SgDiagContract.noteAction) {
                var chPh = '';
                try { chPh = getChatPhase(); } catch (eCh) { chPh = ''; }
                SgDiagContract.noteAction('chat_outbound', 'running', why || 'progress');
            }
        } catch (eDiag) {}
    }

    function clearChatLeaseLocal() {
        try { sessionStorage.removeItem(CHAT_LEASE_KEY); } catch (e) {}
        try {
            if (typeof SgTelemetry !== 'undefined' && SgTelemetry.clearRoundStartDedupe) {
                SgTelemetry.clearRoundStartDedupe();
            } else {
                sessionStorage.removeItem('sg_chat_round_start_emitted_pulse');
            }
        } catch (eD) {}
    }

    /** 从粉丝页 UserCell 提取显示名（首行；第二行为 @handle） */
    function extractUserCellDisplayName(cell) {
        try {
            var lines = (cell.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
            if (lines.length && lines[0] && !/^@/.test(lines[0])) return lines[0];
        } catch (e) {}
        return '';
    }

    /** 显示名归一化（去所有空白 + 小写），用于收件箱行首行匹配 */
    function normalizeDisplayName(s) {
        return String(s || '').replace(/[\s\u3000]+/g, '').toLowerCase();
    }

    /** 当前 URL 对方数字ID：兼容 /i/chat/<peer>-<me> 与新版 /i/chat/<peer> */
    function readDmUrlPeerId() {
        try {
            var href = window.location.href || '';
            var m = href.match(/\/(?:i\/chat|messages)\/(\d{5,})-(\d{5,})(?:\/|$|\?|#)/);
            if (m) {
                try { sessionStorage.setItem('dan_inbox_my_id', String(m[2])); } catch (eMy) {}
                return String(m[1]);
            }
            var m2 = href.match(/\/(?:i\/chat|messages)\/(\d{5,})(?:\/|$|\?|#)/);
            return m2 ? String(m2[1]) : '';
        } catch (e) { return ''; }
    }

    /** 会话页头可见 @handle（用于与 current_target 交叉校验） */
    function readDmConversationHeaderHandle() {
        try {
            var roots = document.querySelectorAll(
                '[data-testid="dmConversationHeader"], [data-testid="dm-conversation-panel"], [data-testid="dm-container"], [data-testid="dm-conversation-content"]'
            );
            for (var ri = 0; ri < roots.length; ri++) {
                var links = roots[ri].querySelectorAll('a[href*="/"]');
                for (var li = 0; li < Math.min(links.length, 12); li++) {
                    var href = String(links[li].getAttribute('href') || '');
                    var path = href.split('?')[0];
                    var seg = path.split('/').filter(Boolean).pop() || '';
                    if (!seg || /^\d+$/.test(seg)) continue;
                    if (/^(i|chat|messages|home|search|settings|compose|notifications|explore)$/i.test(seg)) continue;
                    var cand = normalizeChatHandle(seg);
                    if (cand && cand.length >= 2) return cand;
                }
            }
        } catch (eH) {}
        return '';
    }

    /**
     * 打开的会话是否就是 current_target —— 实现见下方「正向证明」版 assertDmConversationMatchesTarget。
     */

    function captureDmPeerId(targetHandle) {
        targetHandle = normalizeChatHandle(targetHandle);
        if (!targetHandle) return '';
        var peerId = readDmUrlPeerId();
        if (!peerId) return '';
        try {
            var db = loadTargetDB();
            if (!db[targetHandle]) db[targetHandle] = { round: 0, firstSeen: Date.now(), lastDM: null };
            var existing = String(db[targetHandle].peerId || '').replace(/\D/g, '');
            // 已有不同 peerId：禁止污染（错会话）
            if (existing && existing !== peerId) {
                console.warn('[dm_nav] captureDmPeerId 拒绝覆写 @' + targetHandle + ' db=' + existing + ' url=' + peerId);
                return '';
            }
            if (existing !== peerId) {
                db[targetHandle].peerId = peerId;
                saveTargetDB(db);
            }
        } catch (e) {}
        return peerId;
    }

    function isDryRun() {
        try {
            if (sessionStorage.getItem('sg_chat_dry_run') === 'true') return true;
            var cfg = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}');
            return cfg.chat_dry_run_enabled === true || cfg.chat_dry_run_enabled === 'true';
        } catch (e) { return false; }
    }

    function debugChatLog(message, meta) {
        meta = meta || {};
        try {
            if (typeof SgDebugLog !== 'undefined' && SgDebugLog.push) {
                SgDebugLog.push('chat', meta.level || 'info', message, meta);
            }
        } catch (e) {}
    }

    function dryRunPreview(targetHandle, userRound, text, extra) {
        extra = extra || {};
        var roundNumber = (userRound || 0) + 1;
        debugChatLog('干跑预览 @' + targetHandle + ' round=' + roundNumber + ': ' + text, {
            step: 'dry_run', target: targetHandle, round: roundNumber, text: text
        });
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.dry_run_preview', {
                    target: targetHandle,
                    round: roundNumber,
                    text: text,
                    script_id: extra.script_id || ''
                });
            }
        } catch (eT) {}
        showToast('🧪 干跑: 已预览未发送', '#a371f7', 2800);
    }

    function opsDmCheck(targetHandle) {
        return new Promise(function (resolve) {
            try {
                if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
                    resolve(null);
                    return;
                }
                // 4.6.123：12s 超时——须 ≥ 后台 failover 总预算（内网 LAN_TRY_MS 2.5s + 外网 WAN_TRY_MS 8s = 10.5s），
                // 否则内网超时→外网 failover 期间前端先到期白等，failover 成果被浪费（§C2-18）
                var timer = setTimeout(function () {
                    console.log('[私信] OPS 轮次校验前端超时(12s) target=' + normalizeChatHandle(targetHandle));
                    resolve({ ok: false, reason: 'frontend_timeout', msg: 'frontend_timeout' });
                }, 12000);
                chrome.runtime.sendMessage({
                    action: 'ops_dm_check',
                    payload: { bot_id: getWorkerId(), target_handle: normalizeChatHandle(targetHandle) }
                }, function (r) {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(r || null);
                });
            } catch (e) { resolve(null); }
        });
    }

    /** 单次 OPS dm/record（无补记）；超时 10s */
    function opsDmRecordOnce(targetHandle, roundNumber, messageContent, result) {
        return new Promise(function (resolve) {
            try {
                if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
                    resolve({ ok: false, msg: 'no_runtime' });
                    return;
                }
                var timer = setTimeout(function () { resolve({ ok: false, msg: 'timeout' }); }, 10000);
                chrome.runtime.sendMessage({
                    action: 'ops_dm_record',
                    bot_id: getWorkerId(),
                    target_handle: normalizeChatHandle(targetHandle),
                    round_number: roundNumber,
                    message_content: messageContent || '',
                    result: result || 'success'
                }, function (r) {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) {
                        resolve({ ok: false, msg: chrome.runtime.lastError.message });
                        return;
                    }
                    resolve(r || { ok: false });
                });
            } catch (e) { resolve({ ok: false, msg: String(e && e.message || e) }); }
        });
    }

    function opsDmRecordSleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /** 从本地目标库 / 发送史取某轮正文，供 OPS 缺轮补记 */
    function pickLocalDmRoundText(handle, roundNumber) {
        handle = normalizeChatHandle(handle);
        var r = Number(roundNumber) || 0;
        try {
            var entry = loadTargetDB()[handle] || {};
            if (r === 1 && entry.lastIceText) return String(entry.lastIceText);
            if (r === 2 && entry.lastAdText) return String(entry.lastAdText);
            if (r === 3 && (entry.lastKickText || entry.lastRejectText)) {
                return String(entry.lastKickText || entry.lastRejectText);
            }
        } catch (eEntry) {}
        try {
            var dmHist = JSON.parse(localStorage.getItem('sg_dm_history') || '[]');
            for (var i = dmHist.length - 1; i >= 0; i--) {
                var row = dmHist[i];
                if (!row) continue;
                if (normalizeChatHandle(row.target) !== handle) continue;
                if (Number(row.round) === r && row.msg) return String(row.msg);
            }
        } catch (eHist) {}
        return '[local_backfill_r' + r + ']';
    }

    /**
     * 4.6.66：本地已推进、OPS 缺前轮 → round_gap。
     * 按 expected..want-1 用本地正文补记，再重报本轮；duplicate 视作已入账。
     */
    function opsDmRecordBackfill(targetHandle, roundNumber, messageContent, gapResp) {
        var want = Number(roundNumber) || 0;
        var expected = Number(gapResp && gapResp.expected);
        if (!(want >= 2) || !(expected >= 1) || !(expected < want)) {
            return Promise.resolve(gapResp || { ok: false, reason: 'round_gap' });
        }
        console.warn('[私信] OPS round_gap，开始补记', {
            target: normalizeChatHandle(targetHandle),
            want: want,
            expected: expected,
            current: gapResp && gapResp.current
        });
        var filled = [];
        var chain = Promise.resolve(true);
        for (var r = expected; r < want; r++) {
            (function (rr) {
                chain = chain.then(function (okPrev) {
                    if (!okPrev) return false;
                    var fillText = pickLocalDmRoundText(targetHandle, rr);
                    return opsDmRecordOnce(targetHandle, rr, fillText, 'success').then(function (fr) {
                        if (fr && (fr.ok || fr.reason === 'round_duplicate')) {
                            filled.push(rr);
                            return opsDmRecordSleep(200).then(function () { return true; });
                        }
                        console.warn('[私信] OPS 补记第' + rr + '轮失败', fr);
                        return false;
                    });
                });
            })(r);
        }
        return chain.then(function (okAll) {
            if (!okAll) {
                return {
                    ok: false,
                    reason: 'round_gap_backfill_failed',
                    filled: filled,
                    expected: expected,
                    want: want,
                    msg: 'backfill failed before round ' + want
                };
            }
            return opsDmRecordOnce(targetHandle, want, messageContent, 'success').then(function (finalResp) {
                if (finalResp && finalResp.ok) {
                    finalResp.backfilled = filled.slice();
                    console.log('[私信] OPS 补记成功并记账', {
                        target: normalizeChatHandle(targetHandle),
                        round: want,
                        filled: filled
                    });
                    return finalResp;
                }
                if (finalResp && finalResp.reason === 'round_duplicate') {
                    return {
                        ok: true,
                        advanced: false,
                        reason: 'round_duplicate',
                        round: want,
                        backfilled: filled,
                        deduped: true
                    };
                }
                // 补记后仍 gap 且 expected 已前进：再补一轮（并发/半成功）
                if (finalResp && finalResp.reason === 'round_gap') {
                    var exp2 = Number(finalResp.expected);
                    if (exp2 > expected && exp2 < want) {
                        return opsDmRecordBackfill(targetHandle, want, messageContent, finalResp);
                    }
                }
                return finalResp || { ok: false };
            });
        });
    }

    /** OPS 记账：成功路径自动 round_gap 补记 + timeout 重试 1 次；仍失败进出箱 */
    function opsDmRecord(targetHandle, roundNumber, messageContent, result) {
        result = result || 'success';
        var isSuccess = String(result).toLowerCase() === 'success';
        var bot = '';
        try { bot = currentLedgerBotHandle() || (typeof getWorkerId === 'function' ? getWorkerId() : '') || ''; } catch (eB) { bot = ''; }
        function enqueueRecordFail(resp) {
            try {
                enqueueOpsOutbox('dm_record', {
                    bot_id: bot,
                    target_handle: normalizeChatHandle(targetHandle),
                    round_number: roundNumber,
                    message_content: messageContent || '',
                    result: result,
                    last_resp: resp || null
                });
                markLedgerDirty('dm_record_fail');
            } catch (eEnq) {}
            return resp || { ok: false };
        }
        return opsDmRecordOnce(targetHandle, roundNumber, messageContent, result).then(function (resp) {
            if (resp && resp.ok) return resp;
            if (!isSuccess) return resp || { ok: false };
            if (resp && resp.reason === 'round_duplicate') {
                return {
                    ok: true,
                    advanced: false,
                    reason: 'round_duplicate',
                    round: Number(roundNumber) || 0,
                    deduped: true
                };
            }
            if (resp && resp.reason === 'round_gap') {
                return opsDmRecordBackfill(targetHandle, roundNumber, messageContent, resp).then(function (bf) {
                    if (bf && bf.ok) return bf;
                    return enqueueRecordFail(bf);
                });
            }
            var failMsg = String((resp && (resp.msg || resp.error)) || '');
            if (failMsg === 'timeout' || /timeout/i.test(failMsg)) {
                return opsDmRecordSleep(600).then(function () {
                    return opsDmRecordOnce(targetHandle, roundNumber, messageContent, result).then(function (resp2) {
                        if (resp2 && resp2.ok) return resp2;
                        if (resp2 && resp2.reason === 'round_duplicate') {
                            return {
                                ok: true,
                                advanced: false,
                                reason: 'round_duplicate',
                                round: Number(roundNumber) || 0,
                                deduped: true
                            };
                        }
                        if (resp2 && resp2.reason === 'round_gap') {
                            return opsDmRecordBackfill(targetHandle, roundNumber, messageContent, resp2).then(function (bf2) {
                                if (bf2 && bf2.ok) return bf2;
                                return enqueueRecordFail(bf2);
                            });
                        }
                        return enqueueRecordFail(resp2 || resp);
                    });
                });
            }
            return enqueueRecordFail(resp);
        });
    }

    function chatShanghaiDate() {
        try {
            if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiDate) return TimeUtil.shanghaiDate();
        } catch (e0) {}
        try { return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }); } catch (e1) {
            return new Date().toLocaleDateString('zh-CN');
        }
    }

    function loadSgState() {
        try { return JSON.parse(localStorage.getItem('sg_state') || '{}'); } catch (e) { return {}; }
    }

    function saveSgState(sg) {
        try { localStorage.setItem('sg_state', JSON.stringify(sg)); } catch (e) {}
    }

    /** 跨日清定格；到点则快照 pending 名单 */
    function ensureChatFreeze() {
        try {
            var today = chatShanghaiDate();
            var sg = loadSgState();
            if (sg.chatFreezeDate && sg.chatFreezeDate !== today) {
                sg.chatFreezeDate = '';
                sg.chatFreezeAt = 0;
                sg.chatFreezeHandles = [];
                saveSgState(sg);
            }
            var pastFreeze = false;
            try {
                if (typeof TimeUtil !== 'undefined' && TimeUtil.isPastChatFreeze) pastFreeze = !!TimeUtil.isPastChatFreeze();
                else {
                    var p = (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) ? TimeUtil.shanghaiParts() : null;
                    pastFreeze = !!(p && p.minutes >= 17 * 60);
                }
            } catch (ePf) {}
            if (!pastFreeze) {
                // 24h 测试模式：清除已有定格快照，让所有目标可发
                if (sg.chatFreezeDate === today && Array.isArray(sg.chatFreezeHandles)) {
                    sg.chatFreezeDate = '';
                    sg.chatFreezeAt = 0;
                    sg.chatFreezeHandles = [];
                    saveSgState(sg);
                }
                return sg;
            }

            if (sg.chatFreezeDate === today && Array.isArray(sg.chatFreezeHandles)) return sg;

            var db = loadTargetDB();
            var handles = [];
            for (var h in db) {
                var entry = db[h];
                if (!entry) continue;
                if (isFleetHandle(h)) continue;
                if (entry.done || (entry.round || 0) >= 3) continue;
                handles.push(normalizeChatHandle(h));
            }
            sg.chatFreezeDate = today;
            sg.chatFreezeAt = Date.now();
            sg.chatFreezeHandles = handles;
            saveSgState(sg);
            console.log('[私信定格] ' + handles.length + ' 人 @ ' + today);
            try {
                if (typeof Logger !== 'undefined' && Logger.info) Logger.info('调度', '私信定格 ' + handles.length + ' 人');
            } catch (eL) {}
            try {
                var fzLabel = '17点';
                try {
                    if (typeof TimeUtil !== 'undefined' && TimeUtil.chatFreezeMinutes) {
                        var fzM = TimeUtil.chatFreezeMinutes();
                        fzLabel = Math.floor(fzM / 60) + '点';
                    }
                } catch (eFzL) {}
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '私信定格 ' + handles.length + ' 人，' + fzLabel + '后新粉今日跳过' }
                }));
            } catch (eD) {}
            return sg;
        } catch (e) { return loadSgState(); }
    }

    /** 定格后：禁止主动破冰新粉；对方已来信/未读收养仍可当晚处理（破冰或寒暄 AD） */
    function isInboundChatException(entry) {
        if (!entry) return false;
        return !!(entry.adoptedFromUnread || entry.lastInboundAt || entry.replySeenAt);
    }

    function isChatTargetAllowed(handle, sg) {
        if (!handle) return false;
        handle = normalizeChatHandle(handle);
        if (isFleetHandle(handle)) return false;
        sg = sg || ensureChatFreeze();
        var today = chatShanghaiDate();
        if (!sg.chatFreezeDate || sg.chatFreezeDate !== today || !Array.isArray(sg.chatFreezeHandles)) {
            return true; // 未定格
        }
        // 定格时空名单（如刚重置私信）：没有"17点前已在的粉丝"需要保护，不冻结新粉
        if (sg.chatFreezeHandles.length === 0) return true;
        var freezeAt = sg.chatFreezeAt || 0;
        var db = loadTargetDB();
        var entry = db[handle];
        var inbound = isInboundChatException(entry);
        // 定格后新出现的目标：默认今日不发；若对方已来信则放行
        if (entry && freezeAt && (entry.firstSeen || 0) > freezeAt && !inbound) return false;
        var round = entry ? (entry.round || 0) : 0;
        if (round < 1) {
            // 定格前未破冰：默认次日再破冰；对方已打招呼/未读收养则当晚可发
            if (inbound) return true;
            return false;
        }
        return true;
    }

    function isChatRushMode() {
        return false;
    }

    function countFreezePending(sg) {
        sg = sg || loadSgState();
        if (!Array.isArray(sg.chatFreezeHandles) || !sg.chatFreezeHandles.length) return 0;
        var db = loadTargetDB();
        var n = 0;
        for (var i = 0; i < sg.chatFreezeHandles.length; i++) {
            var h = sg.chatFreezeHandles[i];
            var e = db[h];
            if (!e) continue;
            if (e.done || (e.round || 0) >= 3) continue;
            if ((e.round || 0) < 1) continue;
            if ((e.round || 0) === 1 && !isActionableAdEntry(h, e)) continue;
            if ((e.round || 0) === 2 && !isActionableKickEntry(h, e)) continue;
            n++;
        }
        return n;
    }

    var CHAT_DAILY_CAP_SEC = 240 * 60;
    var CHAT_INBOX_CAP_SEC = 120 * 60;
    var CHAT_OUTBOUND_CAP_SEC = 150 * 60;
    // 守箱节奏：单次守箱不超过该时长（到点交回调度，短冷却后再回查新消息）
    var INBOX_VISIT_CAP_MS = 150 * 1000;

    function getChatIntervalCfg() {
        return (window.SgChatGates && window.SgChatGates.getChatIntervalCfg) ? window.SgChatGates.getChatIntervalCfg() : { coolMin:25, coolMax:35, debtMin:8, debtMax:12, adMinWaitMin:20, kickMinHours:2, inboxVisitCapSec:150 };
    }
    function getAdMinWaitMs() {
        return (window.SgChatGates && window.SgChatGates.getAdMinWaitMs) ? window.SgChatGates.getAdMinWaitMs() : 20*60*1000;
    }
    function ensureChatDayStats(st) {
        return (window.SgChatGates && window.SgChatGates.ensureChatDayStats) ? window.SgChatGates.ensureChatDayStats(st) : (st || {});
    }
    function isChatDailyCapReached(st) {
        return !!(window.SgChatGates && window.SgChatGates.isChatDailyCapReached && window.SgChatGates.isChatDailyCapReached(st));
    }
    function isInboxCapReached(st) {
        return !!(window.SgChatGates && window.SgChatGates.isInboxCapReached && window.SgChatGates.isInboxCapReached(st));
    }
    function isOutboundCapReached(st) {
        return !!(window.SgChatGates && window.SgChatGates.isOutboundCapReached && window.SgChatGates.isOutboundCapReached(st));
    }
    function canProbeInboxTarget(handle, entry) {
        return !!(window.SgChatGates && window.SgChatGates.canProbeInboxTarget && window.SgChatGates.canProbeInboxTarget(handle, entry));
    }
    function isActionableAdEntry(handle, entry) {
        if (!entry || entry.done || (entry.round || 0) !== 1) return false;
        if (entry.blockedAt || entry.rejectSentAt) return false;
        if (!entry.iceSentAt) return false;
        // 与调度 countActionableReplyCo 对齐：已确认入站即可行动（不依赖当前是否在收件箱页）
        if (entry.replySeenAt || (entry.lastInboundAt && entry.lastInboundAt > entry.iceSentAt)) return true;
        if (isMessagesPage()) {
            var row = findInboxConversationElement(handle);
            if (conversationHasUnread(row)) return true;
            if (canProbeInboxTarget(handle, entry)) return true;
        }
        return false;
    }

    function isActionableKickEntry(handle, entry) {
        if (!entry || entry.done || (entry.round || 0) !== 2) return false;
        // 缺广告气泡的假推进：算可行动（进箱补发），与列表 needsAdRepair 对齐
        if (!entry.adBubbleOk) return true;
        return canSendKickNow(handle, entry);
    }

    function countAdDebt() {
        var db = loadTargetDB();
        var n = 0;
        for (var h in db) {
            if (isActionableAdEntry(h, db[h])) n++;
        }
        return n;
    }

    function countKickDebt() {
        var db = loadTargetDB();
        var n = 0;
        for (var h in db) {
            if (isActionableKickEntry(h, db[h])) n++;
        }
        return n;
    }

    function countRawAdDebt() {
        var db = loadTargetDB();
        var n = 0;
        for (var h in db) {
            var e = db[h];
            if (!e || e.done) continue;
            if ((e.round || 0) === 1) n++;
        }
        return n;
    }

    function countRawKickDebt() {
        var db = loadTargetDB();
        var n = 0;
        for (var h in db) {
            var e = db[h];
            if (!e || e.done) continue;
            if ((e.round || 0) === 2) n++;
        }
        return n;
    }

    /** 破冰已发、仍在等待对方回复的 round1 目标数（驱动守箱短周期回查） */
    function countReplyPending() {
        var db = loadTargetDB();
        var n = 0;
        for (var h in db) {
            var e = db[h];
            if (!e || e.done) continue;
            if ((e.round || 0) !== 1) continue;
            if (!e.iceSentAt) continue;
            n++;
        }
        return n;
    }

    function hasChatDebt() {
        return countAdDebt() + countKickDebt() > 0;
    }

    /** outbound 触底 pivot：仅已确认回复或到期催加（禁止裸干等投机进箱） */
    function hasDebtForInboxPivot() {
        try {
            if (countAdDebt() > 0) return true;
        } catch (eA) {}
        try {
            if (countKickDebt() > 0) return true;
        } catch (eK) {}
        return false;
    }

    function isSoftRiskOutboundSegment() {
        try {
            var st = JSON.parse(localStorage.getItem('sg_state') || '{}');
            if (!(st.softRiskUntil > Date.now()) || st.softRiskChatDone) return false;
            var ph = st.softRiskPhase || 'chat1';
            return ph === 'chat1' || ph === 'chat2';
        } catch (e) { return false; }
    }

    /** 守箱扫箱段已废除 */
    function isSoftRiskInboxSegment() {
        return false;
    }

    /** 守箱/扫箱相位：禁止任何「逃逸」跳回粉丝列表 */
    function mustStayOnInboxSurface() {
        try {
            var ph = getChatPhase();
            // 粉丝队列破冰/跟进：即便 URL 已是 /i/chat/<id>，结束后也必须回粉丝列表
            if (ph === 'outbound' || ph === 'followup') return false;
            if (isSoftRiskOutboundSegment()) return false;
            // 守箱关：永不锁死收件箱（含误写 phase=inbox）
            if (!isInboxWatchEnabled()) return false;
            if (ph === 'inbox') return true;
            if (isSoftRiskInboxSegment()) return true;
            if (detectDmMailboxSource()) return true;
            var p = (window.location.pathname || '').toLowerCase();
            if (isDmPath(p)) return true;
        } catch (e) {}
        return false;
    }

    /** 是否应原路回粉丝列表（禁止点会话左上返回落到 /i/chat 列表） */
    function shouldReturnToFollowersList() {
        try {
            if (mustStayOnInboxSurface()) return false;
            var ph = getChatPhase();
            if (ph === 'outbound' || ph === 'followup') return true;
            if (isSoftRiskOutboundSegment()) return true;
            if (!isInboxWatchEnabled() && ph !== 'inbox') return true;
        } catch (e) {}
        return false;
    }

    /** 主循环健康 DOM：含新版收件箱行 / 会话，避免 SPA 切换误判「白屏」 */
    function isChatHealthyDom() {
        try {
            if (document.querySelector('[data-testid="UserCell"]')) return true;
            if (document.querySelector('[data-testid="dmComposerTextInput"]')) return true;
            if (document.querySelector('[data-testid="sendDMFromProfile"]')) return true;
            if (document.querySelector('[data-testid="conversation"]')) return true;
            if (document.querySelector('[data-testid="DMConversation"]')) return true;
            if (document.querySelector('[data-testid="DMDrawer"]')) return true;
            if (document.querySelector('[data-testid^="dm-conversation-item-"]')) return true;
            if (document.querySelector('[data-testid="dm-inbox-panel"]')) return true;
            if (detectDmMailboxSource()) return true;
        } catch (e) {}
        return false;
    }

    /** 软风控破冰结束闸：以「列表触底」为准，不用全库 pending 卡死触底循环 */
    function canFinishSoftOutboundIce(pendingLeft, reason) {
        if (reason === 'freeze_idle') return true;
        if (reason === 'outbound_cap') return true;
        // bottom_reached / queue_empty / scroll_timeout：触底确认后允许转扫箱
        // （全库 pending 可能含历史/非本列表目标，不能用来无限 hold）
        return true;
    }

    function noteSoftOutboundResidual(pendingLeft, why) {
        var n = pendingLeft || 0;
        if (!(n > 0)) return;
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.outbound_pending_residual', { pending: n, why: why || '' });
            }
        } catch (eT) {}
        console.log('[私信] 触底转扫箱，库内仍有 pending=' + n + '（非本列表可视目标） why=' + (why || ''));
    }

    /** @deprecated 保留空壳避免旧调用；不再清零触底计数 */
    function holdSoftOutboundForPending(pendingLeft, why) {
        noteSoftOutboundResidual(pendingLeft, why);
    }

    if (typeof window !== 'undefined') {
        window.__sgChatDebtCounts = function () {
            return {
                actionableAd: countAdDebt(),
                actionableKick: countKickDebt(),
                rawAd: countRawAdDebt(),
                rawKick: countRawKickDebt(),
                waitingReply: countReplyPending()
            };
        };
    }

    /** X 改版：DM 收件箱路径已迁移到 /i/chat，旧 /messages 兼容保留 */
    function isDmPath(p) {
        p = String(p || '').toLowerCase();
        return p.indexOf('/messages') >= 0 || p.indexOf('/i/chat') >= 0;
    }

    /** 检测私信环境来源：'url'（/messages 或 /i/chat 路径）| 'drawer'（DM 抽屉弹层）| null */
    function detectDmMailboxSource() {
        try {
            var p = (window.location.pathname || '').toLowerCase();
            if (isDmPath(p)) return 'url';
            if (document.querySelector('[data-testid="DMDrawer"]')) return 'drawer';
        } catch (e) {}
        return null;
    }

    function scrollDmConversationToBottom() {
        try {
            var sc = document.querySelector('[data-testid="dm-conversation-scroller"]')
                || document.querySelector('[data-testid="DmActivityContainer"]')
                || document.querySelector('[data-testid="dm-conversation-content"]')
                || getDmConversationRoot();
            if (sc && sc.scrollHeight && sc.clientHeight && sc.scrollHeight > sc.clientHeight + 5) {
                sc.scrollTop = sc.scrollHeight;
                return true;
            }
        } catch (e) {}
        return false;
    }

    function waitMs(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms || 0); });
    }

    function readReplyStateAfterScroll(targetHandle) {
        // 4.6.34：检测开始横幅（全轮次共用此函数）
        try {
            showToast('🔍 正在检测回复 @' + (normalizeChatHandle(targetHandle || '') || '?') + '…', '#1d9bf0', 4000);
        } catch (eDetStart) {}
        scrollDmConversationToBottom();
        return waitForDmMessagesStable(4, 450).then(function () {
            scrollDmConversationToBottom();
            return waitMs(350);
        }).then(function () {
            return detectDmReplyState(targetHandle);
        }).then(function (st) {
            // 4.6.32 §C3-6 空列表二次机会：慢网/虚拟列表未渲染时首扫全空 ≠ 无回复——
            // 上滚触发历史加载→回底→重扫一次，仍空才允许定性 no_reply
            try {
                var decision = (st && st.decision) || '';
                if (st && !st.hasReply && !st.unreadSeen
                    && (decision === 'no_reply' || decision === 'none')) {
                    try {
                        showToast('🔍 消息未渲染，二次扫描…', '#faad14', 3500);
                    } catch (eRescanToast) {}
                    try {
                        var scRoot = getDmMessageScanRoot();
                        if (scRoot && scRoot.scrollTop != null) scRoot.scrollTop = 0;
                    } catch (eUp1) {}
                    try { window.scrollTo(0, 0); } catch (eUp2) {}
                    return waitMs(900).then(function () {
                        scrollDmConversationToBottom();
                        return waitForDmMessagesStable(5, 500);
                    }).then(function () {
                        scrollDmConversationToBottom();
                        return waitMs(350);
                    }).then(function () {
                        var st2 = detectDmReplyState(targetHandle);
                        try {
                            reportChatMetric('chat.reply_rescan', {
                                target: normalizeChatHandle(targetHandle || ''),
                                found: !!(st2 && (st2.hasReply || st2.unreadSeen)),
                                nodes: countVisibleDmMessageNodes()
                            });
                        } catch (eM) {}
                        return st2;
                    });
                }
            } catch (eRe) {}
            return st;
        }).then(function (finalSt) {
            // 4.6.34：检测结果可视化（全轮次；比特浏览器无控制台）
            try {
                var rsHas = !!(finalSt && finalSt.hasReply);
                var rsUnread = !!(finalSt && finalSt.unreadSeen);
                var rsN = (finalSt && finalSt.texts && finalSt.texts.length) || 0;
                var thShow = normalizeChatHandle(targetHandle || '') || '?';
                showToast(
                    '🔍 查回 @' + thShow + '：' + (rsHas ? ('有回复 ×' + rsN) : (rsUnread ? '有未读标记' : ('未见回复(' + ((finalSt && finalSt.decision) || '?') + ')'))),
                    rsHas ? '#3fb950' : '#8b949e',
                    3500
                );
            } catch (eRsToast) {}
            return finalSt;
        });
    }

    /** 滚动并等待会话消息 DOM 数量稳定（虚拟列表加载） */
    function countVisibleDmMessageNodes(root) {
        root = root || getDmMessageScanRoot();
        try {
            return root.querySelectorAll('[data-testid^="message-text-"], [data-testid="messageText"], [data-testid^="message-"]:not([data-testid^="message-text-"])').length;
        } catch (e) { return 0; }
    }

    function waitForDmMessagesStable(maxRounds, intervalMs) {
        maxRounds = maxRounds || 4;
        intervalMs = intervalMs || 400;
        return new Promise(function (resolve) {
            var lastCount = -1;
            var stableTicks = 0;
            var round = 0;
            function tick() {
                scrollDmConversationToBottom();
                var count = countVisibleDmMessageNodes();
                if (count > 0 && count === lastCount) stableTicks++;
                else stableTicks = 0;
                lastCount = count;
                round++;
                if (stableTicks >= 1 || round >= maxRounds) {
                    resolve(count);
                    return;
                }
                setTimeout(tick, intervalMs);
            }
            tick();
        });
    }

    function getDmMessageScanRoot() {
        if (isDmConversationPage() || isDmConversationView()) {
            return getDmMessageListRoot();
        }
        return getDmConversationRoot();
    }


    /** 收件箱会话列表（左栏）是否可见：扫描未读/打开会话的前提 */
    function isDmInboxListVisible() {
        try {
            if (document.querySelector('[data-testid="conversation"], [data-testid="DMConversation"], [data-testid="dm-inbox-panel"], [data-testid^="dm-conversation-item-"]')) return true;
        } catch (e) {}
        try {
            var p = (window.location.pathname || '').toLowerCase();
            var m = p.indexOf('/messages');
            if (m < 0) m = p.indexOf('/i/chat');
            if (m < 0) return false;
            // /messages 或 /i/chat 为列表根视图；/messages/<id> 或 /i/chat/<id> 窄屏可能隐藏左栏
            var base = m + (p.indexOf('/messages') >= 0 ? 9 : 7);
            return p.slice(base).replace(/\/+$/, '').length === 0;
        } catch (e) {}
        return false;
    }

    /** 是否已进入某个具体 DM 会话页（/i/chat/<id> 或 /i/chat/<peer>-<me>；旧 /messages 同） */
    function isDmConversationPage() {
        try {
            var p = (window.location.pathname || '').toLowerCase();
            // 新版常为 /i/chat/2631113；旧版 /i/chat/peer-me
            return /(?:i\/chat|messages)\/\d{5,}(?:-\d{5,})?(?:\/|$)/.test(p);
        } catch (e) { return false; }
    }

    /** X「Start Conversation」空壳：有 URL id 但无输入框、主文案是开聊引导 */
    function isEmptyDmStartShell() {
        try {
            if (findBottomAwakeningTarget()) return false;
            var t = document.body ? String(document.body.innerText || '') : '';
            // 勿单靠 New chat（侧栏常驻）
            return /Start Conversation|Choose from your existing conversations|开始对话|选择已有对话|既存の会話から選ぶ/i.test(t);
        } catch (e) { return false; }
    }

    /**
     * 粉丝队列误落 CHAT（列表根 / Start Conversation 空壳）→ 立刻回 /followers。
     * 有 composer 的真会话不拉回（资料点 DM 后由 X 打开的发送面）。
     * @returns {boolean} 已处理导航则 true
     */
    function recoverFanQueueOffChatSurface(why) {
        try {
            var ph = getChatPhase();
            var via = '';
            try { via = sessionStorage.getItem('dan_dm_entry_via') || ''; } catch (eV) {}
            if (ph !== 'outbound' && ph !== 'followup' && via !== 'fan_roster') return false;
            if (!isDmPath(window.location.pathname || '')) return false;

            var hasComposer = false;
            try { hasComposer = !!findBottomAwakeningTarget(); } catch (eC) {}
            // 真会话：有输入框且非空壳文案 → 留下发信
            if (hasComposer && !isEmptyDmStartShell()) return false;

            var onListRoot = false;
            try { onListRoot = isDmInboxListRootPath(); } catch (eR) {}
            var emptyShell = false;
            try { emptyShell = isEmptyDmStartShell(); } catch (eE) {}
            // 4.6.68：粉丝队列停在 Messages 任意层（含列表根/空壳/无框会话）一律拉回粉丝页
            var pathLow = String(window.location.pathname || '').toLowerCase();
            var onAnyChatSurface = /\/(?:i\/chat|messages)(?:\/|$)/i.test(pathLow);
            // 4.6.123：带会话 id 的单会话页（/i/chat/\d{5,}）加载较慢，给一次性宽限（约 2 tick / 20s）：
            // 宽限内只探测/唤醒输入框，不判误落、不拉回（避免 DM 未加载完就被拽走导致检测失败）；
            // 宽限用尽即回收。纯列表根（无 id）与 Start Conversation 空壳不发宽限，照旧立即回收。
            // 禁「带 id 永不回收」——否则每单白耗 40–170s 空转。
            var onConvWithId = /\/(?:i\/chat|messages)\/\d{5,}/i.test(pathLow);
            if (onConvWithId && !onListRoot && !emptyShell && !hasComposer) {
                var grTh = normalizeChatHandle(sessionStorage.getItem('current_target') || '');
                var grKey = 'dan_chat_id_grace_' + (grTh || 'unknown');
                var gr = null;
                try { gr = JSON.parse(sessionStorage.getItem(grKey) || 'null'); } catch (eGrJ) { gr = null; }
                var grNow = Date.now();
                if (!gr || !gr.at || (grNow - gr.at) > 25000) { gr = { at: grNow, n: 0 }; }
                gr.n = (gr.n || 0) + 1;
                try { sessionStorage.setItem(grKey, JSON.stringify(gr)); } catch (eGrS) {}
                if ((grNow - gr.at) < 20000) {
                    console.log('[私信] CHAT 单会话页首进宽限 n=' + gr.n + '（待加载，不回收）@' + grTh);
                    try { wakeDmComposerShell(); } catch (eGrW) {}
                    return false;
                }
            }
            if (!onListRoot && !emptyShell && !(onAnyChatSurface && !hasComposer)) return false;

            var th = normalizeChatHandle(sessionStorage.getItem('current_target') || '');
            var host = sessionStorage.getItem('dan_target_username') || getMyHandle();
            var nKey = 'dan_empty_shell_n_' + (th || 'unknown');
            var n = (parseInt(sessionStorage.getItem(nKey) || '0', 10) || 0) + 1;
            sessionStorage.setItem(nKey, String(n));
            console.warn('[私信] 粉丝队列离开 CHAT why=' + (why || '') + ' @' + th + ' n=' + n + ' root=' + onListRoot + ' shell=' + emptyShell);

            try { sessionStorage.removeItem('dan_composer_miss'); } catch (eMc) {}
            try { sessionStorage.removeItem('dan_auto_step'); } catch (eSt) {}
            if (th) sessionStorage.setItem('current_target', th);

            if (th && n >= 3) {
                try { iceQueueMark(th, 'deferred', onListRoot ? 'chat_list_root' : 'empty_chat_shell'); } catch (eIq) {}
                try { sessionStorage.removeItem(nKey); } catch (eNk) {}
                try { sessionStorage.removeItem('current_target'); } catch (eCt) {}
                showToast('⏳ 误入 CHAT，本趟跳过 @' + th, '#faad14', 2200);
            }

            if (host) {
                chatGo('/' + host + '/followers', true);
                return true;
            }
            if (th && n < 3) {
                sessionStorage.setItem('dan_auto_step', '1');
                chatGo('/' + th, false);
                return true;
            }
        } catch (e) {}
        return false;
    }

    /** @deprecated 别名：空壳回收已并入 recoverFanQueueOffChatSurface */
    function recoverFanQueueOffEmptyChatShell(why) {
        return recoverFanQueueOffChatSurface(why);
    }

    /** 点一次会话页返回（宽屏关右栏 / 窄屏退列表），找不到则 false */
    function tryClickDmConversationBack() {
                var sels = [
            '[data-testid="dmConversationBackButton"]',
            '[data-testid="app-bar-back"]',
            '[aria-label="Back"]',
            '[aria-label="戻る"]',
            '[aria-label="返回"]'
        ];
        for (var i = 0; i < sels.length; i++) {
            try {
                var el = document.querySelector(sels[i]);
                if (el && el.getClientRects && el.getClientRects().length) {
                    el.click();
                    return true;
                }
            } catch (eClk) {}
        }
        return false;
    }

    /**
     * 从会话回到列表：只退一层。
     * 守箱已废除 / 粉丝队列 outbound：一律硬回 /followers（禁止点返回落到 Messages 列表）。
     */
    function leaveDmConversationToListOnce() {
        function goFollowersFallback(tag) {
            try {
                var host = sessionStorage.getItem('dan_target_username') || getMyHandle();
                if (host) {
                    console.log('[dm_nav] ' + (tag || 'fallback') + ' → /followers');
                    sessionStorage.setItem('dan_dm_leave_list_at', String(Date.now()));
                    chatGo('/' + host + '/followers', true);
                    return 'followers_fallback';
                }
            } catch (eFf) {}
            return 'no_host';
        }
        // 4.6.68：粉丝台账/outbound/followup 禁止任何「退到收件箱」路径
        try {
            var viaLeave = '';
            try { viaLeave = sessionStorage.getItem('dan_dm_entry_via') || ''; } catch (eViaL) {}
            var phLeave = '';
            try { phLeave = getChatPhase() || ''; } catch (ePhL) { phLeave = ''; }
            if (!isInboxWatchEnabled() || viaLeave === 'fan_roster' || phLeave === 'outbound' || phLeave === 'followup') {
                return goFollowersFallback('force_fans_' + (phLeave || viaLeave || 'no_inbox'));
            }
        } catch (eForce) {}
        try {
            if (isDmInboxListVisible()) {
                if (isDmConversationPage() || isDmConversationView()) {
                    if (tryClickDmConversationBack()) {
                        console.log('[dm_nav] 列表可见，点返回关会话（不重进收件箱）');
                        sessionStorage.setItem('dan_dm_leave_list_at', String(Date.now()));
                        return 'back_btn';
                    }
                    console.log('[dm_nav] 列表已可见，跳过重进');
                    return 'list_visible';
                }
                return 'already';
            }
            var last = parseInt(sessionStorage.getItem('dan_dm_leave_list_at') || '0', 10) || 0;
            var recently = (Date.now() - last) < 5000;
            if (isDmConversationPage()) {
                if (recently) {
                    return goFollowersFallback('已返回过仍无列表');
                }
                sessionStorage.setItem('dan_dm_leave_list_at', String(Date.now()));
                if (tryClickDmConversationBack()) {
                    console.log('[dm_nav] 点返回退列表');
                    return 'back_btn';
                }
                try {
                    history.back();
                    console.log('[dm_nav] history.back 退列表');
                    return 'history_back';
                } catch (eBack) {
                    return goFollowersFallback('history_fail');
                }
            }
            if (!recently) {
                return goFollowersFallback('root');
            }
            return 'wait';
        } catch (eLeave) {
            return goFollowersFallback('error');
        }
    }

    function isDmComposerInPanel(el) {
        if (!el || !el.closest) return false;
        try {
            if (el.closest('[data-testid="dm-container"], [data-testid="dm-conversation-panel"], [data-testid="dm-conversation-content"], [data-testid="DMDrawer"], [data-testid="DmActivityContainer"]')) {
                return true;
            }
            // 4.3.3：中文 UI 常无上述 testid；真会话 URL 上主栏底部输入框即认（勿当 PIN/搜框）
            if (isDmConversationPage()) {
                var col = el.closest('[data-testid="primaryColumn"], main[role="main"], [data-testid="dmComposerTextInput"], [data-testid*="dmComposer"]');
                if (!col && el.getAttribute && /dmComposer|dm-composer/i.test(String(el.getAttribute('data-testid') || ''))) {
                    col = el;
                }
                if (col) {
                    var r = el.getBoundingClientRect();
                    if (r.width >= 40 && r.height >= 14 && r.top > (window.innerHeight || 600) * 0.4) return true;
                }
            }
            return false;
        } catch (e) { return false; }
    }

    /** 会话视图是否打开（URL 会话 或 dm 面板内 composer 可见） */
    function isDmConversationView() {
        if (isDmConversationPage()) return true;
        try {
            var panel = document.querySelector('[data-testid="dm-conversation-panel"], [data-testid="dm-container"], [data-testid="dm-conversation-content"], [data-testid="DMDrawer"]');
            if (!panel) return false;
            var composer = findBottomAwakeningTarget();
            return isDmComposerInPanel(composer);
        } catch (e) { return false; }
    }

    /** 解析当前应诊断/发送的目标 handle（current_target 为空时从 opening / reply_state / URL / 会话头推断） */
    function resolveActiveChatHandle(preferred) {
        var h = normalizeChatHandle(preferred);
        if (h) return h;
        h = normalizeChatHandle(sessionStorage.getItem('current_target') || '');
        if (h) return h;
        h = normalizeChatHandle(sessionStorage.getItem('dan_inbox_opening') || '');
        if (h) return h;
        try {
            var rs = readReplyStateStash();
            if (rs && rs.target) {
                h = normalizeChatHandle(rs.target);
                if (h) return h;
            }
        } catch (eRS) {}
        try {
            var m = (window.location.pathname || '').match(/(?:i\/chat|messages)\/(\d{6,})-(\d{6,})/);
            if (m && m[1]) {
                var db = loadTargetDB();
                for (var k in db) {
                    if (String((db[k] && db[k].peerId) || '') === m[1]) {
                        h = normalizeChatHandle(k);
                        if (h) return h;
                    }
                }
            }
        } catch (eUrl) {}
        try {
            var roots = document.querySelectorAll('[data-testid="dm-conversation-panel"], [data-testid="dm-container"], [data-testid="dm-conversation-content"]');
            for (var ri = 0; ri < roots.length; ri++) {
                var links = roots[ri].querySelectorAll('a[href*="/"]');
                for (var li = 0; li < links.length; li++) {
                    var href = String(links[li].getAttribute('href') || '');
                    var seg = href.split('?')[0].split('/').pop() || '';
                    if (!seg || /^\d+$/.test(seg) || /^(i|chat|messages|home|search)$/i.test(seg)) continue;
                    var cand = normalizeChatHandle(seg);
                    if (cand && loadTargetDB()[cand]) return cand;
                }
            }
        } catch (eHdr) {}
        return '';
    }

    function getDmMessageFallbackRoot() {
        try {
            var composer = findBottomAwakeningTarget();
            var container = composer && composer.closest ? composer.closest('[data-testid="dm-container"], [data-testid="dm-conversation-panel"]') : null;
            if (container && composer) {
                var best = null;
                var bestScore = 0;
                var nodes = container.querySelectorAll('[data-testid="dm-conversation-content"], [data-testid="dm-conversation-scroller"], [data-testid="message-list"], [data-testid="message-list-container"], section, div');
                for (var i = 0; i < nodes.length; i++) {
                    var n = nodes[i];
                    if (!n || n.contains(composer)) continue;
                    var r = n.getBoundingClientRect();
                    if (r.height < 40 || r.width < 80) continue;
                    var score = (n.querySelector('[data-testid^="message"], [data-testid="messageEntry"], [data-testid="messageBubble"]') ? 3 : 0)
                        + (n.scrollHeight > n.clientHeight + 10 ? 2 : 0)
                        + Math.min(r.height / 100, 5);
                    if (score > bestScore) { best = n; bestScore = score; }
                }
                if (best) return best;
            }
        } catch (eFb) {}
        return getDmMessageListRoot();
    }

    /** 消息列表扫描根（比 dm-container 更窄，避免侧栏/资料页 innerText 污染） */
    function getDmMessageListRoot() {
        var selectors = [
            '[data-testid="dm-conversation-scroller"]',
            '[data-testid="message-list-container"]',
            '[data-testid="message-list"]',
            '[data-testid="dm-conversation-content"]',
            '[data-testid="dm-message-scroller"]'
        ];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var el = document.querySelector(selectors[i]);
                if (el) return el;
            } catch (eSel) {}
        }
        try {
            var container = document.querySelector('[data-testid="dm-container"]');
            if (container && container.querySelector('[data-testid^="message-text-"], [data-testid="messageText"], [data-testid="messageEntry"], [data-testid="messageBubble"]')) {
                return container;
            }
        } catch (eC) {}
        return getDmConversationRoot();
    }

    /** 是否在 DM 收件箱环境（URL 或抽屉）且处于列表视图（非窄屏单会话） */
    function isMessagesPage() {
        if (!detectDmMailboxSource()) return false;
        if (isDmInboxListVisible()) return true;
        return !isDmConversationPage();
    }

    var INBOX_PREVIEW_SELF_PREFIX_RE = /^(You:|You sent|Me:|我[:：]?|あなた:|送信済|已发送|Sent)/i;
    var DM_UNREAD_LABEL_RE = /未读|Unread|新消息|new message|message unread/i;
    var INBOX_ARIA_TIME_RE = /^(\d+\s*[smhdwy]|刚刚|刚才|今[天日]|昨[天日]|星期[一二三四五六日天]|Today|Yesterday|Just now|now)$/i;
    var INBOX_ARIA_UNREAD_TOKEN_RE = /^(Unread|未读)$/i;
    var SG_DM_UNREAD_SELECTORS_KEY = (typeof SKeys !== 'undefined' && SKeys.LK_DM_UNREAD_SELECTORS) ? SKeys.LK_DM_UNREAD_SELECTORS : 'sg_dm_unread_selectors';

    function loadInboxUnreadSelectors() {
        try {
            var raw = localStorage.getItem(SG_DM_UNREAD_SELECTORS_KEY);
            if (!raw) return { testids: [], ariaLabels: [] };
            var parsed = JSON.parse(raw);
            return {
                testids: Array.isArray(parsed.testids) ? parsed.testids : [],
                ariaLabels: Array.isArray(parsed.ariaLabels) ? parsed.ariaLabels : []
            };
        } catch (e) { return { testids: [], ariaLabels: [] }; }
    }

    function labelMatchesUnread(label) {
        return DM_UNREAD_LABEL_RE.test(String(label || ''));
    }

    function parseInboxAriaDescription(desc) {
        return (window.SgInboxWatch && window.SgInboxWatch.parseInboxAriaDescription)
            ? window.SgInboxWatch.parseInboxAriaDescription(desc)
            : { displayName: '', handle: '', preview: '', unread: false };
    }
    function inboxRowHasVisibleSelfPrefix(row) {
        // logic owned by SgInboxWatch.extractInboxRowPreviewData
        return false;
    }
    function isInboxPreviewFromSelf(preview) {
        var s = String(preview || '');
        return !!(window.SgInboxWatch && window.SgInboxWatch.scoreInboxPreview
            && window.SgInboxWatch.scoreInboxPreview(s).own);
    }
    function scoreInboxPreview(text) {
        return (window.SgInboxWatch && window.SgInboxWatch.scoreInboxPreview)
            ? window.SgInboxWatch.scoreInboxPreview(text)
            : { own: false, peer: false, unknown: true, confidence: 'unknown', dnaHits: 0 };
    }
    function inboxPreviewIndicatesPeerReply(preview, previewData, previewScore) {
        return !!(window.SgInboxWatch && window.SgInboxWatch.inboxPreviewIndicatesPeerReply
            && window.SgInboxWatch.inboxPreviewIndicatesPeerReply(preview, previewData, previewScore));
    }
    function getInboxRowUnread(row) {
        return (window.SgInboxWatch && window.SgInboxWatch.getInboxRowUnread)
            ? window.SgInboxWatch.getInboxRowUnread(row)
            : { unread: false, source: '', precise: false };
    }
    function conversationHasUnread(row) {
        return !!(window.SgInboxWatch && window.SgInboxWatch.conversationHasUnread
            && window.SgInboxWatch.conversationHasUnread(row));
    }
    function inboxRowOpenPriority(item) {
        // 委托 C3 统一优先级（未读优先）；禁止宿主自行「强回复优先」漂移
        if (window.SgInboxWatch && typeof window.SgInboxWatch.inboxRowOpenPriority === 'function') {
            return window.SgInboxWatch.inboxRowOpenPriority(item);
        }
        if (item.unread && item.unreadPrecise) return 0;
        if (item.unread) return 1;
        if (item.confidence === 'strong_peer' || item.replied) return 2;
        if (item.confidence === 'weak_peer') return 3;
        if (item.kickReady) return 4;
        if (item.probeable) return 5;
        return 6;
    }
    function getChatPhase() {
        var p = sessionStorage.getItem('dan_chat_phase');
        if (p) return p;
        // 守箱关：禁止仅因停在 /i/chat 就推断成 inbox（否则粉丝队列误走守箱身份门）
        try {
            if (!isInboxWatchEnabled()) return 'outbound';
        } catch (eW) {}
        return isMessagesPage() ? 'inbox' : 'outbound';
    }

    function setChatPhase(phase) {
        if (phase === 'inbox') sessionStorage.setItem('dan_chat_phase', 'inbox');
        else if (phase === 'followup') sessionStorage.setItem('dan_chat_phase', 'followup');
        else sessionStorage.setItem('dan_chat_phase', 'outbound');
    }

    /**
     * 破冰↔守箱交接清场（严逻辑 S2 / inbox 脉冲起点）。
     * 清除目标/步进/守箱脉冲态，避免破冰残留污染扫箱。
     */
    function resetChatHandoffState(why) {
        try {
            sessionStorage.removeItem('current_target');
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.removeItem('dan_pending_peer_hash');
            sessionStorage.removeItem('dan_pending_greeting_ad');
            sessionStorage.removeItem('dan_scroll_fail_count');
            sessionStorage.removeItem('dan_bottom_hit_count');
            sessionStorage.removeItem(getReplyStateKey());
        } catch (e) {}
        try {
            localStorage.removeItem(getReplyStateKey());
        } catch (eRs) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.handoff_reset', { why: why || '' });
            }
        } catch (eT) {}
    }

    /** 仅清身份步进（软风控进窗 / 破冰开跑前） */
    function resetChatIdentityState(why) {
        try {
            sessionStorage.removeItem('current_target');
            sessionStorage.removeItem('dan_auto_step');
        } catch (e) {}
        try {
            if (typeof SgTelemetry !== 'undefined') {
                SgTelemetry.emit('chat.identity_reset', { why: why || '' });
            }
        } catch (eT) {}
    }

    /**
     * S2：确保落在收件箱列表根（仅守箱开时）；守箱关则回粉丝页。
     */
    function ensureInboxListRootView() {
        try {
            if (isDmConversationView() || isDmConversationPage()) {
                leaveDmConversationToListOnce();
            }
        } catch (eL) {}
        try {
            if (!isInboxWatchEnabled()) {
                var host = sessionStorage.getItem('dan_target_username') || getMyHandle();
                var p0 = (window.location.pathname || '').toLowerCase();
                if (host && (isDmPath(p0) || /\/(?:i\/chat|messages)/.test(p0))) {
                    chatGo('/' + host + '/followers', true);
                    return 'followers';
                }
                return 'ok_no_inbox';
            }
            var p = (window.location.pathname || '').toLowerCase();
            if (/\/(?:i\/chat|messages)\/\d{5,}/.test(p)) {
                chatGo('/i/chat', true);
                return 'chatgo_list';
            }
            if (!isDmPath(p) || p.indexOf('/followers') >= 0) {
                chatGo('/i/chat', true);
                return 'chatgo_from_elsewhere';
            }
        } catch (eP) {}
        return 'ok';
    }

    /**
     * 身份正向证明：空证据 = pending（不得当 PASS）；真冲突才 mismatch。
     */
    function assertDmConversationMatchesTarget(targetHandle) {
        targetHandle = normalizeChatHandle(targetHandle);
        var out = { ok: false, reason: 'identity_pending', urlPeerId: '', headerHandle: '', dbPeerId: '' };
        if (!targetHandle) {
            out.reason = 'no_target';
            return out;
        }
        out.urlPeerId = readDmUrlPeerId();
        out.headerHandle = readDmConversationHeaderHandle();
        try {
            var entry = loadTargetDB()[targetHandle] || {};
            out.dbPeerId = String(entry.peerId || '').replace(/\D/g, '');
        } catch (eDb) { out.dbPeerId = ''; }

        var synthetic = /^dn_/.test(targetHandle) || /^p\d{5,}$/.test(targetHandle);

        // 真冲突优先
        if (!synthetic && out.headerHandle && out.headerHandle !== targetHandle) {
            out.reason = 'header_handle_mismatch';
            return out;
        }
        if (out.urlPeerId && out.dbPeerId && out.urlPeerId !== out.dbPeerId) {
            out.reason = 'peer_id_mismatch';
            return out;
        }

        // 正向证明
        if (!synthetic && out.headerHandle && out.headerHandle === targetHandle) {
            out.ok = true;
            out.reason = 'ok_header';
            return out;
        }
        if (out.urlPeerId && out.dbPeerId && out.urlPeerId === out.dbPeerId) {
            out.ok = true;
            out.reason = 'ok_peer';
            return out;
        }
        out.reason = 'identity_pending';
        return out;
    }

    /** 是否在收件箱列表根路径（无会话 id） */
    function isDmInboxListRootPath() {
        try {
            var p = (window.location.pathname || '').toLowerCase().replace(/\/+$/, '');
            return p === '/i/chat' || p === '/messages';
        } catch (e) { return false; }
    }

    /** 清除诊断冻结（否则 coTick 会持续 stopChat，Force/解卡无效） */
    function clearDiagFreezeLocal(why) {
        var prev = null;
        try {
            if (typeof SgDiagContract !== 'undefined' && SgDiagContract.clearFreeze) {
                prev = SgDiagContract.clearFreeze(why || 'unstick');
            } else {
                try { prev = JSON.parse(sessionStorage.getItem('sg_diag_freeze') || 'null'); } catch (eP) {}
                try { sessionStorage.removeItem('sg_diag_freeze'); } catch (eR) {}
            }
        } catch (e) {}
        return prev && prev.on ? prev : null;
    }

    /**
     * 守箱关闭时：刷新 OPS + 粉丝页全员登记执行；不在粉丝页则只提示。
     * @returns {{ ok: boolean, reason: string, onFollowers?: boolean }}
     */
    function startFanRosterForce(mins, via) {
        via = via || 'force';
        mins = Math.max(5, Math.min(60, Number(mins) || 20));
        // 4.3.32：Day1 即可私信（原 Day1–2 禁 Force 闸门已移除）
        clearDiagFreezeLocal(via);
        try { maybeRefreshOpsRoundMap(true); } catch (eOps) {}
        try {
            var st = JSON.parse(localStorage.getItem('sg_state') || '{}');
            st.softRiskUntil = Date.now() + mins * 60 * 1000;
            st.softRiskChatDone = false;
            st.softRiskOutboundDone = false;
            st.running = true;
            localStorage.setItem('sg_state', JSON.stringify(st));
        } catch (eSt) {}
        sessionStorage.setItem('dan_auto_run', 'true');
        try { sessionStorage.removeItem('sg_debt_only'); } catch (eD) {}
        try { ensureChatMainEngine(); } catch (eEng) {}
        clearFollowupTaskQueue(via);
        var onFollowers = false;
        try { onFollowers = isFollowersListPath(window.location.href); } catch (eP) {}
        if (!onFollowers) {
            showToast('📋 请打开粉丝列表页，再 Force 登记执行', '#faad14', 3500);
            try {
                var host = sessionStorage.getItem('dan_target_username') || getMyHandle();
                if (host) chatGo('/' + host + '/followers', true);
            } catch (eGo) {}
            return { ok: false, reason: 'need_followers_page', onFollowers: false, inboxWatchEnabled: false };
        }
        try {
            clearIceTaskQueue(via + '_fan_roster');
            clearFanRosterBaseline('force_' + via);
            sessionStorage.removeItem('dan_session_scanned');
            sessionStorage.setItem('dan_session_scanned', '[]');
            sessionStorage.removeItem('dan_bottom_hit_count');
            sessionStorage.removeItem('dan_scroll_fail_count');
            sessionStorage.removeItem('dan_ops_round_refreshed_this_round');
            sessionStorage.removeItem('dan_ice_promoted_deferred');
            sessionStorage.removeItem('dan_ice_seal_inflight');
            sessionStorage.removeItem(SOFT_ROSTER_SCAN_FOR_KEY);
        } catch (eClr) {}
        try { setChatPhase('outbound'); } catch (ePh) {}
        sessionStorage.removeItem('dan_auto_step');
        sessionStorage.removeItem('current_target');
        showToast('📋 Force：重新全量首扫登记', '#1d9bf0', 2200);
        return { ok: true, reason: 'fan_roster_scan', onFollowers: true, inboxWatchEnabled: false, mode: 'fan_roster' };
    }

    /** 一键解卡：解诊断冻结，粉丝登记 */
    function unstickInboxAndPulse(mins) {
        var freezeCleared = clearDiagFreezeLocal('unstick');
        var cleared = [];
        [
            'dan_auto_step', 'dan_warmup_timer'
        ].forEach(function (k) {
            try {
                if (sessionStorage.getItem(k) != null) {
                    sessionStorage.removeItem(k);
                    cleared.push(k);
                }
            } catch (eR) {}
        });
        var fanPulse = startFanRosterForce(mins || 20, 'unstick');
        return {
            cleared: cleared,
            freezeCleared: freezeCleared,
            mode: 'fan_roster',
            pulse: fanPulse,
            version: (function () {
                try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
            })()
        };
    }

    function canSendAdNow(handle, peerTexts, entry) {
        return (window.SgChatGates && window.SgChatGates.canSendAdNow) ? window.SgChatGates.canSendAdNow(handle, peerTexts, entry) : { ok:false, reason:'no_module' };
    }
    function markLastInboundAt(userHandle) {
        if (window.SgChatGates && window.SgChatGates.markLastInboundAt) window.SgChatGates.markLastInboundAt(userHandle);
    }
    function getReplyStateKey() {
        return (typeof SKeys !== 'undefined' && SKeys.LK_CHAT_REPLY_STATE) ? SKeys.LK_CHAT_REPLY_STATE : 'dan_reply_state';
    }

    /** dan_reply_state 双写：sessionStorage（当前页/面板）+ localStorage 持久镜像（防扩展/标签页重载丢证据） */
    function writeReplyStateStash(payload) {
        try {
            var key = getReplyStateKey();
            var p = Object.assign({}, payload || {}, { persistedAt: Date.now() });
            sessionStorage.setItem(key, JSON.stringify(p));
            localStorage.setItem(key, JSON.stringify(p));
        } catch (e) {}
    }

    /** 读取最新回复状态：优先 session，缺省回退持久镜像 */
    function readReplyStateStash() {
        try {
            var key = getReplyStateKey();
            var raw = sessionStorage.getItem(key) || localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    /** 启动恢复：session 空而持久镜像存在时回填，避免重载后回复证据丢失 */
    function restoreReplyStateFromStash() {
        try {
            var key = getReplyStateKey();
            if (sessionStorage.getItem(key)) return;
            var raw = localStorage.getItem(key);
            if (!raw) return;
            var p = JSON.parse(raw);
            sessionStorage.setItem(key, JSON.stringify(Object.assign({}, p, { restoredAt: Date.now() })));
            console.log('[回复状态] 已从持久镜像恢复 dan_reply_state target=' + (p.target || '') + ' decision=' + (p.decision || ''));
        } catch (e) {}
    }

    function canSendKickNow(handle, entry) {
        return !!(window.SgChatGates && window.SgChatGates.canSendKickNow && window.SgChatGates.canSendKickNow(handle, entry));
    }
    function canSendFinalKickNow(handle, entry) {
        return !!(window.SgChatGates && window.SgChatGates.canSendFinalKickNow && window.SgChatGates.canSendFinalKickNow(handle, entry));
    }
    function isChatFullyClosed(entry) {
        return !!(window.SgChatGates && window.SgChatGates.isChatFullyClosed && window.SgChatGates.isChatFullyClosed(entry));
    }
    function markChatFullyClosed(handle, why) {
        handle = normalizeChatHandle(handle);
        if (!handle) return;
        try {
            var db = loadTargetDB();
            if (!db[handle]) db[handle] = { round: 3, firstSeen: Date.now(), lastDM: null };
            db[handle].done = true;
            db[handle].round = Math.max(Number(db[handle].round) || 0, 3);
            db[handle].chatClosedAt = Date.now();
            db[handle].needsFinalKick = false;
            db[handle].closedWhy = why || 'closed';
            if (why === 'kick_max' || why === 'final_kick') {
                db[handle].finalKickSentAt = db[handle].finalKickSentAt || Date.now();
            }
            saveTargetDB(db);
        } catch (e1) {}
        try {
            reportChatMetric('chat_closed', { target: handle, why: why || 'closed' });
            reportSessionVerdict('chat_closed', { target: handle, round: 3, via: why || 'closed' });
        } catch (e3) {}
    }

    /** 守箱已废除：恒 false */
    function isInboxWatchEnabled() {
        return false;
    }

    function getKickCountLocal(entry) {
        if (window.SgChatGates && window.SgChatGates.getKickCount) return window.SgChatGates.getKickCount(entry);
        if (!entry) return 0;
        var n = parseInt(entry.kickCount, 10);
        if (!isNaN(n) && n >= 0) return n;
        return entry.kickSentAt ? 1 : 0;
    }

    function bumpKickCountAndMaybeClose(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return 0;
        var kc = 0;
        try {
            var db = loadTargetDB();
            if (!db[handle]) db[handle] = { round: 2, firstSeen: Date.now(), lastDM: null };
            kc = getKickCountLocal(db[handle]) + 1;
            db[handle].kickCount = kc;
            db[handle].kickSentAt = Date.now();
            db[handle].lastDM = Date.now();
            db[handle].round = Math.max(Number(db[handle].round) || 0, 2);
            var maxK = (window.SgChatGates && window.SgChatGates.KICK_MAX_COUNT) || 2;
            if (kc >= maxK) {
                db[handle].done = true;
                db[handle].chatClosedAt = Date.now();
                db[handle].closedWhy = 'kick_max';
                db[handle].round = Math.max(Number(db[handle].round) || 0, 3);
            }
            saveTargetDB(db);
            if (kc >= maxK) {
                try {
                    reportChatMetric('kick_max_closed', { target: handle, kickCount: kc });
                    reportSessionVerdict('kick_max_closed', { target: handle, round: 3, kickCount: kc });
                } catch (eM) {}
            }
        } catch (e) {}
        return kc;
    }
    function hasMinorKeyword() { return false; }
    function resolveChatPhaseForStats() {
        var phase = sessionStorage.getItem('dan_chat_phase');
        if (phase === 'inbox' || phase === 'outbound') return phase;
        if (isMessagesPage()) return 'inbox';
        if ((window.location.pathname || '').indexOf('/followers') >= 0) return 'outbound';
        try {
            var ms = JSON.parse(sessionStorage.getItem('sg_module_chat') || '{}');
            if (isDmPath(ms.targetUrl || '')) return 'inbox';
        } catch (e) {}
        return 'outbound';
    }

    function reportChatMetric(eventType, meta) {
        meta = meta || {};
        // 只走 SgTelemetry 一次；禁止再经 reportDmHealthEvent（其内部也会 emit → OPS 成对重复）
        try {
            if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
                var sev = meta.severity || 'info';
                SgTelemetry.emit(eventType, Object.assign({ chat_phase: resolveChatPhaseForStats() }, meta), { severity: sev });
            }
        } catch (eT) {}
        try {
            chrome.runtime.sendMessage({
                action: 'ops_activity_report',
                payload: {
                    account_handle: getBotKey() || localStorage.getItem('matrix_my_handle') || 'unknown',
                    action_type: eventType,
                    result: 'ok',
                    source: 'chat_plugin',
                    meta: Object.assign({ chat_phase: resolveChatPhaseForStats() }, meta)
                }
            }, function () {});
        } catch (e1) {}
    }

    /** 进会话后发送/放弃结论（与 parse_age_result 并存） */
    function reportSessionVerdict(verdict, meta) {
        meta = meta || {};
        var sev = 'info';
                        if (verdict === 'composer_not_ready' || verdict === 'gate_blocked' || verdict === 'missing_ice' || verdict === 'pin_blocked' || verdict === 'send_unconfirmed' || verdict === 'ops_report_failed') {
            sev = 'warn';
        }
        reportChatMetric('chat.session_verdict', Object.assign({
            verdict: String(verdict || ''),
            severity: sev
        }, meta));
    }

    /** 探测开聊前：可视区若有未读/强回复，立即让位（禁止 processing_queue 旁路） */
    function listOrphanUnreadRows(urgentHandles) {
        return (window.SgInboxWatch && window.SgInboxWatch.listOrphanUnreadRows)
            ? (window.SgInboxWatch.listOrphanUnreadRows(urgentHandles || {}) || []) : [];
    }

    function reportInboxListSignal(actionable) {
        try {
            var signal = (window.SgInboxWatch && window.SgInboxWatch.summarizeInboxListSignals)
                ? window.SgInboxWatch.summarizeInboxListSignals(actionable || [])
                : null;
            if (!signal) return;
            reportChatMetric('inbox.list_signal', signal);
            var unreadTotal = (signal.unread_dom || 0) + (signal.unread_visual || 0);
            if (unreadTotal > 0 && (signal.urgent || 0) === 0) {
                reportChatMetric('inbox.unread_outside_debt', {
                    count: unreadTotal,
                    unread_dom: signal.unread_dom || 0,
                    unread_visual: signal.unread_visual || 0,
                    debt_matched: signal.debt_matched || 0
                });
            }
        } catch (eSig) {}
    }


    // 扫描当前页所有可见粉丝 → 加入目标数据库
    function syncFanScan() {
        ensureChatFreeze();
        var cells = document.querySelectorAll('[data-testid="UserCell"]');
        var discovered = [];
        var fleetSkipped = 0;
        for (var i = 0; i < cells.length; i++) {
            var link = cells[i].querySelector('a[role="link"]');
            if (!link) continue;
            var href = link.getAttribute('href');
            if (!href) continue;
            var handle = normalizeChatHandle(href.split('?')[0].split('/').pop());
            if (!handle || handle.length < 2) continue;
            if (isFleetHandle(handle)) {
                rejectFleetHandle(handle);
                fleetSkipped++;
                continue;
            }
            if (discoverTarget(handle, extractUserCellDisplayName(cells[i]))) discovered.push(handle);
        }
        if (discovered.length > 0 || fleetSkipped) {
            var skipped = 0;
            for (var j = 0; j < discovered.length; j++) {
                if (!isChatTargetAllowed(discovered[j])) skipped++;
            }
            console.log('[粉丝扫描] 新发现 ' + discovered.length + ' 个粉丝: ' + discovered.slice(0, 5).join(',') + (discovered.length > 5 ? '...' : '')
                + (skipped ? ('（定格后跳过今日私信 ' + skipped + '）') : '')
                + (fleetSkipped ? ('（跳过号池 ' + fleetSkipped + '）') : ''));
        }
        return discovered;
    }

    /** 人对人阶段标签（日志用）：ice→ad→kick */
    function chatStageLabel(round) {
        var r = Number(round) || 0;
        if (r >= 3) return 'done';
        if (r === 2) return 'kick';
        if (r === 1) return 'ad';
        return 'ice';
    }

    /**
     * 本轮仍待处理人数（未按 round 重排）。
     * 一轮 = 粉丝列表从上扫到下；已扫过/已完成/定格不可发的不计。
     */
    function countPendingListTargets(rejectDB, scannedList, completedBackend) {
        var sg = ensureChatFreeze();
        var db = loadTargetDB();
        var n = 0;
        for (var raw in db) {
            var handle = normalizeChatHandle(raw);
            var entry = db[raw];
            if (!entry || !handle) continue;
            if (isFleetHandle(handle)) continue;
            if (entry.done || (entry.round || 0) >= 3) continue;
            if (rejectDB && rejectDB.has(handle)) continue;
            if (scannedList && scannedList.includes(handle)) continue;
            if (completedBackend && completedBackend.includes(handle)) continue;
            if (!isChatTargetAllowed(handle, sg)) continue;
            n++;
        }
        return n;
    }

    /** 仅 round0 待破冰（软风控空破冰出口专用；不含 ad/kick 假债） */
    function countPendingIceTargets(rejectDB, scannedList, completedBackend) {
        var sg = ensureChatFreeze();
        var db = loadTargetDB();
        var n = 0;
        for (var raw in db) {
            var handle = normalizeChatHandle(raw);
            var entry = db[raw];
            if (!entry || !handle) continue;
            if (isFleetHandle(handle)) continue;
            if (entry.done || (entry.round || 0) !== 0) continue;
            if (rejectDB && rejectDB.has(handle)) continue;
            if (scannedList && scannedList.includes(handle)) continue;
            if (completedBackend && completedBackend.includes(handle)) continue;
            if (!isChatTargetAllowed(handle, sg)) continue;
            n++;
        }
        return n;
    }

    /**
     * 粉丝页 outbound：仅 round0 破冰；OPS 已处理则跳过不点进主页。
     */
    function pickNextTargetFromListForRound(rejectDB, scannedList, completedBackend, wantRound) {
        var sg = ensureChatFreeze();
        var cells = document.querySelectorAll('[data-testid="UserCell"]');
        for (var i = 0; i < cells.length; i++) {
            var profileLink = cells[i].querySelector('a[role="link"]');
            if (!profileLink) continue;
            var rawHref = profileLink.getAttribute('href');
            if (!rawHref) continue;
            var userHandle = normalizeChatHandle(rawHref.split('?')[0].split('/').pop());
            if (!userHandle) continue;

            var scannedNow = getSessionList();
            if (scannedNow.includes(userHandle)) continue;

            if (isFleetHandle(userHandle)) {
                rejectFleetHandle(userHandle);
                addSessionList(userHandle);
                continue;
            }
            if (rejectDB && rejectDB.has(userHandle)) {
                addSessionList(userHandle);
                continue;
            }

            try { discoverTarget(userHandle, extractUserCellDisplayName(cells[i])); } catch (eDisc) {}

            if ((completedBackend && completedBackend.includes(userHandle)) || getUserRound(userHandle) >= 3) {
                addSessionList(userHandle);
                continue;
            }
            if (!isChatTargetAllowed(userHandle, sg)) {
                try {
                    if (typeof SgTelemetry !== 'undefined') {
                        SgTelemetry.emit('chat.outbound_freeze_skip', { target: userHandle });
                    }
                } catch (eFz) {}
                addSessionList(userHandle);
                continue;
            }

            if (wantRound === 0) {
                if (!isIceCandidate(userHandle, completedBackend, rejectDB)) {
                    if (getOpsMaxRound(userHandle) >= 1 || getUserRound(userHandle) >= 1) {
                        debugChatLog('outbound skip @' + userHandle + ' opsRound=' + getOpsMaxRound(userHandle), {
                            step: 'outbound_ice_skip', target: userHandle, ops_round: getOpsMaxRound(userHandle)
                        });
                        try {
                            if (typeof SgTelemetry !== 'undefined') {
                                SgTelemetry.emit('chat.outbound_ice_skip', { target: userHandle, ops_round: getOpsMaxRound(userHandle) });
                            }
                        } catch (eSk) {}
                    }
                    addSessionList(userHandle);
                    continue;
                }
                // 破冰文案不含 {LINK}：无推广链仍可点进资料发破冰；广告轮另闸
            }

            var round = getUserRound(userHandle);
            if (round !== wantRound) continue;

            console.log('[私信列表序] @' + userHandle + ' stage=' + chatStageLabel(round) + ' pass=' + wantRound);
            return { link: profileLink, handle: userHandle, round: round };
        }
        return null;
    }

    function pickNextTargetFromList(rejectDB, scannedList, completedBackend) {
        try {
            if (sessionStorage.getItem('sg_debt_only') === 'true') {
                try {
                    var lastDebtToast = parseInt(sessionStorage.getItem('dan_debt_only_toast_at') || '0', 10) || 0;
                    if (Date.now() - lastDebtToast > 60000) {
                        sessionStorage.setItem('dan_debt_only_toast_at', String(Date.now()));
                        showToast('⏸ 仅清债模式：跳过粉丝页破冰', '#faad14', 2000);
                    }
                } catch (eT) {}
                return null;
            }
        } catch (eD) {}
        // 破冰不依赖推广链（无链时仍应点进资料）；广告在发送闸检查 getLiveLink
        return pickNextTargetFromListForRound(rejectDB, scannedList, completedBackend, 0);
    }

    function markUserDone(myHandle, userHandle) {
        advanceRound(userHandle);
    }

    // 将新发现的粉丝同步到后端
    function syncFanScanToBackend(handles) {
        if (!handles || handles.length === 0) return;
        var filtered = handles.map(normalizeChatHandle).filter(function (h) { return h && !isFleetHandle(h); });
        if (!filtered.length) return;
        try {
            chrome.runtime.sendMessage({
                action: 'ops_leads_discover',
                bot_id: localStorage.getItem('matrix_my_handle') || 'unknown',
                handles: filtered
            }, function (r) {
                if (r && r.ok && r.created > 0) {
                    console.log('[粉丝同步] 后台记录 ' + r.created + ' 个新目标');
                }
            });
        } catch (e) {}
        // 回关交叉：仅标记「我们曾关注过」的粉（OPS 侧过滤）
        try {
            if (window.SgFollowBack && typeof window.SgFollowBack.reportFromFollowers === 'function') {
                window.SgFollowBack.reportFromFollowers(filtered);
            }
        } catch (eFb) {}
    }

    // ==================== 年龄识别（C4 → chat/age-parse.js）====================
    var AGE_REJECT_BELOW = (window.SgAgeParse && window.SgAgeParse.AGE_REJECT_BELOW) || 25;
    /** 兼职粉：年龄不挡发送（人工报数扣粉）；dating 仍用 AGE_REJECT_BELOW */
    var SCRIPTS_LS_KEY_DATING = 'dan_scripts';
    var SCRIPTS_LS_KEY_JOB = 'dan_scripts_job';

    function getScriptPoolMode() {
        try {
            if (window.RemoteSettings && typeof window.RemoteSettings.chatScriptPool === 'function') {
                return window.RemoteSettings.chatScriptPool() === 'job' ? 'job' : 'dating';
            }
        } catch (eRs) {}
        try {
            var t = JSON.parse(localStorage.getItem('sg_config_thresholds') || '{}') || {};
            var v = String(t.chat_script_pool || 'dating').toLowerCase().trim();
            return v === 'job' ? 'job' : 'dating';
        } catch (e) {}
        return 'dating';
    }

    function isJobScriptPool() {
        return getScriptPoolMode() === 'job';
    }

    function getAgeRejectBelow() {
        // job：21歳以下（含21）扣粉 → age < 22 婉拒
        return isJobScriptPool() ? 22 : AGE_REJECT_BELOW;
    }

    function parseAgeFromText(text) {
        return (window.SgAgeParse && window.SgAgeParse.parseAgeFromText)
            ? window.SgAgeParse.parseAgeFromText(text) : null;
    }
    function parseAgeFromInbound(texts) {
        return (window.SgAgeParse && window.SgAgeParse.parseAgeFromInbound)
            ? window.SgAgeParse.parseAgeFromInbound(texts) : null;
    }

    /**
     * 兼职粉意向：yes / no / unknown
     * 发送闸：仅 no → 婉拒；yes/unknown 有回复都发完整话术（含蓄寒暄也放行）
     */
    function parseJobIntent(texts) {
        var text = '';
        try {
            if (Array.isArray(texts)) text = texts.join('\n');
            else text = String(texts || '');
        } catch (e) { text = String(texts || ''); }
        text = String(text || '').replace(/\s+/g, ' ').trim();
        if (!text) return 'unknown';
        // 拒绝优先（指定答「やらない」+ 常见婉拒）
        if (/やらな[いぃ]|やらねえ|やんない|やりません|やらなくて|いらない|要らない|興味ない|興味がありません|興味はありません|結構です|大丈夫です|辞退|無理|できない|嫌|やめ|不要|no thanks|pass|不做|不要做/i.test(text)) {
            return 'no';
        }
        // 指定答「やる」或明确愿意
        if (/(^|[^\u3040-\u30ff\u4e00-\u9faf])やる([^\u3040-\u30ff\u4e00-\u9faf\u3089]|$)|^やる[！!。．]?$|やりたい|やってみたい|やります|やるよ|やるね|やるで|興味[ぁあ]?[るり]|興味あります|いいよ|いいです|お願いします|お願い|ぜひ|もちろん|OK|ＯＫ|ok\b|おｋ|了解.*やる|やる.*了解|したい|做$|^做[！!。．]?$/i.test(text)) {
            return 'yes';
        }
        return 'unknown';
    }

    // 纯时刻 / 相对时间；星期+时刻见 DM_WEEKDAY_TIME_RE；日期 at 行见 DM_DATE_AT_RE
    var DM_TIMESTAMP_RE = /^(\d{1,2}:\d{2}(\s?(AM|PM|上午|下午|午前|午後))?|(上午|下午|午前|午後)\s*\d{1,2}:\d{2}|昨[日天]|昨天|今天|今日|刚刚|稍后|saved)$/i;
    var DM_WEEKDAY_TIME_RE = /^(今天|昨天|昨日|今日|星期[一二三四五六日天]|周[一二三四五六日天]|Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon\.?|Tue\.?|Wed\.?|Thu\.?|Fri\.?|Sat\.?|Sun\.?)(\s+\d{1,2}:\d{2}(\s?(AM|PM|上午|下午|午前|午後))?|\s*(午前|午後)\s*\d{1,2}:\d{2})?$/i;
    // 例：8月31日周一 at 7:12 / Aug 31 at 7:12 PM
    var DM_DATE_AT_RE = /^(\d{1,2}\s*月\s*\d{1,2}\s*日([星期周]?[一二三四五六日天])?|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?)\s*(at|@)?\s*\d{1,2}:\d{2}(\s?(AM|PM|上午|下午|午前|午後))?$/i;

    /** 本方话术全集（差集硬门用）；由 rebuildOwnScriptCorpus 填充 */
    var OWN_SCRIPT_CORPUS = [];

    /** 规范化 / 链接壳（C3 → chat/inbox-watch.js） */
    function normalizeForScriptMatch(text) {
        return (window.SgInboxWatch && window.SgInboxWatch.normalizeForScriptMatch)
            ? window.SgInboxWatch.normalizeForScriptMatch(text) : String(text || '').replace(/\s+/g, ' ').trim();
    }
    function isLinkShellText(text) {
        return !!(window.SgInboxWatch && window.SgInboxWatch.isLinkShellText && window.SgInboxWatch.isLinkShellText(text));
    }

    function __pushCorpusEntry(list, text) {
        var raw = String(text || '').trim();
        if (!raw) return;
        var norm = normalizeForScriptMatch(raw);
        if (!norm && !isLinkShellText(raw)) return;
        if (!norm) norm = raw.replace(/\s+/g, ' ').trim();
        for (var i = 0; i < list.length; i++) {
            if (list[i].norm === norm) return;
        }
        list.push({
            raw: raw,
            norm: norm,
            needle: (typeof __msgNeedle === 'function' ? __msgNeedle(norm) : norm.slice(0, 28)),
            short: norm.length < 8
        });
    }

    /** 从当前话术池 + 默认池 + promo 重建语料（发送原文按 handle 另加） */
    function rebuildOwnScriptCorpus() {
        var list = [];
        function addAllFromScripts(scriptsObj) {
            if (!scriptsObj) return;
            Object.keys(scriptsObj).forEach(function (k) {
                var s = scriptsObj[k] || {};
                __pushCorpusEntry(list, s.icebreaker);
                __pushCorpusEntry(list, s.ad_template || s.ad);
                __pushCorpusEntry(list, s.kick_message || s.kick);
                __pushCorpusEntry(list, s.final_kick_message || s.final_kick);
                __pushCorpusEntry(list, s.reject_message || s.reject);
                __pushCorpusEntry(list, s.foreigner_reject);
            });
        }
        function addFromStorageKey(key) {
            try {
                var raw = localStorage.getItem(key);
                if (!raw) return;
                var cfg = JSON.parse(raw);
                addAllFromScripts(cfg.scripts);
                if (cfg.templates) {
                    __pushCorpusEntry(list, cfg.templates.icebreaker);
                    __pushCorpusEntry(list, cfg.templates.ad);
                    __pushCorpusEntry(list, cfg.templates.kick);
                    __pushCorpusEntry(list, cfg.templates.final_kick);
                    __pushCorpusEntry(list, cfg.templates.reject);
                    __pushCorpusEntry(list, cfg.templates.foreigner_reject);
                }
            } catch (eCfg) {}
        }
        try {
            if (typeof SCRIPT_DEFAULTS !== 'undefined' && SCRIPT_DEFAULTS) {
                addAllFromScripts(SCRIPT_DEFAULTS.scripts);
                if (SCRIPT_DEFAULTS.templates) {
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS.templates.icebreaker);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS.templates.ad);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS.templates.kick);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS.templates.final_kick);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS.templates.reject);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS.templates.foreigner_reject);
                }
            }
        } catch (eDef) {}
        try {
            if (typeof SCRIPT_DEFAULTS_JOB !== 'undefined' && SCRIPT_DEFAULTS_JOB) {
                addAllFromScripts(SCRIPT_DEFAULTS_JOB.scripts);
                if (SCRIPT_DEFAULTS_JOB.templates) {
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS_JOB.templates.icebreaker);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS_JOB.templates.ad);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS_JOB.templates.kick);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS_JOB.templates.final_kick);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS_JOB.templates.reject);
                    __pushCorpusEntry(list, SCRIPT_DEFAULTS_JOB.templates.foreigner_reject);
                }
            }
        } catch (eJobDef) {}
        addFromStorageKey('dan_scripts');
        addFromStorageKey('dan_scripts_job');
        try {
            __pushCorpusEntry(list, ICEBREAKER_MESSAGE);
            __pushCorpusEntry(list, AD_MESSAGE_TEMPLATE);
            __pushCorpusEntry(list, KICK_MESSAGE);
            __pushCorpusEntry(list, FINAL_KICK_MESSAGE);
            __pushCorpusEntry(list, REJECT_MESSAGE);
            __pushCorpusEntry(list, FOREIGNER_REJECT_MESSAGE);
        } catch (eLive) {}
        try {
            var links = (typeof getDefaultLinks === 'function' ? getDefaultLinks() : []) || [];
            for (var li = 0; li < links.length; li++) __pushCorpusEntry(list, links[li]);
        } catch (ePromo) {}
        OWN_SCRIPT_CORPUS = list;
        return list;
    }

    function getHandleSentScriptTexts(handle) {
        handle = normalizeChatHandle(handle || '');
        if (!handle) return [];
        try {
            var e = loadTargetDB()[handle] || {};
            return [e.lastIceText, e.lastAdText, e.lastKickText, e.lastRejectText].filter(function (t) {
                return !!String(t || '').trim();
            });
        } catch (e) { return []; }
    }

    /** 发送成功后记忆原文，避免 OPS 换池后旧气泡被当成对方 */
    function rememberSentScriptText(handle, userRound, msg) {
        handle = normalizeChatHandle(handle);
        var text = String(msg || '').trim();
        if (!handle || !text) return;
        try {
            var db = loadTargetDB();
            if (!db[handle]) return;
            if (userRound === 0) db[handle].lastIceText = text;
            else if (userRound === 1 || userRound === 'ad' || userRound === 'greeting_ad') db[handle].lastAdText = text;
            else if (userRound === 2) db[handle].lastKickText = text;
            else if (userRound === 'reject' || userRound === 3) db[handle].lastRejectText = text;
            saveTargetDB(db);
        } catch (e) {}
    }

    /** 对方文本指纹：无新入站则不再处理（S2） */
    function hashPeerTexts(texts) {
        var parts = [];
        texts = texts || [];
        for (var i = 0; i < texts.length; i++) {
            var t = String(texts[i] || '').replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
        }
        var s = parts.join('\n');
        var h = 0;
        for (var j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0;
        return String(h) + ':' + s.length + ':' + parts.length;
    }
    function markPeerTextsProcessed(handle, peerHash, extra) {
        handle = normalizeChatHandle(handle);
        if (!handle) return;
        try {
            var db = loadTargetDB();
            var er = db[handle] || {};
            er.lastProcessedPeerHash = peerHash || '';
            er.peerProcessedAt = Date.now();
            if (extra) {
                for (var k in extra) {
                    if (Object.prototype.hasOwnProperty.call(extra, k)) er[k] = extra[k];
                }
            }
            db[handle] = er;
            saveTargetDB(db);
        } catch (eM) {}
    }

    // ==================== C3 差集硬门（→ chat/inbox-watch.js）====================
    function isOwnScriptText(text, handle) {
        return !!(window.SgInboxWatch && window.SgInboxWatch.isOwnScriptText && window.SgInboxWatch.isOwnScriptText(text, handle));
    }
    function isLikelyOwnDmText(text, handle) {
        return isOwnScriptText(text, handle);
    }

    function collectExtraPeerTexts(handle, opts) {
        return (window.SgInboxWatch && window.SgInboxWatch.collectExtraPeerTexts)
            ? (window.SgInboxWatch.collectExtraPeerTexts(handle, opts) || []) : [];
    }

    function getDmConversationRoot() {
        if (isDmConversationPage()) {
            return document.querySelector('[data-testid="dm-conversation-scroller"]')
                || document.querySelector('[data-testid="dm-conversation-content"]')
                || document.querySelector('[data-testid="dm-conversation-panel"]')
                || document.querySelector('[data-testid="dm-container"]')
                || document.querySelector('[data-testid="DmActivityContainer"]')
                || document.querySelector('[data-testid="conversation"]')
                || document.querySelector('[role="main"]')
                || document.body;
        }
        return document.querySelector('[data-testid="dm-conversation-content"]')
            || document.querySelector('[data-testid="dm-conversation-panel"]')
            || document.querySelector('[data-testid="dm-container"]')
            || document.querySelector('[data-testid="DmActivityContainer"]')
            || document.querySelector('[data-testid="conversation"]')
            || document.querySelector('[role="main"]')
            || document.body;
    }

    function getDmConversationRootTestid() {
        var root = getDmConversationRoot();
        try { return root === document.body ? 'body' : (root.getAttribute('data-testid') || root.tagName); } catch (e) { return 'unknown'; }
    }

    function isDmMessageBubbleNode(el) {
        if (!el || !el.closest) return false;
        try {
            return !!(
                el.closest('[data-testid^="message-text-"]') ||
                el.closest('[data-testid="messageText"]') ||
                el.closest('[data-testid="messageEntry"]') ||
                el.closest('[data-testid="messageBubble"]') ||
                el.closest('[data-testid^="message-"]:not([data-testid^="message-text-"]):not([data-testid="message-list-container"]):not([data-testid="message-list"]):not([data-testid="message-scroller"])')
            );
        } catch (e) { return false; }
    }

    function isDmComposerNode(el) {
        if (!el) return false;
        // 会话气泡在 DMDrawer 内，不能把整棵 Drawer 当 composer，否则 collectPeer 第一步全被滤掉
        if (isDmMessageBubbleNode(el)) return false;
        try {
            if (el.closest && (
                el.closest('[data-testid="dmComposerTextInput"]') ||
                el.closest('[data-testid="dmComposerSendButton"]') ||
                el.closest('[data-testid="dm-composer-container"]') ||
                el.closest('[data-testid="dm-composer-textarea"]') ||
                el.closest('[data-testid="dm-composer-form"]') ||
                el.closest('[data-testid="dm-conversation-panel"] [contenteditable="true"]') ||
                el.closest('[data-testid="DmActivityContainer"] [contenteditable="true"]')
            )) return true;
        } catch (e) {}
        return !!(el.closest && el.closest('[contenteditable="true"]'));
    }

    function getDmMessageText(el) {
        if (!el) return '';
        var raw = (el.innerText || el.textContent || '').replace(/\r/g, '\n');
        var lines = String(raw).split('\n');
        var parts = [];
        for (var i = 0; i < lines.length; i++) {
            var line = String(lines[i] || '').replace(/\s+/g, ' ').trim();
            if (!line) continue;
            if (DM_TIMESTAMP_RE.test(line)) continue;
            if (/^(已读|Read|送达|Delivered|发送失败|Failed to send|无法送达|Message not delivered)$/i.test(line)) continue;
            parts.push(line);
        }
        if (!parts.length) return '';
        var out = parts.join(' ').trim();
        out = out.replace(/^\s*(You:|Me:|我：|我:|你：|你:|あなた:|自分:)/i, '').trim();
        return out;
    }

    function findDmMessageEntry(el) {
        if (!el || !el.closest) return null;
        try {
            return el.closest('[data-testid^="message-"]:not([data-testid^="message-text-"])')
                || el.closest('[data-testid="messageEntry"]')
                || el.closest('[data-testid="messageBubble"]')
                || el.closest('[data-testid="conversationItem"]')
                || el.closest('[role="listitem"]')
                || el.closest('article') || null;
        } catch (e) { return null; }
    }

    /** 统一查找 DM 发送按钮：优先新版 composer 区域，兼容旧版选择器 */
    function findDmSendButton() {
        var root = document.querySelector('[data-testid="dm-composer-form"]')
            || document.querySelector('[data-testid="dm-composer-container"]')
            || document.querySelector('[data-testid="dmComposerTextInput"]')
            || document.querySelector('[data-testid="dm-conversation-panel"]')
            || document.querySelector('[data-testid="DMDrawer"]')
            || null;
        // 会话页：优先在输入口附近找发送键，避免全局文本 aria 误点
        try {
            var mouth = findBottomAwakeningTarget();
            if (mouth && mouth.closest) {
                var near = mouth.closest('form')
                    || mouth.closest('[data-testid*="dmComposer" i]')
                    || mouth.closest('[data-testid*="composer" i]')
                    || mouth.parentElement;
                if (near) {
                    var nearBtn = near.querySelector('[data-testid="dmComposerSendButton"]')
                        || near.querySelector('button[type="submit"]')
                        || near.querySelector('[role="button"][data-testid*="send" i]');
                    if (nearBtn) return nearBtn;
                    root = near;
                }
            }
        } catch (eNear) {}
        if (!root) {
            try {
                if (isDmConversationPage()) {
                    root = document.querySelector('[data-testid="primaryColumn"]')
                        || document.querySelector('main[role="main"]')
                        || document;
                } else {
                    root = document;
                }
            } catch (eR) { root = document; }
        }
        var sendBtn = null;
        try {
            sendBtn = root.querySelector('[data-testid="dmComposerSendButton"]') ||
                root.querySelector('[data-testid^="dm-composer"] button[aria-label*="Send" i]') ||
                root.querySelector('[data-testid^="dm-composer"] button[aria-label*="发送" i]') ||
                root.querySelector('[data-testid^="dm-composer"] button[aria-label*="送信" i]') ||
                root.querySelector('[data-testid^="dm-composer"] button[type="submit"]') ||
                root.querySelector('button[type="submit"]');
        } catch (e) {}
        if (!sendBtn) {
            try {
                sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]');
            } catch (e2) {}
        }
        return sendBtn || null;
    }

    /** 消息行内是否存在对方头像（X 的 1:1 DM 中本方气泡通常不带头像） */
    function dmEntryHasPeerAvatar(entry) {
        if (!entry || !entry.querySelector) return false;
        try {
            if (entry.querySelector('[data-testid="messageEntryAvatar"], [data-testid="userAvatar"], [data-testid="avatar"], [data-testid="dmConversationAvatar"], [data-testid^="dm-message-avatar"], [data-testid^="message-"] [data-testid="avatar"]')) return true;
        } catch (e) {}
        return false;
    }

    /** 对方/本方判别：DOM 信号优先（头像/对齐），内容信号兜底。返回 'peer' | 'own' | null */
    function getDmGeometryBounds() {
        try {
            var scroller = document.querySelector('[data-testid="dm-conversation-scroller"]');
            if (scroller) return scroller.getBoundingClientRect();
            var content = document.querySelector('[data-testid="dm-conversation-content"]');
            if (content) return content.getBoundingClientRect();
            var scanRoot = getDmMessageScanRoot();
            if (scanRoot && scanRoot !== document.body) return scanRoot.getBoundingClientRect();
        } catch (e) {}
        return null;
    }

    function classifyDmNode(el) {
        if (!el) return null;
        var text = getDmMessageText(el);
        if (!text || text.length > 280) return null;
        var rawWithLabel = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^(You:|Me:|我：|我:|あなた:|自分:)/i.test(rawWithLabel)) return 'own';
        var entry = findDmMessageEntry(el) || (el.getAttribute && String(el.getAttribute('data-testid') || '').indexOf('message-text-') === 0 ? el.closest('[data-testid^="message-"]') : null) || el;
        var geomSide = null;
        if (entry) {
            try {
                var entryLabel = String((entry.getAttribute && entry.getAttribute('aria-label')) || '') + ' ' + String(entry.getAttribute('data-testid') || '');
                if (/you sent|your message|あなたが送信|送信済/i.test(entryLabel)) return 'own';
                if (/sent you|message from|からのメッセージ|相手から/i.test(entryLabel)) return 'peer';
            } catch (eLbl) {}
            if (dmEntryHasPeerAvatar(entry)) return 'peer';
            try {
                var rect = el.getBoundingClientRect();
                var pr = getDmGeometryBounds();
                if (!pr) {
                    var parent = entry.parentElement || (entry.closest ? entry.closest('[data-testid="dm-message-scroller"]') : null);
                    pr = parent ? parent.getBoundingClientRect() : null;
                }
                if (pr && rect.width > 0 && pr.width > 0) {
                    var centerX = rect.left + rect.width / 2;
                    var midX = pr.left + pr.width / 2;
                    var leftRatio = (rect.left - pr.left) / pr.width;
                    var rightRatio = (pr.right - rect.right) / pr.width;
                    if (leftRatio > 0.58 || (rightRatio < 0.15 && centerX > midX + 4)) geomSide = 'own';
                    else if (leftRatio < 0.52 || centerX < midX - 4) geomSide = 'peer';
                }
            } catch (eRect) {}
        }
        if (geomSide === 'peer') return 'peer';
        if (geomSide === 'own') return 'own';
        if (isLikelyOwnDmText(text)) return 'own';
        return null;
    }

    function isPeerDmNode(el) {
        // 4.3.15：几何降级。正文差集优先——非壳且非话术池即对方
        var t = '';
        try { t = getDmMessageText(el) || ''; } catch (eT) {}
        if (!t) return false;
        try {
            var h = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || '';
            if (isDmChromeNoise(t, h)) return false;
        } catch (eCh) {}
        if (isLinkShellText(t) || isOwnScriptText(t)) return false;
        var cls = classifyDmNode(el);
        if (cls === 'own') return false;
        if (cls === 'peer') return true;
        // 几何未知：正文已非话术 → 认对方（用户约定）
        return true;
    }

    function isSystemDmLine(text) {
        if (!text) return true;
        var s = String(text).replace(/\s+/g, ' ').trim();
        if (!s) return true;
        if (DM_TIMESTAMP_RE.test(s)) return true;
        if (DM_WEEKDAY_TIME_RE.test(s)) return true;
        if (DM_DATE_AT_RE.test(s)) return true;
        if (/^(已读|Read|送达|Delivered|发送失败|Failed to send|无法送达|Message not delivered)$/i.test(s)) return true;
        if (/^(Unencrypted|Encrypted)$/i.test(s)) return true;
        return false;
    }

    /** 侧栏/资料卡 / 空会话 / X 产品壳 UI 行（非聊天气泡） */
    function isProfileUiLine(text) {
        var s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s || s.length > 120) return true;
        if (/^(Messages|Message|Chat|New message|Send a message|私信|消息|发送消息)$/i.test(s)) return true;
        if (/\b(Private Enterprise|Business|Professional|Creator|Verified|Subscribe|Premium|Affiliate|Parody|Followers?|Following|Joined|View Profile|Birth date|Location|Website|Translate bio)\b/i.test(s)) return true;
        if (/^\d[\d,.]*\s*(Followers?|Following|Posts?|订阅者)/i.test(s)) return true;
        if (/start a conversation|start the conversation|no messages yet|say hello|まだメッセージ|メッセージはまだ|发送第一条|開始對話|开始对话|会話を始め/i.test(s)) return true;
        // 4.1.18 / 4.1.50 / 4.1.53：X 产品壳 / 空会话资料卡（曾被当成对方回复 → peer_first）
        if (/^Use X Number$/i.test(s)) return true;
        if (/Use X Number/i.test(s) && s.length <= 80) return true;
        if (/^(Not Now|以后再说|いまはしない)$/i.test(s)) return true;
        if (/doesn't follow you|If you know their X Number|You must be verified|must be verified|has a closed inbox|closed inbox|收件箱已关闭|要验证/i.test(s) && s.length <= 160) return true;
        if (/Joined\s+\d|登録|に登録|年\d{1,2}月|View\s*Profile|プロフィールを表示/i.test(s) && s.length <= 80) return true;
        if (/^(Get|Try|Upgrade to)\s+X\s+(Premium|Premium\+|Business|Pro)\b/i.test(s)) return true;
        if (/^X Number$/i.test(s)) return true;
        if (/^(Photo|Video|Gif|Image|Voice message|Shared a post|Shared a link)$/i.test(s)) return true;
        if (/^(照片|视频|动图|语音消息|分享了帖子|分享了链接)$/i.test(s)) return true;
        return false;
    }

    /**
     * 身份噪声：句柄/短前缀/页头显示名（4.1.17：防 dai / グロム 类误当回复）
     */
    function isDmIdentityNoise(text, handle) {
        var s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s) return true;
        if (s.length <= 1) return true;
        var nh = normalizeChatHandle(handle || sessionStorage.getItem('current_target') || '') || '';
        var bare = s.replace(/^@+/, '').toLowerCase();
        if (nh) {
            if (bare === nh || s === '@' + nh) return true;
            // 句柄短前缀（如 dai ⊂ dai51788、akairo ⊂ akairoji）
            if (bare.length >= 2 && bare.length <= 8 && nh.indexOf(bare) === 0 && bare.length < nh.length) return true;
        }
        try {
            var entry = nh ? (loadTargetDB()[nh] || {}) : {};
            var dn = String(entry.displayName || '').replace(/\s+/g, ' ').trim();
            if (dn) {
                if (s === dn) return true;
                try {
                    if (typeof normalizeDisplayName === 'function'
                        && normalizeDisplayName(s) === normalizeDisplayName(dn)) return true;
                } catch (eDn) {}
            }
        } catch (eDb) {}
        try {
            var hh = readDmConversationHeaderHandle();
            if (hh) {
                var hhBare = String(hh).replace(/^@+/, '').toLowerCase();
                if (bare === hhBare) return true;
            }
        } catch (eHh) {}
        return false;
    }

    /** DM 页面壳 = 系统行 + UI 行 + 身份噪声（差集 B 层） */
    function isDmChromeNoise(text, handle) {
        if (isSystemDmLine(text) || isProfileUiLine(text)) return true;
        if (isDmIdentityNoise(text, handle)) return true;
        return false;
    }

    /** 从消息行中挑选最可能是正文的文本叶子节点（优先 messageText，其次最长的 [dir=auto]） */
    function findDmTextLeaf(entry) {
        if (!entry || !entry.querySelectorAll) return null;
        try {
            var textNode = entry.querySelector('[data-testid="messageText"], [data-testid^="message-text-"], [data-testid="messageText"] span, [data-testid="messageText"] [dir="auto"], [data-testid^="message-text-"] [dir="auto"]');
            if (textNode && getDmMessageText(textNode)) return textNode;
        } catch (e) {}
        try {
            var dirs = entry.querySelectorAll('[dir="auto"]');
            var best = null, bestLen = 0;
            for (var i = 0; i < dirs.length; i++) {
                var t = getDmMessageText(dirs[i]);
                if (t && t.length > bestLen) { best = dirs[i]; bestLen = t.length; }
            }
            if (best) return best;
        } catch (e2) {}
        return null;
    }

    // ==================== 4.6.33 几何+DNA 混合分类 ====================

    /**
     * 几何判定：消息气泡在会话容器中的水平位置 → own(右) / peer(左) / unknown。
     * X DM：我方气泡右对齐，对方左对齐。用叶子中心的 X 坐标与容器中心比较。
     * 死区 ±3%（最小 15px）内的判定为 unknown（居中系统消息等）。
     */
    function classifyDmLeafGeometry(leaf) {
        if (!leaf || !leaf.getBoundingClientRect) return 'unknown';
        try {
            var rect = leaf.getBoundingClientRect();
            if (!rect || rect.width === 0 || rect.height === 0) return 'unknown';
            var root = null;
            try { root = __getDmMessageListRoot(); } catch (eR) {}
            if (!root) { try { root = getDmMessageScanRoot(); } catch (eS) {} }
            if (!root || !root.getBoundingClientRect) return 'unknown';
            var rootRect = root.getBoundingClientRect();
            if (!rootRect || rootRect.width < 100) return 'unknown';
            var leafCX = rect.left + rect.width / 2;
            var rootCX = rootRect.left + rootRect.width / 2;
            var dead = Math.max(15, rootRect.width * 0.03);
            if (leafCX > rootCX + dead) return 'own';
            if (leafCX < rootCX - dead) return 'peer';
            return 'unknown';
        } catch (e) { return 'unknown'; }
    }

    /**
     * 混合分类：几何优先，DNA（话术池）兜底。
     * 几何右 → own（即使话术池不匹配——可能是新话术未入池）
     * 几何左 → peer（即使文本像话术——对方可能引用/撞车）
     * 几何不明 → DNA 判定（isLinkShellText || isOwnScriptText）
     */
    function classifyDmMessageOwnPeer(text, leaf) {
        var geo = classifyDmLeafGeometry(leaf);
        if (geo === 'own') return 'own';
        if (geo === 'peer') return 'peer';
        var handle = '';
        try { handle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (eH) {}
        return (isLinkShellText(text) || isOwnScriptText(text, handle)) ? 'own' : 'peer';
    }

    function collectPeerDmMessages() {
        var scanRoot = getDmMessageScanRoot();
        var seen = {};
        var out = [];

        // 4.3.19/4.3.20：破冰后对方只走 afterIce；有我方话术时禁止回落宽扫历史灰泡
        // （修：9/21「はなそーん」被当成今日破冰后回复 → 误发完整话术）
        var afterIce = [];
        try { afterIce = collectPeerTextsAfterIceTurn() || []; } catch (eTurn) { afterIce = []; }
        var hasOwnIceSent = false;
        try {
            var bodies = __collectDmBodyTexts();
            hasOwnIceSent = !!(bodies && bodies.own && bodies.own.length);
        } catch (eB) {}
        if (!hasOwnIceSent) {
            try {
                var th = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || '';
                var ent = th ? (loadTargetDB()[th] || {}) : {};
                if (ent.iceSentAt) hasOwnIceSent = true;
            } catch (eDb) {}
        }
        if (hasOwnIceSent) return afterIce;

        function tryPushPeer(leaf, entry) {
            if (!leaf || isDmComposerNode(leaf)) return;
            var raw = getDmMessageText(leaf);
            if (!raw || raw.length > 280) return;
            var peerHandle = '';
            try { peerHandle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (ePh) {}
            if (isDmChromeNoise(raw, peerHandle)) return;
            // 4.6.33：几何优先 + DNA 兜底——右对齐必 own（新话术未入池也跳过），
            // 左对齐必 peer（撞车前缀/链接误判不再漏掉对方回复）
            if (classifyDmMessageOwnPeer(raw, leaf) === 'own') return;
            if (seen[raw]) return;
            seen[raw] = 1;
            out.push({ text: raw, source: leaf, entry: entry || findDmMessageEntry(leaf) || leaf, isReply: true });
        }

        // 1) 新版 /i/chat：message-text-* / messageText 叶子（最可靠）
        try {
            var textLeaves = scanRoot.querySelectorAll('[data-testid^="message-text-"], [data-testid="messageText"]');
            for (var tl = 0; tl < textLeaves.length; tl++) {
                tryPushPeer(textLeaves[tl], findDmMessageEntry(textLeaves[tl]));
            }
        } catch (eLeaves) {}

        // 2) 消息行容器
        var entrySelectors = [
            '[data-testid^="message-"]:not([data-testid^="message-text-"]):not([data-testid="message-list-container"]):not([data-testid="message-list"]):not([data-testid="message-scroller"])',
            '[data-testid="messageEntry"]',
            '[data-testid="messageBubble"]',
            '[data-testid="conversationItem"]',
            '[role="listitem"]'
        ];
        for (var s = 0; s < entrySelectors.length; s++) {
            try {
                var found = scanRoot.querySelectorAll(entrySelectors[s]);
                for (var i = 0; i < found.length; i++) {
                    var entry = found[i];
                    tryPushPeer(findDmTextLeaf(entry) || entry, entry);
                }
            } catch (eSel) {}
        }

        // 3) 限定在消息列表根内的文本节点
        var listRoot = getDmMessageListRoot();
        var narrowSelectors = [
            '[data-testid="tweetText"]',
            '[data-testid="dm-message-text"]',
            '[data-testid="dm-message-bubble"]',
            '[data-testid="DmActivityContainer"] [dir="auto"]',
            '[data-testid="dm-conversation-content"] [dir="auto"]',
            'article [dir="auto"]'
        ];
        for (var s2 = 0; s2 < narrowSelectors.length; s2++) {
            try {
                var found2 = listRoot.querySelectorAll(narrowSelectors[s2]);
                for (var i2 = 0; i2 < found2.length; i2++) tryPushPeer(found2[i2], findDmMessageEntry(found2[i2]));
            } catch (eSel2) {}
        }

        // 3b) dm-container 旧布局：任意 message* testid 节点（排除 composer/列表容器）
        if (!out.length) {
            try {
                var anyMsg = listRoot.querySelectorAll('[data-testid*="message" i], [data-testid="cellInnerDiv"]');
                for (var am = 0; am < anyMsg.length; am++) {
                    var node = anyMsg[am];
                    var tid = String((node.getAttribute && node.getAttribute('data-testid')) || '');
                    if (/conversation-item|composer|message-list-container|message-scroller|message-list$/i.test(tid)) continue;
                    if (/^message-text-/i.test(tid) || tid === 'messageText') continue;
                    tryPushPeer(findDmTextLeaf(node) || node, node);
                }
            } catch (eAny) {}
        }

        // 4) 禁止行级时间戳 fallback（「星期六 13:58」曾误当回复）
        // 5) 正文差集补漏：messageText 叶子再扫一遍（与主路径同一规则）
        if (!out.length) {
            try {
                var rescueLeaves = scanRoot.querySelectorAll('[data-testid^="message-text-"], [data-testid="messageText"], [dir="auto"]');
                var rescueHandle = '';
                try { rescueHandle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (eRh) {}
                for (var rl = 0; rl < rescueLeaves.length; rl++) {
                    tryPushPeer(rescueLeaves[rl], findDmMessageEntry(rescueLeaves[rl]));
                }
            } catch (eRescue) {}
        }
        return out;
    }

    /** 兜底：仅诊断用；发送差集 / peer_first 不得依赖本函数 */
    function fallbackCollectPeerDmTexts(root) {
        var out = [];
        var seen = {};
        try {
            var text = (root.innerText || root.textContent || '').replace(/\r/g, '\n');
            var lines = String(text).split('\n');
            var fbHandle = '';
            try { fbHandle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (eFh) {}
            for (var i = 0; i < lines.length; i++) {
                var line = String(lines[i] || '').replace(/\s+/g, ' ').trim();
                if (!line || line.length > 280) continue;
                if (isDmChromeNoise(line, fbHandle)) continue;
                if (isLikelyOwnDmText(line, fbHandle)) continue;
                if (/^@\S+$/i.test(line)) continue;
                if (/\bFollowers?\b|\bFollowing\b|\bJoined\b|\bView Profile\b/i.test(line)) continue;
                if (seen[line]) continue;
                seen[line] = 1;
                out.push({ text: line, source: root, entry: null, isReply: true });
            }
        } catch (eF) {}
        return out;
    }

    /** 收集会话中对方气泡文案（排除疑似本方话术） */
    function collectPeerDmTexts() {
        var msgs = collectPeerDmMessages();
        var texts = [];
        for (var i = 0; i < msgs.length; i++) texts.push(msgs[i].text);
        return texts;
    }

    function detectDmReplyState(targetHandle) {
        if (window.SgInboxWatch && window.SgInboxWatch.detectDmReplyState) {
            return window.SgInboxWatch.detectDmReplyState(targetHandle);
        }
        return { target: targetHandle || '', texts: [], latest: '', hasReply: false, unreadSeen: false, source: 'none', composerReady: false, canSend: false, decision: 'no_module', extraCount: 0 };
    }
    function bindSgInboxWatchHooks() {
        if (!window.SgInboxWatch || typeof window.SgInboxWatch.bind !== 'function') return;
        window.SgInboxWatch.bind({
            normalizeChatHandle: normalizeChatHandle,
            getDefaultLinks: typeof getDefaultLinks === 'function' ? getDefaultLinks : function () { return []; },
            getOwnScriptCorpus: function () { return OWN_SCRIPT_CORPUS || []; },
            rebuildOwnScriptCorpus: rebuildOwnScriptCorpus,
            getHandleSentScriptTexts: getHandleSentScriptTexts,
            getDnaCore: function () { return (typeof MY_DNA_CORE !== 'undefined' && MY_DNA_CORE) ? MY_DNA_CORE : []; },
            collectPeerDmMessages: collectPeerDmMessages,
            fallbackCollectPeerDmTexts: fallbackCollectPeerDmTexts,
            getDmConversationRoot: getDmConversationRoot,
            isSystemDmLine: isSystemDmLine,
            isProfileUiLine: isProfileUiLine,
            isDmChromeNoise: isDmChromeNoise,
            findBottomAwakeningTarget: findBottomAwakeningTarget,
            findDmSendButton: findDmSendButton,
            loadTargetDB: loadTargetDB,
            saveTargetDB: saveTargetDB,
            ensureChatFreeze: ensureChatFreeze,
            getDB: getDB,
            isChatTargetAllowed: isChatTargetAllowed,
            canProbeInboxTarget: canProbeInboxTarget,
            canSendKickNow: canSendKickNow,
            normalizeDisplayName: normalizeDisplayName,
            getOpsMaxRound: typeof getOpsMaxRound === 'function' ? getOpsMaxRound : function () { return 0; },
            reportChatMetric: reportChatMetric,
            getUrlDmPeerId: readDmUrlPeerId,
            getConversationHeaderHandle: readDmConversationHeaderHandle,
            assertDmConversationMatchesTarget: assertDmConversationMatchesTarget
        });
    }

    function getRejectMessage() {
        return getPoolMessage('reject') || REJECT_MESSAGE || getREJECT_MESSAGE()
            || 'ごめんね😭 25歳以上で探してて💦 また機会があれば！';
    }

    function getRoundMessage(myHandle, userHandle) {
        var round = getUserRound(userHandle);
        switch(round) {
            case 0: return getPoolMessage('icebreaker') || ICEBREAKER_MESSAGE;
            case 1: {
                var link = getLiveLink();
                if (!link) return null;
                var adMsg = getPoolMessage('ad') || AD_MESSAGE_TEMPLATE;
                if (adMsg.indexOf('{LINK}') >= 0) return adMsg.replace('{LINK}', link);
                // 话术池文案不含 {LINK} 时：若已硬编码链接则保留，否则末尾追加
                if (/line\.me/i.test(adMsg)) return adMsg;
                return adMsg + '\n' + link;
            }
            case 2: {
                // 4.1.53：kickCount0=盾牌(kick_message)；kickCount1=催加一次(final_kick_message)
                var kcMsg = 0;
                try {
                    kcMsg = getKickCountLocal(loadTargetDB()[normalizeChatHandle(userHandle)] || {});
                } catch (eKc) { kcMsg = 0; }
                var kickTpl = '';
                if (kcMsg >= 1) {
                    kickTpl = getPoolMessage('final_kick') || getPoolMessage('kick') || FINAL_KICK_MESSAGE || KICK_MESSAGE;
                } else {
                    kickTpl = getPoolMessage('kick') || KICK_MESSAGE;
                }
                var linkK = getLiveLink();
                if (linkK) {
                    if (kickTpl.indexOf('{LINK}') >= 0) return kickTpl.replace('{LINK}', linkK);
                    // 模板不含 {LINK} 且未硬编码链接时，末尾追加（催加轮必须给链接）
                    if (!/line\.me/i.test(kickTpl)) return kickTpl + '\n' + linkK;
                }
                return kickTpl;
            }
            default: return null;
        }
    }

    // ==================== DM PIN 自动解锁（C6 → chat/dm-pin.js）====================
    function getChatDmPin() {
        return (window.SgDmPin && window.SgDmPin.getChatDmPin) ? window.SgDmPin.getChatDmPin() : '2546';
    }
    function isDmPinGateVisible() {
        return !!(window.SgDmPin && window.SgDmPin.isDmPinGateVisible && window.SgDmPin.isDmPinGateVisible());
    }
    function reportDmPinGate(detail) {
        if (window.SgDmPin && window.SgDmPin.reportDmPinGate) window.SgDmPin.reportDmPinGate(detail);
    }
    function clearDmPinBlocked() {
        if (window.SgDmPin && window.SgDmPin.clearDmPinBlocked) window.SgDmPin.clearDmPinBlocked();
    }
    function isDmPinBlockedForSend() {
        return !!(window.SgDmPin && window.SgDmPin.isDmPinBlockedForSend && window.SgDmPin.isDmPinBlockedForSend());
    }
    function tryUnlockDmPin() {
        if (window.SgDmPin && window.SgDmPin.tryUnlockDmPin) return window.SgDmPin.tryUnlockDmPin();
        return { ok: false, no_module: true };
    }
    function bindSgDmPinHooks() {
        if (!window.SgDmPin || typeof window.SgDmPin.bind !== 'function') return;
        window.SgDmPin.bind({
            findBottomAwakeningTarget: findBottomAwakeningTarget,
            isMessagesPage: isMessagesPage,
            isDmPath: isDmPath,
            getWorkerId: getWorkerId,
            getChatPhase: getChatPhase,
            showToast: showToast,
            debugChatLog: debugChatLog
        });
    }
    // 函数声明已提升；启动时绑定宿主依赖（findBottom 等）
    try { bindSgDmPinHooks(); } catch (eBindPin) {}

    // ==================== DM 面板加载检测 ====================
    async function waitForDMReady(timeoutMs) {
        timeoutMs = timeoutMs || 30000;
        var start = Date.now();
        while (Date.now() - start < timeoutMs) {
            tryUnlockDmPin();
            var input = findBottomAwakeningTarget();
            var sendBtn = findDmSendButton();
            // 新版 X：发送按钮仅在有文字时才渲染，输入框就绪即视为可用（发送走 Enter 兜底）
            if (input && !input.disabled) {
                await new Promise(function(r) { setTimeout(r, 2000); });
                return true;
            }
            await new Promise(function(r) { setTimeout(r, 500); });
        }
        var gateVisible = false;
        try { gateVisible = isDmPinGateVisible(); } catch (eG) {}
        if (gateVisible) {
            reportDmPinGate({ ok: false, reason: 'dm_panel_timeout', gate_visible: true });
        }
        return false;
    }

    // ==============================================================================
    // 【话术系统 — 可配置版本，参考原始版】
    // ==============================================================================
    var SCRIPT_DEFAULTS = {
      version: "2.3",
      mode: "random",
      random_pool: ["v1","v2","v3","v4","v5","v6","v7","v8","v9","v10","v11","v12","v13","v14","v15"],
      active_script: "v1",
      scripts: {
        "v1": {
          name: "余裕1",
          icebreaker: "いきなりごめんなさい💦\n同世代より、大人の余裕がある人がいいなーって探してて、メッセージしちゃいました🫣\nちなみに、今おいくつですか？👀",
          ad_template: "教えてくれてありがとう💕\n大人の方とゆっくり話したいな…LINEで待ってるね♡\n{LINK}",
          kick_message: "まだかなー🥺\nこっちの方が話しやすいよ、待ってる💕",
          final_kick_message: "最後にもう一度だけ🙏\nLINEの方が話しやすいよ、よかったら待ってるね💕",
          reject_message: "ごめんね💦\n25歳以上の大人の方とゆっくり話したいって思ってて…また機会があれば🙏",
          foreigner_reject: ""
        },
        "v2": {
          name: "余裕2",
          icebreaker: "突然ごめんね🙏\n落ち着いて話せる大人の人とつながりたくて…\nよかったら年齢だけ教えてくれる？😊",
          ad_template: "ありがとう💕\nゆっくり話したいからLINEで待ってるね♡\n{LINK}",
          kick_message: "お返事まだかな〜🥺\nこっちの方がラクだよ、待ってるね💕",
          final_kick_message: "これで最後にするね🙏\nよかったらLINEで待ってるよ💕",
          reject_message: "ごめんね💦\nもう少し上の世代の方と話したくて…また機会があれば🙏",
          foreigner_reject: ""
        },
        "v3": {
          name: "余裕3",
          icebreaker: "はじめまして🫣\n同い年より、余裕ある大人の方がいいなって思ってDMしちゃった💦\nおいくつくらい？👀",
          ad_template: "教えてくれて嬉しいな💕\nLINEの方が話しやすいよ、待ってるね♡\n{LINK}",
          kick_message: "連絡くれないかな？🥺\nこっちの方がすぐ返せるよ！",
          final_kick_message: "最後のメッセージだよ🙏\n気が向いたらLINEでね💕",
          reject_message: "ごめんね🙏\n25歳以上の方とゆっくり話したくて…またどこかで🙏",
          foreigner_reject: ""
        },
        "v4": {
          name: "余裕4",
          icebreaker: "急にごめんね💦\n大人っぽい人と話したくてメッセージしたんだ…\n年齢どーなの？✌️",
          ad_template: "ありがとう♡\nよかったらLINEで続き話そ💕\n{LINK}",
          kick_message: "待ちくたびれちゃった😭\nこっちでお話しよ💕",
          final_kick_message: "もう一度だけ待ってるね🙏\nLINEの方が楽だよ💕",
          reject_message: "ごめんね💦\nもう少し大人の方と話したいなって…また機会があれば🙏",
          foreigner_reject: ""
        },
        "v5": {
          name: "余裕5",
          icebreaker: "突然DMごめん🤗\n落ち着いた大人の人とつながりたくて…\n何歳か教えて〜？👀",
          ad_template: "教えてくれてありがとう😊\nLINEで待ってるね、ゆっくり話そ♡\n{LINK}",
          kick_message: "まだ〜？🥺\nLINEの方が話しやすいんだ〜待ってる💕",
          final_kick_message: "これが最後の催促だよ🙏\nLINEで待ってるね💕",
          reject_message: "ごめんね🙏\n25歳以上の大人向けに探してて…また機会があれば💦",
          foreigner_reject: ""
        },
        "v6": {
          name: "余裕6",
          icebreaker: "いきなりごめん😳\n余裕ある大人の人と話したくてDMしちゃった…\n年齢聞かせてくれる？😊",
          ad_template: "ありがとう💕\nLINEの方が続きやすいよ、待ってるね♡\n{LINK}",
          kick_message: "あれ？まだかな😳\nこっちで待ってるよ💕",
          final_kick_message: "最後にもう一声だけ🙏\nよかったらLINEで💕",
          reject_message: "ごめんね💦\nもう少し上の方とゆっくり話したくて…またどこかで🙏",
          foreigner_reject: ""
        },
        "v7": {
          name: "余裕7",
          icebreaker: "失礼します🙏\n同世代より大人の余裕がある人を探してて…\nよかったらおいくつですか？😊",
          ad_template: "教えてくれてありがとう💕\n暇なときLINEで話そ、待ってるね♡\n{LINK}",
          kick_message: "もしよかったら、こっちでも話さない？😊💕",
          final_kick_message: "これで一旦終わりにするね🙏\n気が向いたらLINEで待ってる💕",
          reject_message: "ごめんね🙏\n25歳以上の方と話したくて…また機会があれば💦",
          foreigner_reject: ""
        },
        "v8": {
          name: "余裕8",
          icebreaker: "突然ごめんね🙌\n落ち着いて会話できる大人の人がいいなーって…\n年齢教えてほしいな👀",
          ad_template: "ありがとう♡\nLINEで話さない？待ってるね💕\n{LINK}",
          kick_message: "返信遅くなりそうだからこっちで話そう💕\n待ってるね！",
          final_kick_message: "最後の連絡だよ🙏\nLINEの方がすぐ返せるよ💕",
          reject_message: "ごめんね💦\nもう少し大人の方とつながりたくて…また機会があれば🙏",
          foreigner_reject: ""
        },
        "v9": {
          name: "余裕9",
          icebreaker: "はじめまして💦\n大人っぽい人とゆっくり話したくてメッセージした…\n何歳？🤗",
          ad_template: "教えてくれて嬉しいな💕\n気軽にLINEちょうだいね♡\n{LINK}",
          kick_message: "ねぇ、まだ〜？🥺\nこっちの方がいいよ💕",
          final_kick_message: "もう一度だけお願い🙏\nLINEで待ってるね💕",
          reject_message: "ごめんね🙏\n25歳以上の大人の方と話したくて…またどこかで💦",
          foreigner_reject: ""
        },
        "v10": {
          name: "余裕10",
          icebreaker: "急にごめん😳\n同い年より余裕ある大人の方がいいなって探してて…\n年齢どれくらい？👀",
          ad_template: "ありがとう😊\nよかったらLINEで続き話そ💕\n{LINK}",
          kick_message: "おーい😳\nこっちの方が便利だよ！待ってる💕",
          final_kick_message: "これが最後だよ🙏\nよかったらLINEで話そう💕",
          reject_message: "ごめんね💦\nもう少し上の世代とゆっくり話したくて…また機会があれば🙏",
          foreigner_reject: ""
        },
        "v11": {
          name: "余裕11",
          icebreaker: "いきなりDMごめんね🫣\n落ち着いた大人の人とつながりたくて…\n今おいくつくらい？😊",
          ad_template: "教えてくれてありがとう💕\nLINEの方が話しやすいよ、待ってるね♡\n{LINK}",
          kick_message: "まだかなー🥺\nよかったらこっちで待ってるね💕",
          final_kick_message: "最後にもう一度だけ🙏\nLINEで待ってるよ💕",
          reject_message: "ごめんね🙏\n25歳以上の方と話したくて…また機会があれば💦",
          foreigner_reject: ""
        },
        "v12": {
          name: "余裕12",
          icebreaker: "突然すみません🙏\n大人の余裕がある人と話したくてメッセージしました…\n年齢教えてもらえる？👀",
          ad_template: "ありがとう♡\nゆっくりLINEで話そ、待ってるね💕\n{LINK}",
          kick_message: "お返事待ってるね〜😊\nこっちで話そっか💕",
          final_kick_message: "これで最後にするね🙏\n気が向いたらLINEでね💕",
          reject_message: "ごめんね💦\nもう少し大人の方とつながりたくて…またどこかで🙏",
          foreigner_reject: ""
        },
        "v13": {
          name: "余裕13",
          icebreaker: "はじめまして💦\n同世代より上の余裕ある人がいいなって…\nよかったら何歳か教えて？🤗",
          ad_template: "教えてくれて嬉しいな💕\nLINEで待ってるね、続き話そ♡\n{LINK}",
          kick_message: "連絡くれないかな？🥺\nこっちすぐ返せるよ！",
          final_kick_message: "最後のメッセージだよ🙏\nLINEの方が楽だよ💕",
          reject_message: "ごめんね🙏\n25歳以上の大人向けに探してて…また機会があれば💦",
          foreigner_reject: ""
        },
        "v14": {
          name: "余裕14",
          icebreaker: "急にごめんね😊\n落ち着いて会話できる大人の人とつながれたらなって…\nおいくつですか？👀",
          ad_template: "ありがとう💕\nよかったらLINEで話そ♡\n{LINK}",
          kick_message: "まだ〜？🥺\nLINEの方が話しやすいよ待ってる💕",
          final_kick_message: "もう一度だけ待ってるね🙏\nLINEでね💕",
          reject_message: "ごめんね💦\nもう少し上の方とゆっくり話したくて…また機会があれば🙏",
          foreigner_reject: ""
        },
        "v15": {
          name: "余裕15",
          icebreaker: "いきなりごめんなさい🫣\n大人っぽい人とゆっくり話したくてDMしちゃった…\n年齢どれくらい？✌️",
          ad_template: "教えてくれてありがとう😊\nLINEで待ってるね♡\n{LINK}",
          kick_message: "あれ？まだかな😳\nこっちで待ってるよ💕",
          final_kick_message: "これが最後だよ🙏\nよかったらLINEで話そう💕",
          reject_message: "ごめんね🙏\n25歳以上の方と話したくて…またどこかで💦",
          foreigner_reject: ""
        }
      },
      templates: {
        icebreaker: "いきなりごめんなさい💦\n同世代より、大人の余裕がある人がいいなーって探してて、メッセージしちゃいました🫣\nちなみに、今おいくつですか？👀",
        ad: "教えてくれてありがとう💕\n大人の方とゆっくり話したいな…LINEで待ってるね♡\n{LINK}",
        kick: "まだかなー🥺\nこっちの方が話しやすいよ、待ってる💕",
        final_kick: "最後にもう一度だけ🙏\nLINEの方が話しやすいよ、よかったら待ってるね💕",
        reject: "ごめんね💦\n25歳以上の大人の方とゆっくり話したいって思ってて…また機会があれば🙏",
        foreigner_reject: ""
      },
      dna_core: ["line.me","http","大人","メッセージ","おいくつ","余裕","25歳以上"],
      dna_aux: [],
      corpse_days: 3,
      kick_days: 0
    };

    var SCRIPT_DEFAULTS_JOB = {
      version: "1.9",
      mode: "random",
      random_pool: ["v1", "v2", "v3", "v4", "v5", "v6"],
      active_script: "v1",
      scripts: {
        "v1": {
          name: "兼职粉1",
          icebreaker: "いきなりごめんね🙏\nスマホだけでできる小仕事あるんだけど、興味ある？",
          ad_template: "アルバイト募集中。\nTikTokブロガーの動画再生回数を増やすお手伝いをするのが主な仕事で、1日あたり3万～10万円が支払われます。携帯電話さえあれば、必要に応じてビデオを視聴すれば報酬がもらえます。\n22歳以上の場合は、詳細を確認して追加してくださいLINE:\n{LINK}",
          kick_message: "まだ見てくれた？🥺\nよかったらLINE追加してね〜💕",
          final_kick_message: "最後にもう一度だけ🙏\n気が向いたらLINEね💕",
          reject_message: "了解です🙏\nまた何かあったらよろしく〜",
          foreigner_reject: "申し訳ありませんが、この仕事は日本在住の方限定なんです。ごめんね🙏"
        },
        "v2": {
          name: "兼职粉2",
          icebreaker: "突然すみません💦\n空き時間にできる簡単な仕事を教えてもらえないかな？",
          ad_template: "アルバイト募集中。\nTikTok動画の再生回数を増やすお仕事です。1日3万〜10万円、スマホで動画を見るだけでOK。\n22歳以上の方、詳細はLINEで:\n{LINK}",
          kick_message: "お返事まだかな〜🥺\nLINE待ってるよ💕",
          final_kick_message: "これで最後🙏\n気が向いたらLINEね💕",
          reject_message: "了解〜🙏\n無理しないでね",
          foreigner_reject: "すみません、この仕事は日本の方限定なんです。ごめんね🙏"
        },
        "v3": {
          name: "兼职粉3",
          icebreaker: "ごめんね突然💦\nスマホでサクッとできる小仕事、やってみない？",
          ad_template: "アルバイト募集中。\nTikTokブロガーの動画再生を増やすサポート、スマホだけで日給3万〜10万円。\n22歳以上の方、詳細はLINEにて:\n{LINK}",
          kick_message: "まだかな？🥺\nLINE追加してくれたら詳細送るよ💕",
          final_kick_message: "最後の連絡だよ🙏\nLINEで待ってるね💕",
          reject_message: "ごめんね💦\nまた機会があれば🙏",
          foreigner_reject: "申し訳ありませんが、日本在住の方限定です。ごめんね🙏"
        },
        "v4": {
          name: "兼职粉4",
          icebreaker: "いきなりすみません🙏\n友達にスマホだけの簡単な仕事を紹介してもらったんだけど、興味ある人いるかな？",
          ad_template: "アルバイト募集中。\nTikTok動画の視聴で報酬がもらえます。1日3万〜10万円、スマホだけでOK。\n22歳以上の方、詳細はLINEで:\n{LINK}",
          kick_message: "LINE見てくれた？🥺\nよかったら追加してね〜💕",
          final_kick_message: "最後だけ🙏\n気になったらLINEで💕",
          reject_message: "了解です🙏\nありがとうね！",
          foreigner_reject: "ごめんね、日本人の方だけなんです。すみません🙏"
        },
        "v5": {
          name: "兼职粉5",
          icebreaker: "突然ごめんね🥺\nちょっといいかな？スマホでできる仕事あるんだけど…",
          ad_template: "アルバイト募集中。\nTikTokの動画を見るだけで報酬あり。1日3万〜10万円、空き時間でできます。\n22歳以上の方、詳細はLINEで:\n{LINK}",
          kick_message: "お返事待ってるよ🥺\nLINEの方が詳しく説明できるから💕",
          final_kick_message: "これで最後にするね🙏\n気が向いたらLINE💕",
          reject_message: "了解〜🙏\n気になったらまた連絡してね！",
          foreigner_reject: "すみません、日本人の方限定なんです。ごめんね🙏"
        },
        "v6": {
          name: "兼职粉6",
          icebreaker: "すみません、突然🙏\nスマホで空き時間にできる簡単な仕事あるんだけど、どうかな？",
          ad_template: "アルバイト募集中。\nTikTok動画の再生サポート、携帯だけで日給3万〜10万円。\n22歳以上の方、詳細はLINEで:\n{LINK}",
          kick_message: "まだかな？🥺\nよかったらLINE追加してね💕",
          final_kick_message: "最後に🙏\nLINEで待ってるよ💕",
          reject_message: "ごめんね💦\nまたの機会に！",
          foreigner_reject: "申し訳ありませんが、日本在住の方限定です。ごめんね🙏"
        }
      },
      templates: {
        icebreaker: "いきなりごめんね🙏\nスマホだけでできる小仕事あるんだけど、興味ある？",
        ad: "アルバイト募集中。\nTikTokブロガーの動画再生回数を増やすお手伝いをするのが主な仕事で、1日あたり3万～10万円が支払われます。携帯電話さえあれば、必要に応じてビデオを視聴すれば報酬がもらえます。\n22歳以上の場合は、詳細を確認して追加してくださいLINE:\n{LINK}",
        kick: "まだ見てくれた？🥺\nよかったらLINE追加してね〜💕",
        final_kick: "最後にもう一度だけ🙏\n気が向いたらLINEね💕",
        reject: "了解です🙏\nまた何かあったらよろしく〜",
        foreigner_reject: "申し訳ありませんが、この仕事は日本在住の方限定なんです。ごめんね🙏"
      },
      dna_core: ["line.me", "http", "アルバイト", "TikTok", "動画", "仕事", "報酬", "詳細", "スマホ", "空き時間", "22歳", "3万", "10万"],
      dna_aux: [],
      corpse_days: 3,
      kick_days: 0
    };

    function getActiveScriptDefaults() {
        return isJobScriptPool() ? SCRIPT_DEFAULTS_JOB : SCRIPT_DEFAULTS;
    }

    function getActiveScriptsStorageKey() {
        return isJobScriptPool() ? SCRIPTS_LS_KEY_JOB : SCRIPTS_LS_KEY_DATING;
    }

    function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

    function autoExtractDNA(templates) {
        var allText = (templates.icebreaker||'') + ' ' + (templates.ad||'') + ' ' + (templates.kick||'') + ' ' + (templates.final_kick||'') + ' ' + (templates.reject||'') + ' ' + (templates.foreigner_reject||'');
        allText = allText.replace(/{LINK}/g, '').replace(/[\u{1F300}-\u{1FFFF}]/gu, '').replace(/[💦💕🫣👀😭😱💔😣💋🥺❤️😊✨😌…—、。，！？,.!?\n\r]/g, ' ');
        var tokens = allText.split(/\s+/).filter(function(t) { return t.length >= 3 && !/^\d+$/.test(t); });
        var seen = {};
        var unique = tokens.filter(function(t) { var l=t.toLowerCase(); if(seen[l]) return false; seen[l]=true; return true; });
        var core = unique.filter(function(t) { return t.length >= 4; });
        var aux = unique.filter(function(t) { return t.length < 4; });
        var mustCore = ["line.me", "http", "秘密のアカウント", "👇", "デートとかもしてみたいな", "25歳以上で探してて", "年上の方が好みで", "日本語しか分からないです"];
        mustCore.forEach(function(m) { if(core.indexOf(m)===-1) core.push(m); });
        return { core: core, aux: aux };
    }

    var ICEBREAKER_MESSAGE, AD_MESSAGE_TEMPLATE, KICK_MESSAGE, FINAL_KICK_MESSAGE, REJECT_MESSAGE, FOREIGNER_REJECT_MESSAGE;
    var MY_DNA_CORE, MY_DNA_AUX;
    var CORPSE_DAYS = 3;
    // KICK_DAYS / chat_kick_min_hours 小时闸已废（4.1.61）：盾牌/催加只按轮次 + 一窗一条
    var KICK_DAYS = 0;

    // 从当前话术池随机获取消息（dating / job 由 chat_script_pool 决定）
    function getPoolMessage(type) {
        try {
            var defaults = getActiveScriptDefaults();
            var key = getActiveScriptsStorageKey();
            var raw = localStorage.getItem(key);
            var cfg;
            if (!raw) { cfg = defaults; }
            else { try { cfg = JSON.parse(raw); } catch(e) { cfg = defaults; } }
            var mergedScripts = {};
            var pool = defaults.random_pool;
            Object.keys(defaults.scripts).forEach(function(k) {
                mergedScripts[k] = (cfg.scripts && cfg.scripts[k]) || defaults.scripts[k];
            });
            if (pool.length > 0 && mergedScripts) {
                var poolKey = pool[Math.floor(Math.random() * pool.length)];
                try {
                    sessionStorage.setItem('dan_last_experiment_id', poolKey || '');
                    sessionStorage.setItem('dan_script_pool_mode', getScriptPoolMode());
                } catch (eExp) {}
                var chosen = mergedScripts[poolKey];
                if (!chosen) return null;
                if (type === 'icebreaker') return chosen.icebreaker;
                if (type === 'ad') return chosen.ad_template;
                if (type === 'kick') return chosen.kick_message;
                if (type === 'final_kick') return chosen.final_kick_message || chosen.kick_message;
                if (type === 'reject') return chosen.reject_message;
                if (type === 'foreigner_reject') return chosen.foreigner_reject;
            }
        } catch(e) {}
        return null;
    }

    function ensureJobScriptsBootstrapped() {
        try {
            var raw = localStorage.getItem(SCRIPTS_LS_KEY_JOB);
            var config;
            if (!raw) {
                config = deepClone(SCRIPT_DEFAULTS_JOB);
                config.imported_from_json = true;
                config.updated_at = Date.now();
                config.source = 'defaults_job_1_0';
                localStorage.setItem(SCRIPTS_LS_KEY_JOB, JSON.stringify(config));
                return config;
            }
            try { config = JSON.parse(raw); } catch (e) {
                config = deepClone(SCRIPT_DEFAULTS_JOB);
            }
            var localVer = String(config.version || '0');
            if (localVer < String(SCRIPT_DEFAULTS_JOB.version || '1.3')) {
                config.scripts = deepClone(SCRIPT_DEFAULTS_JOB.scripts);
                config.random_pool = SCRIPT_DEFAULTS_JOB.random_pool.slice();
                config.templates = deepClone(SCRIPT_DEFAULTS_JOB.templates);
                config.version = SCRIPT_DEFAULTS_JOB.version;
                config.imported_from_json = true;
                config.updated_at = Date.now();
                config.source = 'defaults_upgrade_job';
                localStorage.setItem(SCRIPTS_LS_KEY_JOB, JSON.stringify(config));
            }
            if (!config.scripts) config.scripts = {};
            Object.keys(SCRIPT_DEFAULTS_JOB.scripts).forEach(function (k) {
                if (!config.scripts[k]) config.scripts[k] = deepClone(SCRIPT_DEFAULTS_JOB.scripts[k]);
                else {
                    if (!config.scripts[k].final_kick_message && SCRIPT_DEFAULTS_JOB.scripts[k].final_kick_message) {
                        config.scripts[k].final_kick_message = SCRIPT_DEFAULTS_JOB.scripts[k].final_kick_message;
                    }
                }
            });
            if (!config.random_pool || config.random_pool.length < SCRIPT_DEFAULTS_JOB.random_pool.length) {
                config.random_pool = SCRIPT_DEFAULTS_JOB.random_pool.slice();
            }
            return config;
        } catch (eJob) {
            return deepClone(SCRIPT_DEFAULTS_JOB);
        }
    }

    function loadScripts() {
        try { ensureJobScriptsBootstrapped(); } catch (eBoot) {}
        var defaults = getActiveScriptDefaults();
        var storageKey = getActiveScriptsStorageKey();
        var poolMode = getScriptPoolMode();
        var raw = localStorage.getItem(storageKey);
        var config;
        if (!raw) { config = deepClone(defaults); }
        // 注意：不写回 localStorage —— 首次写入由 bootstrapFromJSON / ensureJobScriptsBootstrapped 负责
        else { try { config = JSON.parse(raw); } catch(e) { config = deepClone(defaults); } }

        // dating：话术池 v2.3 升档；job：v1.0 升档在 ensureJobScriptsBootstrapped
        if (poolMode === 'dating') {
            try {
                var localVer = String(config.version || '0');
                if (localVer < String(SCRIPT_DEFAULTS.version || '2.3')) {
                    config.scripts = deepClone(SCRIPT_DEFAULTS.scripts);
                    config.random_pool = SCRIPT_DEFAULTS.random_pool.slice();
                    config.templates = deepClone(SCRIPT_DEFAULTS.templates);
                    config.version = SCRIPT_DEFAULTS.version;
                    config.imported_from_json = true;
                    config.updated_at = Date.now();
                    config.source = 'defaults_upgrade_2_3';
                    localStorage.setItem(SCRIPTS_LS_KEY_DATING, JSON.stringify(config));
                    console.log('[话术池] 已升级到 v' + SCRIPT_DEFAULTS.version + '（15套余裕话术）');
                }
            } catch (eUp) {}
        }

        // 确保 scripts 池齐全（合并 defaults 缺失的）
        if (!config.scripts) config.scripts = {};
        Object.keys(defaults.scripts).forEach(function(k) {
            if (!config.scripts[k]) config.scripts[k] = deepClone(defaults.scripts[k]);
            else {
                if (!config.scripts[k].final_kick_message && defaults.scripts[k].final_kick_message) {
                    config.scripts[k].final_kick_message = defaults.scripts[k].final_kick_message;
                }
                if (!config.scripts[k].reject_message && defaults.scripts[k].reject_message) {
                    config.scripts[k].reject_message = defaults.scripts[k].reject_message;
                }
            }
        });
        if (!config.random_pool || config.random_pool.length < defaults.random_pool.length) {
            config.random_pool = defaults.random_pool.slice();
        }
        if (config.mode !== 'random' && config.mode !== 'fixed') config.mode = defaults.mode;

        // 随机池：如果 mode=random 且有 scripts 池，随机选一套
        if (config.mode === 'random' && config.scripts && Array.isArray(config.random_pool) && config.random_pool.length > 0) {
            var poolKey = config.random_pool[Math.floor(Math.random() * config.random_pool.length)];
            var chosen = config.scripts[poolKey];
            if (chosen) {
                config.templates = {
                    icebreaker: chosen.icebreaker || '',
                    ad: chosen.ad_template || '',
                    kick: chosen.kick_message || config.templates.kick || '',
                    final_kick: chosen.final_kick_message || config.templates.final_kick || defaults.templates.final_kick || '',
                    reject: chosen.reject_message || config.templates.reject || '',
                    foreigner_reject: chosen.foreigner_reject || config.templates.foreigner_reject || ''
                };
                console.log('[话术池][' + poolMode + '] 随机选中:', chosen.name || poolKey);
            }
        }

        ICEBREAKER_MESSAGE = config.templates.icebreaker || defaults.templates.icebreaker;
        AD_MESSAGE_TEMPLATE = config.templates.ad || defaults.templates.ad;
        KICK_MESSAGE = config.templates.kick || defaults.templates.kick;
        FINAL_KICK_MESSAGE = config.templates.final_kick || defaults.templates.final_kick || KICK_MESSAGE;
        REJECT_MESSAGE = config.templates.reject || defaults.templates.reject;
        FOREIGNER_REJECT_MESSAGE = config.templates.foreigner_reject || defaults.templates.foreigner_reject;
        MY_DNA_CORE = config.dna_core || defaults.dna_core;
        MY_DNA_AUX = config.dna_aux || defaults.dna_aux;
        if (config.corpse_days) CORPSE_DAYS = config.corpse_days;
        // kick_days 配置保留兼容，不再驱动闸门
        KICK_DAYS = 0;
        try { sessionStorage.setItem('dan_script_pool_mode', poolMode); } catch (eMode) {}
        try { rebuildOwnScriptCorpus(); } catch (eCorpus) {}
        return config;
    }

    function saveScripts(config) {
        var extracted = autoExtractDNA(config.templates);
        config.dna_core = extracted.core;
        config.dna_aux = extracted.aux;
        localStorage.setItem(getActiveScriptsStorageKey(), JSON.stringify(config));
        loadScripts();
    }

    loadScripts();
    window.addEventListener('sg-scripts-updated', function () {
        try { loadScripts(); } catch (e) {}
    });
    window.addEventListener('sg-config-synced', function () {
        try { loadScripts(); } catch (eCfg) {}
    });

    // ====== 跨 tab 私信重置广播：监听唯一归属 A2（scheduler-core.js），见 §X A2↔C2 ======
    // 本文件不再挂 sg_reset_chat_seq 监听，避免双份清理+双 toast 维护分叉（4.6.30）。

    // ========== 【DNA 关键词已从话术系统自动提取】 ==========
    const MAX_DB_SIZE = 8000;

    function getDB(key) { return new Set(JSON.parse(GM_getValue(key, '[]')).map(id => id.replace(/^\//, '').toLowerCase())); }

    function saveToDB(key, id) {
        let dbArr = Array.from(getDB(key));
        let cleanId = id.replace(/^\//, '').toLowerCase();
        if (!dbArr.includes(cleanId)) {
            dbArr.push(cleanId);
            if (dbArr.length > MAX_DB_SIZE) dbArr = dbArr.slice(500); 
            GM_setValue(key, JSON.stringify(dbArr)); 
        }
    }

    function getSessionList() { return JSON.parse(sessionStorage.getItem('dan_session_scanned') || '[]'); }
    function addSessionList(url) {
        let arr = getSessionList();
        if(!arr.includes(url)) arr.push(url);
        sessionStorage.setItem('dan_session_scanned', JSON.stringify(arr));
    }

    /** X 粉丝列表虚拟滚动：多源取 scrollHeight，避免永远触不到底 */
    function isFollowersListAtBottom() {
        var se = document.scrollingElement || document.documentElement;
        var sh = Math.max(
            (se && se.scrollHeight) || 0,
            document.documentElement.scrollHeight || 0,
            (document.body && document.body.scrollHeight) || 0
        );
        var top = window.scrollY || (se && se.scrollTop) || 0;
        var vh = window.innerHeight || 0;
        return sh > 0 && (top + vh) >= (sh - 100);
    }

    /** 本轮私信结束 → 写 completed + 冷却后交回调度；opts.softFivePhase 时不改 softRisk* / 不加长冷却 */
    function completeChatRound(reason, opts) {
        reason = reason || 'done';
        opts = opts || {};
        var softFive = !!opts.softFivePhase;
        var softPass = parseInt(opts.softPass, 10) || 0;
        try {
            reportDmHealthEvent('DM_ROUND_END', {
                reason: reason,
                severity: (reason === 'queue_empty' || reason === 'bottom_reached') ? 'warn' : 'info'
            });
        } catch (eHe) {}
        showToast('✅ 本轮私信完成，交回调度…', '#1d9bf0', 3000);
        console.log('[私信列表序] 本轮完成 reason=' + reason);
        sessionStorage.setItem('dan_scroll_fail_count', '0');
        sessionStorage.setItem('dan_bottom_hit_count', '0');
        sessionStorage.removeItem('dan_ops_round_refreshed_this_round');
        sessionStorage.setItem('dan_auto_run', 'false');
        clearChatLeaseLocal();
        try {
            var cfgIv = getChatIntervalCfg();
            var coolMin;
            var pendingReply = false;
            var pendingKick = false;
            try { pendingReply = countAdDebt() > 0; } catch (ePr) {}
            try { pendingKick = countKickDebt() > 0; } catch (ePk) {}
            // 五段软风控 / 4.1.38：废除 25–35 分长冷却；节流靠关注+填窗。清债仅极短防连开
            if (softFive) {
                coolMin = 0;
            } else if (pendingReply || pendingKick) {
                coolMin = 1;
            } else {
                coolMin = 0;
            }
            var coolMs = coolMin * 60 * 1000;
            var shortRecheck = !!(pendingReply || pendingKick);
            try {
                if (!softFive && typeof SgChatStrategy !== 'undefined') {
                    var pol = SgChatStrategy.resolveChatPolicy({});
                    coolMs = Math.round(coolMs * (pol.cooldownMultiplier || 1));
                    if (!shortRecheck) {
                        coolMs += SgChatStrategy.fleetChatJitterMs(getBotKey());
                    }
                }
            } catch (ePol) {}
            var ms = JSON.parse(sessionStorage.getItem('sg_module_chat') || '{}');
            var st = ensureChatDayStats(JSON.parse(localStorage.getItem('sg_state') || '{}'));
            var phase = resolveChatPhaseForStats();
            if (ms.startedAt) {
                var chatDur = Math.floor((Date.now() - ms.startedAt) / 1000);
                if (chatDur > 0) {
                    st.chatTotalToday = (st.chatTotalToday || 0) + chatDur;
                    if (phase === 'inbox') st.chatInboxToday = (st.chatInboxToday || 0) + chatDur;
                    else st.chatOutboundToday = (st.chatOutboundToday || 0) + chatDur;
                    try {
                        if (typeof SgTimeBudget !== 'undefined' && SgTimeBudget.recordSpend) {
                            SgTimeBudget.recordSpend(phase, chatDur);
                        }
                    } catch (eTb) {}
                }
            }
            st.chatRoundsToday = (st.chatRoundsToday || 0) + 1;
            st.chatLastEndAt = Date.now();
            // 4.6.83：任一轮私信收工 → 让路关注，直到 soft 再开
            st.chatYieldToFollow = true;
            // 4.1.38：coolMs=0 必须清零 nextAt，否则旧 25–35/55 残留会继续挡窗外私信
            if (coolMs > 0) {
                st.chatNextAllowedAt = Date.now() + coolMs;
            } else {
                st.chatNextAllowedAt = 0;
            }
            try {
                // 五段节奏：softRiskPhase / chatDone 只由 markPass* 写，禁止旧扫箱分支覆盖
                if (!softFive && st.softRiskUntil > Date.now() && !st.softRiskChatDone) {
                    var outboundEnd = {
                        queue_empty: 1, bottom_reached: 1, outbound_cap: 1, scroll_timeout: 1,
                        freeze_idle: 1
                    };
                    var phaseNow = phase || 'outbound';
                    if (!st.softRiskOutboundDone && (outboundEnd[reason] || phaseNow === 'outbound')) {
                        st.softRiskOutboundDone = true;
                        try {
                            if (typeof window.__sgMarkSoftRiskOutboundDone === 'function') {
                                window.__sgMarkSoftRiskOutboundDone(reason);
                            }
                        } catch (eMk2) {}
                    } else {
                        sessionStorage.setItem('sg_soft_risk_pulse_reason', String(reason || ''));
                        st.softRiskChatDone = true;
                        st.softRiskOutboundDone = true;
                    }
                }
            } catch (ePulse) {}
            // 五段：重新读 markPass* 已写入的相位，避免覆盖
            if (softFive) {
                try {
                    var stLive = JSON.parse(localStorage.getItem('sg_state') || '{}');
                    st.softRiskUntil = stLive.softRiskUntil;
                    st.softRiskMode = stLive.softRiskMode;
                    st.softRiskPhase = stLive.softRiskPhase;
                    st.softRiskChatPass = stLive.softRiskChatPass;
                    st.softRiskChatDone = stLive.softRiskChatDone;
                    st.softRiskOutboundDone = stLive.softRiskOutboundDone;
                    st.softRiskIceExtendMs = stLive.softRiskIceExtendMs;
                    st.followNextDelayUntil = stLive.followNextDelayUntil;
                } catch (eMerge) {}
            }
            localStorage.setItem('sg_state', JSON.stringify(st));
            ms.running = false;
            ms.phase = 'completed';
            ms.lastActive = Date.now();
            sessionStorage.setItem('sg_module_chat', JSON.stringify(ms));
            console.log('[私信] 冷却 ' + coolMin + ' 分钟后可再开 (phase=' + phase + ' debt=' + hasChatDebt() + ')');
        } catch (e) {}
        try {
            window.dispatchEvent(new CustomEvent('sg-runtime-push', { detail: { reason: 'chat_round_end' } }));
        } catch (ePush) {}
        try { clearAllTimers(); } catch (e3) {}
        try { cleanupInjectedDOM(); } catch (e4) {}
        try {
            if (typeof Logger !== 'undefined' && Logger.info) Logger.info('私信', '本轮完成 → 交回调度 (' + reason + ')');
        } catch (e5) {}
    }

    // ========== 【消息时间检测：判断最后一条消息距离现在多少天】 ==========
    function getLatestMessageAgeDays() {
        const timeEls = document.querySelectorAll('time[datetime]');
        let latestDate = null;
        
        for (let el of timeEls) {
            let dt = el.getAttribute('datetime');
            if (dt) {
                let d = new Date(dt);
                if (!isNaN(d.getTime()) && (!latestDate || d > latestDate)) {
                    latestDate = d;
                }
            }
        }
        
        if (latestDate) {
            let now = new Date();
            let today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            let msgDay = new Date(latestDate.getFullYear(), latestDate.getMonth(), latestDate.getDate());
            let diffDays = Math.floor((today - msgDay) / (1000 * 60 * 60 * 24));
            return diffDays; // 0=今天, 1=昨天, 2=前天...
        }
        
        // 如果找不到 datetime，通过页面文本推断
        const bodyText = document.body.innerText;
        // 页面中出现了月份格式的日期（如 "May 1"），说明有旧消息
        const monthDatePattern = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i;
        if (monthDatePattern.test(bodyText)) {
            // 保守估计：出现月份日期格式，至少前天
            let match = bodyText.match(monthDatePattern);
            if (match) {
                let monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
                let msgMonth = monthNames.indexOf(match[1].toLowerCase());
                let msgDay = parseInt(match[2]);
                let now = new Date();
                let today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                // 尝试推断年份（假设是今年）
                let msgDate = new Date(now.getFullYear(), msgMonth, msgDay);
                let diffDays = Math.floor((today - msgDate) / (1000 * 60 * 60 * 24));
                if (diffDays >= 0) return diffDays;
                // 如果计算出负数，可能是去年的日期
                msgDate = new Date(now.getFullYear() - 1, msgMonth, msgDay);
                diffDays = Math.floor((today - msgDate) / (1000 * 60 * 60 * 24));
                return Math.max(diffDays, 30); // 至少30天
            }
            return 2; // 兜底：至少前天
        }
        
        return 0; // 无法判断，默认是新消息
    }

    // ========== 【UI 面板注入 — V2 暗色主题 Tab 布局】 ==========
    // v3：左下悬浮球/Chat 控制台停用，功能已合并到 #sg-panel；DOM 仍创建供内部逻辑，不挂到页面
    var SG_LEGACY_CHAT_UI = false;
    const style = document.createElement('style');
    style.innerHTML = `
        #matrix-switch-btn { position: fixed; bottom: 20px; left: 20px; background-color: #f91880; color: white; border: none; border-radius: 50%; width: 50px; height: 50px; font-size: 22px; cursor: pointer; z-index: 999999; box-shadow: 0 4px 15px rgba(0,0,0,0.3); transition: 0.3s; }
        #matrix-switch-btn.running { background-color: #888888 !important; box-shadow: 0 4px 15px rgba(0,0,0,0.2) !important; }
        #matrix-switch-btn.auto-mode { background-color: #00ba7c !important; box-shadow: 0 4px 15px rgba(0,186,124,0.4) !important; }
        #matrix-settings-btn { position: fixed; bottom: 80px; left: 25px; background-color: #2f3336; color: #e7e9ea; border: none; border-radius: 50%; width: 40px; height: 40px; font-size: 18px; cursor: pointer; z-index: 999999; box-shadow: 0 4px 10px rgba(0,0,0,0.3); transition: 0.2s; }
        #matrix-settings-btn:hover { background-color: #3e4144; }

        #matrix-config-panel { position: fixed; bottom: 130px; left: 20px; background: #16181c; border: 1px solid #2f3336; border-radius: 16px; z-index: 999999; display: none; box-shadow: 0 8px 32px rgba(0,0,0,0.6); width: 380px; max-height: 85vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e7e9ea; overflow: hidden; display: none; flex-direction: column; }
        #matrix-config-panel.mcp-show { display: flex; }

        .mcp-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #2f3336; flex-shrink: 0; }
        .mcp-header h2 { font-size: 17px; font-weight: 700; color: #e7e9ea; margin: 0; }
        .mcp-close { width: 32px; height: 32px; border: none; border-radius: 50%; background: transparent; color: #71767b; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
        .mcp-close:hover { background: #2f3336; color: #e7e9ea; }

        .mcp-tabs { display: flex; border-bottom: 1px solid #2f3336; flex-shrink: 0; }
        .mcp-tab { flex: 1; padding: 12px 0; text-align: center; font-size: 13px; font-weight: 600; color: #71767b; background: none; border: none; cursor: pointer; position: relative; transition: color 0.2s; }
        .mcp-tab:hover { color: #e7e9ea; }
        .mcp-tab.active { color: #e7e9ea; }
        .mcp-tab.active::after { content: ''; position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 56px; height: 3px; background: #1d9bf0; border-radius: 2px; }

        .mcp-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
        .mcp-body::-webkit-scrollbar { width: 4px; }
        .mcp-body::-webkit-scrollbar-thumb { background: #2f3336; border-radius: 2px; }
        .mcp-section { display: none; }
        .mcp-section.active { display: block; }

        .mcp-label { font-size: 12px; font-weight: 600; color: #71767b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; display: block; }
        .mcp-hint { font-size: 11px; color: #536471; margin-top: 4px; line-height: 1.4; }
        .mcp-input, .mcp-textarea { width: 100%; background: #202327; border: 1px solid #2f3336; border-radius: 8px; color: #e7e9ea; font-size: 13px; font-family: inherit; padding: 10px 12px; outline: none; transition: border-color 0.2s; resize: vertical; }
        .mcp-input:focus, .mcp-textarea:focus { border-color: #1d9bf0; }
        .mcp-textarea { min-height: 60px; line-height: 1.5; }

        .mcp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 16px; border: none; border-radius: 999px; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.15s; }
        .mcp-btn-primary { background: #1d9bf0; color: #fff; }
        .mcp-btn-primary:hover { background: #1a8cd8; }
        .mcp-btn-success { background: #00ba7c; color: #fff; }
        .mcp-btn-success:hover { background: #00a06a; }
        .mcp-btn-ghost { background: transparent; color: #e7e9ea; border: 1px solid #2f3336; }
        .mcp-btn-ghost:hover { background: #2f3336; }
        .mcp-btn-danger { background: transparent; color: #f4212e; border: 1px solid #2f3336; }
        .mcp-btn-danger:hover { background: rgba(244,33,46,0.1); }
        .mcp-btn-sm { padding: 6px 12px; font-size: 12px; }
        .mcp-btn-full { width: 100%; }
        .mcp-btn-group { display: flex; gap: 8px; margin-top: 12px; }

        .mcp-card { background: #202327; border: 1px solid #2f3336; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
        .mcp-card-title { font-size: 13px; font-weight: 700; color: #e7e9ea; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }

        .mcp-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #2f3336; }
        .mcp-toggle-row:last-child { border-bottom: none; }
        .mcp-toggle-info { flex: 1; }
        .mcp-toggle-title { font-size: 13px; font-weight: 600; color: #e7e9ea; }
        .mcp-toggle-desc { font-size: 11px; color: #71767b; margin-top: 2px; }
        .mcp-toggle { width: 44px; height: 24px; background: #2f3336; border: none; border-radius: 12px; cursor: pointer; position: relative; transition: background 0.2s; flex-shrink: 0; }
        .mcp-toggle.on { background: #1d9bf0; }
        .mcp-toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
        .mcp-toggle.on::after { transform: translateX(20px); }

        .mcp-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
        .mcp-stat { background: #202327; border: 1px solid #2f3336; border-radius: 10px; padding: 12px; text-align: center; }
        .mcp-stat-value { font-size: 22px; font-weight: 800; color: #e7e9ea; }
        .mcp-stat-label { font-size: 11px; color: #71767b; margin-top: 4px; }

        .mcp-preview { background: #202327; border: 1px solid #2f3336; border-radius: 12px; padding: 14px; margin-top: 12px; font-size: 13px; line-height: 1.6; color: #e7e9ea; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
        .mcp-preview-link { color: #1d9bf0; text-decoration: underline; }

        .mcp-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
        .mcp-badge-green { background: rgba(0,186,124,0.15); color: #00ba7c; }
        .mcp-badge-red { background: rgba(244,33,46,0.15); color: #f4212e; }
        .mcp-badge-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
        .mcp-badge-green .mcp-badge-dot { background: #00ba7c; }
        .mcp-badge-red .mcp-badge-dot { background: #f4212e; }

        .mcp-divider { border: none; border-top: 1px solid #2f3336; margin: 14px 0; }
        .mcp-footer { padding: 10px 18px; border-top: 1px solid #2f3336; font-size: 11px; color: #536471; text-align: center; flex-shrink: 0; }

        #auto-dm-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #1d9bf0; color: white; padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; z-index: 999999; display: none; pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    `;
    safeAppendToHead(style);

    // Toast
    const toast = document.createElement('div');
    toast.id = 'auto-dm-toast';
    if (document.body) document.body.appendChild(toast);
    var __dmToastTok = 0;
    function showToast(msg, color = '#1d9bf0', time = 2500) {
        // 4.6.34：代次令牌——旧 timeout 不得藏掉新横幅
        var myTok = (++__dmToastTok);
        toast.innerText = msg;
        toast.style.background = color;
        toast.style.display = 'block';
        setTimeout(function () {
            if (myTok !== __dmToastTok) return;
            if (toast && toast.parentNode) {
                toast.style.display = 'none';
            }
        }, time);
    }

    // Master button (Chat)
    const masterBtn = document.createElement('button');
    masterBtn.id = 'matrix-switch-btn';
    masterBtn.innerText = '\u{1F680}';
    if (SG_LEGACY_CHAT_UI && document.body) document.body.appendChild(masterBtn);

    // Settings button
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'matrix-settings-btn';
    settingsBtn.innerText = '\u2699\uFE0F';
    if (SG_LEGACY_CHAT_UI && document.body) document.body.appendChild(settingsBtn);

    // Config panel
    const configPanel = document.createElement('div');
    configPanel.id = 'matrix-config-panel';
    configPanel.innerHTML = `
        <div class="mcp-header">
            <h2>\u{1F4AC} Chat \u63A7\u5236\u53F0</h2>
            <button class="mcp-close" id="mcp-close-btn">\u2715</button>
        </div>
        <div class="mcp-tabs">
            <button class="mcp-tab active" data-tab="links">\u{1F517} \u94FE\u63A5</button>
            <button class="mcp-tab" data-tab="scripts">\u{1F4DD} \u8BDD\u672F</button>
            <button class="mcp-tab" data-tab="settings">\u2699\uFE0F \u8BBE\u7F6E</button>
            <button class="mcp-tab" data-tab="stats">\u{1F4CA} \u7EDF\u8BA1</button>
        </div>
        <div class="mcp-body">
            <!-- TAB: LINKS -->
            <div class="mcp-section active" id="mcp-tab-links">
                <label class="mcp-label">推广链接</label>
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                    <span id="matrix-link-status" style="font-size:11px;"></span>
                </div>
                <textarea class="mcp-textarea" id="mcp-links-input" rows="3" placeholder="https://line.me/R/ti/p/@你的ID&#10;每行一个链接，随机选择"></textarea>
                <p class="mcp-hint">发送私信时随机选一个链接。支持多个链接轮换。</p>
                <div class="mcp-btn-group">
                    <button class="mcp-btn mcp-btn-success" id="mcp-save-links-btn" style="flex:1;">💾 保存链接</button>
                    <button class="mcp-btn mcp-btn-primary" id="mcp-refresh-links-btn">🔄 从服务器刷新</button>
                </div>
                <hr class="mcp-divider">
                <label class="mcp-label">当前生效链接</label>
                <div id="mcp-current-links" class="mcp-card" style="font-size:12px; color:#71767b; word-break:break-all;">加载中...</div>
            </div>

            <!-- TAB: SCRIPTS -->
            <div class="mcp-section" id="mcp-tab-scripts">
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F3AF} \u9009\u62E9\u8BDD\u672F</div>
                    <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <select class="mcp-input" id="mcp-script-select" style="flex:1;">
                            <option value="v1">话术1</option>
                            <option value="v2">话术2</option>
                            <option value="v3">话术3</option>
                            <option value="v4">话术4</option>
                            <option value="v5">话术5</option>
                            <option value="v6">话术6</option>
                            <option value="v7">话术7</option>
                            <option value="v8">话术8</option>
                            <option value="v9">话术9</option>
                            <option value="v10">话术10</option>
                        </select>
                        <button class="mcp-toggle" id="mcp-script-random" title="\u968F\u673A\u6A21\u5F0F"></button>
                    </div>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F44B} \u5F00\u573A\u767D\uFF08\u7834\u51B0\uFF09</div>
                    <textarea class="mcp-textarea" id="mcp-tpl-icebreaker" rows="3"></textarea>
                    <p class="mcp-hint">\u7B2C\u4E00\u6B21\u79C1\u4FE1\u53D1\u9001\u7684\u5185\u5BB9</p>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F4E2} \u5E7F\u544A\uFF08\u5F15\u6D41\uFF09</div>
                    <textarea class="mcp-textarea" id="mcp-tpl-ad" rows="5"></textarea>
                    <p class="mcp-hint">\u56DE\u590D\u540E\u53D1\u9001\u7684\u63A8\u5E7F\u5185\u5BB9\u3002<code>{LINK}</code> \u4F1A\u88AB\u66FF\u6362\u4E3A\u63A8\u5E7F\u94FE\u63A5</p>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F501} \u8FFD\u5355</div>
                    <textarea class="mcp-textarea" id="mcp-tpl-kick" rows="2"></textarea>
                    <p class="mcp-hint">\u5BF9\u65B9\u5DF2\u8BFB\u4E0D\u56DE\u65F6\u7684\u63D0\u9192\u6D88\u606F</p>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F6AB} \u62D2\u7EDD</div>
                    <textarea class="mcp-textarea" id="mcp-tpl-reject" rows="2"></textarea>
                    <p class="mcp-hint">\u5E74\u9F84\u4E0D\u8FBE\u6807\u65F6\u7684\u62D2\u7EDD\u8BDD\u672F</p>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F30F} \u5916\u56FD\u4EBA\u62D2\u7EDD</div>
                    <textarea class="mcp-textarea" id="mcp-tpl-foreigner" rows="2"></textarea>
                    <p class="mcp-hint">\u68C0\u6D4B\u5230\u975E\u65E5\u8BED\u7528\u6237\u65F6\u53D1\u9001</p>
                </div>
                <div class="mcp-btn-group">
                    <button class="mcp-btn mcp-btn-success" id="mcp-save-scripts-btn" style="flex:1;">💾 保存话术（DNA自动提取）</button>
                    <button class="mcp-btn mcp-btn-primary" id="mcp-refresh-scripts-btn">🔄 从服务器同步</button>
                </div>
                <p class="mcp-hint" style="text-align:center; margin-top:8px;">\u4FDD\u5B58\u65F6\u81EA\u52A8\u4ECE\u8BDD\u672F\u4E2D\u63D0\u53D6 DNA \u5173\u952E\u8BCD\uFF0C\u65E0\u9700\u624B\u52A8\u914D\u7F6E</p>
                <hr class="mcp-divider">
                <label class="mcp-label">\u6D88\u606F\u9884\u89C8</label>
                <div class="mcp-preview" id="mcp-msg-preview">\u8F93\u5165\u8BDD\u672F\u540E\u70B9\u51FB\u4FDD\u5B58\u5373\u53EF\u9884\u89C8...</div>
            </div>

            <!-- TAB: SETTINGS -->
            <div class="mcp-section" id="mcp-tab-settings">
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F916} \u5F15\u64CE\u884C\u4E3A</div>
                    <div class="mcp-toggle-row">
                        <div class="mcp-toggle-info">
                            <div class="mcp-toggle-title">\u81EA\u52A8\u542F\u52A8</div>
                            <div class="mcp-toggle-desc">\u9875\u9762\u6253\u5F00\u65F6\u81EA\u52A8\u8FD0\u884C Chat \u5F15\u64CE</div>
                        </div>
                        <button class="mcp-toggle" id="mcp-toggle-auto-start"></button>
                    </div>
                    <div class="mcp-toggle-row">
                        <div class="mcp-toggle-info">
                            <div class="mcp-toggle-title">DNA \u68C0\u6D4B</div>
                            <div class="mcp-toggle-desc">\u81EA\u52A8\u8BC6\u522B\u6211\u65B9\u5DF2\u53D1\u6D88\u606F\uFF0C\u907F\u514D\u91CD\u590D\u53D1\u9001</div>
                        </div>
                        <button class="mcp-toggle on" id="mcp-toggle-dna"></button>
                    </div>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u23F1\uFE0F \u65F6\u95F4\u53C2\u6570</div>
                    <label class="mcp-label" style="margin-top:8px;">\u5C38\u4F53\u5929\u6570\uFF08\u5929\u4E0D\u6D3B\u8DC3\u89C6\u4E3A\u5C38\u4F53\uFF09</label>
                    <input class="mcp-input" type="number" id="mcp-setting-corpse-days" min="1" max="30" value="3">
                    <label class="mcp-label" style="margin-top:12px;">追单天数（已废弃，催加只用 OPS 小时闸门）</label>
                    <input class="mcp-input" type="number" id="mcp-setting-kick-days" min="0" max="14" value="0" disabled title="已废弃：盾牌/催加按轮次下一窗，不看小时">
                </div>
                <div class="mcp-btn-group">
                    <button class="mcp-btn mcp-btn-primary mcp-btn-full" id="mcp-save-settings-btn">\u{1F4BE} \u4FDD\u5B58\u8BBE\u7F6E</button>
                </div>
                <hr class="mcp-divider">
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F9F9} \u6570\u636E\u7BA1\u7406</div>
                    <div class="mcp-btn-group" style="margin-top:0">
                        <button class="mcp-btn mcp-btn-danger mcp-btn-sm" id="mcp-show-blacklist-btn">\u{1F4E6} \u67E5\u770B\u9ED1\u540D\u5355</button>
                        <button class="mcp-btn mcp-btn-ghost mcp-btn-sm" id="mcp-reset-scripts-btn">\u{1F504} \u6062\u590D\u9ED8\u8BA4\u8BDD\u672F</button>
                    </div>
                </div>
            </div>

            <!-- TAB: STATS -->
            <div class="mcp-section" id="mcp-tab-stats">
                <div class="mcp-stat-grid">
                    <div class="mcp-stat"><div class="mcp-stat-value" id="mcp-stat-ice">0</div><div class="mcp-stat-label">\u7834\u51B0</div></div>
                    <div class="mcp-stat"><div class="mcp-stat-value" id="mcp-stat-ad">0</div><div class="mcp-stat-label">\u5E7F\u544A</div></div>
                    <div class="mcp-stat"><div class="mcp-stat-value" id="mcp-stat-reject">0</div><div class="mcp-stat-label">\u62D2\u7EDD</div></div>
                    <div class="mcp-stat"><div class="mcp-stat-value" id="mcp-stat-corpse">0</div><div class="mcp-stat-label">\u5C38\u4F53</div></div>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F4C8} \u8FD0\u884C\u72B6\u6001</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <span style="font-size:12px; color:#71767b;">Chat \u5F15\u64CE</span>
                        <span class="mcp-badge mcp-badge-green" id="mcp-engine-status"><span class="mcp-badge-dot"></span> \u8FD0\u884C\u4E2D</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <span style="font-size:12px; color:#71767b;">\u8FD0\u884C\u65F6\u957F</span>
                        <span style="font-size:12px; color:#e7e9ea;" id="mcp-runtime">--</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:12px; color:#71767b;">\u4ECA\u65E5\u603B\u64CD\u4F5C</span>
                        <span style="font-size:12px; color:#e7e9ea; font-weight:700;" id="mcp-total-ops">0</span>
                    </div>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F6E1}\uFE0F \u9ED1\u540D\u5355</div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:12px; color:#71767b;">\u5DF2\u62C9\u9ED1\u7528\u6237</span>
                        <span style="font-size:14px; color:#f4212e; font-weight:700;" id="mcp-blacklist-count">0</span>
                    </div>
                </div>
                <div class="mcp-card">
                    <div class="mcp-card-title">\u{1F517} \u94FE\u63A5\u72B6\u6001</div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:12px; color:#71767b;">\u53EF\u7528\u94FE\u63A5\u6570</span>
                        <span style="font-size:14px; color:#1d9bf0; font-weight:700;" id="mcp-links-count">0</span>
                    </div>
                </div>
            </div>
        </div>
        <div class="mcp-footer">X-Matrix Chat V16 \u00B7 \u94FE\u63A5\u548C\u8BDD\u672F\u4FDD\u5B58\u5728\u672C\u5730 localStorage</div>
    `;
    if (SG_LEGACY_CHAT_UI && document.body) document.body.appendChild(configPanel);

    // ==================== TAB SWITCHING ====================
    configPanel.querySelectorAll('.mcp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            configPanel.querySelectorAll('.mcp-tab').forEach(t => t.classList.remove('active'));
            configPanel.querySelectorAll('.mcp-section').forEach(s => s.classList.remove('active'));
            tab.classList.add('active');
            configPanel.querySelector('#mcp-tab-' + tab.dataset.tab).classList.add('active');
            if (tab.dataset.tab === 'stats') mcpRefreshStats();
            if (tab.dataset.tab === 'scripts') mcpRefreshPreview();
            if (tab.dataset.tab === 'links') mcpRefreshLinks();
        });
    });

    // Close button
    configPanel.querySelector('#mcp-close-btn').onclick = () => configPanel.classList.remove('mcp-show');

    // ==================== LINKS ====================
    function mcpGetLinks() {
        try {
            const raw = localStorage.getItem('dan_my_promo_links');
            if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0) return arr; }
        } catch(e) {}
        return __promoLinksArr().length > 0 ? __promoLinksArr() : [];
    }

    function mcpRefreshLinks() {
        const links = mcpGetLinks();
        const linkStatus = configPanel.querySelector('#matrix-link-status');
        configPanel.querySelector('#mcp-links-input').value = links.join('\n');
        if (links.length > 0) {
            configPanel.querySelector('#mcp-current-links').innerHTML = links.map(l => '<div style="margin-bottom:4px;"><span style="color:#1d9bf0;">●</span> ' + l + '</div>').join('');
            if (linkStatus) linkStatus.innerHTML = '<span style="color:#00ba7c;">✅ 已加载 ' + links.length + ' 个链接</span>';
        } else {
            configPanel.querySelector('#mcp-current-links').innerHTML = '<span style="color:#f91880;">❌ 无可用链接！请从服务器刷新或手动输入</span>';
            if (linkStatus) linkStatus.innerHTML = '<span style="color:#f91880;">❌ 无可用链接 — 广告消息将跳过</span>';
        }
        mcpRefreshPreview();
    }

    configPanel.querySelector('#mcp-save-links-btn').onclick = async () => {
        const raw = configPanel.querySelector('#mcp-links-input').value.trim();
        if (!raw) { showToast('\u274C \u8BF7\u8F93\u5165\u94FE\u63A5', '#f91880'); return; }
        const links = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
        if (links.length === 0) { showToast('\u274C \u6CA1\u6709\u6709\u6548\u94FE\u63A5\uFF08\u9700 http \u5F00\u5934\uFF09', '#f91880'); return; }
        await saveMyLinks(links, true);
        __setPromoLinksArr(links);
        mcpRefreshLinks();
        showToast('✅ 已保存 ' + links.length + ' 个链接', '#00ba7c');
    };

    configPanel.querySelector('#mcp-refresh-links-btn').onclick = async () => {
        mcpRefreshLinksBtn();
    };

    async function mcpRefreshLinksBtn() {
        const btn = configPanel.querySelector('#mcp-refresh-links-btn');
        if (btn) { btn.textContent = '⏳ 刷新中...'; btn.disabled = true; }
        const serverLinks = await fetchLinksFromServer();
        if (serverLinks && serverLinks.length > 0) {
            __setPromoLinksArr(serverLinks);
            localStorage.setItem(MY_LINKS_KEY, JSON.stringify(serverLinks));
            localStorage.setItem(LINKS_SYNC_KEY, String(Date.now()));
            mcpRefreshLinks();
            showToast('✅ 从服务器加载 ' + serverLinks.length + ' 个链接', '#00ba7c');
        } else {
            showToast('⚠️ 服务器不可达，使用本地缓存', '#f0883e');
            mcpRefreshLinks();
        }
        if (btn) { btn.textContent = '🔄 从服务器刷新'; btn.disabled = false; }
    }

    // ==================== SCRIPTS ====================
    function mcpLoadScriptsUI() {
        var config = loadScripts();

        // 加载话术池
        var poolData = null;
        try {
            var raw = localStorage.getItem('dan_scripts');
            if (raw) poolData = JSON.parse(raw);
        } catch(e) {}

        if (!poolData || !poolData.scripts) poolData = { scripts: {} };

        // 用 SCRIPT_DEFAULTS 补全缺失的话术，始终确保 5 套都可用
        var mergedScripts = {};
        Object.keys(SCRIPT_DEFAULTS.scripts).forEach(function(k) {
            mergedScripts[k] = (poolData.scripts && poolData.scripts[k]) || SCRIPT_DEFAULTS.scripts[k];
        });
        var pool = SCRIPT_DEFAULTS.random_pool;
        poolData.scripts = mergedScripts;
        poolData.random_pool = pool;

        // 显示随机模式开关
        var randomToggle = configPanel.querySelector('#mcp-script-random');
        if (randomToggle) randomToggle.classList.toggle('on', poolData.mode === 'random' || SCRIPT_DEFAULTS.mode === 'random');

        // 填充下拉框
        var select = configPanel.querySelector('#mcp-script-select');
        select.innerHTML = pool.map(function(id) {
            var s = mergedScripts[id];
            return '<option value="' + id + '">' + ((s && s.name) || id) + '</option>';
        }).join('');

        // 加载第一个话术的破冰和广告
        var firstId = pool[0];
        if (firstId && mergedScripts[firstId]) {
            configPanel.querySelector('#mcp-tpl-icebreaker').value = mergedScripts[firstId].icebreaker || '';
            configPanel.querySelector('#mcp-tpl-ad').value = mergedScripts[firstId].ad_template || '';
        }

        configPanel.querySelector('#mcp-tpl-kick').value = config.templates.kick || '';
        configPanel.querySelector('#mcp-tpl-reject').value = config.templates.reject || '';
        configPanel.querySelector('#mcp-tpl-foreigner').value = config.templates.foreigner_reject || '';
        mcpRefreshPreview();
    }

    // 话术池：切换 v1-v5 时加载对应破冰和广告
    var poolSelect = configPanel.querySelector('#mcp-script-select');
    if (poolSelect) {
        poolSelect.onchange = function() {
            var id = this.value;
            try {
                var raw = localStorage.getItem('dan_scripts');
                var scripts = SCRIPT_DEFAULTS.scripts;
                if (raw) {
                    try { var p = JSON.parse(raw); if (p.scripts) scripts = p.scripts; } catch(_) {}
                }
                var s = scripts[id] || SCRIPT_DEFAULTS.scripts[id];
                if (!s) return;
                configPanel.querySelector('#mcp-tpl-icebreaker').value = s.icebreaker || '';
                configPanel.querySelector('#mcp-tpl-ad').value = s.ad_template || '';
                mcpRefreshPreview();
            } catch(e) {}
        };
    }

    // 随机模式开关
    var randomToggle = configPanel.querySelector('#mcp-script-random');
    if (randomToggle) {
        randomToggle.onclick = function() { this.classList.toggle('on'); };
    }

    configPanel.querySelector('#mcp-save-scripts-btn').onclick = () => {
        var ice = configPanel.querySelector('#mcp-tpl-icebreaker').value;
        var ad = configPanel.querySelector('#mcp-tpl-ad').value;
        var kick = configPanel.querySelector('#mcp-tpl-kick').value;
        var reject = configPanel.querySelector('#mcp-tpl-reject').value;
        var foreigner = configPanel.querySelector('#mcp-tpl-foreigner').value;

        // 读取现有话术池，合并 SCRIPT_DEFAULTS 防止缺失
        var raw = localStorage.getItem('dan_scripts');
        var poolData;
        try { poolData = raw ? JSON.parse(raw) : {}; } catch(e) { poolData = {}; }
        if (!poolData.scripts) poolData.scripts = {};
        // 补全缺失的话术（始终确保 5 套齐全）
        Object.keys(SCRIPT_DEFAULTS.scripts).forEach(function(k) {
            if (!poolData.scripts[k]) poolData.scripts[k] = JSON.parse(JSON.stringify(SCRIPT_DEFAULTS.scripts[k]));
        });
        poolData.random_pool = SCRIPT_DEFAULTS.random_pool;

        // 更新当前选中的话术
        var selectEl = configPanel.querySelector('#mcp-script-select');
        var currentId = selectEl ? selectEl.value : 'v1';
        if (!poolData.scripts[currentId]) poolData.scripts[currentId] = { name: '话术' + currentId.replace('v', '') };
        poolData.scripts[currentId].icebreaker = ice;
        poolData.scripts[currentId].ad_template = ad;

        // 随机模式
        var randomToggle = configPanel.querySelector('#mcp-script-random');
        poolData.mode = (randomToggle && randomToggle.classList.contains('on')) ? 'random' : 'fixed';

        // 追单/拒绝/外国人拒绝写入所有话术（固定不变）
        Object.keys(poolData.scripts).forEach(function(k) {
            poolData.scripts[k].kick_message = kick;
            poolData.scripts[k].reject_message = reject;
            poolData.scripts[k].foreigner_reject = foreigner;
        });

        // DNA 提取（从全部5套话术合并提取）
        var allDnaTexts = [];
        Object.keys(poolData.scripts).forEach(function(k) {
            var s = poolData.scripts[k];
            if (s) {
                allDnaTexts.push(s.icebreaker || '');
                allDnaTexts.push(s.ad_template || '');
                allDnaTexts.push(s.kick_message || '');
                allDnaTexts.push(s.reject_message || '');
                allDnaTexts.push(s.foreigner_reject || '');
            }
        });
        var extracted = autoExtractDNA({ icebreaker: allDnaTexts.join(' '), ad: '', kick: '', reject: '', foreigner_reject: '' });
        poolData.dna_core = extracted.core;
        poolData.dna_aux = extracted.aux;
        poolData.templates = { icebreaker: ice, ad: ad, kick: kick, reject: reject, foreigner_reject: foreigner };

        localStorage.setItem('dan_scripts', JSON.stringify(poolData));
        loadScripts();
        mcpRefreshPreview();
        showToast('\u2705 \u8BDD\u672F\u5DF2\u4FDD\u5B58 (' + currentId + ')', '#00ba7c');
    };

    function mcpRefreshPreview() {
        const ad = configPanel.querySelector('#mcp-tpl-ad').value;
        const link = mcpGetLinks()[0] || '';
        const preview = ad.replace(/\{LINK\}/g, link);
        configPanel.querySelector('#mcp-msg-preview').innerHTML = preview.replace(/(https?:\/\/[^\s]+)/g, '<span class="mcp-preview-link">$1</span>');
    }

    configPanel.querySelector('#mcp-reset-scripts-btn').onclick = () => {
        if (!confirm('\u786E\u5B9A\u6062\u590D\u9ED8\u8BA4\u8BDD\u672F\uFF1F\u5F53\u524D\u8BDD\u672F\u5C06\u88AB\u8986\u76D6\u3002')) return;
        localStorage.removeItem('dan_scripts');
        loadScripts();
        mcpLoadScriptsUI();
        showToast('\u2705 \u5DF2\u6062\u590D\u9ED8\u8BA4\u8BDD\u672F', '#00ba7c');
    };

    configPanel.querySelector('#mcp-refresh-scripts-btn').onclick = async () => {
        const btn = configPanel.querySelector('#mcp-refresh-scripts-btn');
        if (btn) { btn.textContent = '⏳ 同步中...'; btn.disabled = true; }
        await syncScriptsFromServer(false);
        mcpLoadScriptsUI();
        if (btn) { btn.textContent = '🔄 从服务器同步'; btn.disabled = false; }
    };

    // ==================== SETTINGS ====================
    function mcpLoadSettingsUI() {
        const autoStart = localStorage.getItem('dan_auto_start_enabled') === 'true';
        configPanel.querySelector('#mcp-toggle-auto-start').classList.toggle('on', autoStart);
        configPanel.querySelector('#mcp-toggle-dna').classList.add('on');
        try {
            const config = JSON.parse(localStorage.getItem('dan_scripts') || '{}');
            configPanel.querySelector('#mcp-setting-corpse-days').value = config.corpse_days || 3;
            configPanel.querySelector('#mcp-setting-kick-days').value = config.kick_days || 2;
        } catch(e) {}
    }

    configPanel.querySelector('#mcp-toggle-auto-start').onclick = function() {
        this.classList.toggle('on');
        localStorage.setItem('dan_auto_start_enabled', this.classList.contains('on') ? 'true' : 'false');
        showToast(this.classList.contains('on') ? '\u{1F916} \u81EA\u52A8\u542F\u52A8\u5DF2\u5F00\u542F' : '\u{1F512} \u81EA\u52A8\u542F\u52A8\u5DF2\u5173\u95ED', this.classList.contains('on') ? '#00ba7c' : '#f91880');
        updateMasterBtn();
    };

    configPanel.querySelector('#mcp-toggle-dna').onclick = function() { this.classList.toggle('on'); };

    configPanel.querySelector('#mcp-save-settings-btn').onclick = () => {
        var config = loadScripts();
        config.corpse_days = parseInt(configPanel.querySelector('#mcp-setting-corpse-days').value) || 3;
        // kick_days 废弃，保存时固定写 0 避免误导
        config.kick_days = 0;
        localStorage.setItem('dan_scripts', JSON.stringify(config));
        showToast('\u2705 \u8BBE\u7F6E\u5DF2\u4FDD\u5B58', '#00ba7c');
    };

    configPanel.querySelector('#mcp-show-blacklist-btn').onclick = () => {
        try {
            const bl = JSON.parse(localStorage.getItem('dan_chat_blacklist') || '{}');
            const count = Object.keys(bl).length;
            alert('\u9ED1\u540D\u5355\u7528\u6237: ' + count + ' \u4EBA\\n\\n' + (count > 0 ? Object.keys(bl).slice(0, 20).join('\\n') : '\uFF08\u7A7A\uFF09'));
        } catch(e) { alert('\u9ED1\u540D\u5355\u4E3A\u7A7A'); }
    };

    // ==================== STATS ====================
    function mcpRefreshStats() {
        try {
            const stats = JSON.parse(localStorage.getItem('dan_local_stats') || '{}');
            configPanel.querySelector('#mcp-stat-ice').textContent = stats.ice || 0;
            configPanel.querySelector('#mcp-stat-ad').textContent = stats.ad || 0;
            configPanel.querySelector('#mcp-stat-reject').textContent = stats.reject || 0;
            configPanel.querySelector('#mcp-stat-corpse').textContent = stats.corpse || 0;
            const total = (stats.ice||0) + (stats.ad||0) + (stats.reject||0) + (stats.corpse||0);
            configPanel.querySelector('#mcp-total-ops').textContent = total;
            if (stats.start_time > 0) {
                const mins = Math.floor((Date.now() - stats.start_time) / 60000);
                configPanel.querySelector('#mcp-runtime').textContent = mins < 60 ? mins + ' \u5206\u949F' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
            }
        } catch(e) {}
        const running = sessionStorage.getItem('dan_auto_run') === 'true';
        const badge = configPanel.querySelector('#mcp-engine-status');
        if (running) { badge.className = 'mcp-badge mcp-badge-green'; badge.innerHTML = '<span class="mcp-badge-dot"></span> \u8FD0\u884C\u4E2D'; }
        else { badge.className = 'mcp-badge mcp-badge-red'; badge.innerHTML = '<span class="mcp-badge-dot"></span> \u5DF2\u505C\u6B62'; }
        try { configPanel.querySelector('#mcp-blacklist-count').textContent = Object.keys(JSON.parse(localStorage.getItem('dan_chat_blacklist') || '{}')).length; } catch(e) {}
        configPanel.querySelector('#mcp-links-count').textContent = mcpGetLinks().length;
    }

    // ==================== PANEL TOGGLE ====================
    settingsBtn.onclick = () => {
        if (configPanel.classList.contains('mcp-show')) {
            configPanel.classList.remove('mcp-show');
        } else {
            configPanel.classList.add('mcp-show');
            mcpRefreshLinks();
            mcpLoadScriptsUI();
            mcpLoadSettingsUI();
            mcpRefreshStats();
        }
    };

    const AUTO_START_KEY = 'dan_auto_start_enabled';
    function isAutoStartEnabled() { return localStorage.getItem(AUTO_START_KEY) === 'true'; }
    function setAutoStartEnabled(enabled) { localStorage.setItem(AUTO_START_KEY, enabled ? 'true' : 'false'); }
    function updateMasterBtn() {
        if (sessionStorage.getItem('dan_auto_run') === 'true') {
            masterBtn.title = '\u5F15\u64CE\u8FD0\u884C\u4E2D (\u70B9\u51FB\u505C\u6B62)';
            masterBtn.className = 'running';
            masterBtn.innerText = '\u23F9';
        } else {
            masterBtn.title = isAutoStartEnabled() ? '\u81EA\u52A8\u542F\u52A8\u6A21\u5F0F (\u70B9\u51FB\u624B\u52A8\u542F\u52A8)' : '\u624B\u52A8\u542F\u52A8\u6A21\u5F0F (\u70B9\u51FB\u542F\u52A8)';
            masterBtn.className = isAutoStartEnabled() ? 'auto-mode' : '';
            masterBtn.innerText = isAutoStartEnabled() ? '\u{1F916}' : '\u{1F680}';
        }
    }

    // 获取当前登录用户的 handle
    function getMyHandle() {
        let myHandleEl = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        if (myHandleEl && myHandleEl.href) {
            return myHandleEl.href.split('/').pop().toLowerCase();
        }
        // 从 worker_id 缓存获取
        let workerId = sessionStorage.getItem('dan_worker_id');
        if (workerId) {
            return workerId.split('#')[0].replace('@', '').toLowerCase();
        }
        return null;
    }

    // 检查是否在自己的 followers 页面（私信脚本专属）
    /** 粉丝列表面：含 /followers 与 /verified_followers（后者不含 `/followers` 子串） */
    function isFollowersListPath(urlOrPath) {
        var p = String(urlOrPath || window.location.pathname || '').toLowerCase().split('?')[0];
        return /\/(?:verified_)?followers(?:\/|$)/.test(p) || /\/followers_you_follow(?:\/|$)/.test(p);
    }
    function isMyFollowersPage() {
        if (!isFollowersListPath(window.location.pathname)) return false;
        var pathHandle = normalizeChatHandle((window.location.pathname.split('/')[1] || ''));
        var myHandle = '';
        try {
            myHandle = normalizeChatHandle(
                getMyHandle() ||
                sessionStorage.getItem('dan_target_username') ||
                localStorage.getItem('matrix_my_handle') || ''
            );
        } catch (e) { myHandle = ''; }
        if (!myHandle) {
            // 无法确定，默认不启动（避免在错误的页面启动）
            console.log('[隔离] 无法确定当前用户，跳过自动启动');
            return false;
        }
        return pathHandle === myHandle;
    }

    function tryAutoStart() {
        // 硬规则：自动模式下禁止自启，只认调度 sg-*-command
        if (typeof SchedulerGate !== 'undefined' && !SchedulerGate.canSelfStart('chat')) {
            console.log('【自动启动】调度自动模式中，跳过私信自启');
            return false;
        }
        // 自动启动条件检查
        if (!isAutoStartEnabled()) return false;
        if (sessionStorage.getItem('dan_auto_run') === 'true') return false;
        if (!__promoLinksArr().length) {
            console.log('【自动启动】引流链接未就绪（空），跳过');
            return false;
        }

        let myHandleAuto = getMyHandle();
        if (!myHandleAuto) {
            console.log('【自动启动】无法获取当前用户');
            return false;
        }

        console.log('【自动启动】私信引擎自动启动中...');
        sessionStorage.setItem('dan_auto_run', 'true');
        localStorage.setItem('dan_chat_status', 'running');
        sessionStorage.removeItem('dan_auto_step');
        sessionStorage.setItem('dan_session_scanned', '[]');
        sessionStorage.setItem('dan_warmup_timer', (Date.now() + 1000).toString());
        sessionStorage.setItem('dan_target_username', myHandleAuto);
        try { setChatPhase('outbound'); } catch (ePhA) {}
        try { clearOwnProfileFollowerReady('try_auto_start'); } catch (eClrA) {}
        showToast('🤖 私信引擎自动启动！先读本号主页关注者', '#00ba7c', 2000);
        // 4.6.72/73：先资料页读 F，禁止直跳 /followers
        if (typeof SchedulerGate !== 'undefined') {
            SchedulerGate.go('chat', 'https://x.com/' + myHandleAuto);
        } else {
            window.location.href = 'https://x.com/' + myHandleAuto;
        }
        renderStats();
        updateMasterBtn();
        return true;
    }

    masterBtn.onclick = () => {
        if (sessionStorage.getItem('dan_auto_run') === 'true') {
            // 停止引擎
            sessionStorage.setItem('dan_auto_run', 'false');
            localStorage.setItem('dan_chat_status', 'stopped');
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.removeItem('dan_inbox_opening');
            showToast('🛑 引擎已停止', '#f91880');
        } else {
            // 自动模式：禁止旁路手动开私信，避免与调度抢跑
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode()) {
                showToast('自动模式中请用调度面板，勿手动开私信', '#f91880', 3000);
                return;
            }
            if (!__promoLinksArr().length) { 
                alert('⚠️ 推广链接未就绪！请在设置面板中配置。'); 
                return; 
            }
            let myHandle = getMyHandle();
            if (!myHandle) { showToast('无法获取当前用户', '#f91880', 3000); return; }
            sessionStorage.setItem('dan_auto_run', 'true');
            localStorage.setItem('dan_chat_status', 'running');
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.setItem('dan_session_scanned', '[]');
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 1000).toString());
            sessionStorage.setItem('dan_target_username', myHandle);
            try { setChatPhase('outbound'); } catch (ePhM) {}
            try { clearOwnProfileFollowerReady('master_btn_start'); } catch (eClrM) {}
            showToast('🚀 引擎启动，先停本号主页读关注者…', '#1d9bf0', 2000);
            // 4.6.72/73：先资料页读 F，禁止直跳 /followers
            chatGo('https://x.com/' + myHandle, false);
            renderStats();
        }
        updateMasterBtn();
    };

    updateMasterBtn();
    renderStats();

    // 软风控分流 → chat1：刷新 OPS 轮次（队列灌入在 sg-chat-command start，避免被 clear 冲掉）
    /** 4.6.87：日终/日启成功后才盖同日幂等戳（失败可由调度 60s 冷却重试） */
    function markChatDayLedgerAck(ack, ok) {
        if (!ok || !ack) return;
        try {
            var today = '';
            try { today = chatShanghaiDate(); } catch (eD) { today = ''; }
            if (!today) {
                try {
                    if (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiDate) today = String(TimeUtil.shanghaiDate() || '');
                } catch (eT) {}
            }
            if (!today) {
                try { today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }); } catch (eL) { today = ''; }
            }
            if (!today) return;
            var sg = loadSgState();
            if (ack === 'day_end') {
                sg.chatDayEndLedgerPostedDate = today;
                sg.chatDayEndLedgerAttemptAt = 0;
                saveSgState(sg);
                console.log('[台账] 日终 POST 成功盖戳 date=' + today);
            } else if (ack === 'day_start') {
                sg.chatDayLedgerPulledDate = today;
                sg.chatDayLedgerPullAttemptAt = 0;
                saveSgState(sg);
                console.log('[台账] 日启 GET 成功盖戳 date=' + today);
            }
        } catch (eAck) {}
    }

    function isChatDayEndLedgerWhy(why) {
        var w = String(why || '');
        return w === 'chat_day_end' || w === 'soft_chat_end'
            || w === 'daytime_past_chat_hours' || w === 'chat_hours_closed'
            || w.indexOf('chat_day_end') === 0;
    }

    /** 4.6.87：日终强制 POST——绕过 isLedgerOpsSyncPhase；inflight 则短延重试 */
    function postLedgerSnapshotForced(why, ack, attempt) {
        attempt = attempt || 0;
        if (_ledgerSyncInflight) {
            if (attempt >= 20) {
                console.warn('[台账] 日终强制 POST 放弃：持续 inflight why=' + why);
                return;
            }
            setTimeout(function () { postLedgerSnapshotForced(why, ack, attempt + 1); }, 3000);
            return;
        }
        var snapPost = null;
        try { snapPost = buildFanLedgerSnapshot(why); } catch (eSp) { snapPost = null; }
        if (!snapPost) {
            console.warn('[台账] 日终强制 POST 无快照 why=' + why);
            return;
        }
        console.log('[台账] 收工强制 POST items=' + (snapPost.itemCount || 0) + ' why=' + why);
        opsDmRosterSync(snapPost, function (ok) {
            markChatDayLedgerAck(ack || 'day_end', !!ok);
            if (!ok) console.warn('[台账] 日终 POST 失败，待调度冷却重试 why=' + why);
        });
    }

    /** 4.6.81/87：调度侧挂起/恢复/清窗/日终 → 保证 OPS roster 链接 */
    window.addEventListener('sg-soft-risk-ledger-sync', function (e) {
        var d = (e && e.detail) || {};
        var mode = String(d.mode || 'post');
        var why = String(d.why || 'soft_risk_ledger');
        var force = !!d.force || isChatDayEndLedgerWhy(why);
        var ack = String(d.ack || '');
        if (!ack && isChatDayEndLedgerWhy(why)) ack = 'day_end';
        if (!ack && mode === 'pull' && force) ack = 'day_start';
        try {
            if (mode === 'pull') {
                if (_ledgerSyncInflight && force) {
                    setTimeout(function () {
                        try {
                            syncLedgerWithOps({ reason: why, allowPost: false }, function (res) {
                                markChatDayLedgerAck(ack, !!(res && res.ok));
                            });
                        } catch (eRetry) {}
                    }, 3000);
                    return;
                }
                syncLedgerWithOps({ reason: why, allowPost: false }, function (res) {
                    markChatDayLedgerAck(ack, !!(res && res.ok));
                });
            } else if (mode === 'dirty') {
                markLedgerDirty(why);
                flushLedgerDirty(why);
            } else if (mode === 'post') {
                if (force || ack === 'day_end') {
                    postLedgerSnapshotForced(why, ack || 'day_end', 0);
                    return;
                }
                if (_ledgerSyncInflight) {
                    markLedgerDirty(why);
                    return;
                }
                var snapPost = null;
                try { snapPost = buildFanLedgerSnapshot(why); } catch (eSp) { snapPost = null; }
                if (snapPost) {
                    console.log('[台账] 收工/清窗 POST items=' + (snapPost.itemCount || 0) + ' why=' + why);
                    opsDmRosterSync(snapPost);
                }
            }
        } catch (eLs) {
            console.warn('[台账] sg-soft-risk-ledger-sync 异常', eLs && eLs.message);
        }
    });

    window.addEventListener('sg-soft-risk-chat-start', function (e) {
        var d = (e && e.detail) || {};
        debugChatLog('软风控 chat1 开启，刷新 OPS 轮次', { step: 'soft_risk_chat1', duration_min: d.durationMin });
        try {
            setChatPhase('outbound');
            resetChatIdentityState('soft_risk_chat_start');
        } catch (ePh) {}
        // 4.6.65：每一软窗都重读主页 F（不是只有早间一轮）
        try { clearOwnProfileFollowerReady('soft_risk_chat_start'); } catch (ePf) {}
        maybeRefreshOpsRoundMap(true);
    });

    window.addEventListener('sg-soft-risk-chat2-start', function (e) {
        var d = (e && e.detail) || {};
        debugChatLog('软风控 chat2 开启', { step: 'soft_risk_chat2', reason: d.reason || '' });
        try {
            prepareSoftRiskChat2Queue(d.reason || 'chat2_event');
        } catch (ePrep) {}
    });

    // 页面加载后尝试自动启动
    async function initAutoStart() {
        // 换号对账优先于「仅空时写入」：禁止沿用上一号 dan_target_username
        try { reconcileChatHostIdentity('init_auto_start'); } catch (eRecInit) {}
        if (!sessionStorage.getItem('dan_target_username')) {
            var hh = localStorage.getItem('matrix_my_handle');
            if (hh) {
                hh = hh.replace('@','').replace('#guard','').toLowerCase();
                sessionStorage.setItem('dan_target_username', hh);
                console.log('[初始化] dan_target_username 修复为:', hh);
            }
        }
        console.log('[初始化] ✅ 推广链接已就绪:', __promoLinksArr());
        // 从后端加载今日已完成名单
        try {
            var h = sessionStorage.getItem('dan_target_username') || localStorage.getItem('matrix_my_handle');
            if (h) {
                h = h.replace('@','').replace('#guard','').toLowerCase();
                var softOpsPending = sessionStorage.getItem('dan_ops_refresh_on_soft_risk');
                if (softOpsPending && isSoftRiskChatWindow()) {
                    sessionStorage.removeItem('dan_ops_refresh_on_soft_risk');
                    maybeRefreshOpsRoundMap(true, function (ok) {
                        if (ok) console.log('[私信-后端] 软风控窗 OPS 轮次已刷新');
                    });
                } else if (!shouldDeferChatForFollow()) {
                    refreshOpsRoundMap(function (ok) {
                        if (ok) {
                            try {
                                var r = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]');
                                console.log('[私信-后端] 已完成:', (r||[]).length,
                                    '轮次映射:', Object.keys(loadOpsRoundMap()).length);
                            } catch (eLog) {}
                        }
                    });
                } else {
                    console.log('[私信-后端] 关注轮次进行中，跳过 OPS 轮次拉取');
                }
            }
        } catch(e) { console.log('[私信-后端] 查询跳过:', e.message); }
        // 硬规则：自动模式不自启
        if (typeof SchedulerGate !== 'undefined' && !SchedulerGate.canSelfStart('chat')) {
            console.log('[初始化] 自动模式，跳过 tryAutoStart');
            return;
        }
        tryAutoStart();
    }
    
    // 延迟启动，确保页面和链接都就绪
    setTimeout(initAutoStart, 2500);
    
    // ========== 【批量同步本地累计统计到 NAS】 ==========
    setTimeout(() => {
        let localStats = JSON.parse(GM_getValue('dan_local_stats', '{"ice":0, "ad":0, "ignored":0}'));
        let botId = getWorkerId();
        let total = (localStats.ice || 0) + (localStats.ad || 0) + (localStats.ignored || 0);
        if (total > 0) {
            console.log(`[批量同步] 本地累计: 破冰${localStats.ice} 广告${localStats.ad} 拦截${localStats.ignored}，正在上传到 NAS...`);
            try {
                chrome.runtime.sendMessage({
                    action: "send_report",
                    payload: {
                        worker_id: botId,
                        engine: "chat",
                        status: "批量同步本地统计",
                        detail: `破冰${localStats.ice} 广告${localStats.ad} 拦截${localStats.ignored}`,
                        stats: {
                            ice: localStats.ice || 0,
                            ad: localStats.ad || 0,
                            ignored: localStats.ignored || 0
                        }
                    }
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('[批量同步] Service Worker 未就绪');
                    } else if (response && response.status === 'success') {
                        console.log('[批量同步] ✅ 上传成功！大屏将显示正确累计值');
                    } else {
                        console.warn('[批量同步] 上传失败:', response);
                    }
                });
            } catch(e) {
                console.error('[批量同步] 异常:', e);
            }
        }
    }, 4000);

    // ==============================================================================
    // 寻框与打字函数
    // ==============================================================================
    /** 含 open shadowRoot；X 偶发把口挂在 shadow 里 */
    function __dmQueryAllDeep(root, selector, out, depth) {
        out = out || [];
        depth = depth || 0;
        if (!root || depth > 6) return out;
        try {
            if (root.querySelectorAll) {
                var nodes = root.querySelectorAll(selector);
                for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
            }
        } catch (eQ) {}
        try {
            var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (var j = 0; j < all.length; j++) {
                var n = all[j];
                if (n && n.shadowRoot) __dmQueryAllDeep(n.shadowRoot, selector, out, depth + 1);
            }
        } catch (eS) {}
        return out;
    }

    /**
     * 穿透 open shadowRoot 收集文本（4.6.126）。
     * innerText/textContent 不透 shadow：X 已把 DM 会话面板（dm-container 全链）
     * 整体移入 shadow，「收件箱已关闭 / X 安全码 / 只读」等硬文案只有穿透才扫得到。
     */
    function __dmCollectTextDeep(root, maxLen, depth) {
        maxLen = maxLen || 8000;
        depth = depth || 0;
        var out = '';
        if (!root || depth > 6) return out;
        try {
            var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while (w.nextNode()) {
                var v = w.currentNode.nodeValue || '';
                if (v && v.trim()) out += v.replace(/\s+/g, ' ').trim() + ' ';
                if (out.length >= maxLen) return out.slice(0, maxLen);
            }
        } catch (eW) {}
        try {
            var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (var i = 0; i < all.length; i++) {
                var n = all[i];
                if (n && n.shadowRoot) {
                    out += __dmCollectTextDeep(n.shadowRoot, maxLen - out.length, depth + 1);
                    if (out.length >= maxLen) return out.slice(0, maxLen);
                }
            }
        } catch (eS) {}
        return out;
    }

    var DM_EDITABLE_SEL = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]';

    /** 从 wrapper 钻到真正可输入口；密码框不当会话口 */
    function __resolveEditableMouth(el) {
        if (!el) return null;
        try {
            var tag = String(el.tagName || '').toUpperCase();
            if (tag === 'INPUT') {
                var typ = String(el.type || 'text').toLowerCase();
                if (typ === 'password' || typ === 'hidden' || typ === 'checkbox' || typ === 'radio' || typ === 'submit' || typ === 'button') return null;
                return el;
            }
            if (tag === 'TEXTAREA') return el;
            var ce = el.getAttribute && el.getAttribute('contenteditable');
            if (el.isContentEditable || ce === 'true' || ce === 'plaintext-only' || ce === '') return el;
            var inner = el.querySelector(DM_EDITABLE_SEL);
            if (inner && inner !== el) {
                var dug = __resolveEditableMouth(inner);
                if (dug) return dug;
            }
            if (el.getAttribute('role') === 'textbox') return el;
        } catch (e) {}
        return null;
    }

    function __dmMouthVisible(el) {
        var m = __resolveEditableMouth(el);
        if (!m) return null;
        try {
            if (m.disabled || (m.getAttribute && m.getAttribute('aria-disabled') === 'true')) return null;
            // 隐藏节点跳过（含 display:none）
            if (m.offsetParent === null && m.getClientRects && m.getClientRects().length === 0) {
                var r0 = m.getBoundingClientRect();
                if (r0.width < 1 || r0.height < 1) return null;
            }
            var r = m.getBoundingClientRect();
            if (r.width < 20 || r.height < 8) return null;
            var meta = String((m.getAttribute && (m.getAttribute('name') || '')) || '')
                + ' ' + String((m.getAttribute && (m.getAttribute('autocomplete') || '')) || '')
                + ' ' + String((m.id || ''));
            if (/passcode|password|pin/i.test(meta)) return null;
            if (m.closest && m.closest('[data-testid*="passcode" i], [data-testid*="Passcode" i], [data-testid*="password" i]')) {
                return null;
            }
            return m;
        } catch (eV) {
            return m;
        }
    }

    /** 底部「私信」假壳：可见文案/aria/placeholder，尚无真正 editable */
    function findDmComposerPlaceholderShell() {
        try {
            if (!(isDmConversationPage() || isMessagesPage())) return null;
            var col = document.querySelector('[data-testid="primaryColumn"]')
                || document.querySelector('main[role="main"]')
                || document.body;
            var minTop = (window.innerHeight || 600) * 0.45;
            var cands = __dmQueryAllDeep(col, 'div, span, p, label, [role="button"], [data-testid], [aria-label], [placeholder], [data-placeholder]');
            var best = null;
            var bestTop = -1;
            for (var i = 0; i < cands.length; i++) {
                var el = cands[i];
                if (!el || !el.getBoundingClientRect) continue;
                try {
                    if (el.closest && el.closest('[data-testid="tweetTextarea_0"], [data-testid="SearchBox"], header[role="banner"], [data-testid="sidebarColumn"]')) continue;
                } catch (eEx) {}
                var r = el.getBoundingClientRect();
                if (r.top < minTop || r.width < 60 || r.height < 16 || r.height > 160) continue;
                var meta = '';
                try {
                    meta = [
                        el.getAttribute('placeholder') || '',
                        el.getAttribute('data-placeholder') || '',
                        el.getAttribute('aria-label') || '',
                        el.getAttribute('aria-placeholder') || ''
                    ].join(' ');
                } catch (eM) {}
                var ownText = '';
                try {
                    // 只看自身直接文本，避免吃整栏
                    var tn = [];
                    for (var c = el.firstChild; c; c = c.nextSibling) {
                        if (c.nodeType === 3) tn.push(String(c.nodeValue || ''));
                    }
                    ownText = tn.join('').replace(/\s+/g, ' ').trim();
                    if (!ownText && el.childElementCount === 0) {
                        ownText = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                    }
                } catch (eT) {}
                if (ownText.length > 24) ownText = '';
                var hit = /私信|Message|Unencrypted|メッセージ|メッセージを入力|Start a message/i.test(meta)
                    || /^(私信|发私信|Message|Messages|メッセージ)$/i.test(ownText);
                if (!hit) continue;
                if (r.top >= bestTop) {
                    best = el;
                    bestTop = r.top;
                }
            }
            return best;
        } catch (e) {
            return null;
        }
    }

    /** 会话页底部 composer 壳（可能尚未挂上 textarea/contenteditable） */
    function findDmComposerShell() {
        var sels = [
            '[data-testid="dm-composer-textarea"]',
            '[data-testid="dmComposerTextInputRichTextInputContainer"]',
            '[data-testid="dmComposerTextInput"]',
            '[data-testid="dm-composer-form"]',
            '[data-testid="dm-composer-container"]',
            'form[data-testid*="dmComposer" i]',
            '[data-testid*="dmComposerTextInput" i]',
            '[data-testid*="dm-composer" i]'
        ];
        for (var i = 0; i < sels.length; i++) {
            try {
                var nodes = __dmQueryAllDeep(document, sels[i]);
                for (var j = 0; j < nodes.length; j++) {
                    var el = nodes[j];
                    var r = el.getBoundingClientRect();
                    if (r.width >= 40 && r.height >= 12 && r.top > 0) return el;
                }
            } catch (e) {}
        }
        // 会话 URL：主栏底部最靠下的大块输入区（含 input / 中文「私信」占位壳）
        try {
            if (isDmConversationPage() || isMessagesPage()) {
                var col = document.querySelector('[data-testid="primaryColumn"]')
                    || document.querySelector('main[role="main"]')
                    || document.body;
                var cands = __dmQueryAllDeep(col, DM_EDITABLE_SEL + ', div[data-testid*="composer" i], div[data-testid*="Composer"]');
                var best = null;
                var bestTop = -1;
                var minTop = (window.innerHeight || 600) * 0.35;
                for (var k = 0; k < cands.length; k++) {
                    var c = cands[k];
                    try {
                        if (c.closest('[data-testid="tweetTextarea_0"], [data-testid="SearchBox"], header[role="banner"]')) continue;
                    } catch (eC) {}
                    var rc = c.getBoundingClientRect();
                    if (rc.top < minTop || rc.width < 80 || rc.height < 20) continue;
                    if (rc.top >= bestTop) {
                        best = c;
                        bestTop = rc.top;
                    }
                }
                if (best) return best;
                var phShell = findDmComposerPlaceholderShell();
                if (phShell) return phShell;
            }
        } catch (eB) {}
        return null;
    }

    /** 点一下壳，催 X 挂上真正 textarea/contenteditable（中文「私信」常先出壳） */
    function wakeDmComposerShell() {
        var shell = findDmComposerShell();
        if (!shell) return false;
        try {
            shell.click();
            if (shell.focus) shell.focus();
            var mouth = __dmMouthVisible(shell);
            if (mouth && mouth !== shell) {
                try { mouth.click(); mouth.focus(); } catch (eM) {}
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function findBottomAwakeningTarget() {
        // 0. 现网优先：原生 textarea / input（X 偶发从 ce 迁到 textarea 或 input）
        try {
            var taSels = [
                '[data-testid="dm-composer-textarea"]',
                'textarea[data-testid*="dm-composer" i]',
                'textarea[data-testid*="dmComposer" i]',
                'textarea[placeholder*="私信"]',
                'textarea[placeholder*="Message" i]',
                'textarea[placeholder*="Unencrypted" i]',
                'textarea[aria-label*="私信"]',
                'textarea[aria-label*="Message" i]',
                'input[placeholder*="私信"]',
                'input[placeholder*="Message" i]',
                'input[placeholder*="Unencrypted" i]',
                'input[aria-label*="私信"]',
                'input[aria-label*="Message" i]'
            ];
            for (var ti = 0; ti < taSels.length; ti++) {
                var tas = __dmQueryAllDeep(document, taSels[ti]);
                for (var tj = 0; tj < tas.length; tj++) {
                    var mouthT = __dmMouthVisible(tas[tj]);
                    if (mouthT) return mouthT;
                }
            }
        } catch (eTa) {}

        // A. 官方 composer wrapper → 钻口
        var wrapSels = [
            '[data-testid="dmComposerTextInputRichTextInputContainer"]',
            '[data-testid="dmComposerTextInput"]',
            '[data-testid="dm-composer-form"]',
            '[data-testid="dm-composer-container"]',
            'form[data-testid*="dmComposer" i]',
            '[data-testid*="dmComposerTextInput" i]'
        ];
        for (var wi = 0; wi < wrapSels.length; wi++) {
            try {
                var wraps = __dmQueryAllDeep(document, wrapSels[wi]);
                for (var wj = 0; wj < wraps.length; wj++) {
                    var mouthA = __dmMouthVisible(wraps[wj]);
                    if (mouthA) return mouthA;
                }
            } catch (eW) {}
        }

        // B. 会话页：主栏底部任意可编辑口（含 input[type=text]）
        try {
            if (isDmConversationPage() || isMessagesPage()) {
                var col = document.querySelector('[data-testid="primaryColumn"]')
                    || document.querySelector('main[role="main"]')
                    || document.body;
                var nodes = __dmQueryAllDeep(col, DM_EDITABLE_SEL);
                var best = null;
                var bestTop = -1;
                var minTop = (window.innerHeight || 600) * 0.35;
                for (var i = 0; i < nodes.length; i++) {
                    var mouthB = __dmMouthVisible(nodes[i]);
                    if (!mouthB) continue;
                    try {
                        if (mouthB.closest('[data-testid="tweetTextarea_0"], [data-testid="toolBar"], [data-testid="SearchBox"], header[role="banner"]')) {
                            continue;
                        }
                    } catch (eEx) {}
                    var r = mouthB.getBoundingClientRect();
                    if (r.top < minTop || r.width < 40) continue;
                    if (r.top >= bestTop) {
                        best = mouthB;
                        bestTop = r.top;
                    }
                }
                if (best) {
                    try { console.log('[DM-INPUT] 会话页结构寻口 ok', best.tagName, best.type || ''); } catch (eL) {}
                    return best;
                }
            }
        } catch (eB) {}

        // C. 面板内
        try {
            var panel = document.querySelector(
                '[data-testid="dm-conversation-panel"], [data-testid="dm-container"], [data-testid="dm-conversation-content"], [data-testid="DMDrawer"], [data-testid="DmActivityContainer"]'
            );
            if (panel) {
                var pNodes = __dmQueryAllDeep(panel, DM_EDITABLE_SEL);
                var pBest = null;
                var pTop = -1;
                for (var pi = 0; pi < pNodes.length; pi++) {
                    var mouthC = __dmMouthVisible(pNodes[pi]);
                    if (!mouthC) continue;
                    var rp = mouthC.getBoundingClientRect();
                    if (rp.width < 30 || rp.height < 8) continue;
                    if (rp.top >= pTop) {
                        pBest = mouthC;
                        pTop = rp.top;
                    }
                }
                if (pBest) return pBest;
            }
        } catch (eP) {}

        try {
            var phN = 0;
            try {
                var hits = document.querySelectorAll('[placeholder*="私信"], [aria-label*="私信"], [data-placeholder*="私信"]');
                phN = hits.length;
            } catch (ePh) {}
            console.log(
                '[DM-INPUT] 未找到输入口 url=',
                (location.pathname || ''),
                'textarea=',
                document.querySelectorAll('textarea').length,
                'inputText=',
                document.querySelectorAll('input:not([type]), input[type="text"]').length,
                'ce=',
                document.querySelectorAll('[contenteditable]').length,
                'roleTb=',
                document.querySelectorAll('[role="textbox"]').length,
                'ph私信=',
                phN,
                'shell=',
                !!findDmComposerShell(),
                'conv=',
                !!isDmConversationPage()
            );
        } catch (eLog) {}
        return null;
    }

    /** 读输入框占位（仅诊断/can_send 辅助） */
    function __dmComposerPlaceholderText(el) {
        if (!el) return '';
        try {
            var parts = [];
            parts.push(el.getAttribute('placeholder') || '');
            parts.push(el.getAttribute('aria-label') || '');
            parts.push(el.getAttribute('data-placeholder') || '');
            var p = el.parentElement;
            if (p) {
                parts.push(p.getAttribute('data-placeholder') || '');
                parts.push(p.getAttribute('aria-label') || '');
            }
            return parts.join(' ');
        } catch (e) {
            return '';
        }
    }

    /** 用户铁律：会话面板内固定正向标记 → can_send / hard_closed / pending */
    function getDmConversationPanelRoot() {
        try {
            // 4.6.126：X 已把会话面板整体移入 open shadowRoot，必须穿透查找
            var hits = __dmQueryAllDeep(document,
                '[data-testid="dm-conversation-panel"], [data-testid="dm-container"], [data-testid="dm-conversation-content"], [data-testid="DMDrawer"], [data-testid="DmActivityContainer"]');
            return hits && hits.length ? hits[0] : null;
        } catch (e) {
            return null;
        }
    }

    function __dmElVisible(el) {
        if (!el) return false;
        try {
            if (el.disabled) return false;
            if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * 4.1.59/4.1.63 可发三态（只认会话面板内正向标记，禁止「找不到框」定罪）
     * can_send: dmComposer / placeholder「Unencrypted message」
     * hard_closed: closed inbox / 只读 / Use X Number …
     * pending: 都未命中 → 等待/deferred，禁止永久拉黑
     */
    /** 只读会话文案（简繁英日）；命中即 hard_closed / 立刻拉黑 */
    var DM_READ_ONLY_RE = /This conversation is currently in read-only|read-only mode|此对话当前处于只读模式|此對話目前處於唯讀模式|当前处于只读|目前處於唯讀|只读模式|唯讀模式|会話は現在読み取り専用/i;

    function pageLooksDmReadOnly(text) {
        try {
            var t = text != null ? String(text) : '';
            if (!t) {
                try { t = String((document.body && document.body.innerText) || ''); } catch (eB) { t = ''; }
                // 4.6.126：DM 面板在 shadow 内时 body.innerText 漏只读文案，补穿透收集
                try {
                    if (!DM_READ_ONLY_RE.test(t) && isDmPath(window.location.pathname || '')) {
                        var tDeep = __dmCollectTextDeep(document.body, 8000);
                        if (tDeep) t = (t ? t + ' ' : '') + tDeep;
                    }
                } catch (eBd) {}
            }
            if (t.length > 8000) t = t.slice(-8000);
            return DM_READ_ONLY_RE.test(t);
        } catch (e) { return false; }
    }

    function classifyDmSendability() {
        var canSendMarkers = [];
        var hardClosedMarkers = [];
        var panel = null;
        try { panel = getDmConversationPanelRoot(); } catch (eP) { panel = null; }
        var hasPanel = !!panel;
        var composerTestid = '';
        var hasRealComposer = false;

        function pushCan(m) {
            if (m && canSendMarkers.indexOf(m) < 0) canSendMarkers.push(m);
        }
        function pushHard(m) {
            if (m && hardClosedMarkers.indexOf(m) < 0) hardClosedMarkers.push(m);
        }

        // 4.6.69：整页只读文案优先定罪（不依赖 isDmConversationPage）
        var readOnlyLocked = false;
        try {
            if (pageLooksDmReadOnly()) {
                pushHard('text:read_only');
                readOnlyLocked = true;
            }
        } catch (eRo0) {}

        // —— 真 composer testid（有框即可发；只读/禁用框不算 can_send） ——
        var scope = panel || document;
        try {
            // 4.6.126：composer 可能在 shadow 内，穿透查找（保持原优先级）
            var preferred = __dmQueryAllDeep(scope, '[data-testid="dmComposerTextInput"]')[0]
                || __dmQueryAllDeep(scope, '[data-testid="dm-composer-textarea"]')[0]
                || __dmQueryAllDeep(scope, '[data-testid="dmComposerTextInputRichTextInputContainer"]')[0];
            var mouthPref = preferred ? (__dmMouthVisible(preferred) || preferred) : null;
            if (mouthPref && __dmElVisible(mouthPref)) {
                var deadMouth = false;
                try {
                    if (mouthPref.disabled || mouthPref.getAttribute('aria-disabled') === 'true'
                        || mouthPref.getAttribute('contenteditable') === 'false'
                        || mouthPref.getAttribute('aria-readonly') === 'true') {
                        deadMouth = true;
                    }
                } catch (eDm) { deadMouth = false; }
                if (readOnlyLocked || deadMouth) {
                    pushHard(deadMouth ? 'composer:disabled_readonly' : 'text:read_only');
                } else if (!panel || isDmComposerInPanel(mouthPref) || isDmConversationPage()) {
                    hasRealComposer = true;
                    composerTestid = String((preferred && preferred.getAttribute && preferred.getAttribute('data-testid')) || 'dmComposer');
                    pushCan('testid:' + composerTestid);
                }
            }
        } catch (ePref) {}

        var scanRoot = panel;
        if (!scanRoot) {
            try {
                if (isDmConversationPage() || isDmPath(window.location.pathname || '')) {
                    scanRoot = document.querySelector('[data-testid="primaryColumn"]')
                        || document.querySelector('main[role="main"]')
                        || document.body;
                }
            } catch (eSc) { scanRoot = null; }
        }
        if (scanRoot) {
            var blob = '';
            try { blob = String(scanRoot.innerText || scanRoot.textContent || ''); } catch (eB) { blob = ''; }
            // 4.6.126：innerText 不透 shadow——「收件箱已关闭 / X 安全码 / 只读」在 shadow 内时补穿透收集
            try {
                if (!/has a closed inbox|\bclosed inbox\b|收件箱已关闭|关闭了收件箱|私信收件箱已关闭|受信トレイが閉じ|只读|唯讀|read-only|Use X Number|安全码/i.test(blob)) {
                    var blobDeep = __dmCollectTextDeep(scanRoot, 6000);
                    if (blobDeep) blob = blob ? (blob + ' ' + blobDeep) : blobDeep;
                }
            } catch (eBd) {}
            if (blob.length > 6000) blob = blob.slice(-6000);
            if (/has a closed inbox|\bclosed inbox\b|收件箱已关闭|关闭了收件箱|私信收件箱已关闭|受信トレイが閉じ/i.test(blob)) {
                pushHard('text:closed_inbox');
            }
            if (pageLooksDmReadOnly(blob)
                || /You can.?t message|Can.?t message this user|Unable to message|Cannot send messages|消息发送失败|无法发送私信|このユーザーにメッセージを送れ|メッセージを送信できません/i.test(blob)) {
                pushHard('text:cant_message');
            }
            // 无真框时：doesn't follow / must verify / Use X Number → 硬封闭
            if (!hasRealComposer) {
                if (/doesn't follow you|does not follow you|未关注你|フォローされていません/i.test(blob)) {
                    pushHard('text:not_follower');
                }
                if (/You must be verified|must be verified|要验证/i.test(blob)) {
                    pushHard('text:must_verified');
                }
                try {
                    var btns = __dmQueryAllDeep(scanRoot, '[role="button"], button, div[role="button"]');
                    var bLim = Math.min(btns.length, 80);
                    for (var bi = 0; bi < bLim; bi++) {
                        var bt = String(btns[bi].innerText || btns[bi].textContent || '').replace(/\s+/g, ' ').trim();
                        if (!bt || bt.length > 40) continue;
                        if (/^Use X Number$/i.test(bt) || (/Use X Number/i.test(bt) && bt.length <= 24)
                            || /使用 X 安全码|^X 安全码$|Xナンバー/i.test(bt)) {
                            if (__dmElVisible(btns[bi])) {
                                pushHard('btn:Use_X_Number');
                                break;
                            }
                        }
                    }
                } catch (eBtn) {}
            }
        }

        if (hardClosedMarkers.length) {
            return {
                verdict: 'hard_closed',
                canSendMarkers: canSendMarkers,
                hardClosedMarkers: hardClosedMarkers,
                hasPanel: hasPanel,
                composerTestid: composerTestid
            };
        }
        if (canSendMarkers.length) {
            return {
                verdict: 'can_send',
                canSendMarkers: canSendMarkers,
                hardClosedMarkers: hardClosedMarkers,
                hasPanel: hasPanel,
                composerTestid: composerTestid
            };
        }

        // —— can_send：仅认输入框自身 placeholder/aria（禁止 near 吃到页头「🔒 Unencrypted」） ——
        // 4.3.3：无 dm-container 时仍扫主栏（中文「私信」占位）
        var phRoot = panel || scanRoot || null;
        if (!phRoot) {
            try {
                if (isDmConversationPage()) {
                    phRoot = document.querySelector('[data-testid="primaryColumn"]')
                        || document.querySelector('main[role="main"]');
                }
            } catch (ePhR) { phRoot = null; }
        }
        if (phRoot) {
            try {
                var phEls = phRoot.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea, input[type="text"]');
                for (var pi = 0; pi < phEls.length; pi++) {
                    var elp = phEls[pi];
                    if (!__dmElVisible(elp)) continue;
                    if (!isDmComposerInPanel(elp)) continue;
                    var ph = __dmComposerPlaceholderText(elp);
                    if (/Unencrypted message|Encrypted message|Start a message|メッセージを入力|私信|发消息|Start a DM/i.test(ph)) {
                        pushCan('placeholder:message');
                        break;
                    }
                }
            } catch (ePh) {}
        }

        if (!canSendMarkers.length) {
            try {
                var fb = findBottomAwakeningTarget();
                if (fb && __dmElVisible(fb) && (!panel || isDmComposerInPanel(fb))) {
                    pushCan('findBottomAwakeningTarget');
                    try {
                        composerTestid = String((fb.getAttribute && fb.getAttribute('data-testid')) || composerTestid || '');
                    } catch (eTid) {}
                }
            } catch (eFb) {}
        }

        if (canSendMarkers.length) {
            return {
                verdict: 'can_send',
                canSendMarkers: canSendMarkers,
                hardClosedMarkers: hardClosedMarkers,
                hasPanel: hasPanel,
                composerTestid: composerTestid
            };
        }

        return {
            verdict: 'pending',
            canSendMarkers: canSendMarkers,
            hardClosedMarkers: hardClosedMarkers,
            hasPanel: hasPanel,
            composerTestid: composerTestid
        };
    }

    /** 有固定可发标记 = 可发送 */
    function hasSendableDmComposer() {
        try {
            return classifyDmSendability().verdict === 'can_send';
        } catch (e) {
            return false;
        }
    }

    /** 硬封闭正向标记命中 = 不可发（pending/加载中 ≠ 不可发） */
    function detectDmSendUnavailable() {
        try {
            return classifyDmSendability().verdict === 'hard_closed';
        } catch (e) {
            return false;
        }
    }

    /** 控制台：await __sgDmSendability() */
    function debugDmSendability() {
        var c = null;
        try { c = classifyDmSendability(); } catch (e) {
            return { error: String(e && e.message || e) };
        }
        return {
            verdict: c.verdict,
            canSendMarkers: c.canSendMarkers || [],
            hardClosedMarkers: c.hardClosedMarkers || [],
            hasPanel: !!c.hasPanel,
            composerTestid: c.composerTestid || '',
            note: c.verdict === 'can_send'
                ? '可发：应破冰/跟进'
                : (c.verdict === 'hard_closed' ? '硬封闭：应永久跳过' : '未定：只等框/deferred，禁止永久拉黑')
        };
    }

    /**
     * 4.1.55 真空会话：有可发框 + 无任何真气泡（对方灰泡或我方蓝泡都没有）。
     * 仅有我方破冰、对方未回 → 非真空（禁止再破冰）；禁止宽扫判空。
     */
    function isBlankDmThread() {
        try {
            if (!hasSendableDmComposer()) return false;
            var bodies = null;
            try { bodies = __collectDmBodyTexts(); } catch (eB) { bodies = null; }
            if (!bodies) return true;
            // 有我方话术正文或对方非壳正文 → 非真空
            if ((bodies.own && bodies.own.length) || (bodies.peer && bodies.peer.length)) return false;
            if (bodies.all && bodies.all.length) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 会话内是否已有我方正文（话术池命中，不认气泡几何） */
    function hasOwnDmBubbles() {
        try {
            var bodies = __collectDmBodyTexts();
            return !!(bodies.own && bodies.own.length);
        } catch (e) {
            return false;
        }
    }

    /**
     * 4.1.58：DOM 已有我方破冰/蓝泡但库缺 iceSentAt → 补写，禁止再破冰。
     * @returns {boolean} 是否已认定「破过冰」
     */
    function ensureIceRecordFromDom(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return false;
        try {
            var db = loadTargetDB();
            var e = db[handle] || {};
            if (e.iceSentAt) {
                if ((parseInt(e.round, 10) || 0) < 1) {
                    e.round = Math.max(1, parseInt(e.round, 10) || 0);
                    db[handle] = e;
                    saveTargetDB(db);
                }
                return true;
            }
            var own = false;
            try { own = hasOwnDmBubbles(); } catch (eO) { own = false; }
            var sessIced = false;
            try { sessIced = sessionStorage.getItem('dan_iced_' + handle) === '1'; } catch (eS) {}
            if (!own && !sessIced) return false;
            if (!db[handle]) db[handle] = { round: 0, firstSeen: Date.now(), lastDM: null };
            db[handle].iceSentAt = Date.now();
            db[handle].lastDM = db[handle].lastDM || Date.now();
            db[handle].round = Math.max(1, parseInt(db[handle].round, 10) || 0);
            saveTargetDB(db);
            try { sessionStorage.setItem('dan_iced_' + handle, '1'); } catch (eS2) {}
            try {
                reportSessionVerdict('ice_healed_from_dom', {
                    target: handle,
                    round: db[handle].round,
                    detail: own ? 'own_bubbles' : 'session_lock'
                });
            } catch (eV) {}
            console.log('[私信] DOM/会话已破冰，补写 iceSentAt @' + handle);
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 资料页私信按钮：testid + 可见 Message/私信 aria（防 X 改 DOM 误杀 no_dm） */
    function findProfileDmButton() {
        try {
            var byId = document.querySelector('[data-testid="sendDMFromProfile"]');
            if (byId) return byId;
        } catch (e0) {}
        try {
            var nodes = document.querySelectorAll('[role="button"], button, a[role="link"], div[role="button"]');
            var lim = Math.min(nodes.length, 80);
            for (var i = 0; i < lim; i++) {
                var el = nodes[i];
                if (!el) continue;
                var vis = false;
                try { vis = !!(el.offsetParent !== null || (el.getClientRects && el.getClientRects().length)); } catch (eV) {}
                if (!vis) continue;
                var al = String(el.getAttribute('aria-label') || el.getAttribute('title') || '');
                var tid = String(el.getAttribute('data-testid') || '');
                if (tid === 'sendDMFromProfile') return el;
                // 精确：Message / 私信 / 訊息 / メッセージ，排除 Messages 列表入口、通知铃
                if (CHAT_I18N.dmAria.test(al.trim())) return el;
                if (/\bMessage\b/i.test(al) && !/\bMessages\b/i.test(al) && !/Notification|通知|Follow|关注|關注|フォロー/i.test(al)) return el;
                if (/(私信|訊息|メッセージ|ダイレクト)/i.test(al) && !/(通知|Notifications)/i.test(al)) return el;
            }
        } catch (e1) {}
        return null;
    }

    function threadSafeSend(inputElement, text) {
        // 兼容旧调用：异步确认版见 threadSafeSendAndConfirm
        threadSafeSendAndConfirm(inputElement, text).catch(function () {});
    }

    function __dmSleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function __msgNeedle(text) {
        var s = String(text || '').replace(/\s+/g, ' ').trim();
        if (s.length > 28) s = s.slice(0, 28);
        return s;
    }

    /** 发送确认用多针：全文头、去 emoji、首行 —— 降低「已上屏仍 no_bubble」黄条误报 */
    function __msgNeedleVariants(text) {
        var out = [];
        function push(s) {
            s = String(s || '').replace(/\s+/g, ' ').trim();
            try { s = s.normalize('NFC'); } catch (eN) {}
            if (s.length > 28) s = s.slice(0, 28);
            if (s.length < 4) return;
            if (out.indexOf(s) < 0) out.push(s);
        }
        push(__msgNeedle(text));
        // 去代理对 emoji + 常见符号 emoji
        push(String(text || '')
            .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
            .replace(/[\u2600-\u27BF]/g, '')
            .replace(/\s+/g, ' '));
        push(String(text || '').split(/\r?\n/)[0] || '');
        var ascii = String(text || '').replace(/[^\u0020-\u007E\u3040-\u30FF\u4E00-\u9FFF、。！？〜ー]/g, ' ');
        push(ascii);
        // 纯日文片段（去掉空白后前 12 字）— 催加短句保底
        var jp = String(text || '').replace(/[^\u3040-\u30FF\u4E00-\u9FFF]/g, '');
        if (jp.length >= 4) push(jp.slice(0, 12));
        return out;
    }

    /**
     * 会话气泡区域（排除输入框）。
     * 4.3.12：与寻口同源 — 优先 getDmMessageFallbackRoot / getDmMessageListRoot，
     * 禁再只靠旧 dm-conversation-* testid（中文壳常无这些节点 → 已上屏仍 no_bubble）。
     */
    function __getDmMessageListRoot() {
        try {
            var root = null;
            try { root = getDmMessageFallbackRoot(); } catch (eFb) { root = null; }
            if (!root) {
                try { root = getDmMessageListRoot(); } catch (eL) { root = null; }
            }
            if (!root) {
                try { root = getDmMessageScanRoot(); } catch (eS) { root = null; }
            }
            if (root && root !== document.body) return root;
            // 结构兜底：从输入口往上找不含 composer 的消息区
            var composer = null;
            try { composer = findBottomAwakeningTarget(); } catch (eC) { composer = null; }
            if (composer && composer.closest) {
                var panel = composer.closest('[role="main"], [data-testid="primaryColumn"], main') || composer.parentElement;
                if (panel) {
                    var best = null;
                    var bestScore = 0;
                    // 只扫带 aria/testid 的块，禁全量 div（大树 query 易拖垮渲染进程）
                    var nodes = panel.querySelectorAll(
                        'section, [aria-label], [data-testid="dm-conversation-content"], [data-testid="dm-conversation-scroller"], [data-testid="message-list"], [data-testid="message-list-container"]'
                    );
                    for (var i = 0; i < Math.min(nodes.length, 40); i++) {
                        var n = nodes[i];
                        if (!n || n.contains(composer)) continue;
                        var r = n.getBoundingClientRect();
                        if (r.height < 60 || r.width < 120) continue;
                        var hasMsg = !!(n.querySelector(
                            '[data-testid^="message-text-"], [data-testid="messageText"], [data-testid="messageEntry"], [data-testid="messageBubble"], [data-testid^="message-"]'
                        ));
                        var score = (hasMsg ? 5 : 0) + (n.scrollHeight > n.clientHeight + 10 ? 2 : 0) + Math.min(r.height / 120, 4);
                        if (score > bestScore) { best = n; bestScore = score; }
                    }
                    if (best && bestScore >= 5) return best;
                }
            }
            return root || null;
        } catch (eR) { return null; }
    }

    function __normalizeDmScanText(s) {
        s = String(s || '');
        try { s = s.normalize('NFC'); } catch (eN) {}
        return s
            .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
            .replace(/[\u2600-\u27BF]/g, '')
            // 波浪号统一（话术「3万〜」vs DOM「3万～」）
            .replace(/[\u301C\uFF5E\u007E\u2053]/g, '\u301C')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 确认轮询内短缓存扫根，避免每 500ms 全页找根 + clone 大树（易 Aw Snap）
    var __dmNeedleRootCache = { el: null, at: 0 };

    function __countNeedleInDmMessages(needle) {
        if (!needle || needle.length < 4) return 0;
        var now = Date.now();
        var root = (__dmNeedleRootCache.el && (now - __dmNeedleRootCache.at) < 2500)
            ? __dmNeedleRootCache.el
            : null;
        if (!root || !root.isConnected) {
            root = __getDmMessageListRoot();
            __dmNeedleRootCache = { el: root, at: now };
        }
        if (!root) return 0;
        var text = '';
        // 优先叶子气泡（轻量）；无叶子再读 root.innerText（禁 cloneNode 大树）
        try {
            var leaves = root.querySelectorAll(
                '[data-testid^="message-text-"], [data-testid="messageText"], [data-testid="messageBubble"], [data-testid="messageEntry"]'
            );
            if (leaves && leaves.length) {
                var parts = [];
                var lim = Math.min(leaves.length, 40);
                for (var li = Math.max(0, leaves.length - lim); li < leaves.length; li++) {
                    var leaf = leaves[li];
                    try { if (isDmComposerNode(leaf)) continue; } catch (eComp) {}
                    var lt = '';
                    try { lt = getDmMessageText(leaf); } catch (eT) {
                        lt = String(leaf.innerText || leaf.textContent || '');
                    }
                    if (lt) parts.push(lt);
                }
                text = parts.join('\n');
            }
        } catch (eLeaf) {}
        if (!text) {
            try {
                text = String(root.innerText || root.textContent || '');
            } catch (eTx) { text = ''; }
        }
        if (!text) return 0;
        var normHay = __normalizeDmScanText(text);
        var normNeedle = __normalizeDmScanText(needle);
        var c = 0;
        var idx = 0;
        while (idx < text.length) {
            var at = text.indexOf(needle, idx);
            if (at < 0) break;
            c++;
            idx = at + needle.length;
            if (c > 20) break;
        }
        if (c === 0 && normNeedle.length >= 4 && normHay) {
            idx = 0;
            while (idx < normHay.length) {
                var at2 = normHay.indexOf(normNeedle, idx);
                if (at2 < 0) break;
                c++;
                idx = at2 + normNeedle.length;
                if (c > 20) break;
            }
        }
        return c;
    }

    function __countNeedleInDmUi(needle) {
        return __countNeedleInDmMessages(needle);
    }

    function __composerLen(el) {
        if (!el) return 0;
        if (el.tagName === 'TEXTAREA' || el.value !== undefined) {
            return String(el.value || '').replace(/\s+/g, ' ').trim().length;
        }
        return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().length;
    }

    /** 会话/本地是否已有低龄婉拒证据（禁止再走广告补发） */
    function conversationHasRejectEvidence(handle) {
        handle = normalizeChatHandle(handle);
        try {
            var entry = loadTargetDB()[handle] || {};
            if (entry.rejectSentAt || entry.blockedAt) return true;
            if ((entry.round || 0) >= 3 && entry.done) return true;
            try {
                var rejectDB = getDB('dan_reject_users');
                if (rejectDB && rejectDB.has && rejectDB.has(handle)) return true;
            } catch (eR) {}
            var root = __getDmMessageListRoot();
            var text = root ? String(root.innerText || root.textContent || '') : '';
            if (!text) {
                try {
                    var alt = getDmConversationRoot();
                    text = alt ? String(alt.innerText || alt.textContent || '') : '';
                } catch (eAlt) {}
            }
            if (entry.lastRejectText) {
                var n = __msgNeedle(entry.lastRejectText);
                if (n && text.indexOf(n) >= 0) return true;
            }
            // 仅认本方婉拒句式，禁止单凭「25歳以上」误杀（冰破/DNA 也可能出现该词）
            if (/ごめんね[\s\S]{0,40}25歳以上|25歳以上[\s\S]{0,40}また機会があれば|25歳以上の大人の方とゆっくり/i.test(text)
                && !/line\.me\/R\/ti\/p\//i.test(text)) {
                return true;
            }
            return false;
        } catch (e) { return false; }
    }

    function markAgeRejected(handle, age) {
        handle = normalizeChatHandle(handle);
        if (!handle) return;
        try {
            setUserRound(handle, 3);
            var db = loadTargetDB();
            if (db[handle]) {
                db[handle].done = true;
                db[handle].rejectSentAt = db[handle].rejectSentAt || Date.now();
                db[handle].blockedAt = db[handle].blockedAt || Date.now();
                db[handle].chatClosedAt = db[handle].chatClosedAt || Date.now();
                db[handle].closedWhy = 'age_reject';
                db[handle].ageRoute = 'reject';
                if (age != null) db[handle].rejectAge = age;
                saveTargetDB(db);
            }
        } catch (e1) {}
        try { saveToDB('dan_reject_users', handle); } catch (e2) {}
        try { followupQueueMark(handle, 'done', 'age_reject'); } catch (e3) {}
    }

    /** 对方明确拒绝继续 / 要拉黑 → 本地完结，禁止再发广告/催加 */
    function peerTextsIndicateStop(texts) {
        texts = texts || [];
        for (var i = 0; i < texts.length; i++) {
            var s = String(texts[i] || '');
            // 勿用裸「ブロック」（易误伤）；要完整拒绝对话意图
            if (/ブロックします|ブロックする|block\s*you|blocking\s*you|i'?m\s*blocking|もう話さない|二度と(連絡|メッセージ)|連絡しないで|やめろ|うるさい|通報(する|します)/i.test(s)) return true;
        }
        return false;
    }

    /**
     * 对方是同行/引流号：主动塞 LINE/色诱/性服务 → 本地完结，禁止再聊。
     * 只看对方气泡；本方推广链回显（链接壳）不算同行。
     */
    function peerTextsIndicateCompetitor(texts) {
        texts = texts || [];
        var ourLink = '';
        try { ourLink = String(getLiveLink() || '').replace(/^https?:\/\//i, '').trim(); } catch (eL) { ourLink = ''; }
        var joined = texts.join('\n');
        if (/性的なサービス|セック[〇オ]?|エロ配信|援交|パパ活/i.test(joined)) return true;
        for (var i = 0; i < texts.length; i++) {
            var s = String(texts[i] || '');
            if (!s) continue;
            try { if (isLinkShellText(s)) continue; } catch (eShell) {}
            if (/LINE\s*交換|LINEを交換|友だちになりませんか|私の\s*LINE|LINE\s*ID\s*[:：]|追加お待ちしています/i.test(s)) return true;
            var m = s.match(/line\.me\/[^\s<>"']+/i);
            if (m) {
                var their = String(m[0] || '').replace(/^https?:\/\//i, '');
                if (ourLink && (their.indexOf(ourLink) >= 0 || ourLink.indexOf(their) >= 0)) continue;
                // 对方气泡里出现「非本方」LINE 链 → 同行引流
                return true;
            }
        }
        return false;
    }

    function markCompetitorBlocked(handle, reason) {
        markPeerBlocked(handle, reason || 'competitor');
        try { sendLogToNAS(handle, 'SKIP_COMPETITOR', reason || 'competitor'); } catch (eNas) {}
        try {
            reportSessionVerdict('gate_blocked', {
                target: handle,
                round: getUserRound(handle),
                gate_reason: 'competitor',
                detail: String(reason || '')
            });
        } catch (eV) {}
    }

    function markPeerBlocked(handle, reason) {
        handle = normalizeChatHandle(handle);
        if (!handle) return;
        try {
            setUserRound(handle, 3);
            var db = loadTargetDB();
            if (!db[handle]) db[handle] = { round: 3, firstSeen: Date.now(), lastDM: null };
            db[handle].done = true;
            db[handle].blockedAt = Date.now();
            db[handle].blockReason = String(reason || 'blocked');
            saveTargetDB(db);
        } catch (e1) {}
        try { saveToDB('dan_reject_users', handle); } catch (e2) {}
        try {
            reportSessionVerdict('gate_blocked', {
                target: handle,
                round: getUserRound(handle),
                gate_reason: 'peer_blocked',
                detail: String(reason || '')
            });
        } catch (e3) {}
        try {
            opsDmRecord(handle, 3, '[peer_blocked]', 'success').catch(function () {});
        } catch (e4) {}
        console.warn('[私信] 标记不可再聊 @' + handle + ' reason=' + reason);
    }

    /**
     * 清理超过 N 小时未回复的目标，避免挤占队列空间。
     * 触发时机：私信启动时每日一次。
     * 规则：round=1 或 round=2，未 done，lastDM 超过 staleMs → 拉黑。
     */
    function pruneStaleNoReply(staleMs, maxPerRun) {
        staleMs = Number(staleMs) || 48 * 60 * 60 * 1000;
        maxPerRun = Number(maxPerRun) || 200;
        var now = Date.now();
        var pruned = 0;
        var db;
        try {
            db = loadTargetDB();
        } catch (eDb) { return 0; }
        if (!db || typeof db !== 'object') return 0;
        var handles = Object.keys(db);
        for (var i = 0; i < handles.length && pruned < maxPerRun; i++) {
            try {
                var h = handles[i];
                var entry = db[h];
                if (!entry || typeof entry !== 'object') continue;
                if (entry.done) continue;
                if (entry.blockedAt) continue;
                var r = Number(entry.round) || 0;
                if (r < 1) continue; // 没发过私信的不处理
                if (r >= 3) continue; // 已到最高轮次的也不处理
                var lastDm = Number(entry.lastDM) || Number(entry.iceSentAt) || 0;
                if (!lastDm) continue;
                if (now - lastDm < staleMs) continue;
                // 超过 48h 未回复 → 拉黑（台账 reason 固定便于 OPS 对账）
                markPeerBlocked(h, 'stale_48h_no_reply');
                try { iceQueueMark(h, 'skipped', 'stale_48h_no_reply', 'reject'); } catch (eIq) {}
                pruned++;
            } catch (ePr) {}
        }
        if (pruned > 0) {
            console.log('[私信] 清理 ' + pruned + ' 个 ' + Math.round(staleMs / 3600000) + 'h 未回复目标');
            try { showToast('🧹 清理 ' + pruned + ' 个超时未回复目标', '#1d9bf0', 2000); } catch (eT) {}
        }
        return pruned;
    }

    function pruneStaleIfNeeded() {
        var STALE_MS = STALE_NO_REPLY_MS;
        var PRUNE_KEY = 'dan_stale_prune_day';
        var today = '';
        try {
            today = new Date().toISOString().slice(0, 10);
            var last = localStorage.getItem(PRUNE_KEY) || '';
            if (last === today) return 0;
            localStorage.setItem(PRUNE_KEY, today);
        } catch (eK) { return 0; }
        try {
            return pruneStaleNoReply(STALE_MS, 300);
        } catch (e) {
            console.warn('[私信] 清理超时目标失败', e);
            return 0;
        }
    }

    /**
     * 无法私信（无输入框 / Use X Number 硬门）→ 永久拉黑 + 队列 skipped，本趟立刻走人，禁止再点进。
     */
    function finalizeUnsendablePeer(handle, reason) {
        handle = normalizeChatHandle(handle);
        reason = String(reason || 'x_number_gate');
        if (!handle) return false;
        try { markPeerBlocked(handle, reason); } catch (eB) {}
        try { iceQueueMark(handle, 'skipped', reason, 'reject'); } catch (eIq) {}
        try { markDmVerified(handle, reason); } catch (eVf) {}
        try { sessionStorage.removeItem('dan_composer_miss'); } catch (eM) {}
        try { sessionStorage.removeItem('dan_dm_ready_wait_' + handle); } catch (eW) {}
        showToast('⛔ 无法私信已拉黑 → 跳过 @' + handle, '#f85149', 2800);
        console.warn('[私信] 无法私信永久跳过 @' + handle + ' reason=' + reason);
        return true;
    }

    /**
     * 上线前清误杀：仅解开 blockReason 属于 UI/日上限误杀的人（不碰 age_reject / 真拉黑意图）。
     * 控制台：__sgClearFalseDmBlocks()
     */
    function clearFalseDmBlocks(opts) {
        opts = opts || {};
        var dry = !!opts.dryRun;
        // 不解开：ui_unavailable / x_number_gate / no_dm / protected / they_blocked_us（真无法私信）
        var FALSE_RE = /^(ops_dm_limit|dm_limit_reached|peer_stop_text)$/i;
        var db = {};
        try { db = loadTargetDB() || {}; } catch (e) { db = {}; }
        var cleared = [];
        var rejectDB = null;
        try { rejectDB = getDB('dan_reject_users'); } catch (eR) { rejectDB = null; }
        for (var h in db) {
            if (!Object.prototype.hasOwnProperty.call(db, h)) continue;
            var e = db[h];
            if (!e || !e.blockedAt) continue;
            var br = String(e.blockReason || '');
            if (!FALSE_RE.test(br)) continue;
            if (e.rejectSentAt || e.closedWhy === 'age_reject') continue;
            cleared.push({ handle: h, blockReason: br });
            if (dry) continue;
            delete e.blockedAt;
            delete e.blockReason;
            e.done = false;
            if ((e.round || 0) >= 3 && !e.adSentAt && !e.kickSentAt) {
                e.round = e.iceSentAt ? 1 : 0;
            }
            try {
                if (rejectDB && rejectDB.delete) rejectDB.delete(h);
                else if (rejectDB && rejectDB.has && rejectDB.has(h)) {
                    // Set-like
                    try { rejectDB.delete(h); } catch (eDel) {}
                }
            } catch (eRj) {}
            try {
                var raw = localStorage.getItem('dan_reject_users');
                if (raw) {
                    var arr = JSON.parse(raw);
                    if (Array.isArray(arr)) {
                        arr = arr.filter(function (x) { return normalizeChatHandle(x) !== normalizeChatHandle(h); });
                        localStorage.setItem('dan_reject_users', JSON.stringify(arr));
                    }
                }
            } catch (eLs) {}
        }
        if (!dry) {
            try { saveTargetDB(db); } catch (eS) {}
            try {
                if (typeof SgTelemetry !== 'undefined') {
                    SgTelemetry.emit('chat.false_block_cleared', { count: cleared.length, handles: cleared.slice(0, 40) });
                }
            } catch (eT) {}
        }
        console.log('[私信] clearFalseDmBlocks ' + (dry ? 'dryRun' : 'done') + ' n=' + cleared.length, cleared.slice(0, 20));
        try { showToast('🧹 已清误杀拉黑 ' + cleared.length + ' 人', '#1d9bf0', 2800); } catch (eTo) {}
        return { ok: true, dryRun: dry, count: cleared.length, items: cleared };
    }

    function noteSendFailStreak(handle, reason) {
        handle = normalizeChatHandle(handle);
        if (!handle) return 0;
        var key = 'dan_send_fail_' + handle;
        var n = 0;
        try {
            n = parseInt(sessionStorage.getItem(key) || '0', 10) || 0;
            if (reason === 'no_bubble' || reason === 'no_input' || reason === 'no_send_btn') n += 1;
            else n = 0;
            sessionStorage.setItem(key, String(n));
        } catch (e) { n = 0; }
        return n;
    }

    /** 会话里是否已有本方广告证据（链接或已确认气泡） */
    function conversationHasOwnAdEvidence(handle) {
        handle = normalizeChatHandle(handle);
        try {
            var entry = loadTargetDB()[handle] || {};
            if (entry.adBubbleOk || entry.adSentAt) return true;
            var root = __getDmMessageListRoot();
            var text = root ? String(root.innerText || root.textContent || '') : '';
            if (!text) {
                try {
                    var alt = getDmConversationRoot();
                    text = alt ? String(alt.innerText || alt.textContent || '') : '';
                } catch (eAlt) {}
            }
            if (entry.lastAdText) {
                var n = __msgNeedle(entry.lastAdText);
                if (n && (text.indexOf(n) >= 0 || __normalizeDmScanText(text).indexOf(__normalizeDmScanText(n)) >= 0)) return true;
            }
            var link = '';
            try { link = String(getLiveLink() || '').trim(); } catch (eL) { link = ''; }
            if (link && text.indexOf(link) >= 0) return true;
            if (link) {
                try {
                    var host = (link.match(/^https?:\/\/([^\/\s]+)/i) || [])[1];
                    if (host && host.length >= 6 && text.indexOf(host) >= 0) return true;
                } catch (eH) {}
            }
            // 推广链卡片/对方复读 line.me：会话里已有本方 LINE 推广痕迹即视为已发 AD
            if (/line\.me\/R\/ti\/p\//i.test(text)) return true;
            return false;
        } catch (e) { return false; }
    }

    function markAdBubbleOk(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return;
        try {
            var db = loadTargetDB();
            if (!db[handle]) return;
            db[handle].adBubbleOk = 1;
            db[handle].adSentAt = db[handle].adSentAt || Date.now();
            saveTargetDB(db);
        } catch (e) {}
    }

    function __ownBubbleSignature(raw) {
        return __normalizeDmScanText(raw).slice(0, 36);
    }

    function isDmTimestampLine(text) {
        var s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s) return false;
        return DM_TIMESTAMP_RE.test(s) || DM_WEEKDAY_TIME_RE.test(s) || DM_DATE_AT_RE.test(s);
    }

    /**
     * 4.3.16：按时间戳切开几轮气泡。
     * 时间戳 = 轮界（区分第几轮），不当正文、不认谁说的。
     * 轮内正文：∈话术池 → own；非壳其余 → peer。
     */
    function collectDmTurnsByTimestamp() {
        var turns = [];
        var cur = { time: '', own: [], peer: [], all: [] };
        function flush() {
            if (!cur.all.length && !cur.time) return;
            turns.push(cur);
            cur = { time: '', own: [], peer: [], all: [] };
        }
        var root = null;
        try { root = __getDmMessageListRoot(); } catch (eR) { root = null; }
        if (!root) {
            try { root = getDmMessageScanRoot(); } catch (eS) { root = null; }
        }
        if (!root) return turns;
        var handle = '';
        try { handle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (eH) {}
        // 4.6.33：递归遍历 DOM 同时抓消息叶子（几何分类）和时间戳行（切轮）
        // innerText 行流丢失几何位置；纯叶子选择器丢时间戳——递归遍历兼得
        var items = [];
        try {
            var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
            var node;
            while (node = walker.nextNode()) {
                if (isDmComposerNode(node)) continue;
                var tid = String((node.getAttribute && node.getAttribute('data-testid')) || '');
                // 消息叶子
                if (/^message-text-/i.test(tid) || tid === 'messageText') {
                    var msgText = getDmMessageText(node);
                    if (msgText) items.push({ text: msgText, leaf: node, isTime: false });
                    continue;
                }
                // 时间戳行：textContent 短且匹配时间戳模式
                var tc = String(node.textContent || '').replace(/\s+/g, ' ').trim();
                if (tc && tc.length < 40 && isDmTimestampLine(tc)) {
                    items.push({ text: tc, leaf: null, isTime: true });
                }
            }
        } catch (eScan) {}
        if (!items.length) return turns;
        for (var i = 0; i < items.length; i++) {
            var line = String(items[i].text || '').replace(/\s+/g, ' ').trim();
            if (!line) continue;
            if (items[i].isTime) {
                cur.time = line;
                flush();
                continue;
            }
            // 壳噪声跳过（但时间戳已在上面处理）
            try {
                if (isProfileUiLine(line) || isDmIdentityNoise(line, handle)) continue;
                if (/^(已读|Read|送达|Delivered|发送失败|Failed to send|无法送达|Message not delivered|Unencrypted|Encrypted)$/i.test(line)) continue;
            } catch (eN) {}
            if (line.length > 280) continue;
            cur.all.push(line);
            // 4.6.33：几何+DNA 混合分类
            var kind = classifyDmMessageOwnPeer(line, items[i].leaf);
            if (kind === 'own') cur.own.push(line);
            else cur.peer.push(line);
        }
        flush();
        return turns;
    }

    /**
     * 4.3.18：只取破冰之后的对方正文。
     * 主路径=按正文流：最后一条我方话术之后的非壳非话术正文（不要求中间必须有时间戳切轮）。
     * 时间戳切轮作辅助；同轮内「我方在前、对方在后」也算破冰后回复。
     */
    function collectPeerTextsAfterIceTurn() {
        var out = [];
        var seen = {};
        var handle = '';
        try { handle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (eH) {}

        function pushPeer(pt, turnTime) {
            if (!pt || seen[pt]) return;
            seen[pt] = 1;
            out.push({
                text: pt,
                source: null,
                entry: null,
                isReply: true,
                turnTime: turnTime || '',
                afterIce: true
            });
        }

        // A) DOM 叶子流（4.6.33）：几何+DNA 混合分类，最后一条 own 叶子之后的 peer
        //    替代 innerText 行流——innerText 丢失几何位置，话术撞车/引用会误判 own
        try {
            var rootA = null;
            try { rootA = __getDmMessageListRoot(); } catch (eR) { rootA = null; }
            if (!rootA) {
                try { rootA = getDmMessageScanRoot(); } catch (eS) { rootA = null; }
            }
            if (rootA) {
                var textLeaves = rootA.querySelectorAll('[data-testid^="message-text-"], [data-testid="messageText"]');
                var lastOwnIdx = -1;
                var classified = [];
                for (var i = 0; i < textLeaves.length; i++) {
                    var leaf = textLeaves[i];
                    if (!leaf || isDmComposerNode(leaf)) continue;
                    var text = getDmMessageText(leaf);
                    if (!text || text.length > 280) continue;
                    try {
                        if (isProfileUiLine(text) || isDmIdentityNoise(text, handle)) continue;
                        if (/^(已读|Read|送达|Delivered|发送失败|Failed to send|无法送达|Message not delivered|Unencrypted|Encrypted)$/i.test(text)) continue;
                    } catch (eN) {}
                    var kind = classifyDmMessageOwnPeer(text, leaf);
                    classified.push({ kind: kind, text: text });
                    if (kind === 'own') lastOwnIdx = classified.length - 1;
                }
                if (lastOwnIdx >= 0) {
                    for (var j = lastOwnIdx + 1; j < classified.length; j++) {
                        if (classified[j].kind === 'peer') pushPeer(classified[j].text, '');
                    }
                } else {
                    // 4.6.32 §C3-7 边界缺失上报
                    try {
                        var peerCnt = 0;
                        for (var pc = 0; pc < classified.length; pc++) { if (classified[pc].kind === 'peer') peerCnt++; }
                        if (peerCnt > 0) {
                            reportChatMetric('chat.ice_boundary_missing', { target: handle, peer_lines: peerCnt, lines: classified.length });
                        }
                    } catch (eBm) {}
                }
            }
        } catch (eStream) {}
        if (out.length) return out;

        // B) 回落切轮：只取 iceIdx **之后**各轮 peer；同轮 peer 若排在 own 前（历史灰泡）绝不能算破冰后
        try {
            var turns = collectDmTurnsByTimestamp();
            if (!turns || !turns.length) return out;
            var iceIdx = -1;
            for (var ti = 0; ti < turns.length; ti++) {
                if (turns[ti].own && turns[ti].own.length) iceIdx = ti;
            }
            if (iceIdx < 0) return out;
            for (var t = iceIdx + 1; t < turns.length; t++) {
                var peers = turns[t].peer || [];
                for (var p = 0; p < peers.length; p++) {
                    pushPeer(peers[p], turns[t].time || '');
                }
            }
        } catch (eTurn) {}
        return out;
    }

    /**
     * 4.3.15/16：采集会话正文。优先按时间戳切轮后再汇总；
     * 谁说的只看话术池，几轮看时间戳。
     */
    function __collectDmBodyTexts() {
        var own = [];
        var peer = [];
        var all = [];
        var turns = [];
        try { turns = collectDmTurnsByTimestamp(); } catch (eTu) { turns = []; }
        if (turns.length) {
            for (var t = 0; t < turns.length; t++) {
                var turn = turns[t];
                for (var o = 0; o < turn.own.length; o++) {
                    own.push(__ownBubbleSignature(turn.own[o]));
                    all.push(turn.own[o]);
                }
                for (var p = 0; p < turn.peer.length; p++) {
                    peer.push(__ownBubbleSignature(turn.peer[p]));
                    all.push(turn.peer[p]);
                }
            }
            return { own: own, peer: peer, all: all, turns: turns, latest: turns[turns.length - 1] || null };
        }
        // 无切轮结果时回落叶子扫描
        var root = null;
        try { root = __getDmMessageListRoot(); } catch (eR) { root = null; }
        if (!root) {
            try { root = getDmMessageScanRoot(); } catch (eS) { root = null; }
        }
        if (!root || !root.querySelectorAll) return { own: own, peer: peer, all: all, turns: [], latest: null };
        var handle = '';
        try { handle = normalizeChatHandle(sessionStorage.getItem('current_target') || '') || ''; } catch (eH) {}
        var leaves = null;
        try {
            leaves = root.querySelectorAll(
                '[data-testid^="message-text-"], [data-testid="messageText"], [data-testid="messageBubble"], [dir="auto"]'
            );
        } catch (eL) { leaves = null; }
        if (!leaves || !leaves.length) return { own: own, peer: peer, all: all, turns: [], latest: null };
        var seen = {};
        var start = Math.max(0, leaves.length - 50);
        for (var i = start; i < leaves.length; i++) {
            var leaf = leaves[i];
            try { if (isDmComposerNode(leaf)) continue; } catch (eC) {}
            var rawLine = '';
            try { rawLine = getDmMessageText(leaf); } catch (eT) {
                rawLine = String(leaf.innerText || leaf.textContent || '');
            }
            rawLine = String(rawLine || '').replace(/\s+/g, ' ').trim();
            if (!rawLine || rawLine.length < 2 || rawLine.length > 280) continue;
            if (seen[rawLine]) continue;
            try { if (isDmChromeNoise(rawLine, handle)) continue; } catch (eN) {}
            seen[rawLine] = 1;
            all.push(rawLine);
            var sig = __ownBubbleSignature(rawLine);
            // 4.6.34：叶子回落与 C3 几何+DNA 同源，避免确认路径仍纯 DNA 假阴性
            var kindFb = 'unknown';
            try { kindFb = classifyDmMessageOwnPeer(rawLine, leaf); } catch (eKind) {
                kindFb = (isLinkShellText(rawLine) || isOwnScriptText(rawLine, handle)) ? 'own' : 'peer';
            }
            if (kindFb === 'own') own.push(sig);
            else if (kindFb === 'peer') peer.push(sig);
            else if (isLinkShellText(rawLine) || isOwnScriptText(rawLine, handle)) own.push(sig);
            else peer.push(sig);
        }
        return { own: own, peer: peer, all: all, turns: [], latest: null };
    }

    function __collectOwnBubbleSigs() {
        return __collectDmBodyTexts().own;
    }

    function __textMatchesNeedles(sample, needles) {
        var hay = __normalizeDmScanText(sample);
        if (!hay || hay.length < 4) return false;
        for (var i = 0; i < (needles || []).length; i++) {
            var n = __normalizeDmScanText(needles[i]);
            if (n.length >= 4 && hay.indexOf(n) >= 0) return true;
        }
        return false;
    }

    function __ownBubblesMatchNeedles(sigs, needles) {
        for (var i = 0; i < (sigs || []).length; i++) {
            if (__textMatchesNeedles(sigs[i], needles)) return true;
        }
        return false;
    }

    function __bodiesMatchNeedles(bodies, needles) {
        for (var i = 0; i < (bodies || []).length; i++) {
            if (__textMatchesNeedles(bodies[i], needles)) return true;
        }
        return false;
    }

    function __newOwnMatchesNeedles(beforeSigs, afterSigs, needles) {
        var seen = {};
        for (var b = 0; b < (beforeSigs || []).length; b++) seen[beforeSigs[b]] = true;
        for (var a = 0; a < (afterSigs || []).length; a++) {
            var s = afterSigs[a];
            if (seen[s]) continue;
            if (__textMatchesNeedles(s, needles)) return true;
        }
        if ((afterSigs || []).length > (beforeSigs || []).length && __ownBubblesMatchNeedles(afterSigs, needles)) {
            return true;
        }
        return false;
    }

    /** 填入并点击发送；确认只认正文∈话术/本条针（4.3.15 不认气泡几何） */
    async function threadSafeSendAndConfirm(inputElement, text) {
        if (!inputElement) return { ok: false, reason: 'no_input' };
        if (isDryRun()) {
            var th = sessionStorage.getItem('dan_target_username') || '';
            dryRunPreview(th, parseInt(sessionStorage.getItem('dan_user_round') || '0', 10), text, {});
            return { ok: false, reason: 'dry_run' };
        }
        var needles = __msgNeedleVariants(text);
        if (!needles.length) {
            var fallback = __msgNeedle(text);
            if (fallback && fallback.length >= 4) needles = [fallback];
        }
        // 把本条原文也塞进针，保证刚发内容可命中
        try {
            var sentNorm = __normalizeDmScanText(text);
            if (sentNorm.length >= 4 && needles.indexOf(sentNorm.slice(0, 28)) < 0) {
                needles = needles.concat(__msgNeedleVariants(sentNorm));
            }
        } catch (eSn) {}
        // 4.6.28：写入方式改一次性粘贴（模拟真人 Ctrl+V）
        // 弃用旧的 execCommand/setter/textContent，减少事件数，降低被检测概率
        // 4.6.30：粘贴前必须清空（上次发送失败的残留会与本次粘贴拼接成双倍正文）；
        // 核对改 trim 后全等——粘贴只有全成/全败，无中间态（§C5 写入不变量）
        function __dmNormTxt(s) { return ((s || '') + '').replace(/\r\n?/g, '\n').trim(); }
        var wantText = __dmNormTxt(text);
        var fillOk = false;
        var fillReason = '';
        try {
            inputElement.click();
            inputElement.focus();
            await __dmSleep(300 + Math.floor(Math.random() * 300));
            var isTextarea = inputElement.tagName === 'TEXTAREA' || inputElement.value !== undefined;
            if (isTextarea) {
                // textarea：先清空再粘贴
                try {
                    var proto = inputElement.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (setter && setter.set) setter.set.call(inputElement, text);
                    else inputElement.value = text;
                } catch (eSetter) {
                    inputElement.value = text;
                }
                inputElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                inputElement.dispatchEvent(new Event('change', { bubbles: true }));
                fillOk = __dmNormTxt(inputElement.value) === wantText;
                fillReason = fillOk ? 'textarea_setter' : 'textarea_value_mismatch';
            } else {
                // contenteditable：一次性粘贴（模拟 Ctrl+V）
                // 4.6.30：先清空（selectAll+delete）再粘贴
                try {
                    inputElement.focus();
                    document.execCommand('selectAll', false);
                    document.execCommand('delete', false);
                } catch (_) {}
                await __dmSleep(200);
                try {
                    var dt = new DataTransfer();
                    dt.setData('text/plain', text);
                    inputElement.dispatchEvent(new ClipboardEvent('paste', {
                        clipboardData: dt,
                        bubbles: true,
                        cancelable: true
                    }));
                } catch (ePaste) {
                    // 兜底：execCommand
                    try { document.execCommand('insertText', false, text); } catch (_) {}
                }
                // 核对：读 innerText，trim 后全等
                var got = ((inputElement.innerText || inputElement.textContent || '') + '').trim();
                fillOk = __dmNormTxt(got) === wantText;
                fillReason = fillOk ? 'paste_ok_' + got.length + '字' : 'paste_mismatch_got_' + got.length + '字';
                // 不匹配时重试一次
                if (!fillOk) {
                    try {
                        document.execCommand('selectAll', false);
                        document.execCommand('delete', false);
                    } catch (_) {}
                    await __dmSleep(200);
                    try {
                        var dt2 = new DataTransfer();
                        dt2.setData('text/plain', text);
                        inputElement.dispatchEvent(new ClipboardEvent('paste', {
                            clipboardData: dt2,
                            bubbles: true,
                            cancelable: true
                        }));
                    } catch (_) {
                        try { document.execCommand('insertText', false, text); } catch (_) {}
                    }
                    var got2 = ((inputElement.innerText || inputElement.textContent || '') + '').trim();
                    fillOk = __dmNormTxt(got2) === wantText;
                    fillReason = fillOk ? 'paste_retry_ok_' + got2.length + '字' : 'paste_retry_fail_got_' + got2.length + '字';
                }
            }
        } catch (eFill) {
            fillReason = 'fill_exception:' + eFill.message;
        }
        console.log('[私信发送] 写入核对：' + fillReason + ' 目标=' + text.length + '字');
        if (!fillOk) return { ok: false, reason: 'fill_failed:' + fillReason };

        // 4.6.34：发送前多等 Lexical reconciliation（1.8–2.5s）
        await __dmSleep(1800 + Math.floor(Math.random() * 700));
        var beforeBodies = __collectDmBodyTexts();
        var beforeOwn = beforeBodies.own;
        var beforeAll = beforeBodies.all.slice();
        var beforeMap = {};
        for (var bi = 0; bi < needles.length; bi++) {
            beforeMap[needles[bi]] = __countNeedleInDmMessages(needles[bi]);
        }
        try {
            var sendBtn = null;
            for (var w = 0; w < 6; w++) {
                sendBtn = findDmSendButton();
                if (sendBtn && !sendBtn.disabled) break;
                await __dmSleep(600);
            }
            console.log('[私信发送] 发送按钮状态：' + (sendBtn ? (sendBtn.disabled ? '禁用' : '可用') : '未找到'));
            if (sendBtn && !sendBtn.disabled) {
                // 4.6.34：优先 humanClick（对齐关注/转帖），失败再原生 click / Enter
                var clicked = false;
                try {
                    if (typeof EngineUtils !== 'undefined' && EngineUtils.humanClick) {
                        clicked = !!(await EngineUtils.humanClick(sendBtn));
                    }
                } catch (eHc) { clicked = false; }
                if (!clicked) {
                    try { sendBtn.click(); clicked = true; } catch (eNc) { clicked = false; }
                }
                if (!clicked) {
                    inputElement.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13
                    }));
                }
            } else {
                inputElement.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13
                }));
            }
        } catch (eClick) {
            return { ok: false, reason: 'click_failed' };
        }

        function confirmTick() {
            var bodies = __collectDmBodyTexts();
            // A) 新出现的正文命中本条针 / 话术池
            if (__newOwnMatchesNeedles(beforeOwn, bodies.own, needles)) {
                return { ok: true, reason: 'script_body_grew' };
            }
            // B) 任意正文块新增且命中针（即使分类暂时未进 own）
            var seenBefore = {};
            for (var bi2 = 0; bi2 < beforeAll.length; bi2++) seenBefore[beforeAll[bi2]] = true;
            for (var ai = 0; ai < bodies.all.length; ai++) {
                var t = bodies.all[ai];
                if (seenBefore[t]) continue;
                if (__textMatchesNeedles(t, needles) || isOwnScriptText(t)) {
                    return { ok: true, reason: 'body_text_appeared' };
                }
            }
            // C) 旧针计数
            try {
                for (var ni = 0; ni < needles.length; ni++) {
                    var n = needles[ni];
                    if (__countNeedleInDmMessages(n) > (beforeMap[n] || 0)) {
                        return { ok: true, reason: 'needle_grew' };
                    }
                }
            } catch (eN) {}
            return null;
        }

        // 4.6.28：确认等待拉长（24次→30次，500ms→700ms），给气泡渲染更多时间
        for (var i = 0; i < 30; i++) {
            await __dmSleep(700);
            var hit = confirmTick();
            if (hit) {
                console.log('[私信发送] 发送确认成功：' + hit.reason + '（第' + (i+1) + '次检测）');
                return hit;
            }
        }
        await __dmSleep(800);
        var late = confirmTick();
        if (late) {
            late.reason = (late.reason || 'body') + '_late';
            console.log('[私信发送] 发送确认成功（延迟）：' + late.reason);
            return late;
        }
        // 绝对：会话里已有命中本条/话术池的正文
        try {
            var nowBodies = __collectDmBodyTexts();
            if (__bodiesMatchNeedles(nowBodies.all, needles) || __ownBubblesMatchNeedles(nowBodies.own, needles)) {
                console.log('[私信发送] 发送确认成功（绝对匹配）');
                return { ok: true, reason: 'body_absolute' };
            }
            for (var aj = 0; aj < needles.length; aj++) {
                if (__countNeedleInDmMessages(needles[aj]) > 0) {
                    console.log('[私信发送] 发送确认成功（针绝对匹配）');
                    return { ok: true, reason: 'needle_absolute' };
                }
            }
        } catch (eAbs) {}
        console.log('[私信发送] 发送确认失败：no_bubble（30次检测均未发现新气泡）');
        return { ok: false, reason: 'no_bubble' };
    }

    function reportDmHealthEvent(eventType, detail) {
        detail = detail || {};
        var sev = detail.severity || 'warn';
        var mapId = eventType;
        if (eventType === 'DM_SEND_UNCONFIRMED' || eventType === 'DM_REPORT_FAILED') {
            mapId = 'chat.dm_send_fail';
        } else if (eventType === 'DM_CHECK_FAILED') {
            mapId = 'chat.dm_check_fail';
        } else if (eventType === 'DM_ROUND_END') {
            mapId = 'chat.dm_round_end';
        }
        try {
            if (typeof SgTelemetry !== 'undefined' && SgTelemetry.emit) {
                SgTelemetry.emit(mapId, detail, { severity: sev });
            }
        } catch (eT) {}
        try {
            chrome.runtime.sendMessage({
                action: 'ops_health_event',
                payload: Object.assign({
                    event_type: eventType || 'DM_HEALTH',
                    severity: sev,
                    bot_id: (typeof getWorkerId === 'function' ? getWorkerId() : ''),
                    ts: Date.now()
                }, detail || {})
            }, function () {});
        } catch (e) {}
    }


    // ========== getChatDecision 已移除 — 改为三轮 push 模式 ==========


    // ========== 【主巡航引擎】 ==========
    // 可重启：completeChatRound/stop 的 clearAllTimers 会杀掉 interval；开人保活需 ensureChatMainEngine
    window.__sgChatMainEngineTick = function () {
        var isRunning = sessionStorage.getItem('dan_auto_run') === 'true';
        if (!isRunning) {
            if (!isRunning) return;
        }

        // 4.6.102：跳页落地 settle — 未到点不武装 step / 不点按钮
        try {
            var leftGate = 0;
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.arriveSettleLeftMs) {
                leftGate = SchedulerGate.arriveSettleLeftMs() || 0;
            }
            if (leftGate > 0) return;
        } catch (eNavSettle) {}

        // 验证页期间整个 Chat 引擎只做门禁处理，禁止进入任何发送分支。
        if (isDmPinBlockedForSend()) {
            var pinRes = tryUnlockDmPin();
            if (pinRes && (pinRes.max_attempts || pinRes.rate_limited || pinRes.encryption_broken || (pinRes.needs_setup && !pinRes.setup_pending))) {
                try { sessionStorage.setItem('sg_dm_pin_give_up', '1'); } catch (eGu) {}
                try {
                    if (typeof window.__sgReclaimChatZombie === 'function') {
                        window.__sgReclaimChatZombie(
                            pinRes.encryption_broken ? 'pin_blocked'
                              : (pinRes.needs_setup ? 'pin_setup' : (pinRes.rate_limited ? 'pin_rate_limit' : 'pin_blocked'))
                        );
                    } else {
                        window.dispatchEvent(new CustomEvent('sg-dm-pin-give-up', {
                            detail: { reason: pinRes.encryption_broken ? 'encryption_module_broken'
                              : (pinRes.needs_setup ? 'needs_setup' : (pinRes.rate_limited ? 'rate_limited' : 'max_attempts')) }
                        }));
                    }
                } catch (eRc) {}
                if (pinRes.encryption_broken) {
                    showToast('🔒 加密模块加载失败，已交回养号', '#f85149', 3500);
                } else if (pinRes.needs_setup) {
                    showToast('🔒 自动创建密码失败，请手动创建并设 2546', '#f85149', 4000);
                } else if (pinRes.rate_limited) {
                    showToast('🔒 Passcode 限流，已停私信稍后再试', '#f85149', 3500);
                } else {
                    showToast('🔒 PIN 多次失败，已停私信交回调度', '#f85149', 3200);
                }
                return;
            }
            if (pinRes && pinRes.setup_pending) {
                try {
                    var lastPinProgS = parseInt(sessionStorage.getItem('sg_chat_last_progress_at') || '0', 10) || 0;
                    if (Date.now() - lastPinProgS > 15000) noteChatProgress('ice_pin_setup');
                } catch (eNpS) {}
                return;
            }
            if (!pinRes || !pinRes.throttled) {
                if (!window._sgDmPinToastAt || Date.now() - window._sgDmPinToastAt > 12000) {
                    window._sgDmPinToastAt = Date.now();
                    reportDmPinGate({ ok: false, reason: 'engine_blocked_on_pin_recovery', gate_visible: true });
                    showToast('🔒 DM 正在等待 Passcode 验证', '#ff8c00', 2500);
                }
            }
            // 等人填码：限频续 progress，避免 45s 误杀；超 3min 仍由调度回收
            try {
                var lastPinProg = parseInt(sessionStorage.getItem('sg_chat_last_progress_at') || '0', 10) || 0;
                if (Date.now() - lastPinProg > 20000) noteChatProgress('ice_pin_wait');
            } catch (eNp) {}
            return;
        }

        // 更新模块状态（告诉 Coordinator 我还活着）
        try {
            var ms = JSON.parse(sessionStorage.getItem('sg_module_chat') || '{}');
            ms.lastActive = Date.now();
            var step = sessionStorage.getItem('dan_auto_step');
            ms.phase = !step ? 'scanning' : (step === '1' ? 'dm_ing' : (step === '2' || step === '2_waiting' ? 'sending' : 'transitioning'));
            sessionStorage.setItem('sg_module_chat', JSON.stringify(ms));
            // 开人全步骤续 progress（含 step1 资料页等私信钮）；仅 step2 会在慢网/确认时>45s 被假活回收拽去养号→主页
            if (step === '1' || step === '2' || step === '2_waiting' || step === '3' || step === '4') {
                try { noteChatProgress('step_' + step); } catch (eNpS) {}
            } else {
                try {
                    var ctAlive = sessionStorage.getItem('current_target') || '';
                    if (ctAlive) noteChatProgress('has_target');
                } catch (eCt) {}
            }
        } catch (e) {}

        let errorButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        let retryBtn = errorButtons.find(btn => btn.innerText && (btn.innerText.includes('重试') || btn.innerText.includes('Retry') || btn.innerText.includes('限制')));
        if (retryBtn && isFollowersListPath(window.location.href)) { retryBtn.click(); }

        let lastHealthyTime = parseInt(sessionStorage.getItem('dan_last_healthy_time') || Date.now().toString());
        let isHealthyDOM = isChatHealthyDom();

        if (isHealthyDOM) {
            sessionStorage.setItem('dan_last_healthy_time', Date.now().toString());
        } else if (Date.now() - lastHealthyTime > 40000) {
            // 4.1.26：勿把 lastHealthy 重置成「假装健康」——否则心跳永远到不了 ≥45s heal
            var softAt = parseInt(sessionStorage.getItem('dan_last_soft_recovery_at') || '0', 10) || 0;
            if (Date.now() - softAt < 40000) {
                // 软恢复冷却中：仅等待 heal / 下次探测
            } else {
                sessionStorage.setItem('dan_last_soft_recovery_at', String(Date.now()));
                sessionStorage.removeItem('dan_auto_step');
                // 扫箱/收件箱相位：只回列表根，严禁跳粉丝页（旧逻辑会把守箱扫到一半打回 /followers）
                if (mustStayOnInboxSurface()) {
                    showToast('⚠️ 收件箱无响应，回到列表重试…', '#faad14', 2800);
                    console.warn('[私信] 健康超时 → 回收件箱列表（禁止跳粉丝页）');
                    try { ensureInboxListRootView(); } catch (eRootH) {}
                    try {
                        if (!isInboxWatchEnabled()) {
                            requestSharedSoftHealChat('soft_recover_inbox_off');
                        } else {
                            leaveDmConversationToListOnce();
                        }
                    } catch (eHealGo) { requestSharedSoftHealChat('soft_recover_inbox_err'); }
                    return;
                }
                showToast('⚠️ 页面无响应，点重试/软愈…', '#ff4d4f', 3000);
                // 禁同 URL chatGo 刷握手；优先回粉丝页（outbound 禁落 Messages）/ soft_reload
                try {
                    if (isDmConversationPage() || isDmConversationView() || isDmPath(window.location.pathname || '')) {
                        var hostRec = sessionStorage.getItem('dan_target_username') || getMyHandle();
                        var viaRec = '';
                        try { viaRec = sessionStorage.getItem('dan_dm_entry_via') || ''; } catch (eVr) {}
                        var phRec = '';
                        try { phRec = getChatPhase() || ''; } catch (ePr) {}
                        if (!isInboxWatchEnabled() || viaRec === 'fan_roster' || phRec === 'outbound' || phRec === 'followup') {
                            if (hostRec) {
                                // 4.6.75：followers 相位 / 已读 F → 只回列表；禁止清标记回主页
                                var goFansRec = getRosterNavPhase() === 'followers' ||
                                    sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1';
                                if (goFansRec) {
                                    chatGo('/' + hostRec + '/followers', true);
                                } else {
                                    chatGo('/' + hostRec, true);
                                }
                                return;
                            }
                        }
                        leaveDmConversationToListOnce();
                        return;
                    }
                } catch (eLeaveR) {}
                requestSharedSoftHealChat('soft_recover_unhealthy');
                return;
            }
        }

        if (isFollowersListPath(window.location.href)) {
            let allCells = document.querySelectorAll('[data-testid="UserCell"]');
            // 软风控破冰段禁止删行，避免未进 session 的粉被卸掉漏扫
            if (allCells.length > 60 && !isSoftRiskOutboundSegment()) {
                for (let i = 0; i < 20; i++) {
                    if (allCells[i] && allCells[i].parentNode) allCells[i].parentNode.removeChild(allCells[i]);
                }
            }
        }

        let warmupTime = parseInt(sessionStorage.getItem('dan_warmup_timer') || '0');
        if (Date.now() < warmupTime) return;

        let memCount = parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0');
        if (memCount >= 35) {
            showToast('🧹 内存防爆：软愈释放…', '#f91880', 3000);
            sessionStorage.setItem('dan_mem_cleaner_count', '0');
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 5000).toString());
            // 禁同 URL chatGo；改共用 soft_reload
            requestSharedSoftHealChat('mem_cleaner');
            return;
        }

        const currentStep = sessionStorage.getItem('dan_auto_step');

        // 4.6.77：粉丝队列硬禁 Messages 会话栏；无 step 误入立刻硬回 /followers
        try {
            if (!currentStep && getChatPhase() === 'outbound' && isMessagesPage()) {
                if (recoverFanQueueOffChatSurface('main_messages_bar_ban')) return;
            }
        } catch (eBarBan) {}

        // 任意步进前：粉丝队列若停在 CHAT 列表根/空壳，立刻拉回（不依赖 step=2）
        try {
            if (recoverFanQueueOffChatSurface('main_pre_step')) return;
        } catch (eShellPre) {}

        // 4.6.110：过渡步骤——点 DM 后等待进入 DM 会话，确认后才升 step2
        if (currentStep === '1_entering_dm') {
            if (isDmConversationView() || isDmConversationPage()) {
                // 已进入 DM → 升 step2
                console.log('[私信] 1_entering_dm → 确认进入 DM，升 step2');
                sessionStorage.setItem('dan_auto_step', '2');
                sessionStorage.removeItem('dan_entering_dm_wait');
                return; // 下一 tick 走 step2 逻辑
            }
            var _enterWait = parseInt(sessionStorage.getItem('dan_entering_dm_wait') || '0') + 1;
            sessionStorage.setItem('dan_entering_dm_wait', String(_enterWait));
            if (_enterWait > 10) {
                // 超时（约 50-100s）→ 回退重试
                sessionStorage.removeItem('dan_auto_step');
                sessionStorage.removeItem('dan_entering_dm_wait');
                showToast('⚠️ 进入 DM 超时，回退重试', '#faad14', 2500);
                try { if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.step_mismatch', { step: '1_entering_dm', page: location.pathname, action: 'heal', reason: 'enter_dm_timeout' }); } catch (eT) {}
                requestSharedSoftHealChat('entering_dm_timeout');
            }
            return; // 等下一 tick
        }

        if (!currentStep) {
            // 守箱关 / followup 遗留相位：一律走粉丝队列 drain；会话中有 target 则武装 step2
            if (isMessagesPage() || getChatPhase() === 'inbox' || getChatPhase() === 'followup' || isSoftRiskInboxSegment()) {
                if (shouldDeferChatForFollow()) return;
                if (!isInboxWatchEnabled()) {
                    // 守箱关：禁止在 Messages 武装 step2
                    // 4.6.75：本窗已读 F → 回粉丝列表；否则先资料页
                    try {
                        if (!isFollowersListPath(window.location.href) && !isMyProfilePage()) {
                            var hostFu = sessionStorage.getItem('dan_target_username') || getMyHandle();
                            if (hostFu) {
                                try { setChatPhase('outbound'); } catch (ePhF) {}
                                try { sessionStorage.removeItem('dan_inbox_opening'); } catch (eOp) {}
                                var goFans = getRosterNavPhase() === 'followers' ||
                                    sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1';
                                if (goFans) {
                                    console.log('[私信] 守箱关：离开 CHAT → 粉丝列表 /' + hostFu + '/followers');
                                    chatGo('/' + hostFu + '/followers', true);
                                } else {
                                    console.log('[私信] 守箱关：离开 CHAT → 资料页读 F /' + hostFu);
                                    chatGo('/' + hostFu, true);
                                }
                                return;
                            }
                        }
                    } catch (eGoF) {}
                    try { setChatPhase('outbound'); } catch (ePh2) {}
                    runFollowupQueueTick();
                    return;
                }
            }
            if (!isFollowersListPath(window.location.href)) {
                if (sessionStorage.getItem('dan_auto_step') && !isMessagesPage()) {
                    sessionStorage.removeItem('dan_auto_step');
                }
                // 4.6.75：严格两段——仅本号资料页读 F；ready 后只准跳一次 /followers
                if (isSoftRiskOutboundSegment() || getChatPhase() === 'outbound') {
                    if (!gateFollowersBehindProfileF('pre_followers_nav')) return;
                    // 已在本号资料页才进列表；其它页先由 gate 拉回资料页
                    if (!isMyProfilePage() && getRosterNavPhase() !== 'followers') return;
                    try { reconcileChatHostIdentity('soft_outbound_redirect'); } catch (eRec0) {}
                    // 换号对账若误清，以「已读过 F」为准：相位锁死 followers
                    if (sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) !== '1' &&
                        getRosterNavPhase() !== 'followers') {
                        return;
                    }
                    var hostIce = sessionStorage.getItem('dan_target_username') || getMyHandle();
                    if (hostIce) {
                        try {
                            var lastFolNav = parseInt(sessionStorage.getItem('sg_followers_nav_at') || '0', 10) || 0;
                            if (Date.now() - lastFolNav < 8000) return;
                            sessionStorage.setItem('sg_followers_nav_at', String(Date.now()));
                        } catch (eTh) {}
                        setRosterNavPhase('followers', 'nav_to_followers');
                        console.log('[私信] 主页 F 已读 → 进粉丝列表（本窗仅此一次） /' + hostIce + '/followers');
                        chatGo('/' + hostIce + '/followers', true);
                    }
                }
                return;
            }

            // 4.6.76：已在列表但相位被误清 → 优先用缓存恢复，禁止再回主页乒乓
            if ((isSoftRiskOutboundSegment() || getChatPhase() === 'outbound') &&
                getRosterNavPhase() === 'profile' &&
                sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) !== '1') {
                var cachedF = 0;
                try {
                    var cNav = JSON.parse(localStorage.getItem('sg_own_follower_count') || 'null');
                    if (cNav && cNav.n > 0) cachedF = parseInt(cNav.n, 10) || 0;
                } catch (eCf) { cachedF = 0; }
                if (cachedF > 0) {
                    markProfileFReady(cachedF, 'followers_recover_cache');
                    console.log('[粉丝对账] 列表上相位误清，缓存 F=' + cachedF + ' 恢复，留列表');
                } else if (!gateFollowersBehindProfileF('on_followers_no_f')) {
                    return;
                }
            }

            // 换号对账 + 必须本人粉丝列表才扫/开人
            try {
                var rec = reconcileChatHostIdentity('followers_tick');
                if (rec && rec.changed) {
                    showToast('🔄 换号：清破冰脏数据，重扫本号粉丝', '#faad14', 2500);
                    return;
                }
            } catch (eRec) {}
            if (!isMyFollowersPage()) {
                try {
                    var hostOwn = sessionStorage.getItem('dan_target_username') || getMyHandle();
                    if (hostOwn) {
                        console.warn('[隔离] 非本号粉丝页，拉回 /' + hostOwn + '/followers');
                        showToast('⚠️ 非本号粉丝列表，拉回自己', '#faad14', 2000);
                        // 已读过 F 则直回列表，勿清标记回主页乒乓
                        if (getRosterNavPhase() === 'followers' ||
                            sessionStorage.getItem(OWN_PROFILE_F_READY_KEY) === '1') {
                            chatGo('/' + hostOwn + '/followers', true);
                        } else {
                            chatGo('/' + hostOwn, true);
                        }
                    }
                } catch (eOwn) {}
                return;
            }

            // 4.6.124：粉丝列表加载前置确认——URL 到了但列表仍在加载（cells=0 或 aria-busy/progressbar）→ 等待
            try {
                var _cells = document.querySelectorAll('[data-testid="UserCell"]');
                var _listLoading = false;
                try {
                    _listLoading = !!document.querySelector('[aria-busy="true"]') ||
                        !!document.querySelector('[role="progressbar"]');
                } catch (eLB) { _listLoading = false; }
                if ((_cells.length === 0 || _listLoading) && !pageLooksChatFollowersShell()) {
                    // 4.6.127：白壳判定（pageLooksChatFollowersShell）会把「仍在加载」误判为白壳从而跳过等待，
                    // 导致 cells0_hard 无限 defer。改为只有「真实空态（0 粉丝 emptyState 文案）」才跳过等待，
                    // 其余 cells=0 一律等加载或软愈。
                    var _skipWait = false;
                    try {
                        var _emptyState = document.querySelector('[data-testid="emptyState"], [data-testid="emptyStateHeader"]');
                        if (_emptyState && /关注者|followers|フォロワー/i.test(String(_emptyState.textContent || ''))) _skipWait = true;
                    } catch (eEs) { _skipWait = false; }
                    if (!_skipWait) {
                    var _waitOk = false;
                    if (_listLoading) {
                        // 加载态单独计数（不计入空列表失败窗口），封顶 15 tick（约 30s）防永等
                        var _busyWait = parseInt(sessionStorage.getItem('dan_followers_busy_wait') || '0') + 1;
                        sessionStorage.setItem('dan_followers_busy_wait', String(_busyWait));
                        if (_busyWait <= 15) {
                            console.log('[私信] 粉丝列表加载中（cells=' + _cells.length + '）等待…(' + _busyWait + '/15)');
                            _waitOk = true;
                        }
                    } else {
                        // 空列表且非加载态：计数封顶 10 tick（约 20s）
                        var _loadWait = parseInt(sessionStorage.getItem('dan_followers_loading_wait') || '0') + 1;
                        sessionStorage.setItem('dan_followers_loading_wait', String(_loadWait));
                        if (_loadWait <= 10) {
                            console.log('[私信] 粉丝列表 URL 已到，UserCell 未渲染，等待加载…(' + _loadWait + '/10)');
                            _waitOk = true;
                        }
                    }
                    if (_waitOk) return;
                    // 超窗仍无 cells → soft_reload 自愈
                    sessionStorage.removeItem('dan_followers_loading_wait');
                    sessionStorage.removeItem('dan_followers_busy_wait');
                    showToast('⚠️ 粉丝列表未加载完成，软愈刷新…', '#faad14', 2500);
                    try { if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.step_mismatch', { step: 'scan_followers', page: location.pathname, action: 'heal', reason: 'no_usercell_after_wait' }); } catch (eT) {}
                    requestSharedSoftHealChat('followers_not_loaded');
                    return;
                    }
                }
                // 已加载（cells>0 且无加载态）或有空态（白壳）→ 清计数
                sessionStorage.removeItem('dan_followers_loading_wait');
                sessionStorage.removeItem('dan_followers_busy_wait');
                // 4.6.124：首屏 harvest 前要求连续 2 拍 UserCell 数一致——防列表未挂满即登记漏粉
                if (_cells.length > 0 && !_listLoading) {
                    var _pulseGate = '';
                    try { _pulseGate = iceQueuePulseId() || ''; } catch (ePg) { _pulseGate = ''; }
                    if (_pulseGate && sessionStorage.getItem('dan_followers_stable_ok') !== _pulseGate) {
                        var _wantStable = _pulseGate + ':' + _cells.length;
                        if (sessionStorage.getItem('dan_followers_cells_stable') !== _wantStable) {
                            sessionStorage.setItem('dan_followers_cells_stable', _wantStable);
                            console.log('[私信] 粉丝列表格子数未稳定（cells=' + _cells.length + '），等下一拍…');
                            return;
                        }
                        sessionStorage.setItem('dan_followers_stable_ok', _pulseGate);
                        sessionStorage.removeItem('dan_followers_cells_stable');
                    }
                }
            } catch (eLoadGuard) {}

            if (!canRunChatOutboundWork()) {
                return;
            }

            if (isChatDailyCapReached()) {
                if (isSoftRiskRoundOpen()) {
                    finishSoftRiskFanQueueDone('chat_daily_cap');
                } else {
                    completeChatRound('chat_daily_cap');
                }
                return;
            }
            if (isOutboundCapReached()) {
                // 帽满：已登记的仍逐条做完；未 seal 则先 seal 再 drain
                try {
                    var qCap = loadIceTaskQueue();
                    if (!qCap.sealed) {
                        if (sessionStorage.getItem('dan_ice_seal_inflight') === '1') return;
                        prepareAndSealIceQueue('outbound_cap', function () {
                            if (iceQueueHasOpenWork()) {
                                var nextCap2 = iceQueueNextPending();
                                if (nextCap2) startIceTaskFromQueueItem(nextCap2);
                            }
                        });
                        return;
                    }
                } catch (eCap) {}
                if (iceQueueHasOpenWork()) {
                    var nextCap = iceQueueNextPending();
                    if (nextCap) {
                        startIceTaskFromQueueItem(nextCap);
                        return;
                    }
                }
                if (isSoftRiskOutboundSegment()) {
                    finishSoftRiskFanQueueDone('outbound_cap');
                    return;
                }
                if (!isInboxWatchEnabled()) {
                    finishSoftRiskFanQueueDone('outbound_cap');
                    return;
                }
                if (hasDebtForInboxPivot() && !isInboxCapReached()) {
                    setChatPhase('inbox');
                    var goCap = chatGo('/i/chat', false);
                    if (!goCap) {
                        finishSoftRiskFanQueueDone('outbound_cap_chat_blocked');
                        return;
                    }
                    return;
                }
                if (isSoftRiskRoundOpen()) {
                    finishSoftRiskFanQueueDone('outbound_cap');
                } else {
                    completeChatRound('outbound_cap');
                }
                return;
            }

            // 4.6.34：人间间隔（非 rush 也生效；rush 更长）。防握手未完成就被下一人带走
            {
                var paceUntil = parseInt(sessionStorage.getItem('dan_next_target_at') || '0', 10) || 0;
                try {
                    if (!paceUntil) paceUntil = parseInt(sessionStorage.getItem('dan_rush_next_target_at') || '0', 10) || 0;
                } catch (ePaceLegacy) {}
                if (Date.now() < paceUntil) {
                    var leftSec = Math.ceil((paceUntil - Date.now()) / 1000);
                    if (leftSec % 10 === 0 || leftSec <= 3) {
                        showToast((isChatRushMode() ? '赶工匀速中' : '匀速中') + '，下一人 ' + leftSec + 's…', '#faad14', 1200);
                    }
                    return;
                }
            }

            // 粉丝页 DOM 登记到目标库（本地）；已封口逐条时跳过，避免每 30s 再扫一遍刷屏
            var lastScan = parseInt(sessionStorage.getItem('dan_last_fan_scan') || '0');
            var iceSealedEarly = false;
            try { iceSealedEarly = !!loadIceTaskQueue().sealed; } catch (eSe) { iceSealedEarly = false; }
            if (!iceSealedEarly && Date.now() - lastScan > FAN_SCAN_INTERVAL_MS) {
                var discovered = syncFanScan();
                sessionStorage.setItem('dan_last_fan_scan', Date.now().toString());
                if (discovered.length > 0) syncFanScanToBackend(discovered);
            }

            maybeRefreshOpsRoundMap(false);
            if (!sessionStorage.getItem('dan_ops_round_refreshed_this_round')) {
                sessionStorage.setItem('dan_ops_round_refreshed_this_round', '1');
                maybeRefreshOpsRoundMap(true);
            }
            // 软风控 outbound 段：每轮一次抬起可执行 deferred（催加到点 / OPS 软失败可再试）
            if (isSoftRiskOutboundSegment() && sessionStorage.getItem('dan_ice_promoted_deferred') !== '1') {
                try {
                    iceQueuePromoteDeferred('soft_outbound_tick');
                    sessionStorage.setItem('dan_ice_promoted_deferred', '1');
                } catch (eProm2) {}
            }

            const scannedList = getSessionList();
            const rejectDB = getDB('dan_reject_users');
            const completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]');

            ensureChatFreeze();

            // 债务模式：不建破冰队列
            try {
                if (sessionStorage.getItem('sg_debt_only') === 'true') {
                    try {
                        var lastDebtToast = parseInt(sessionStorage.getItem('dan_debt_only_toast_at') || '0', 10) || 0;
                        if (Date.now() - lastDebtToast > 60000) {
                            sessionStorage.setItem('dan_debt_only_toast_at', String(Date.now()));
                            showToast('⏸ 仅清债模式：跳过粉丝页破冰', '#faad14', 2000);
                        }
                    } catch (eT) {}
                    finishIceOutboundAfterQueue('debt_only');
                    return;
                }
            } catch (eD) {}

            var iceQ = loadIceTaskQueue();

            // —— 已封口：只按队列逐条执行；有 doing 只续当前人 ——
            if (iceQ.sealed) {
                if (iceQueueHasOpenWork()) {
                    // 4.6.64：已封口队列也按新序重排（未破冰优先于 need_probe）
                    try { sortIceQueueForDrain(); } catch (eSortD) {}
                    var nextItem = iceQueueNextPending();
                    if (nextItem) {
                        var started = startIceTaskFromQueueItem(nextItem);
                        // 硬跳过（freeze/already_iced）同拍再取下一 pending，避免空等一轮
                        if (!started && !iceQueueCurrentDoing()) {
                            var next2 = iceQueueNextPending();
                            if (next2) startIceTaskFromQueueItem(next2);
                        }
                    }
                    return;
                }
                finishIceOutboundAfterQueue('queue_drained');
                return;
            }

            // —— 扫描登记段：首趟全量触底建台账；之后只浅扫列表顶部新粉 + DB 未完成债 ——
            try { maybeMorningFullScanReset(); } catch (eMorning) {}
            if (sessionStorage.getItem('dan_ice_seal_inflight') === '1') {
                showToast('⏳ OPS 核对封口中…', '#faad14', 1000);
                return;
            }
            var baselineOk = false;
            try { baselineOk = hasFanRosterBaseline(); } catch (eBl) { baselineOk = false; }
            // 4.3.11：同软窗已扫过却未封口（中途清队）→ 只灌债封口，禁止再回顶滚列表
            try {
                if (baselineOk && hasSoftWindowRosterScanDone() && !iceQ.sealed) {
                    seedUnfinishedFanDebtToQueue('rescan_guard');
                    iceQueuePromoteDeferred('rescan_guard');
                    prepareAndSealIceQueue(iceQueueStats().pending > 0 ? 'shallow_reuse' : 'shallow_empty', function () {
                        if (iceQueueHasOpenWork()) {
                            var nextRu = iceQueueNextPending();
                            if (nextRu) startIceTaskFromQueueItem(nextRu);
                            else finishIceOutboundAfterQueue('shallow_reuse');
                        } else {
                            // 4.6.67/70：空队列再拉 OPS 并对齐回写；仍无债才完工
                            syncLedgerWithOps({ reason: 'shallow_empty_ops', allowPost: true }, function (res) {
                                var n = (res && res.added) || 0;
                                if (n > 0 && iceQueueHasOpenWork()) {
                                    var nextOp = iceQueueNextPending();
                                    if (nextOp) startIceTaskFromQueueItem(nextOp);
                                    else finishIceOutboundAfterQueue('shallow_reuse');
                                } else {
                                    finishIceOutboundAfterQueue('shallow_empty');
                                }
                            });
                        }
                    });
                    return;
                }
            } catch (eGuard) {}
            try {
                var pulseSeed = iceQueuePulseId();
                if (sessionStorage.getItem('dan_ice_db_seeded') !== pulseSeed) {
                    seedUnfinishedFanDebtToQueue('pre_harvest');
                    sessionStorage.setItem('dan_ice_db_seeded', pulseSeed);
                }
                // 浅扫：先回顶（X 新粉在上），再只收上面屏
                if (baselineOk && sessionStorage.getItem('dan_ice_shallow_topped') !== pulseSeed) {
                    sessionStorage.setItem('dan_ice_shallow_topped', pulseSeed);
                    try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (eTop) {
                        try { window.scrollTo(0, 0); } catch (eTop2) {}
                    }
                    showToast('📋 浅扫：回顶抓新粉…', '#1d9bf0', 1000);
                    return;
                }
            } catch (eSeedH) {}
            var addedPending = harvestIceCandidatesToQueue(rejectDB, completedBackend);
            iceQ = loadIceTaskQueue();
            var stNow = iceQueueStats(iceQ);
            var harvestPasses = (parseInt(sessionStorage.getItem('dan_ice_harvest_passes') || '0', 10) || 0) + 1;
            sessionStorage.setItem('dan_ice_harvest_passes', String(harvestPasses));
            var shallowIdle = parseInt(sessionStorage.getItem('dan_ice_shallow_idle') || '0', 10) || 0;
            if (addedPending > 0) shallowIdle = 0;
            else shallowIdle += 1;
            sessionStorage.setItem('dan_ice_shallow_idle', String(shallowIdle));

            // 当前屏已收获：有台账则顶部浅扫封口；无台账必须触底建账
            var cellCount = document.querySelectorAll('[data-testid="UserCell"]').length;

            if (cellCount === 0 && !isFollowersListAtBottom()) {
                showToast('⏳ 等待粉丝列表…', '#faad14', 1200);
                return;
            }

            try {
                var pastFreezePick = false;
                if (typeof TimeUtil !== 'undefined' && TimeUtil.isPastChatFreeze) pastFreezePick = !!TimeUtil.isPastChatFreeze();
                else {
                    var pp = (typeof TimeUtil !== 'undefined' && TimeUtil.shanghaiParts) ? TimeUtil.shanghaiParts() : null;
                    var fzMinFb = 17 * 60;
                    try {
                        if (typeof TimeUtil !== 'undefined' && TimeUtil.chatFreezeMinutes) fzMinFb = TimeUtil.chatFreezeMinutes();
                    } catch (eFzFb) {}
                    pastFreezePick = !!(pp && pp.minutes >= fzMinFb);
                }
                if (pastFreezePick && stNow.pending === 0 && baselineOk && harvestPasses >= 1) {
                    var lastFzToast = parseInt(sessionStorage.getItem('dan_freeze_toast_at') || '0', 10) || 0;
                    if (Date.now() - lastFzToast > 90000) {
                        sessionStorage.setItem('dan_freeze_toast_at', String(Date.now()));
                        var freezeToastH = 17;
                        try {
                            if (typeof TimeUtil !== 'undefined' && TimeUtil.chatFreezeMinutes) {
                                freezeToastH = Math.floor(TimeUtil.chatFreezeMinutes() / 60) || 17;
                            }
                        } catch (eFzT) {}
                        showToast('🔒 ' + freezeToastH + '点定格：今日不破冰新粉（仅清未完成债）', '#faad14', 2800);
                        try {
                            if (typeof SgTelemetry !== 'undefined') {
                                SgTelemetry.emit('chat.outbound_freeze_idle', { cells: cellCount });
                            }
                        } catch (eEm) {}
                    }
                }
            } catch (eFzToast) {}

            // 4.6.125：关注者缺口补登——prepareAndSeal 已置标记时本拍真正下滚补收（防「再滚补登」空转）
            if (sessionStorage.getItem('dan_need_scroll_down') === '1' && !iceQ.sealed) {
                var cellGap = document.querySelectorAll('[data-testid="UserCell"]').length;
                var fGapT = 0;
                try { fGapT = readOwnFollowerCount() || 0; } catch (eFg) { fGapT = 0; }
                var gapScrollN = parseInt(sessionStorage.getItem('dan_need_scroll_down_count') || '0', 10) || 0;
                var gapDone = (cellGap === 0) || (fGapT > 0 && cellGap >= fGapT) ||
                    (gapScrollN >= 8) || isFollowersListAtBottom();
                if (gapDone) {
                    sessionStorage.removeItem('dan_need_scroll_down');
                    sessionStorage.removeItem('dan_need_scroll_down_count');
                } else {
                    sessionStorage.setItem('dan_need_scroll_down_count', String(gapScrollN + 1));
                    try { window.scrollBy({ top: 600, behavior: 'smooth' }); } catch (eSd) { try { window.scrollBy(0, 600); } catch (eSd2) {} }
                    try { showToast('📋 关注者缺口：下滚补登 ' + cellGap + (fGapT > 0 ? ('/' + fGapT) : '') + '（' + (gapScrollN + 1) + '/8）', '#faad14', 1200); } catch (eTsd) {}
                    noteSoftOutboundResidual(stNow.pending, 'gap_scroll_down');
                    return;
                }
            }

            // 4.6.59：浅扫也对账；缺口过大由 prepareAndSeal 再滚硬对齐
            var shPF = 0;
            try { shPF = readOwnFollowerCount() || 0; } catch (ePfSh) {}
            var shDbTotal = 0;
            try { shDbTotal = Object.keys(loadTargetDB() || {}).length; } catch (eDbSh) {}
            if (baselineOk && harvestPasses >= 1 && !iceQ.sealed) {
                console.log('[私信列表序] 顶部浅扫封口 pending=' + stNow.pending + ' passes=' + harvestPasses + ' seen=' + cellCount + ' 主页粉丝=' + shPF + ' 台账=' + shDbTotal + ' 缺口=' + (shPF > 0 && shDbTotal > 0 ? (shPF - shDbTotal) : 'N/A'));
                if (shPF > 0 && ((cellCount + 2 < shPF) || (shDbTotal > 0 && shDbTotal < shPF * 0.85))) {
                    console.warn('[粉丝对账] 浅扫缺口过大！主页=' + shPF + ' 已见=' + cellCount + ' 台账=' + shDbTotal);
                    try {
                        if (typeof SgTelemetry !== 'undefined') {
                            SgTelemetry.emit('chat.fan_roster_gap', {
                                cellsSeen: cellCount,
                                queueTotal: stNow.total,
                                gap: shPF - Math.max(cellCount, shDbTotal),
                                profileFollowers: shPF,
                                dbTotal: shDbTotal,
                                profileGap: true,
                                reason: 'shallow_gap',
                                pulseId: (iceQ && iceQ.pulseId) || ''
                            });
                        }
                    } catch (eEm2) {}
                    try {
                        showToast('⚠ 浅扫缺口：主页' + shPF + ' / 已见' + cellCount + ' → 再滚对齐', '#faad14', 2800);
                    } catch (eTsGap) {}
                }
                noteSoftOutboundResidual(stNow.pending, 'shallow_new_fans');
                prepareAndSealIceQueue(stNow.pending > 0 ? 'shallow_new_fans' : 'shallow_empty', function () {
                    var stSeal = iceQueueStats();
                    if (iceQueueHasOpenWork()) {
                        var nextSh = iceQueueNextPending();
                        if (nextSh) startIceTaskFromQueueItem(nextSh);
                        else finishIceOutboundAfterQueue('shallow_empty');
                    } else {
                        syncLedgerWithOps({ reason: 'shallow_seal_ops', allowPost: true }, function (res) {
                            var n = (res && res.added) || 0;
                            if (n > 0 && iceQueueHasOpenWork()) {
                                var nextOp2 = iceQueueNextPending();
                                if (nextOp2) startIceTaskFromQueueItem(nextOp2);
                                else finishIceOutboundAfterQueue('shallow_empty');
                            } else {
                                finishIceOutboundAfterQueue(stSeal.total > 0 ? 'all_skipped' : 'queue_empty');
                            }
                        });
                    }
                });
                return;
            }

            // 以下仅首扫全量：继续下滚直至触底
            window.scrollBy({ top: 200, behavior: 'smooth' });
            let failCount = parseInt(sessionStorage.getItem('dan_scroll_fail_count') || '0');
            sessionStorage.setItem('dan_scroll_fail_count', failCount + 1);

            let isPhysicalBottom = isFollowersListAtBottom();

            if (isPhysicalBottom) {
                let hasLoader = document.querySelector('[role="progressbar"]');
                // 4.6.125：触底封口计数改按「本拍无新增 UserCell」而非裸拍数；连续 2 拍「无加载条+无新增」才封
                let curCellsFull = document.querySelectorAll('[data-testid="UserCell"]').length;
                let prevCellsFull = parseInt(sessionStorage.getItem('dan_last_cells_seen') || '-1', 10);
                let noNewCells = (prevCellsFull === curCellsFull);
                sessionStorage.setItem('dan_last_cells_seen', String(curCellsFull));
                let bottomHitCount = parseInt(sessionStorage.getItem('dan_bottom_hit_count') || '0');
                if (!hasLoader && noNewCells) {
                    bottomHitCount += 1;
                    sessionStorage.setItem('dan_bottom_hit_count', String(bottomHitCount));
                } else {
                    bottomHitCount = 0;
                    sessionStorage.setItem('dan_bottom_hit_count', '0');
                }

                // 4.6.125：连续 2 拍触底确认才封口（旧 4.1.36 首见即封）
                if (!hasLoader && bottomHitCount >= 2) {
                    console.log('[私信列表序] 触底×2确认 → seal 粉丝队列 pending=' + stNow.pending + '（首扫建台账）');
                    noteSoftOutboundResidual(stNow.pending, 'bottom_confirmed');
                    prepareAndSealIceQueue(stNow.pending > 0 ? 'bottom_reached' : 'queue_empty', function () {
                        var stSeal = iceQueueStats();
                        if (iceQueueHasOpenWork()) {
                            var nextBot = iceQueueNextPending();
                            if (nextBot) startIceTaskFromQueueItem(nextBot);
                            else finishIceOutboundAfterQueue('bottom_empty');
                        } else {
                            finishIceOutboundAfterQueue(stSeal.total > 0 ? 'all_skipped' : 'queue_empty');
                        }
                    });
                    return;
                } else if (hasLoader) {
                    sessionStorage.setItem('dan_bottom_hit_count', '0');
                    showToast('⏳ 等待拉取新粉丝中...', '#faad14', 1500);
                } else {
                    showToast('⏬ 首扫全量触底确认中…', '#faad14', 1200);
                }
            } else {
                sessionStorage.setItem('dan_bottom_hit_count', '0');
                var scrollCap = 20;
                if (failCount > scrollCap) {
                    prepareAndSealIceQueue('scroll_timeout', function () {
                        if (iceQueueHasOpenWork()) {
                            var nextTo = iceQueueNextPending();
                            if (nextTo) startIceTaskFromQueueItem(nextTo);
                            else finishIceOutboundAfterQueue('scroll_timeout');
                        } else {
                            finishIceOutboundAfterQueue('scroll_timeout');
                        }
                    });
                    return;
                } else {
                    var seenN = 0;
                    try { seenN = getSessionList().length; } catch (eSeen) { seenN = 0; }
                    showToast('📋 首扫全量登记…已见 ' + seenN + ' · 待开 ' + stNow.pending + '（须触底，仅首趟）', '#1d9bf0', 1200);
                }
            }
            return;
        }

        if (currentStep === '1') {
            let pageText = document.body.innerText || '';
            if (pageLooksAccountGone(pageText)) {
                showToast('💀 账号已阵亡，跳过！', '#000', 3000);
                let deadHandle = sessionStorage.getItem('current_target');
                if (deadHandle) {
                    saveToDB('dan_reject_users', deadHandle);
                    sendLogToNAS(deadHandle, 'CORPSE', '封号阵亡');
                    try { iceQueueMark(deadHandle, 'skipped', 'corpse'); } catch (eDead) {}
                }
                sessionStorage.setItem('dan_auto_step', '4');
                return;
            }

            // 对方已屏蔽我：立刻永久 skipped（不等无 DM 的 2 拍）
            if (pageLooksTheyBlockedUs(pageText)) {
                var bh = sessionStorage.getItem('current_target');
                showToast('🚫 已被对方屏蔽 → 永久跳过', '#f85149', 2800);
                if (bh) {
                    try { saveToDB('dan_reject_users', bh); } catch (eRjB) {}
                    try { sendLogToNAS(bh, 'REJECT', 'they_blocked_us'); } catch (eLgB) {}
                    try { iceQueueMark(bh, 'skipped', 'they_blocked_us'); } catch (eIqB) {}
                    try { markPeerBlocked(bh, 'they_blocked_us'); } catch (eBlkB) {}
                    try { markDmVerified(bh, 'they_blocked_us'); } catch (eVfB) {}
                }
                sessionStorage.setItem('dan_wait_count', '0');
                sessionStorage.setItem('dan_auto_step', '4');
                return;
            }

            // 隐私/保护账号：关注侧早有方案；私信 step1 必须同样立刻 skipped，禁止空等无 DM 按钮
            var protectedHit = pageLooksProtectedAccount(pageText);
            let dmButton = findProfileDmButton();
            if (protectedHit && !dmButton) {
                var ph = sessionStorage.getItem('current_target');
                showToast('🔒 隐私账号无私信，跳过', '#faad14', 2500);
                if (ph) {
                    try { saveToDB('dan_reject_users', ph); } catch (eRj) {}
                    try { sendLogToNAS(ph, 'REJECT', '隐私账号'); } catch (eLg) {}
                    try { iceQueueMark(ph, 'skipped', 'protected'); } catch (eIq) {}
                    try { markPeerBlocked(ph, 'protected_no_dm'); } catch (eBlk) {}
                    try { markDmVerified(ph, 'protected'); } catch (eVfP) {}
                }
                sessionStorage.setItem('dan_wait_count', '0');
                sessionStorage.setItem('dan_auto_step', '4');
                return;
            }

            if (dmButton) {
                let waitCount = parseInt(sessionStorage.getItem('dan_profile_wait') || '0');
                if (waitCount > 0) {
                    let randomDir = Math.random() > 0.4 ? 1 : -0.5;
                    window.scrollBy({ top: randomDir * (200 + Math.random()*200), behavior: 'smooth' });
                    sessionStorage.setItem('dan_profile_wait', (waitCount - 1).toString());
                    return;
                }
                // 4.6.68：已点过仍停在资料页 → 私信钮打不开，直接拉黑
                var dmClickN = parseInt(sessionStorage.getItem('dan_dm_click_n') || '0', 10) || 0;
                if (dmClickN >= 2) {
                    var thDeadBtn = sessionStorage.getItem('current_target');
                    showToast('⛔ 私信按钮打不开 → 拉黑跳过', '#f85149', 2800);
                    if (thDeadBtn) {
                        try { finalizeUnsendablePeer(thDeadBtn, 'dm_button_dead'); } catch (eFd) {
                            try { markPeerBlocked(thDeadBtn, 'dm_button_dead'); } catch (eB) {}
                            try { iceQueueMark(thDeadBtn, 'skipped', 'dm_button_dead'); } catch (eIq) {}
                        }
                    }
                    sessionStorage.setItem('dan_dm_click_n', '0');
                    sessionStorage.setItem('dan_wait_count', '0');
                    sessionStorage.setItem('dan_auto_step', '4');
                    return;
                }
                sessionStorage.setItem('dan_dm_click_n', String(dmClickN + 1));
                sessionStorage.setItem('dan_wait_count', '0');
                // 4.6.110：过渡标记——点 DM 后先设 1_entering_dm，下 tick 确认在 DM 才升 2
                sessionStorage.setItem('dan_auto_step', '1_entering_dm');
                sessionStorage.setItem('dan_chat_wait_time', '0');
                // 4.6.101：点 DM 前 settle 加长，给资料页/按钮态时间（2.5–4s）
                var dmClickSettle = 2500 + Math.floor(Math.random() * 1500);
                setTimeout(function () { try { dmButton.click(); } catch (eDmClk) {} }, dmClickSettle);
            } else {
                let failDMCount = parseInt(sessionStorage.getItem('dan_wait_count') || '0');
                // 无 DM 按钮：最多再等 2 拍（防 SPA 未渲染），然后硬 skipped，禁止 doing 占坑反复进同一资料
                if (failDMCount >= 2) {
                    showToast('⛔ 未开启私信 → 拉黑跳过', '#f85149', 2800);
                    let targetHandle = sessionStorage.getItem('current_target');
                    if (targetHandle) {
                        try { finalizeUnsendablePeer(targetHandle, 'no_dm'); } catch (eFn) {
                            try { saveToDB('dan_reject_users', targetHandle); } catch (eRj2) {}
                            try { iceQueueMark(targetHandle, 'skipped', 'no_dm'); } catch (eIq2) {}
                            try { markPeerBlocked(targetHandle, 'no_dm'); } catch (eBlk2) {}
                        }
                        try { sendLogToNAS(targetHandle, 'REJECT', '未开启私信'); } catch (eLg2) {}
                    }
                    sessionStorage.setItem('dan_wait_count', '0');
                    sessionStorage.setItem('dan_dm_click_n', '0');
                    sessionStorage.setItem('dan_auto_step', '4');
                } else {
                    sessionStorage.setItem('dan_wait_count', String(failDMCount + 1));
                }
            }
        }

        if (currentStep === '2') {
            // 4.6.34：已在发送/分析中则早退，禁止主循环并行重入 sendOneOrDump
            try {
                if (sessionStorage.getItem('dan_dm_inflight') === '1') return;
            } catch (eInfEarly) {}
            const targetHandleEarly = sessionStorage.getItem('current_target');
            /** @param {{ skipInboxDone?: boolean }} [opts] */
            function finishTargetVisit(opts) {
                opts = opts || {};
                var th = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                // deferred/skipped 软离：未真正发出，禁止写 dan_sent_ 占坑
                if (th && opts.queueStatus !== 'deferred' && opts.queueStatus !== 'skipped' && opts.queueStatus !== 'failed') {
                    sessionStorage.setItem('dan_sent_' + th, 'true');
                }
                sessionStorage.setItem('dan_mem_cleaner_count', (parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0') + 1).toString());
                sessionStorage.setItem('dan_auto_step', '4');
                try { sessionStorage.removeItem('dan_dm_inflight'); } catch (eInfClr) {}
                // 4.6.101：离开会话前 settle 加长（2.5–4s），避免未反馈完就被回退带走
                try {
                    sessionStorage.setItem('dan_leave_settle_until', String(Date.now() + 2500 + Math.floor(Math.random() * 1500)));
                } catch (eLvSet) {}
                // 4.6.34：人间间隔 25–40s（rush 仍 70–120s）
                try {
                    var gapMs = isChatRushMode()
                        ? (70000 + Math.floor(Math.random() * 50000))
                        : (25000 + Math.floor(Math.random() * 15000));
                    sessionStorage.setItem('dan_next_target_at', String(Date.now() + gapMs));
                    console.log('[私信] 下一人间隔 ' + Math.round(gapMs / 1000) + 's');
                } catch (eGap) {}
                if (th && (getChatPhase() === 'outbound' || getChatPhase() === 'followup')) {
                    // 一窗一遍：显式 deferred/skipped/failed 优先；发送路径已标终态则勿用 iceSentAt 盖成 done
                    try {
                        var entQ = loadTargetDB()[th] || {};
                        var rQ = getUserRound(th) || 0;
                        var preSt = '';
                        try {
                            var qPre = loadIceTaskQueue();
                            var iPre = iceQueueFindIndex(qPre, th);
                            if (iPre >= 0) preSt = String(qPre.items[iPre].status || '');
                        } catch (ePre) { preSt = ''; }
                        if (opts.queueStatus === 'skipped' || opts.queueStatus === 'failed' || opts.queueStatus === 'deferred') {
                            iceQueueMark(th, opts.queueStatus, opts.queueReason || '');
                        } else if (preSt === 'deferred' || preSt === 'skipped' || preSt === 'failed') {
                            // 保留 recordDmAndAdvance / finalize 已写终态
                        } else if (entQ.blockedAt || entQ.rejectSentAt) {
                            iceQueueMark(th, 'skipped', opts.queueReason || entQ.blockReason || 'reject');
                        } else if (isChatFullyClosed(entQ) || rQ >= 3) {
                            iceQueueMark(th, 'done', opts.queueReason || 'completed');
                        } else if (entQ.adSentAt || entQ.iceSentAt || getKickCountLocal(entQ) >= 1 || rQ >= 1) {
                            iceQueueMark(th, 'done', opts.queueReason || 'pass_sent');
                        } else if (opts.skipInboxDone) {
                            iceQueueMark(th, 'deferred', opts.queueReason || 'soft_leave');
                        }
                    } catch (eIq) {}
                }
            }

            // 页面守卫：step2 却停在粉丝列表 → 禁止假「输入框未就绪」，回 step1 真开人
            try {
                if (isFollowersListPath(window.location.href)) {
                    try { sessionStorage.removeItem('dan_composer_miss'); } catch (eMc0) {}
                    var thOnFans = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                    if (thOnFans) {
                        // 节流：导航未完成时禁止每拍重开+弹 toast
                        var reopenAt = parseInt(sessionStorage.getItem('dan_fans_step2_reopen_at') || '0', 10) || 0;
                        if (Date.now() - reopenAt < 2800) {
                            return;
                        }
                        sessionStorage.setItem('dan_fans_step2_reopen_at', String(Date.now()));
                        console.warn('[私信] step2 误停粉丝列表 → 回 step1 重开 @' + thOnFans);
                        // 先清 step 再开人，避免 startIce「有 step 已在飞」早退导致根本不点
                        try { sessionStorage.removeItem('dan_auto_step'); } catch (eClrSt) {}
                        sessionStorage.setItem('dan_wait_count', '0');
                        sessionStorage.setItem('current_target', thOnFans);
                        try {
                            var doingItem = iceQueueCurrentDoing();
                            var opened = false;
                            if (doingItem && normalizeChatHandle(doingItem.handle) === thOnFans) {
                                opened = !!startIceTaskFromQueueItem(doingItem);
                            }
                            if (!opened) {
                                sessionStorage.setItem('dan_auto_step', '1');
                                var linkFix = findUserCellLinkByHandle(thOnFans);
                                if (linkFix) linkFix.click();
                                else chatGo('/' + thOnFans, false);
                            }
                        } catch (eRe) {
                            sessionStorage.setItem('dan_auto_step', '1');
                            chatGo('/' + thOnFans, false);
                        }
                    } else {
                        sessionStorage.removeItem('dan_auto_step');
                    }
                    return;
                }
            } catch (eSurf) {}

            // 粉丝队列：误落 CHAT → 拉回（与 main_pre_step 同逻辑）
            try {
                if (recoverFanQueueOffChatSurface('step2')) return;
            } catch (eShell) {}

            // 4.6.68/69：只读 / 硬封闭 → 立刻拉黑（不等 composer 超时）
            try {
                var thRo = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                var readOnlyHit = false;
                try { readOnlyHit = pageLooksDmReadOnly(); } catch (eRoHit) { readOnlyHit = false; }
                var sendClsEarly = null;
                try { sendClsEarly = classifyDmSendability(); } catch (eCl) { sendClsEarly = null; }
                if (thRo && (readOnlyHit || (sendClsEarly && sendClsEarly.verdict === 'hard_closed'))) {
                    finalizeUnsendablePeer(thRo, readOnlyHit ? 'read_only' : 'hard_closed');
                    reportSessionVerdict('gate_blocked', {
                        target: thRo, round: getUserRound(thRo) || 0,
                        gate_reason: 'peer_blocked',
                        detail: readOnlyHit ? 'read_only_toast' : 'hard_closed_early'
                    });
                    finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: readOnlyHit ? 'read_only' : 'hard_closed' });
                    return;
                }
            } catch (eRo) {}

            // 4.6.123：step2 DM 会话页 / 资料页封禁·不存在文案 → 直接拉黑（不等 composer 超时）
            try {
                var thGone2 = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                if (thGone2 && pageLooksAccountGone()) {
                    showToast('💀 账号已阵亡，跳过！', '#000', 3000);
                    try { saveToDB('dan_reject_users', thGone2); } catch (eGone1) {}
                    try { sendLogToNAS(thGone2, 'CORPSE', '封号阵亡'); } catch (eGone2) {}
                    reportSessionVerdict('gate_blocked', {
                        target: thGone2, round: getUserRound(thGone2) || 0,
                        gate_reason: 'corpse', detail: 'dm_surface_gone'
                    });
                    finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'corpse' });
                    return;
                }
            } catch (eGoneSt2) {}

            // 4.6.68/69：点了私信仍停在资料页（非 DM/非粉丝列表）→ ≥2 拍拉黑
            try {
                var pathSt2 = String(window.location.pathname || '').toLowerCase();
                var onDmSt2 = isDmPath(pathSt2);
                var onFansSt2 = isFollowersListPath(window.location.href);
                if (!onDmSt2 && !onFansSt2) {
                    var stayProf = parseInt(sessionStorage.getItem('dan_dm_stay_profile') || '0', 10) || 0;
                    stayProf += 1;
                    sessionStorage.setItem('dan_dm_stay_profile', String(stayProf));
                    if (stayProf >= 2) {
                        var thStay = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                        if (thStay) {
                            finalizeUnsendablePeer(thStay, 'dm_button_dead');
                            finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'dm_button_dead' });
                            return;
                        }
                    }
                } else {
                    try { sessionStorage.removeItem('dan_dm_stay_profile'); } catch (eSp) {}
                    try { sessionStorage.removeItem('dan_dm_click_n'); } catch (eCn) {}
                }
            } catch (eStay) {}

            // 无输入框 + Use X Number/verified 硬门：立刻拉黑跳过，禁止空等再点
            try {
                var thEarlyDead = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                if (thEarlyDead && !findBottomAwakeningTarget() && detectDmSendUnavailable()) {
                    finalizeUnsendablePeer(thEarlyDead, 'x_number_gate');
                    finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'x_number_gate' });
                    return;
                }
            } catch (eXd) {}

            // 4.1.53：PIN 门检出立即填 2546；填完门消失则继续 round 决策
            if (isDmPinBlockedForSend()) {
                var pinTry = null;
                try { pinTry = tryUnlockDmPin(); } catch (ePinU) { pinTry = null; }
                if (!isDmPinBlockedForSend()) {
                    // 已解锁，落入下方发送
                } else {
                    reportDmPinGate({
                        ok: false,
                        reason: (pinTry && pinTry.pending_verify) ? 'pending_verify' : 'send_blocked_before_round_detection',
                        gate_visible: true
                    });
                    if (pinTry && (pinTry.ok || pinTry.pending_verify || pinTry.throttled)) {
                        showToast('🔓 已填 PIN 2546，等待解锁…', '#1d9bf0', 2800);
                    } else {
                        showToast('🔓 正在填入 PIN 2546…', '#ff8c00', 2500);
                        try { tryUnlockDmPin(); } catch (ePin2) {}
                    }
                    if (getChatPhase() === 'outbound') {
                        try { noteChatProgress('ice_pin_wait'); } catch (ePinW) {}
                        return;
                    }
                    finishTargetVisit({ skipInboxDone: true });
                    return;
                }
            }
            var wakeUpTarget = findBottomAwakeningTarget();
            if (!wakeUpTarget) {
                // 4.3.6：先有「私信」壳时点一下再认口，避免假 composer_miss
                try {
                    if (wakeDmComposerShell()) {
                        wakeUpTarget = findBottomAwakeningTarget();
                    }
                } catch (eWake) {}
            }
            if (!wakeUpTarget) {
                var missKey = 'dan_composer_miss';
                var missN = (parseInt(sessionStorage.getItem(missKey) || '0', 10) || 0) + 1;
                sessionStorage.setItem(missKey, String(missN));
                // 偶数次 miss 再点壳（给 X 挂 textarea 的时间）
                if (missN % 2 === 1) {
                    try { wakeDmComposerShell(); } catch (eW2) {}
                }
                var thMiss = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                var uiDead = false;
                try { uiDead = detectDmSendUnavailable(); } catch (eUi) {}
                // 仅「会话内明确不可发」才永久完结；纯 DOM 未就绪只跳过本轮，禁止误杀导致 1/2/3 轮次机停转
                if (thMiss && uiDead) {
                    finalizeUnsendablePeer(thMiss, 'x_number_gate');
                    finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'x_number_gate' });
                    return;
                }
                if (missN >= 8) {
                    try { sessionStorage.removeItem(missKey); } catch (eMk2) {}
                    console.warn('[私信] composer 多次未就绪，本趟 deferred @' + thMiss + ' miss=' + missN);
                    showToast('⏳ 输入框未就绪，本趟跳过', '#faad14', 2200);
                    finishTargetVisit({
                        skipInboxDone: true,
                        queueStatus: 'deferred',
                        queueReason: 'composer_miss'
                    });
                }
                return;
            }
            try { sessionStorage.removeItem('dan_composer_miss'); } catch (eMc) {}
            // 真会话已就绪：清空壳累计，避免下次误 deferred
            try {
                var thShellOk = normalizeChatHandle(targetHandleEarly || sessionStorage.getItem('current_target') || '');
                if (thShellOk) sessionStorage.removeItem('dan_empty_shell_n_' + thShellOk);
            } catch (eClrShell) {}

            const targetHandle = sessionStorage.getItem('current_target');
            if (!targetHandle) { sessionStorage.setItem('dan_auto_step', '4'); return; }
            // 身份正向证明：pending 只等待；真冲突才报「不一致」
            // 粉丝队列：错会话只 deferred 回粉丝页，不用守箱 inboxQueueMark / 「不一致」toast
            var idAssert = assertDmConversationMatchesTarget(targetHandle);
            var fanIdMode = false;
            try {
                fanIdMode = !isInboxWatchEnabled()
                    || getChatPhase() === 'outbound'
                    || getChatPhase() === 'followup'
                    || sessionStorage.getItem('dan_dm_entry_via') === 'fan_roster';
            } catch (eFm) { fanIdMode = true; }
            // 4.1.51：粉丝队列从资料进 DM 的空会话常无页头 @（仅 Unencrypted 框）——
            // 无真冲突且已有可发框时，短等后按 current_target + 目标库 round 发送，禁止空等到超时「跳回」
            if (!idAssert.ok && idAssert.reason === 'identity_pending' && fanIdMode) {
                try {
                    var viaFan = sessionStorage.getItem('dan_dm_entry_via') === 'fan_roster'
                        || getChatPhase() === 'outbound'
                        || getChatPhase() === 'followup';
                    var idWaitPeek = parseInt(sessionStorage.getItem('dan_dm_id_wait_' + normalizeChatHandle(targetHandle)) || '0', 10) || 0;
                    if (viaFan && hasSendableDmComposer() && idWaitPeek >= 2) {
                        idAssert = {
                            ok: true,
                            reason: 'ok_fan_roster_composer',
                            urlPeerId: idAssert.urlPeerId || '',
                            headerHandle: idAssert.headerHandle || '',
                            dbPeerId: idAssert.dbPeerId || ''
                        };
                        console.log('[私信] 粉丝队列空会话放行（有框+目标库轮次）@' + targetHandle);
                    }
                } catch (eFanId) {}
            }
            if (!idAssert.ok) {
                if (idAssert.reason === 'identity_pending' || idAssert.reason === 'no_target') {
                    try { sessionStorage.setItem('dan_last_healthy_time', Date.now().toString()); } catch (eHt2) {}
                    try { noteChatProgress('identity_pending_step2'); } catch (eNp2) {}
                    var idWaitKey = 'dan_dm_id_wait_' + normalizeChatHandle(targetHandle);
                    var idWaitN = (parseInt(sessionStorage.getItem(idWaitKey) || '0', 10) || 0) + 1;
                    sessionStorage.setItem(idWaitKey, String(idWaitN));
                    try { captureDmPeerId(targetHandle); } catch (eCap) {}
                    var hardCap = 24;
                    try {
                        if (findBottomAwakeningTarget() || idAssert.urlPeerId) hardCap = 16;
                    } catch (eHc) {}
                    if (idWaitN >= hardCap) {
                        try { sessionStorage.removeItem(idWaitKey); } catch (eClr) {}
                        console.warn('[私信] 身份证据超时 @' + targetHandle, idAssert);
                        if (fanIdMode) {
                            finishTargetVisit({
                                skipInboxDone: true,
                                queueStatus: 'deferred',
                                queueReason: 'identity_timeout'
                            });
                        } else {
                            finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'identity_timeout' });
                        }
                    }
                    return;
                }
                // header/peer 真冲突
                if (fanIdMode) {
                    console.warn('[私信] 粉丝队列错会话面，deferred 回粉丝页 @' + targetHandle, idAssert);
                    try { sessionStorage.removeItem('dan_dm_id_wait_' + normalizeChatHandle(targetHandle)); } catch (eClr2) {}
                    reportSessionVerdict('gate_blocked', {
                        target: targetHandle,
                        round: getUserRound(targetHandle),
                        gate_reason: 'stale_dm_surface',
                        detail: idAssert.reason || '',
                        url_peer_id: idAssert.urlPeerId || '',
                        header_handle: idAssert.headerHandle || '',
                        db_peer_id: idAssert.dbPeerId || ''
                    });
                    finishTargetVisit({
                        skipInboxDone: true,
                        queueStatus: 'deferred',
                        queueReason: 'stale_dm_surface'
                    });
                    return;
                }
                reportSessionVerdict('gate_blocked', {
                    target: targetHandle,
                    round: getUserRound(targetHandle),
                    gate_reason: 'target_mismatch',
                    detail: idAssert.reason || '',
                    url_peer_id: idAssert.urlPeerId || '',
                    header_handle: idAssert.headerHandle || '',
                    db_peer_id: idAssert.dbPeerId || ''
                });
                console.warn('[私信] 会话身份不匹配，中止 @' + targetHandle, idAssert);
                showToast('⚠️ 会话与目标不一致，跳过', '#faad14', 2800);
                try { sessionStorage.removeItem('dan_dm_id_wait_' + normalizeChatHandle(targetHandle)); } catch (eClr2b) {}
                finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: idAssert.reason || 'target_mismatch' });
                return;
            }
            try { sessionStorage.removeItem('dan_dm_id_wait_' + normalizeChatHandle(targetHandle)); } catch (eClr3) {}
            // 新版收件箱无 handle：进入会话页后从 URL 捕获对方数字ID，供下次收件箱列表精确匹配
            captureDmPeerId(targetHandle);

            // 查询三轮状态：已完成3轮的跳过
            var myHandle = sessionStorage.getItem('dan_target_username');
            var userRound = getUserRound(targetHandle);
            if (userRound >= 3) {
                finishTargetVisit();
                return;
            }
            try {
                var earlyEntry = loadTargetDB()[targetHandle] || {};
                if (earlyEntry.blockedAt || earlyEntry.done && earlyEntry.rejectSentAt) {
                    finishTargetVisit();
                    return;
                }
            } catch (eEarlyBlk) {}
            if (!isChatTargetAllowed(targetHandle)) {
                console.log('[私信定格] 跳过今日非定格目标 @' + targetHandle);
                reportChatMetric('chat.reply_blocked', { target: targetHandle, reason: 'freeze_block' });
                reportSessionVerdict('freeze_block', { target: targetHandle, round: getUserRound(targetHandle) });
                finishTargetVisit();
                return;
            }

            // DM 面板加载检测
            var waitKey = 'dan_dm_ready_wait_' + targetHandle;
            var waitCount = parseInt(sessionStorage.getItem(waitKey) || '0');
            var isReady = (function() {
                var input = findBottomAwakeningTarget();
                var sendBtn = findDmSendButton();
                if (!sendBtn && input) {
                    var parent = input.closest('div[data-testid], form, section');
                    var btns = parent ? parent.querySelectorAll('button[aria-label], [role="button"], button[type]') : [];
                    if (btns.length > 0) {
                        sendBtn = btns[btns.length - 1];
                        console.log('[DM检测] 兜底找到sendBtn:', sendBtn.getAttribute('aria-label') || sendBtn.getAttribute('data-testid') || 'NO-LABEL');
                    }
                }
                if (waitCount === 0) {
                    console.log('[DM检测] input:', input ? (input.tagName + '.' + (input.className || '').substring(0,40)) : 'NULL',
                        'disabled:', input ? input.disabled : 'N/A');
                    console.log('[DM检测] sendBtn:', sendBtn ? (sendBtn.tagName + ' aria-label=' + (sendBtn.getAttribute('aria-label') || 'none')) : 'NULL');
                    console.log('[DM检测] all contenteditable:', document.querySelectorAll('[contenteditable="true"]').length);
                }
                // 新版 X：输入框就绪即视为可用（发送按钮仅在有文字时出现，发送走 Enter 兜底）
                return !!(input && !input.disabled);
            })();

            if (!isReady) {
                tryUnlockDmPin();
                // 无框+硬门：拉黑 skipped，禁止空等后再点进
                var waitDead = false;
                try { waitDead = detectDmSendUnavailable(); } catch (eWd) {}
                if (waitDead) {
                    try { sessionStorage.removeItem(waitKey); } catch (eWk) {}
                    finalizeUnsendablePeer(targetHandle, 'x_number_gate');
                    reportSessionVerdict('gate_blocked', {
                        target: targetHandle, round: 0, gate_reason: 'peer_blocked', detail: 'read_only_ready_wait'
                    });
                    finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'x_number_gate' });
                    return;
                }
                if (waitCount >= 5) {
                    var dmGateVisible = false;
                    try { dmGateVisible = isDmPinGateVisible(); } catch (eG) {}
                    if (dmGateVisible) {
                        showToast('🔒 DM 被 Passcode 拦截，请手动解锁', '#ff8c00', 3500);
                        reportDmPinGate({ ok: false, reason: 'dm_panel_timeout', gate_visible: true });
                    } else {
                        showToast('❌ DM加载超时，跳过', '#ff4d4f', 2000);
                    }
                    sessionStorage.removeItem(waitKey);
                    finishTargetVisit({
                        skipInboxDone: true,
                        queueStatus: 'deferred',
                        queueReason: 'dm_panel_timeout'
                    });
                    return;
                }
                sessionStorage.setItem(waitKey, (waitCount + 1).toString());
                showToast('⏳ DM面板加载中... (' + waitCount + 's)', '#faad14', 2000);
                if (waitCount >= 2) {
                    reportChatMetric('chat.reply_waiting', { target: targetHandle, reason: 'dm_panel_not_ready', wait_sec: waitCount });
                }
                return;
            }
            sessionStorage.removeItem(waitKey);

            // 根据轮次获取消息并发送；赶工窗对 round>=1 连续发完剩余轮次
            var roundNames = ['❄️ 破冰', '🎣 广告', '🛡️ 盾牌'];
            var actionTypes = ['ICEBREAKER', 'AD', 'KICK'];
            // finishTargetVisit：skipInboxDone=true 表示已见回复但未到发送窗，本轮不拉黑，守箱窗口内可再打开

            /** 发送 → UI 确认 → OPS success 后再推进；未确认上报 failed 且不推进 */
            async function recordDmAndAdvance(msgToSend, userRound) {
                var roundName = roundNames[userRound] || '未知';
                if (userRound === 2) {
                    try {
                        var kcRn = getKickCountLocal(loadTargetDB()[normalizeChatHandle(targetHandle)] || {});
                        roundName = kcRn >= 1 ? '📣 催加' : '🛡️ 盾牌';
                    } catch (eRn) {}
                }
                var roundNumber = (userRound || 0) + 1;
                debugChatLog('待发 @' + targetHandle + ' round=' + roundNumber + ': ' + msgToSend, {
                    step: 'before_send', target: targetHandle, round: roundNumber, text: msgToSend
                });
                if (isDryRun()) {
                    dryRunPreview(targetHandle, userRound, msgToSend, {});
                    return false;
                }
                showToast(roundName + '发送中…(第' + roundNumber + '轮)', '#1d9bf0', 25000);
                sendLogToNAS(targetHandle, actionTypes[userRound] || 'AD', '第' + roundNumber + '轮:' + roundName, msgToSend);

                dmTracePush('send', { target: targetHandle, round: roundNumber, text: '开始发送 ' + roundName });
                var confirm = await threadSafeSendAndConfirm(wakeUpTarget, msgToSend);
                if (!confirm || !confirm.ok) {
                    var failReason = (confirm && confirm.reason) || 'unknown';
                    console.warn('[私信] 发送未确认', confirm);
                    debugChatLog('发送失败 @' + targetHandle + ' reason=' + failReason, {
                        step: 'send_fail', target: targetHandle, round: roundNumber, reason: failReason, level: 'warn'
                    });
                    dmTracePush('send', { target: targetHandle, round: roundNumber, text: '发送失败：' + failReason });
                    reportDmHealthEvent('DM_SEND_UNCONFIRMED', {
                        target: targetHandle,
                        round: roundNumber,
                        reason: failReason,
                        round_name: roundName
                    });
                    try {
                        reportSessionVerdict('send_unconfirmed', {
                            target: targetHandle,
                            round: userRound,
                            gate_reason: failReason,
                            round_name: roundName
                        });
                    } catch (eSv) {}
                    try {
                        await opsDmRecord(targetHandle, roundNumber, msgToSend, 'failed');
                    } catch (eFail) {}
                    var failStreak = noteSendFailStreak(targetHandle, failReason);
                    // 4.1.57：发送失败后若已无面板输入框 → 立即无法私信拉黑（禁止「气泡未确认下窗再试」反复点进）
                    var uiDeadNow = false;
                    var noComposerNow = false;
                    try { noComposerNow = !hasSendableDmComposer(); } catch (eNc) { noComposerNow = false; }
                    try { uiDeadNow = detectDmSendUnavailable(); } catch (eUd) {}
                    if (uiDeadNow || (noComposerNow && (failReason === 'no_bubble' || failReason === 'no_input' || failReason === 'no_send_btn'))) {
                        finalizeUnsendablePeer(targetHandle, noComposerNow && !uiDeadNow ? 'no_composer_after_send' : 'x_number_gate');
                    } else if (failReason === 'no_bubble' && failStreak < 2) {
                        try {
                            iceQueueMark(targetHandle, 'deferred', 'no_bubble_retry');
                        } catch (eIqDef) {}
                        showToast('⚠️ ' + roundName + '气泡未确认，本趟跳过（下窗再试）', '#faad14', 2800);
                    } else if (failReason === 'no_bubble' || (failStreak >= 3 && detectDmSendUnavailable()) || (failStreak >= 5)) {
                        markPeerBlocked(targetHandle, failReason === 'no_bubble'
                            ? 'send_no_bubble'
                            : ('send_fail_' + failReason));
                        try {
                            iceQueueMark(targetHandle, 'skipped', failReason === 'no_bubble' ? 'send_no_bubble' : 'send_fail_block');
                        } catch (eIqBlk) {}
                        showToast('⛔ ' + roundName + (failReason === 'no_bubble'
                            ? '气泡连败未确认，拉黑跳过'
                            : '连续失败，可能已拉黑，完结'), '#f85149', 2800);
                    } else {
                        // 类别与轮次对应：破冰/广告/催加各自提示，避免笼统「未检测」
                        // 4.6.34：fill_failed:* 前缀归入「填入话术失败」
                        var tipMap = {
                            no_bubble: '已点发送但会话气泡未确认',
                            no_input: '找不到输入框',
                            click_failed: '发送按钮点击失败',
                            fill_failed: '填入话术失败',
                            dry_run: '干跑未真发'
                        };
                        var tipKey = failReason;
                        if (String(failReason || '').indexOf('fill_failed') === 0) tipKey = 'fill_failed';
                        var tip = tipMap[tipKey] || ('确认失败:' + failReason);
                        showToast('⚠️ ' + roundName + tip + '，本轮不计数', '#faad14', 3200);
                    }
                    return false;
                }
                try { sessionStorage.removeItem('dan_send_fail_' + normalizeChatHandle(targetHandle)); } catch (eClr) {}

                // 4.1.56：会话气泡已确认 → 本地轮次必须推进；OPS 失败只告警，禁止「未计数」连环重发同人
                var resp = null;
                try {
                    resp = await opsDmRecord(targetHandle, roundNumber, msgToSend, 'success');
                } catch (eOpsRec) {
                    resp = { ok: false, msg: String((eOpsRec && eOpsRec.message) || eOpsRec || 'ops_throw') };
                }
                var opsOk = !!(resp && resp.ok);
                if (!opsOk) {
                    console.warn('[私信] OPS 上报失败，仍按本地计数防重发', resp);
                    reportDmHealthEvent('DM_REPORT_FAILED', {
                        target: targetHandle,
                        round: roundNumber,
                        reason: (resp && (resp.reason || resp.msg)) || 'report_failed',
                        local_advanced: true,
                        backfill_filled: (resp && resp.filled) || undefined
                    });
                    try {
                        reportSessionVerdict('ops_report_failed_local_ok', {
                            target: targetHandle,
                            round: userRound,
                            gate_reason: (resp && (resp.reason || resp.msg)) || 'report_failed',
                            round_name: roundName
                        });
                    } catch (eSv2) {}
                    var opsFailTip = '⚠️ ' + roundName + '已发出，后台记账失败，已按本地计数';
                    if (resp && resp.reason === 'round_gap_backfill_failed') {
                        opsFailTip = '⚠️ ' + roundName + '已发出，后台缺轮补记失败，已按本地计数';
                    }
                    showToast(opsFailTip, '#faad14', 2800);
                } else if (resp && resp.backfilled && resp.backfilled.length) {
                    try {
                        console.log('[私信] OPS 本轮记账含补记', resp.backfilled);
                    } catch (eBfLog) {}
                }

                var iceLatencyMs = null;
                if (userRound === 1) {
                    try {
                        var latEntry = loadTargetDB()[targetHandle] || {};
                        if (latEntry.lastDM) iceLatencyMs = Date.now() - latEntry.lastDM;
                    } catch (eLat) {}
                }
                // 4.6.34：发送成功后停留 4–7s（模拟真人发完看一眼），放慢节奏
                var postSendStayMs = 4000 + Math.floor(Math.random() * 3000);
                console.log('[私信发送] 发送成功，停留 ' + Math.round(postSendStayMs/1000) + ' 秒后离开');
                await __dmSleep(postSendStayMs);
                markUserDone(myHandle, targetHandle);
                if (userRound === 0) {
                    try { sessionStorage.setItem('dan_iced_' + normalizeChatHandle(targetHandle), '1'); } catch (eLock) {}
                }
                maybeRefreshOpsRoundMap(true);
                try {
                    if (userRound === 0) iceQueueMark(targetHandle, 'done', opsOk ? 'ice_sent' : 'ice_sent_local');
                } catch (eIceQ) {}
                try { rememberSentScriptText(targetHandle, userRound, msgToSend); } catch (eMem) {}
                if (iceLatencyMs != null) {
                    console.log('[诊断] ice_to_ad_latency_ms=' + iceLatencyMs);
                    reportChatMetric('ice_to_ad_latency_ms', { latency_ms: iceLatencyMs, target: targetHandle });
                }
                try {
                    var expId = sessionStorage.getItem('dan_last_experiment_id') || '';
                    if (userRound === 0) {
                        reportChatMetric('ice_sent', { target: targetHandle, experiment_id: expId, ops_ok: opsOk });
                        reportSessionVerdict('ice_sent', { target: targetHandle, round: 0, ops_ok: opsOk });
                    }
                    if (userRound === 1) {
                        reportChatMetric('ad_sent', { target: targetHandle, experiment_id: expId, ops_ok: opsOk });
                        var isGreetAd = false;
                        try { isGreetAd = sessionStorage.getItem('dan_pending_greeting_ad') === '1'; } catch (eGa) {}
                        reportSessionVerdict(isGreetAd ? 'greeting_ad' : 'ad_sent', {
                            target: targetHandle,
                            round: 1,
                            experiment_id: expId,
                            ops_ok: opsOk
                        });
                        try { markAdBubbleOk(targetHandle); } catch (eAdOk) {}
                        try {
                            markPeerTextsProcessed(
                                targetHandle,
                                sessionStorage.getItem('dan_pending_peer_hash') || '',
                                { adSentAt: Date.now() }
                            );
                            sessionStorage.removeItem('dan_pending_greeting_ad');
                            sessionStorage.removeItem('dan_pending_peer_hash');
                        } catch (eHashAd) {}
                    }
                    if (userRound === 2) {
                        var kcNow = bumpKickCountAndMaybeClose(targetHandle);
                        reportChatMetric('kick_sent', { target: targetHandle, experiment_id: expId, kickCount: kcNow, ops_ok: opsOk });
                        reportSessionVerdict('kick_sent', { target: targetHandle, round: 2, kickCount: kcNow, ops_ok: opsOk });
                        if (kcNow >= ((window.SgChatGates && window.SgChatGates.KICK_MAX_COUNT) || 2)) {
                            try { iceQueueMark(targetHandle, 'done', 'kick_max'); } catch (eIqK) {}
                        }
                    }
                } catch (eMet) {}
                try {
                    var dmHist = JSON.parse(localStorage.getItem('sg_dm_history') || '[]');
                    dmHist.push({
                        target: targetHandle,
                        round: roundNumber,
                        msg: msgToSend,
                        time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
                        result: opsOk ? 'success' : 'success_local',
                        confirm: confirm.reason || '',
                        ops_ok: opsOk
                    });
                    if (dmHist.length > 200) dmHist = dmHist.slice(-200);
                    localStorage.setItem('sg_dm_history', JSON.stringify(dmHist));
                } catch (eH) {}
                return true;
            }

            async function sendOneOrDump() {
                // 4.6.110：步骤前置校验——step=2 必须在 DM 会话页才能发送
                try {
                    var _inDm = isDmConversationView() || isDmConversationPage();
                    if (!_inDm) {
                        // 不在 DM 会话 → 清 step 回退，让主循环重新导航
                        sessionStorage.removeItem('dan_auto_step');
                        try { sessionStorage.removeItem('dan_dm_inflight'); } catch (eInfClr) {}
                        var _mmKey = 'dan_step_mismatch_' + (targetHandle || 'unknown');
                        var _mmCount = parseInt(sessionStorage.getItem(_mmKey) || '0') + 1;
                        sessionStorage.setItem(_mmKey, String(_mmCount));
                        if (_mmCount >= 3) {
                            // 3 次不匹配 → deferred，不死循环
                            try { iceQueueMark(targetHandle, 'deferred', 'step_mismatch_not_in_dm'); } catch (eMk) {}
                            finishTargetVisit({ queueStatus: 'deferred', queueReason: 'step_mismatch_not_in_dm' });
                            sessionStorage.removeItem(_mmKey);
                        } else {
                            try { showToast('⚠️ 步骤不匹配：发送需要 DM 会话页，回退重试', '#faad14', 2000); } catch (eT) {}
                            try { if (typeof SgTelemetry !== 'undefined') SgTelemetry.emit('chat.step_mismatch', { step: '2', page: location.pathname, target: targetHandle, count: _mmCount, action: 'retry' }); } catch (eT) {}
                        }
                        return;
                    }
                    // 校验通过，清计数
                    sessionStorage.removeItem('dan_step_mismatch_' + (targetHandle || 'unknown'));
                } catch (eGuard) {}
                // 4.6.34：进入异步体即锁（belt-and-suspenders，与调用前锁双保险）
                try {
                    sessionStorage.setItem('dan_auto_step', '2_waiting');
                    sessionStorage.setItem('dan_dm_inflight', '1');
                } catch (eLockIn) {}
                if (isFleetHandle(targetHandle)) {
                    rejectFleetHandle(targetHandle);
                    finishTargetVisit();
                    return;
                }

                // OPS 权威轮次：必须拿到有效 check 才发送（失败关闭，防 OPS 宕机时同轮重发）
                // 4.6.34：校验横幅（比特无控制台）
                try { showToast('⏳ 后台校验 @' + targetHandle + '…', '#8b949e', 4000); } catch (eOpsToast) {}
                var check = await opsDmCheck(targetHandle);
                debugChatLog('opsDmCheck @' + targetHandle + ' allowed=' + (check && check.allowed) + ' reason=' + ((check && check.reason) || '') + ' round=' + ((check && check.current_round) != null ? check.current_round : '?'), {
                    step: 'ops_check', target: targetHandle, reason: (check && check.reason) || '', round: check && check.current_round
                });
                // 4.1.41：忽略 OPS 日私信条数上限（旧默认 50；节流靠关注+填窗）
                if (check && check.reason === 'dm_limit_reached') {
                    check.allowed = true;
                    check.reason = '';
                    try {
                        if (typeof SgTelemetry !== 'undefined') {
                            SgTelemetry.emit('chat.dm_limit_ignored', { target: targetHandle });
                        }
                    } catch (eIg) {}
                }
                if (!check || !check.ok) {
                    var failReason = (check && check.reason) ? check.reason : ((check && check.msg) ? check.msg : 'unknown');
                    var failReasonText = {
                        account_not_registered: '账号未注册，先启动插件注册',
                        fleet_target: '目标是号池账号，禁止互发',
                        dm_limit_reached: '今日私信上限已满',
                        already_completed: '该目标已完成3轮私信',
                        check_error: '后台校验异常',
                        frontend_timeout: '后台校验超时（内外网均未在预算内响应）',
                        ops_unreachable: '后台校验不可达（内网/外网均失败）',
                        round_gap: '私信轮次跳号'
                    }[failReason] || ('后台校验失败: ' + failReason);
                    console.warn('[私信] OPS 轮次校验失败，跳过发送 @' + targetHandle, check);
                    showToast('⚠️ ' + failReasonText + '，暂不发送', '#faad14', 3000);
                    reportDmHealthEvent('DM_CHECK_FAILED', {
                        target: targetHandle,
                        reason: failReason,
                        payload: check || {},
                    });
                    // 不抬本地轮次；软失败 deferred，硬完结 skipped
                    var softFail = !check || failReason === 'check_error' || failReason === 'unknown' || failReason === 'dm_limit_reached' || failReason === 'frontend_timeout' || failReason === 'ops_unreachable';
                    finishTargetVisit({
                        skipInboxDone: true,
                        queueStatus: softFail ? 'deferred' : 'skipped',
                        queueReason: 'ops_' + failReason
                    });
                    return;
                }
                if (check.allowed === false) {
                    if (check.reason === 'fleet_target') rejectFleetHandle(targetHandle);
                    if (check.reason === 'already_completed' || (check.current_round != null && check.current_round >= 3)) {
                        setUserRound(targetHandle, 3);
                    }
                    var blockReasonText = {
                        fleet_target: '目标是号池账号，禁止互发',
                        dm_limit_reached: '今日私信上限已满',
                        already_completed: '该目标已完成3轮私信'
                    }[check.reason] || (check.reason || 'blocked');
                    console.log('[私信] OPS 拒绝 @' + targetHandle + ':', check.reason || 'blocked');
                    showToast('⛔ ' + blockReasonText, '#faad14', 2500);
                    var opsDone = check.reason === 'already_completed' || check.reason === 'fleet_target'
                        || (check.current_round != null && check.current_round >= 3);
                    finishTargetVisit({
                        skipInboxDone: true,
                        queueStatus: opsDone ? 'skipped' : 'deferred',
                        queueReason: 'ops_' + (check.reason || 'blocked')
                    });
                    return;
                }
                // OPS 只升不降：本地婉拒/已发广告优先于滞后的 current_round
                var opsRound = Number(check.current_round);
                if (isNaN(opsRound) || opsRound < 0) opsRound = 0;
                applyOpsMaxRound(targetHandle, opsRound);
                var userRound = getUserRound(targetHandle);
                if (userRound >= 3) {
                    finishTargetVisit();
                    return;
                }

                // 4.6.62：粉丝台账模式 — 只认队列 kind/reason，禁止 step2 自行改轮次/破冰
                var ledgerItem = null;
                var ledgerForceRound = null;
                var ledgerSkipHeuristics = false;
                if (isFanLedgerOutboundMode()) {
                    ledgerItem = getFanQueueItemForHandle(targetHandle);
                    var ledgerEn = enforceLedgerOnDmOpen(targetHandle);
                    if (applyLedgerSkipFromEnforce(targetHandle, ledgerEn)) {
                        finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: ledgerEn.reason });
                        return;
                    }
                    try { markDmVerified(targetHandle, 'ledger_open'); } catch (eVfL) {}
                    if (ledgerItem && ledgerItem.status === 'doing') {
                        if (ledgerItem.kind === 'ad' && ledgerItem.reason === 'need_probe') {
                            var rejectDbL = getDB('dan_reject_users');
                            var completedBkL = [];
                            try { completedBkL = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]'); } catch (eCbL) {}
                            var clsProbe = classifyFanRosterAction(targetHandle, rejectDbL, completedBkL, ensureChatFreeze());
                            // 仍可行动：保持 doing，只更新 kind/reason（禁止 demote→pending 让下一人插队）
                            if (clsProbe.status === 'pending') {
                                iceQueueMark(targetHandle, 'doing', clsProbe.reason || '', clsProbe.kind);
                            } else {
                                iceQueueMark(targetHandle, clsProbe.status, clsProbe.reason, clsProbe.kind);
                            }
                            console.log('[台账] need_probe 复检 @' + targetHandle + ' → ' + clsProbe.status + '/' + clsProbe.kind + '/' + (clsProbe.reason || ''));
                            try {
                                showToast('📋 台账复检：' + clsProbe.status + (clsProbe.reason ? '/' + clsProbe.reason : ''), '#1d9bf0', 2800);
                            } catch (eTpr) {}
                            if (clsProbe.status !== 'pending') {
                                finishTargetVisit({
                                    skipInboxDone: true,
                                    queueStatus: clsProbe.status,
                                    queueReason: clsProbe.reason || 'probe_done'
                                });
                                return;
                            }
                            ledgerItem = { kind: clsProbe.kind, reason: clsProbe.reason, status: 'doing' };
                        }
                        if (ledgerItem.kind === 'ice') {
                            ledgerForceRound = 0;
                            ledgerSkipHeuristics = true;
                        } else if (ledgerItem.kind === 'ad') {
                            ledgerForceRound = 1;
                            ledgerSkipHeuristics = true;
                        } else if (ledgerItem.kind === 'kick') {
                            ledgerForceRound = 2;
                            ledgerSkipHeuristics = true;
                        } else if (ledgerItem.kind === 'reject') {
                            finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: ledgerItem.reason || 'reject' });
                            return;
                        }
                    }
                }
                if (ledgerForceRound !== null && ledgerForceRound !== undefined) {
                    userRound = ledgerForceRound;
                }

                // 已婉拒目标：任何轮次都禁止再发（含 round2 缺广告补发）
                if (conversationHasRejectEvidence(targetHandle)) {
                    try { markAgeRejected(targetHandle); } catch (eRejE) {}
                    reportSessionVerdict('gate_blocked', {
                        target: targetHandle,
                        round: userRound,
                        gate_reason: 'already_rejected'
                    });
                    finishTargetVisit();
                    return;
                }
                // 对方气泡明确拒绝 → 完结；硬封闭正向标记 → 永久跳过；pending 只 deferred
                try {
                    var stopPeers = collectExtraPeerTexts(targetHandle) || [];
                    if (peerTextsIndicateStop(stopPeers)) {
                        markPeerBlocked(targetHandle, 'peer_stop_text');
                        showToast('⛔ 对方拒绝继续，完结', '#f85149', 2500);
                        finishTargetVisit();
                        return;
                    }
                    var sendCls = null;
                    try { sendCls = classifyDmSendability(); } catch (eCls) { sendCls = null; }
                    if (sendCls && sendCls.verdict === 'hard_closed') {
                        finalizeUnsendablePeer(targetHandle, 'hard_closed');
                        finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'hard_closed' });
                        return;
                    }
                    if (sendCls && sendCls.verdict === 'pending') {
                        showToast('⏳ 会话状态未定，本趟跳过', '#faad14', 2200);
                        finishTargetVisit({
                            skipInboxDone: true,
                            queueStatus: 'deferred',
                            queueReason: 'sendability_pending'
                        });
                        return;
                    }
                    if (peerTextsIndicateCompetitor(stopPeers)) {
                        markCompetitorBlocked(targetHandle, 'peer_competitor');
                        showToast('⛔ 同行/引流号，跳过', '#f85149', 2500);
                        finishTargetVisit();
                        return;
                    }
                } catch (eStop) {}
                if (!isChatTargetAllowed(targetHandle)) {
                    sessionStorage.setItem('dan_auto_step', '4');
                    return;
                }

                // 4.1.58 统一硬门：DOM/会话已破冰则补库，禁止任何路径再破冰
                try { ensureIceRecordFromDom(targetHandle); } catch (eHeal) {}
                if (ledgerForceRound === null || ledgerForceRound === undefined) {
                    userRound = getUserRound(targetHandle);
                }

                // 仅「真真空」且从未 iceSentAt 才强制破冰；有蓝泡/iceSentAt/会话锁一律不发
                var needIceOnly = false;
                var blankThread = false;
                if (ledgerSkipHeuristics && ledgerForceRound === 0) {
                    // 台账 ice：DOM/库已有破冰证据则禁止二次破冰
                    var alreadyIced = false;
                    try {
                        var eIceGuard = loadTargetDB()[targetHandle] || {};
                        alreadyIced = !!(eIceGuard.iceSentAt || eIceGuard.adSentAt);
                        if (!alreadyIced) alreadyIced = !!hasOwnDmBubbles();
                    } catch (eIg) { alreadyIced = false; }
                    needIceOnly = !alreadyIced;
                    if (alreadyIced) {
                        console.log('[台账] kind=ice 但已有破冰证据，跳过二次破冰 @' + targetHandle);
                    }
                }
                try { blankThread = isBlankDmThread(); } catch (eBl0) { blankThread = false; }
                if (!ledgerSkipHeuristics) try {
                    var obEntry0 = loadTargetDB()[targetHandle] || {};
                    var noAdYet = !obEntry0.adSentAt;
                    var neverIced = !obEntry0.iceSentAt;
                    var sessIced = false;
                    try { sessIced = sessionStorage.getItem('dan_iced_' + targetHandle) === '1'; } catch (eSi) {}
                    var ownBubbles = false;
                    try { ownBubbles = hasOwnDmBubbles(); } catch (eOb) {}
                    if (obEntry0.iceSentAt || sessIced || ownBubbles) {
                        needIceOnly = false;
                        if (!obEntry0.iceSentAt) {
                            try { ensureIceRecordFromDom(targetHandle); } catch (eH2) {}
                        }
                    } else if (blankThread && neverIced && noAdYet && hasSendableDmComposer()) {
                        needIceOnly = true;
                        if ((userRound || 0) > 0) {
                            try {
                                var dbFix = loadTargetDB();
                                if (!dbFix[targetHandle]) dbFix[targetHandle] = { round: 0, firstSeen: Date.now(), lastDM: null };
                                if (!dbFix[targetHandle].adSentAt && !dbFix[targetHandle].iceSentAt) {
                                    dbFix[targetHandle].round = 0;
                                    saveTargetDB(dbFix);
                                    userRound = 0;
                                }
                            } catch (eFix) {}
                        }
                        try {
                            reportSessionVerdict('blank_force_ice', {
                                target: targetHandle,
                                round: 0,
                                detail: 'empty_composer_force',
                                was_round: getUserRound(targetHandle)
                            });
                        } catch (eVf) {}
                        console.log('[私信] 真空会话强制破冰 @' + targetHandle);
                    } else {
                        needIceOnly = (userRound <= 0) && !obEntry0.iceSentAt && blankThread && !ownBubbles && !sessIced;
                        if (needIceOnly) {
                            var peersBeforeIce = [];
                            var peersReadOk = true;
                            try { peersBeforeIce = collectExtraPeerTexts(targetHandle) || []; } catch (ePb) {
                                peersBeforeIce = [];
                                peersReadOk = false;
                            }
                            if (!peersReadOk) {
                                needIceOnly = false;
                                console.warn('[私信] collectExtraPeerTexts 失败，暂不强制破冰 @' + targetHandle);
                            } else if (peersBeforeIce.length > 0) {
                                needIceOnly = false;
                                try {
                                    reportSessionVerdict('skip_ice_peer_texts', {
                                        target: targetHandle,
                                        round: 0,
                                        peer_count: peersBeforeIce.length,
                                        preview: String(peersBeforeIce[0] || '').slice(0, 80)
                                    });
                                } catch (eSp) {}
                                console.log('[私信] 会话已有对方文本 → 跳过强制破冰，走 peer_first @' + targetHandle + ' n=' + peersBeforeIce.length);
                            }
                        }
                    }
                } catch (eOb) {
                    try {
                        var eCatch = loadTargetDB()[targetHandle] || {};
                        needIceOnly = isBlankDmThread() && hasSendableDmComposer() && !eCatch.iceSentAt && !eCatch.adSentAt
                            && !hasOwnDmBubbles();
                    } catch (eOb2) { needIceOnly = false; }
                }
                if (ledgerSkipHeuristics && ledgerForceRound > 0) {
                    needIceOnly = false;
                }
                if (needIceOnly) {
                    if (isDmPinBlockedForSend()) {
                        reportSessionVerdict('pin_blocked', { target: targetHandle, round: 0, detail: 'outbound_ice' });
                        finishTargetVisit({ skipInboxDone: true });
                        return;
                    }
                    if (isDryRun()) {
                        reportSessionVerdict('gate_blocked', { target: targetHandle, round: 0, gate_reason: 'dry_run' });
                        finishTargetVisit({ skipInboxDone: true });
                        return;
                    }
                    // 4.6.34：破冰前也给检测反馈（真空=可破冰）
                    try {
                        showToast('🔍 查回 @' + targetHandle + '：真空会话 → 破冰', '#8b949e', 3500);
                    } catch (eIceDet) {}
                    var iceInputOb = wakeUpTarget || findBottomAwakeningTarget();
                    if (!(iceInputOb && !iceInputOb.disabled)) {
                        var iceDead = false;
                        try { iceDead = detectDmSendUnavailable(); } catch (eId) {}
                        if (iceDead) {
                            finalizeUnsendablePeer(targetHandle, 'x_number_gate');
                            reportSessionVerdict('gate_blocked', {
                                target: targetHandle, round: 0, gate_reason: 'peer_blocked', detail: 'read_only_or_no_dm'
                            });
                            finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'x_number_gate' });
                            return;
                        }
                        reportSessionVerdict('composer_not_ready', { target: targetHandle, round: 0, detail: 'outbound_ice' });
                        finishTargetVisit({ skipInboxDone: true });
                        return;
                    }
                    var iceMsgOb = getPoolMessage('icebreaker') || ICEBREAKER_MESSAGE || getRoundMessage(myHandle, targetHandle);
                    if (!iceMsgOb) {
                        reportSessionVerdict('gate_blocked', { target: targetHandle, round: 0, gate_reason: 'no_script' });
                        finishTargetVisit({ skipInboxDone: true });
                        return;
                    }
                    // 破冰话术固定取 icebreaker；禁止 setUserRound(0) 清掉已破冰状态
                    showToast('❄️ 破冰发送中…(第1轮)', '#1d9bf0', 25000);
                    sessionStorage.setItem('dan_auto_step', '2_waiting');
                    var iceOkOb = await recordDmAndAdvance(iceMsgOb, 0);
                    if (iceOkOb) {
                        reportSessionVerdict('ice_sent', { target: targetHandle, round: 0, via: 'outbound' });
                        dmTracePush('route', { target: targetHandle, decision: 'pass_ice_once', text: '本趟只发破冰一条' });
                    } else {
                        reportSessionVerdict('gate_blocked', { target: targetHandle, round: 0, gate_reason: 'send_failed' });
                    }
                    finishTargetVisit();
                    return;
                }

                // 4.1.0：废除未读驱动最终催加（改 kickCount≤4）；已完结则离开
                try {
                    var entryClosed = loadTargetDB()[targetHandle] || {};
                    if (isChatFullyClosed(entryClosed)) {
                        finishTargetVisit();
                        return;
                    }
                } catch (eCl) {}

                // L3：round0 无破冰记录（仅收箱/收养路径）
                // - 会话里已有对方文本（对方先开口/未读里已有话）→ 跳过问年龄破冰，抬 round1 走寒暄 AD
                // - 否则（真·无对方文本）→ 先发破冰（禁止无 ice 直接广告）
                // 4.6.62：台账已指定 ad/kick 时禁止收养路径自行破冰
                if (userRound === 0 && !(ledgerSkipHeuristics && ledgerForceRound > 0)) {
                    var adoptEntry = loadTargetDB()[targetHandle] || {};
                    if (!adoptEntry.iceSentAt) {
                        var earlyPeers = [];
                        var blankAdopt = false;
                        try { blankAdopt = isBlankDmThread(); } catch (eBa) { blankAdopt = false; }
                        try {
                            showToast('🔍 正在检测回复 @' + targetHandle + '…', '#1d9bf0', 3500);
                        } catch (eR0Start) {}
                        try { earlyPeers = blankAdopt ? [] : (collectExtraPeerTexts(targetHandle) || []); } catch (eEp) { earlyPeers = []; }
                        try {
                            showToast(
                                '🔍 查回 @' + targetHandle + '：' + (earlyPeers.length ? ('有回复 ×' + earlyPeers.length) : (blankAdopt ? '真空会话' : '未见回复')),
                                earlyPeers.length ? '#3fb950' : '#8b949e',
                                3500
                            );
                        } catch (eR0Res) {}
                        if (earlyPeers.length > 0) {
                            // OPS 禁止跳轮：无破冰记录时先占位 round1，再发 AD 记 round2
                            var opsMaxPf = Number(check.current_round);
                            if (isNaN(opsMaxPf) || opsMaxPf < 0) opsMaxPf = 0;
                            if (opsMaxPf < 1) {
                                var phResp = await opsDmRecord(
                                    targetHandle,
                                    1,
                                    '[peer_first_placeholder]',
                                    'success'
                                );
                                if (!phResp || !phResp.ok) {
                                    if (!(phResp && phResp.reason === 'round_duplicate')) {
                                        reportSessionVerdict('gate_blocked', {
                                            target: targetHandle,
                                            round: 0,
                                            gate_reason: 'peer_first_ops_ice_fail',
                                            detail: (phResp && (phResp.reason || phResp.msg)) || 'ops_fail'
                                        });
                                        console.warn('[私信] peer_first OPS 占位破冰失败', phResp);
                                        showToast('⚠️ 对方先开口但后台破冰占位失败', '#faad14', 2800);
                                        finishTargetVisit({ skipInboxDone: true });
                                        return;
                                    }
                                }
                                try { applyOpsMaxRound(targetHandle, 1); } catch (eOpsPf) {}
                            }
                            try {
                                var dbSkipIce = loadTargetDB();
                                var erSkip = dbSkipIce[targetHandle] || {};
                                var inboundAt = erSkip.lastInboundAt || Date.now();
                                // 闸门要 lastInboundAt > iceSentAt；对方先开口 → 占位破冰时刻略早于入站
                                erSkip.iceSentAt = Math.max(1, inboundAt - 1000);
                                if (!erSkip.lastInboundAt) erSkip.lastInboundAt = inboundAt;
                                dbSkipIce[targetHandle] = erSkip;
                                saveTargetDB(dbSkipIce);
                                setUserRound(targetHandle, 1);
                                userRound = 1;
                                sessionStorage.setItem('dan_pending_greeting_ad', '1');
                            } catch (eSkipIce) {}
                            reportChatMetric('parse_age_result', {
                                result: 'adopt_skip_ice_to_ad',
                                target: targetHandle,
                                peer_count: earlyPeers.length
                            });
                            dmTracePush('route', {
                                target: targetHandle,
                                decision: 'peer_first_greeting_ad',
                                peer_count: earlyPeers.length,
                                text: '对方已有入站 → OPS 占位破冰后寒暄 AD'
                            });
                            console.log('[私信] 对方已开口，跳过破冰直接寒暄AD @' + targetHandle + ' peers=' + earlyPeers.length);
                            // 落入下方 userRound===1 年龄/AD 分支
                        } else {
                            if (isDmPinBlockedForSend()) {
                                reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'pin' });
                                reportSessionVerdict('pin_blocked', { target: targetHandle, round: 0, detail: 'adopt_ice' });
                                finishTargetVisit({ skipInboxDone: true });
                                return;
                            }
                            if (isDryRun()) {
                                reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'dry_run' });
                                reportSessionVerdict('gate_blocked', { target: targetHandle, round: 0, gate_reason: 'dry_run' });
                                finishTargetVisit({ skipInboxDone: true });
                                return;
                            }
                            var iceInput = wakeUpTarget || findBottomAwakeningTarget();
                            if (!(iceInput && !iceInput.disabled)) {
                                var adoptCls = null;
                                try { adoptCls = classifyDmSendability(); } catch (eAc) { adoptCls = null; }
                                if (adoptCls && adoptCls.verdict === 'hard_closed') {
                                    finalizeUnsendablePeer(targetHandle, 'hard_closed');
                                    reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'hard_closed' });
                                    reportSessionVerdict('gate_blocked', {
                                        target: targetHandle, round: 0, gate_reason: 'peer_blocked', detail: 'hard_closed'
                                    });
                                    finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'hard_closed' });
                                    return;
                                }
                                reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'no_input' });
                                reportSessionVerdict('composer_not_ready', { target: targetHandle, round: 0, detail: 'adopt_ice' });
                                finishTargetVisit({
                                    skipInboxDone: true,
                                    queueStatus: 'deferred',
                                    queueReason: adoptCls && adoptCls.verdict === 'pending' ? 'sendability_pending' : 'no_input'
                                });
                                return;
                            }
                            // 已有我方蓝泡则禁止收养路径再破冰
                            if (ensureIceRecordFromDom(targetHandle)) {
                                reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'already_iced_dom' });
                                finishTargetVisit({ skipInboxDone: true, queueStatus: 'deferred', queueReason: 'already_iced' });
                                return;
                            }
                            var iceMsg = getRoundMessage(myHandle, targetHandle);
                            if (!iceMsg) {
                                reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'no_script' });
                                reportSessionVerdict('gate_blocked', { target: targetHandle, round: 0, gate_reason: 'no_script' });
                                finishTargetVisit({ skipInboxDone: true });
                                return;
                            }
                            showToast('❄️ 未读收养破冰中…', '#1d9bf0', 25000);
                            sessionStorage.setItem('dan_auto_step', '2_waiting');
                            var iceOk = await recordDmAndAdvance(iceMsg, 0);
                            if (iceOk) {
                                reportChatMetric('inbox.unread_adopt_ice', { target: targetHandle });
                                reportSessionVerdict('ice_sent', { target: targetHandle, round: 0, via: 'unread_adopt' });
                                dmTracePush('route', { target: targetHandle, decision: 'adopt_ice', text: '宇宙外未读先破冰' });
                            } else {
                                reportChatMetric('parse_age_result', { result: 'adopt_ice_skipped', target: targetHandle, reason: 'send_failed' });
                                reportSessionVerdict('gate_blocked', { target: targetHandle, round: 0, gate_reason: 'send_failed' });
                            }
                            finishTargetVisit({ skipInboxDone: true });
                            return;
                        }
                    }
                    // 有 iceSentAt 但 round 仍为 0：抬到 1 后走年龄分流
                    if (userRound === 0) {
                        try {
                            setUserRound(targetHandle, 1);
                            userRound = 1;
                        } catch (eLift) {}
                    }
                }

                // Round1：dating=年龄分流；job=有回复且非明显拒绝即发完整话术
                if (userRound === 1) {
                    var dbEntryPre = loadTargetDB()[targetHandle] || {};
                    // 已婉拒：禁止再发任何广告
                    if (dbEntryPre.rejectSentAt || conversationHasRejectEvidence(targetHandle)) {
                        try { markAgeRejected(targetHandle, dbEntryPre.rejectAge); } catch (eRejPre) {}
                        reportSessionVerdict('peer_unchanged_skip', {
                            target: targetHandle,
                            round: 1,
                            gate_reason: 'already_rejected'
                        });
                        console.log('[年龄识别] 已婉拒，跳过 @' + targetHandle);
                        finishTargetVisit();
                        return;
                    }
                    // 已发过广告：禁止同会话连环寒暄 AD（对方只回 line.me 链接壳时尤甚）
                    if (dbEntryPre.adSentAt || dbEntryPre.adBubbleOk || conversationHasOwnAdEvidence(targetHandle)) {
                        try {
                            markAdBubbleOk(targetHandle);
                            if ((dbEntryPre.round || getUserRound(targetHandle) || 0) < 2) setUserRound(targetHandle, 2);
                        } catch (eAdLift) {}
                        reportSessionVerdict('peer_unchanged_skip', {
                            target: targetHandle,
                            round: 1,
                            gate_reason: 'ad_already_sent'
                        });
                        console.log('[年龄识别] 会话已有广告，跳过重复 AD @' + targetHandle);
                        finishTargetVisit();
                        return;
                    }
                    var replyState = await readReplyStateAfterScroll(targetHandle);
                    // 4.6.34：查回横幅已在 readReplyStateAfterScroll 内统一弹出（全轮次）
                    var dbEntry = loadTargetDB()[targetHandle] || {};
                    try {
                        if (!dbEntry.iceSentAt) {
                            if (dbEntry.lastDM || dbEntry.firstSeen) {
                                dbEntry.iceSentAt = dbEntry.lastDM || dbEntry.firstSeen;
                                var dbFix = loadTargetDB();
                                dbFix[targetHandle] = dbEntry;
                                saveTargetDB(dbFix);
                            } else {
                                console.warn('[年龄识别] 缺 iceSentAt 且无 lastDM/firstSeen，跳过发送 @' + targetHandle);
                                reportChatMetric('parse_age_result', { result: 'missing_ice_sent_at', target: targetHandle });
                                reportSessionVerdict('missing_ice', { target: targetHandle, round: 1 });
                                finishTargetVisit({ skipInboxDone: true });
                                return;
                            }
                        }
                    } catch (eIceBackfill) {}
                    var peerTexts = [];
                    try { peerTexts = collectExtraPeerTexts(targetHandle); } catch (ePeer) {
                        peerTexts = (replyState.texts || []).slice();
                    }
                    // 差集确认有额外文本 → 先写入 lastInboundAt，再过闸门（禁止等满强写旁路）
                    if (peerTexts.length > 0) {
                        try { markLastInboundAt(targetHandle); } catch (eMarkEarly) {}
                        dbEntry = loadTargetDB()[targetHandle] || dbEntry;
                    }
                    var peerHash = hashPeerTexts(peerTexts);
                    if (peerTexts.length > 0
                        && dbEntry.lastProcessedPeerHash
                        && String(dbEntry.lastProcessedPeerHash) === peerHash
                        && (dbEntry.adSentAt || dbEntry.rejectSentAt || dbEntry.peerProcessedAt)) {
                        reportSessionVerdict('peer_unchanged_skip', {
                            target: targetHandle,
                            round: 1,
                            peer_hash: peerHash,
                            peer_count: peerTexts.length
                        });
                        console.log('[年龄识别] 对方文本未变化，跳过重复处理 @' + targetHandle);
                        finishTargetVisit();
                        return;
                    }
                    try {
                        sessionStorage.setItem('dan_pending_peer_hash', peerHash);
                        sessionStorage.setItem('dan_pending_greeting_ad', '0');
                    } catch (ePh) {}
                    dmTracePush('read_reply', {
                        target: targetHandle,
                        peer_count: peerTexts.length,
                        text: '额外文本=' + peerTexts.length + ' 未读=' + (replyState.unreadSeen ? '是' : '否') + ' 来源=' + replyState.source,
                        unread: !!replyState.unreadSeen,
                        source: replyState.source,
                        decision: replyState.decision
                    });
                    var sendGate = canSendAdNow(targetHandle, peerTexts, dbEntry);
                    try { writeReplyStateStash({
                        target: targetHandle,
                        decision: replyState.decision || '',
                        source: replyState.source || '',
                        hasReply: !!replyState.hasReply,
                        unreadSeen: !!replyState.unreadSeen,
                        composerReady: !!replyState.composerReady,
                        latest: String(replyState.latest || '').slice(0, 120),
                        sendGate: sendGate,
                        at: Date.now()
                    }); } catch (eReplyState) {}
                    if (replyState.decision === 'target_mismatch') {
                        var fanAdMode = false;
                        try {
                            fanAdMode = !isInboxWatchEnabled()
                                || getChatPhase() === 'outbound'
                                || getChatPhase() === 'followup'
                                || sessionStorage.getItem('dan_dm_entry_via') === 'fan_roster';
                        } catch (eFam) { fanAdMode = true; }
                        var hasPeerBubble = (peerTexts && peerTexts.length > 0) || !!replyState.hasReply;
                        if (fanAdMode && hasPeerBubble) {
                            // 粉丝队列：灰泡已在 → 认回复继续 AD，不被守箱身份门误杀
                            console.warn('[私信] 粉丝队列有对方文本，忽略 target_mismatch 继续 AD @' + targetHandle, {
                                peer_count: peerTexts.length,
                                header: replyState.headerHandle || '',
                                decision: replyState.decision
                            });
                            try { captureDmPeerId(targetHandle); } catch (eCapMm) {}
                            try { markLastInboundAt(targetHandle); } catch (eMkMm) {}
                            try {
                                replyState.hasReply = true;
                                if (!replyState.source) replyState.source = 'peer_texts_mismatch_bypass';
                            } catch (eRsSet) {}
                            dbEntry = loadTargetDB()[targetHandle] || dbEntry;
                            sendGate = canSendAdNow(targetHandle, peerTexts, dbEntry);
                            // 落入下方 hasReply / sendGate / 年龄分流
                        } else if (fanAdMode) {
                            console.warn('[私信] 粉丝队列 target_mismatch 且无对方文本 → deferred @' + targetHandle);
                            reportSessionVerdict('gate_blocked', {
                                target: targetHandle,
                                round: 1,
                                gate_reason: 'stale_dm_surface',
                                decision: 'target_mismatch'
                            });
                            finishTargetVisit({
                                skipInboxDone: true,
                                queueStatus: 'deferred',
                                queueReason: 'stale_dm_surface'
                            });
                            return;
                        } else {
                            reportSessionVerdict('gate_blocked', {
                                target: targetHandle,
                                round: 1,
                                gate_reason: 'target_mismatch',
                                decision: 'target_mismatch'
                            });
                            console.warn('[私信] target_mismatch，禁止发广告 @' + targetHandle);
                            finishTargetVisit({ skipInboxDone: true });
                            return;
                        }
                    }
                    if (replyState.hasReply || (peerTexts && peerTexts.length > 0)) {
                        reportChatMetric('chat.inbox_reply_detected', {
                            target: targetHandle,
                            peer_count: peerTexts.length,
                            peer_preview: String(replyState.latest || peerTexts[peerTexts.length - 1] || '').slice(0, 60),
                            source: replyState.source,
                            unread: !!replyState.unreadSeen,
                            decision: replyState.decision || '',
                            gate_reason: sendGate.reason || ''
                        });
                    }
                    if (!sendGate.ok) {
                        if (!replyState.composerReady || replyState.decision === 'composer_not_ready') {
                            reportSessionVerdict('composer_not_ready', {
                                target: targetHandle,
                                round: 1,
                                gate_reason: sendGate.reason || '',
                                decision: replyState.decision || ''
                            });
                        } else {
                            reportSessionVerdict('gate_blocked', {
                                target: targetHandle,
                                round: 1,
                                gate_reason: sendGate.reason || '',
                                decision: replyState.decision || '',
                                peer_count: peerTexts.length
                            });
                        }
                        if (peerTexts.length > 0 || replyState.unreadSeen) {
                            var waitLeftMin = Math.max(0, Math.ceil((getAdMinWaitMs() - (Date.now() - (dbEntry.iceSentAt || Date.now()))) / 60000));
                            reportChatMetric('chat.inbox_reply_waiting', {
                                target: targetHandle,
                                peer_count: peerTexts.length,
                                wait_left_min: waitLeftMin,
                                source: replyState.source,
                                decision: replyState.decision || '',
                                gate_reason: sendGate.reason || ''
                            });
                            dmTracePush('route', {
                                target: targetHandle,
                                decision: 'defer_pass',
                                peer_count: peerTexts.length,
                                unread: !!replyState.unreadSeen,
                                source: replyState.source,
                                gate_reason: sendGate.reason || '',
                                text: '本趟不发 AD，deferred（不等待连发）'
                            });
                            console.log('[年龄识别] 本趟闸门未过，deferred @' + targetHandle + ' reason=' + (sendGate.reason || ''));
                            finishTargetVisit({
                                skipInboxDone: true,
                                queueStatus: 'deferred',
                                queueReason: sendGate.reason || 'ad_gate'
                            });
                        } else {
                            dmTracePush('route', {
                                target: targetHandle,
                                decision: 'no_reply',
                                peer_count: 0,
                                unread: !!replyState.unreadSeen,
                                source: replyState.source,
                                gate_reason: sendGate.reason || '',
                                text: '尚无非本方额外文本'
                            });
                            console.log('[年龄识别] 破冰后尚无新回复，跳过 @' + targetHandle);
                            finishTargetVisit({
                                skipInboxDone: true,
                                queueStatus: 'deferred',
                                queueReason: sendGate.reason || 'no_reply'
                            });
                        }
                        return;
                    }
                    try { writeReplyStateStash({
                        target: targetHandle,
                        decision: 'send_gate_open',
                        source: replyState.source || '',
                        hasReply: !!replyState.hasReply,
                        unreadSeen: !!replyState.unreadSeen,
                        composerReady: !!replyState.composerReady,
                        latest: String(replyState.latest || '').slice(0, 120),
                        at: Date.now()
                    }); } catch (eReplySend) {}
                    dmTracePush('route', {
                        target: targetHandle,
                        decision: 'send',
                        peer_count: peerTexts.length,
                        unread: !!replyState.unreadSeen,
                        source: replyState.source,
                        text: '准备发送下一轮内容'
                    });
                    if (replyState.hasReply) {
                        try { markLastInboundAt(targetHandle); } catch (eMark) {}
                        try {
                            var dbRS = loadTargetDB();
                            if (dbRS[targetHandle] && !dbRS[targetHandle].replySeenAt) {
                                dbRS[targetHandle].replySeenAt = Date.now();
                                saveTargetDB(dbRS);
                            }
                        } catch (eRS) {}
                    }
                    // 婉拒：dating 认年龄 <25；job 只认明确拒绝意向（年龄留给人工扣粉）
                    var parsedAge = parseAgeFromInbound(peerTexts);
                    var ageRejectBelow = getAgeRejectBelow();
                    var jobMode = isJobScriptPool();
                    var jobIntent = jobMode ? parseJobIntent(peerTexts) : 'n/a';
                    console.log('[年龄识别] @' + targetHandle + ' age=', parsedAge, 'rejectBelow=', ageRejectBelow,
                        'pool=', getScriptPoolMode(), 'intent=', jobIntent, 'peers=', peerTexts.slice(-3));

                    if (jobMode && jobIntent === 'no') {
                        reportChatMetric('parse_job_intent', {
                            result: 'reject', intent: 'no', age: parsedAge, target: targetHandle, script_pool: 'job'
                        });
                        var intentRejectMsg = getRejectMessage();
                        showToast('⛔ 对方不愿做 → 婉拒', '#f85149');
                        sendLogToNAS(targetHandle, 'REJECT', '兼职意向拒绝', intentRejectMsg);
                        sessionStorage.setItem('dan_auto_step', '2_waiting');
                        var intentRejectConfirm = await threadSafeSendAndConfirm(wakeUpTarget, intentRejectMsg);
                        if (!intentRejectConfirm || !intentRejectConfirm.ok) {
                            console.warn('[私信] 意向婉拒发送未确认，仍本地记死 skipped', intentRejectConfirm);
                            var irFail = (intentRejectConfirm && intentRejectConfirm.reason) || 'no_bubble';
                            reportSessionVerdict('send_unconfirmed', {
                                target: targetHandle, round: 1, gate_reason: irFail, round_name: '意向婉拒',
                                script_pool: 'job', local_reject: true
                            });
                            showToast('⚠️ 婉拒气泡未确认(' + irFail + ')，已本地记死跳过', '#faad14', 3000);
                            try { markAgeRejected(targetHandle, parsedAge); } catch (eMarkIrFail) {}
                            try {
                                markPeerTextsProcessed(targetHandle, sessionStorage.getItem('dan_pending_peer_hash') || peerHash || '', {
                                    rejectSentAt: Date.now(),
                                    rejectReason: 'job_intent_no'
                                });
                            } catch (eIrHashFail) {}
                            try { iceQueueMark(targetHandle, 'skipped', 'job_intent_no', 'reject'); } catch (eIqIr) {}
                            finishTargetVisit({
                                skipInboxDone: true,
                                queueStatus: 'skipped',
                                queueReason: 'job_intent_no'
                            });
                            return;
                        }
                        var irOps = null;
                        try { irOps = await opsDmRecord(targetHandle, 2, intentRejectMsg, 'success'); } catch (eOpsIr) { irOps = null; }
                        if (!irOps || !irOps.ok) {
                            reportSessionVerdict('ops_report_failed_local_ok', {
                                target: targetHandle, round: 1, gate_reason: 'intent_reject_ops_fail',
                                detail: (irOps && (irOps.reason || irOps.msg)) || 'ops_fail', script_pool: 'job'
                            });
                        }
                        try { rememberSentScriptText(targetHandle, 'reject', intentRejectMsg); } catch (eIrMem) {}
                        try { markAgeRejected(targetHandle, parsedAge); } catch (eMarkIr) {}
                        reportChatMetric('reject_sent', { target: targetHandle, reason: 'job_intent_no', script_pool: 'job' });
                        reportSessionVerdict('reject_sent', {
                            target: targetHandle, round: 1, reason: 'job_intent_no', script_pool: 'job'
                        });
                        try {
                            markPeerTextsProcessed(targetHandle, sessionStorage.getItem('dan_pending_peer_hash') || peerHash || '', {
                                rejectSentAt: Date.now(),
                                rejectReason: 'job_intent_no'
                            });
                        } catch (eIrHash) {}
                        try { await opsDmRecord(targetHandle, 3, '[job_intent_reject_done]', 'success'); } catch (eCloseIr) {}
                        showToast('⛔ 已婉拒（不愿做）', '#f85149', 2000);
                        finishTargetVisit();
                        return;
                    }

                    // dating 低龄婉拒；job 不按年龄挡（getAgeRejectBelow=0）
                    if (!jobMode && parsedAge != null && parsedAge < ageRejectBelow) {
                        reportChatMetric('parse_age_result', {
                            result: 'reject', age: parsedAge, target: targetHandle,
                            script_pool: 'dating', age_reject_below: ageRejectBelow
                        });
                        var rejectMsg = getRejectMessage();
                        showToast('⛔ 低龄婉拒中…(' + parsedAge + '岁)', '#f85149');
                        sendLogToNAS(targetHandle, 'REJECT', '低龄婉拒 age=' + parsedAge, rejectMsg);
                        sessionStorage.setItem('dan_auto_step', '2_waiting');
                        var rejectConfirm = await threadSafeSendAndConfirm(wakeUpTarget, rejectMsg);
                        if (!rejectConfirm || !rejectConfirm.ok) {
                            console.warn('[私信] 低龄婉拒发送未确认，仍本地记死 skipped', rejectConfirm);
                            var rjFail = (rejectConfirm && rejectConfirm.reason) || 'no_bubble';
                            reportSessionVerdict('send_unconfirmed', {
                                target: targetHandle, round: 1, gate_reason: rjFail, round_name: '婉拒',
                                local_reject: true
                            });
                            showToast('⚠️ 婉拒气泡未确认(' + rjFail + ')，已本地记死跳过', '#faad14', 3000);
                            try { markAgeRejected(targetHandle, parsedAge); } catch (eMarkRjFail) {}
                            try {
                                markPeerTextsProcessed(targetHandle, sessionStorage.getItem('dan_pending_peer_hash') || peerHash || '', {
                                    rejectSentAt: Date.now(),
                                    rejectAge: parsedAge
                                });
                            } catch (eRjHashFail) {}
                            try { iceQueueMark(targetHandle, 'skipped', 'age_reject', 'reject'); } catch (eIqRj) {}
                            finishTargetVisit({
                                skipInboxDone: true,
                                queueStatus: 'skipped',
                                queueReason: 'age_reject'
                            });
                            return;
                        }
                        var rejOps = null;
                        try { rejOps = await opsDmRecord(targetHandle, 2, rejectMsg, 'success'); } catch (eOpsAge) { rejOps = null; }
                        if (!rejOps || !rejOps.ok) {
                            reportSessionVerdict('ops_report_failed_local_ok', {
                                target: targetHandle,
                                round: 1,
                                gate_reason: 'reject_ops_fail',
                                detail: (rejOps && (rejOps.reason || rejOps.msg)) || 'ops_fail'
                            });
                            showToast('⚠️ 婉拒已发出，后台记账失败，已按本地完结', '#faad14', 2800);
                        }
                        try { rememberSentScriptText(targetHandle, 'reject', rejectMsg); } catch (eRejMem) {}
                        try { markAgeRejected(targetHandle, parsedAge); } catch (eMarkRej) {}
                        reportChatMetric('reject_sent', { target: targetHandle, age: parsedAge, script_pool: 'dating' });
                        reportSessionVerdict('reject_sent', { target: targetHandle, round: 1, age: parsedAge, script_pool: 'dating' });
                        try {
                            markPeerTextsProcessed(targetHandle, sessionStorage.getItem('dan_pending_peer_hash') || peerHash || '', {
                                rejectSentAt: Date.now(),
                                rejectAge: parsedAge
                            });
                        } catch (eRejHash) {}
                        try {
                            await opsDmRecord(targetHandle, 3, '[age_reject_done]', 'success');
                        } catch (eClose) {}
                        try { sendLogToNAS(targetHandle, 'REJECT', '低龄婉拒完结 age=' + parsedAge, rejectMsg); } catch (eLog2) {}
                        showToast('⛔ 已婉拒 ' + parsedAge + '岁', '#f85149', 2000);
                        finishTargetVisit();
                        return;
                    }

                    // job：已有回复且非明显拒绝 → 发完整话术（含蓄寒暄也发；年龄不挡）
                    if (jobMode) {
                        reportChatMetric('parse_job_intent', {
                            result: 'ad',
                            intent: jobIntent,
                            age: parsedAge,
                            target: targetHandle,
                            script_pool: 'job'
                        });
                        try { sessionStorage.setItem('dan_pending_greeting_ad', jobIntent === 'yes' ? '0' : '1'); } catch (eGJob) {}
                        dmTracePush('route', {
                            target: targetHandle,
                            decision: 'job_ad',
                            peer_count: peerTexts.length,
                            text: '兼职粉有回复且非拒绝 → 发完整话术 intent=' + jobIntent
                        });
                    } else if (parsedAge == null) {
                        // dating：无年龄（寒暄）直接发 AD，废除 need_age 追问
                        reportChatMetric('parse_age_result', { result: 'greeting_ad', target: targetHandle, script_pool: 'dating' });
                        try { sessionStorage.setItem('dan_pending_greeting_ad', '1'); } catch (eG) {}
                        dmTracePush('route', {
                            target: targetHandle,
                            decision: 'greeting_ad',
                            peer_count: peerTexts.length,
                            text: '寒暄无年龄 → 直接发 AD'
                        });
                        console.log('[年龄识别] 无年龄寒暄，直接发广告 @' + targetHandle);
                    } else {
                        reportChatMetric('parse_age_result', {
                            result: 'parsed', age: parsedAge, target: targetHandle, script_pool: 'dating'
                        });
                        try { sessionStorage.setItem('dan_pending_greeting_ad', '0'); } catch (eG2) {}
                    }
                }

                if (userRound === 2) {
                    var kickEntry = loadTargetDB()[targetHandle] || {};
                    try {
                        showToast('🔍 正在检测回复 @' + targetHandle + '…', '#1d9bf0', 3500);
                    } catch (eR2Start) {}
                    // 已婉拒/已拉黑 / 会话有婉拒痕迹：绝不能当「缺广告」补发（@f2jgmw 类事故）
                    if (kickEntry.rejectSentAt || kickEntry.blockedAt || conversationHasRejectEvidence(targetHandle)) {
                        try {
                            if (kickEntry.blockedAt) markPeerBlocked(targetHandle, kickEntry.blockReason || 'blocked');
                            else markAgeRejected(targetHandle, kickEntry.rejectAge);
                        } catch (eRej2) {}
                        reportSessionVerdict('gate_blocked', {
                            target: targetHandle,
                            round: 2,
                            gate_reason: kickEntry.blockedAt ? 'peer_blocked' : 'already_rejected'
                        });
                        console.log('[kick] 已婉拒/拉黑，禁止广告补发 @' + targetHandle);
                        try { showToast('🔍 查回 @' + targetHandle + '：已婉拒/拉黑，跳过催加', '#8b949e', 3500); } catch (eR2Skip) {}
                        finishTargetVisit();
                        return;
                    }
                    // round2 仍见明确低龄：仅 dating 补完结；job 年龄不挡
                    try {
                        var agePeers = collectExtraPeerTexts(targetHandle) || [];
                        try {
                            showToast(
                                '🔍 查回 @' + targetHandle + '：' + (agePeers.length ? ('有回复 ×' + agePeers.length) : '未见新回复 → 催加闸'),
                                agePeers.length ? '#3fb950' : '#8b949e',
                                3500
                            );
                        } catch (eR2Res) {}
                        var ageAgain = parseAgeFromInbound(agePeers);
                        if (!isJobScriptPool() && ageAgain != null && ageAgain < getAgeRejectBelow()) {
                            try { markAgeRejected(targetHandle, ageAgain); } catch (eAge2) {}
                            try { await opsDmRecord(targetHandle, 3, '[age_reject_done]', 'success'); } catch (eOps3) {}
                            try { sendLogToNAS(targetHandle, 'REJECT', 'round2见低龄完结 age=' + ageAgain); } catch (eL3) {}
                            reportSessionVerdict('gate_blocked', {
                                target: targetHandle,
                                round: 2,
                                gate_reason: 'age_reject_on_round2',
                                age: ageAgain
                            });
                            finishTargetVisit();
                            return;
                        }
                    } catch (eAgeChk) {}
                    // 假推进修复：OPS/本地已 round2，但会话里没有广告气泡 → 补发广告
                    // DOM 未就绪时先等一拍，避免误判「无广告」连环补发
                    if (!conversationHasOwnAdEvidence(targetHandle)) {
                        try {
                            await new Promise(function (r) { setTimeout(r, 900); });
                        } catch (eWait) {}
                    }
                    if (!conversationHasOwnAdEvidence(targetHandle)) {
                        if (isDmPinBlockedForSend()) {
                            reportSessionVerdict('pin_blocked', { target: targetHandle, round: 2, detail: 'ad_repair' });
                            finishTargetVisit({ skipInboxDone: true });
                            return;
                        }
                        var repairLink = getLiveLink();
                        var repairMsg = repairLink
                            ? (getPoolMessage('ad') || AD_MESSAGE_TEMPLATE).replace('{LINK}', repairLink)
                            : null;
                        if (!repairMsg) {
                            reportSessionVerdict('gate_blocked', { target: targetHandle, round: 2, gate_reason: 'ad_repair_no_link' });
                            showToast('⏳ 会话无广告且无链接，无法补发', '#faad14', 2500);
                            finishTargetVisit({ skipInboxDone: true });
                            return;
                        }
                        showToast('🩹 补发广告中…(会话缺第二步)', '#1d9bf0');
                        sessionStorage.setItem('dan_auto_step', '2_waiting');
                        sessionStorage.setItem('dan_pending_greeting_ad', '1');
                        var repairConfirm = await threadSafeSendAndConfirm(wakeUpTarget, repairMsg);
                        if (!repairConfirm || !repairConfirm.ok) {
                            var repairFail = (repairConfirm && repairConfirm.reason) || 'no_bubble';
                            var repairStreak = noteSendFailStreak(targetHandle, repairFail);
                            reportSessionVerdict('gate_blocked', {
                                target: targetHandle,
                                round: 2,
                                gate_reason: 'ad_repair_no_bubble',
                                detail: repairFail
                            });
                            if (repairStreak >= 3 && detectDmSendUnavailable()) {
                                markPeerBlocked(targetHandle, 'ad_repair_' + repairFail);
                                showToast('⛔ 补发广告连续失败且疑似拉黑，完结', '#f85149', 2800);
                                finishTargetVisit();
                            } else {
                                showToast('⚠️ 补发广告已点发送但气泡未确认(' + repairFail + ')，本轮不计数', '#faad14', 3000);
                                finishTargetVisit({ skipInboxDone: true });
                            }
                            return;
                        }
                        try { sessionStorage.removeItem('dan_send_fail_' + normalizeChatHandle(targetHandle)); } catch (eClrR) {}
                        try { rememberSentScriptText(targetHandle, 1, repairMsg); } catch (eMemR) {}
                        try { markAdBubbleOk(targetHandle); } catch (eOkR) {}
                        try {
                            // 已记过 round2 时 OPS 会 round_duplicate；忽略，本地以气泡为准
                            await opsDmRecord(targetHandle, 2, repairMsg, 'success');
                        } catch (eOpsR) {}
                        reportChatMetric('ad_sent', { target: targetHandle, via: 'ad_missing_repair' });
                        reportSessionVerdict('greeting_ad', {
                            target: targetHandle,
                            round: 1,
                            via: 'ad_missing_repair'
                        });
                        showToast('✅ 已补发广告', '#3fb950', 2000);
                        // 一窗一遍：本趟只发补发广告，催加留待下窗
                        finishTargetVisit();
                        return;
                    }
                    try { markAdBubbleOk(targetHandle); } catch (eMarkEv) {}
                    // 催加前再扫一次对方文案（广告后对方可能刚回「ブロック」）
                    try {
                        var kickStopPeers = collectExtraPeerTexts(targetHandle) || [];
                        if (peerTextsIndicateStop(kickStopPeers)) {
                            markPeerBlocked(targetHandle, 'peer_stop_before_kick');
                            showToast('⛔ 对方拒绝继续，不发催加', '#f85149', 2500);
                            finishTargetVisit();
                            return;
                        }
                        if (!hasSendableDmComposer() && detectDmSendUnavailable()) {
                            finalizeUnsendablePeer(targetHandle, 'x_number_gate');
                            finishTargetVisit({ skipInboxDone: true, queueStatus: 'skipped', queueReason: 'x_number_gate' });
                            return;
                        }
                    } catch (eKickStop) {}
                    if (!canSendKickNow(targetHandle, kickEntry)) {
                        console.log('[kick] 闸门未满足，本趟 deferred @' + targetHandle);
                        reportSessionVerdict('gate_blocked', { target: targetHandle, round: 2, gate_reason: 'kick_not_ready' });
                        finishTargetVisit({
                            skipInboxDone: true,
                            queueStatus: 'deferred',
                            queueReason: 'kick_not_ready'
                        });
                        return;
                    }
                }

                var msgToSend = getRoundMessage(myHandle, targetHandle);
                if (msgToSend) {
                    debugChatLog('话术选取 @' + targetHandle + ' round=' + (userRound + 1) + ': ' + msgToSend, {
                        step: 'script_pick', target: targetHandle, round: userRound + 1, text: msgToSend
                    });
                }
                if (!msgToSend) {
                    if (userRound === 1) {
                        var entryForLat = loadTargetDB()[targetHandle] || {};
                        if (entryForLat.lastDM) {
                            console.log('[诊断] ice_to_ad_latency_ms=' + (Date.now() - entryForLat.lastDM));
                        }
                    }
                    if (userRound === 1) {
                        // 无广告链接：停在 round1，绝不空推进到 kick
                        console.log('[跳过] 无可用链接，停留广告轮，等待链接');
                        showToast('⏳ 无推广链接，暂不发广告/催加', '#faad14', 2500);
                        reportNoPromoLink('ad_round_no_link');
                    }
                    finishTargetVisit();
                    return;
                }
                // 破冰轮：若 OPS 已记过破冰仍走到这里，属异常，硬停
                if (userRound === 0 && Number(check.next_round) > 1) {
                    console.warn('[私信] OPS next_round=' + check.next_round + ' 却要发破冰，中止 @' + targetHandle);
                    applyOpsMaxRound(targetHandle, Number(check.next_round) - 1);
                    finishTargetVisit();
                    return;
                }
                sessionStorage.setItem('dan_auto_step', '2_waiting');
                var ok = await recordDmAndAdvance(msgToSend, userRound);
                if (!ok) {
                    finishTargetVisit();
                    return;
                }
                // 一窗一遍：成功发送一条后立刻回列表，禁止同人续发第二轮
                var delay = isChatRushMode()
                    ? (12000 + Math.floor(Math.random() * 8000))
                    : (3500 + Math.floor(Math.random() * 2000));
                setTimeout(function () {
                    var rNow = getUserRound(targetHandle);
                    dmTracePush('finish', { target: targetHandle, round: rNow, text: '本趟一条已处理，返回列表' });
                    finishTargetVisit();
                }, delay);
            }

            // 4.6.34：调用异步发送前立刻锁 step，防 3–7s tick 在 opsDmCheck/检测期间重入
            try {
                sessionStorage.setItem('dan_auto_step', '2_waiting');
                sessionStorage.setItem('dan_dm_inflight', '1');
            } catch (eLockPre) {}
            Promise.resolve(sendOneOrDump()).catch(function (eSendDump) {
                console.warn('[私信] sendOneOrDump 异常', eSendDump);
                try {
                    finishTargetVisit({
                        skipInboxDone: true,
                        queueStatus: 'deferred',
                        queueReason: 'send_throw'
                    });
                } catch (eFt) {
                    try { sessionStorage.removeItem('dan_dm_inflight'); } catch (eInf) {}
                    try { sessionStorage.setItem('dan_auto_step', '4'); } catch (eSt) {}
                }
            });
            return;
        }

        if (currentStep === '4') {
            // 4.6.34：离开会话前短 settle
            try {
                var leaveSettleUntil = parseInt(sessionStorage.getItem('dan_leave_settle_until') || '0', 10) || 0;
                if (Date.now() < leaveSettleUntil) {
                    return;
                }
                sessionStorage.removeItem('dan_leave_settle_until');
            } catch (eLeaveSettle) {}
            let hostUser = sessionStorage.getItem('dan_target_username');
            // 安全网：如果 hostUser 为空，从 localStorage 恢复
            if (!hostUser) {
                var mh = localStorage.getItem('matrix_my_handle');
                if (mh) { hostUser = mh.replace('@','').replace('#guard','').toLowerCase(); }
            }
            try { reconcileChatHostIdentity('step4_back'); } catch (eRec4) {}
            try { hostUser = sessionStorage.getItem('dan_target_username') || hostUser; } catch (eHu) {}

            dmTracePush('back_to_list', { target: sessionStorage.getItem('current_target') || '', text: '返回会话列表/关注页' });
            // 粉丝队列 / 守箱关：一律原路回 /followers（禁止退到收件箱列表）
            var forceFansBack = false;
            try {
                forceFansBack = !isInboxWatchEnabled()
                    || shouldReturnToFollowersList()
                    || sessionStorage.getItem('dan_dm_entry_via') === 'fan_roster'
                    || getChatPhase() === 'outbound'
                    || getChatPhase() === 'followup';
            } catch (eFb) { forceFansBack = true; }

            function onOwnFollowersNow() {
                try {
                    if (!isFollowersListPath(window.location.href)) return false;
                    var ph = String(window.location.pathname || '').split('/')[1] || '';
                    var me = normalizeChatHandle(hostUser || getMyHandle() || '');
                    return !!(me && normalizeChatHandle(ph) === me);
                } catch (eOwn) { return false; }
            }

            if (forceFansBack && hostUser) {
                try { sessionStorage.removeItem('dan_dm_entry_via'); } catch (eVia4) {}
                try { sessionStorage.removeItem('dan_fans_back_phase'); } catch (eBpClr) {}
                // 已在本号粉丝页：收尾
                if (onOwnFollowersNow()) {
                    sessionStorage.removeItem('dan_auto_step');
                    sessionStorage.setItem('dan_warmup_timer', (Date.now() + 3000).toString());
                    return;
                }
                // 4.6.68：禁止 history.back / 点返回（会落到 Messages 列表）；一律硬跳本号粉丝页
                showToast('🔙 回粉丝列表…', '#1d9bf0', 900);
                console.log('[step4] 粉丝队列硬跳 /' + hostUser + '/followers（禁落 chat 列表）');
                sessionStorage.removeItem('dan_auto_step');
                chatGo('/' + hostUser + '/followers', true);
                sessionStorage.setItem('dan_warmup_timer', (Date.now() + 3000).toString());
                return;
            }

            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.removeItem('dan_fans_back_phase');
            showToast('🔙 跳回...', '#1d9bf0', 1000);
            if (mustStayOnInboxSurface() || (getChatPhase() === 'inbox' && (isMessagesPage() || isDmConversationPage() || isDmConversationView()))) {
                var leaveHow4 = leaveDmConversationToListOnce();
                console.log('[step4] 退回收件箱列表 once via=' + leaveHow4);
                try {
                    var p4 = (window.location.pathname || '').toLowerCase();
                    if (/\/(?:i\/chat|messages)\/\d{5,}/.test(p4)) {
                        if (!isInboxWatchEnabled() && hostUser) chatGo('/' + hostUser + '/followers', true);
                        else chatGo('/i/chat', true);
                    }
                } catch (eP4) {}
            } else if (hostUser) {
                chatGo('/' + hostUser + '/followers', true);
            } else {
                let cleanUrl = window.location.href.split('?')[0];
                chatGo(cleanUrl, true);
            }
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 3000).toString());
        }

    };
    function ensureChatMainEngine() {
        try {
            if (window._sgChatMainEngineId != null && window._matrixTimers
                && window._matrixTimers.indexOf(window._sgChatMainEngineId) >= 0) {
                return true;
            }
        } catch (eChk) {}
        // 4.6.34：主巡航 5–7s（旧 3–4.5 过快导致 step2 重入/握手来不及）
        window._sgChatMainEngineId = safeSetInterval(function () {
            try {
                // 4.6.113：未运行时跳过 tick（函数内部已有同样检查，这里提前拦截省函数调用）
                if (sessionStorage.getItem('dan_auto_run') !== 'true') return;
                if (typeof window.__sgChatMainEngineTick === 'function') window.__sgChatMainEngineTick();
            } catch (eTick) {
                console.warn('[chat] mainEngine tick', eTick);
            }
        }, 5000 + Math.floor(Math.random() * 2000));
        return true;
    }
    ensureChatMainEngine();
    var mainEngine = window._sgChatMainEngineId;

    // ==============================================================================
    // 【V3 自动刷新已禁用 — 由 Coordinator 全权接管调度，不再自主刷新】
    // ==============================================================================
    // safeSetInterval(() => { ... }, 30 * 60 * 1000); // DISABLED in V3
    
    // 刷新后恢复 Coordinator 接管（不再绕过调度器直接设 dan_auto_run）
    (function recoverAfterRefresh() {
        const recoveryTime = localStorage.getItem('dan_recovery_time');
        if (recoveryTime && Date.now() - parseInt(recoveryTime) < 60000) {
            console.log('[自动刷新] 检测到恢复标记，等待 Coordinator 接管...');
            // Coordinator 在 init() 后会自动根据阶段调度引擎，无需这里直接开启
        }
        localStorage.removeItem('dan_recovery_auto_run');
        localStorage.removeItem('dan_recovery_time');
        localStorage.removeItem('dan_recovery_target');
        localStorage.removeItem('dan_recovery_links');
    })();
    
    // ==============================================================================
    // 【内存/媒体缓存监控 — 300MB 仅清缓存；>400MB/DOM>8000 走 recreate heal】
    // ==============================================================================
    safeSetInterval(() => {
        if (window.performance && window.performance.memory) {
            const mem = window.performance.memory;
            const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
            const totalMB = Math.round(mem.totalJSHeapSize / 1024 / 1024);
            console.log(`[内存监控] 已用: ${usedMB}MB / 总量: ${totalMB}MB`);

            const domCount = document.getElementsByTagName('*').length;
            sessionStorage.setItem('dan_memory_mb', usedMB.toString());
            sessionStorage.setItem('dan_dom_count', domCount.toString());

            // 约 300MB / DOM≥6000：只清媒体缓存（不掉登录、不重建 tab）
            if ((usedMB >= 300 || domCount >= 6000) && !(usedMB > 400 || domCount > 8000)) {
                try {
                    chrome.runtime.sendMessage({ action: 'sg_purge_cache', reason: 'heap_300' }, function (r) {
                        if (chrome.runtime.lastError) return;
                        if (r && r.skipped) console.log('[内存监控] 清缓存跳过:', r.reason || 'rate_limit');
                        else if (r && r.ok) console.log('[内存监控] 已请求清媒体缓存');
                    });
                } catch (ePurge) {}
            }

            // 内存超过 400MB 或 DOM 节点超过 8000：自动模式 request_heal(recreate)
            if (usedMB > 400 || domCount > 8000) {
                console.warn(`[内存监控] 资源过高(内存${usedMB}MB/DOM${domCount})，请求自愈...`);
                try {
                    if (typeof ChallengeGuard !== 'undefined' && ChallengeGuard.shouldBlockHeal && ChallengeGuard.shouldBlockHeal()) {
                        console.warn('[内存监控] 验证/熔断中，跳过 heal');
                        return;
                    }
                } catch (eCgMem) {}
                if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode()) {
                    let pausedTill = 0;
                    try { pausedTill = parseInt(sessionStorage.getItem('sg_paused_till') || '0', 10) || 0; } catch (_) {}
                    try {
                        chrome.runtime.sendMessage({
                            action: 'sg_request_heal',
                            reason: 'memory',
                            mode: 'recreate',
                            pausedTill: pausedTill,
                            challenge: false
                        }, function (r) {
                            if (chrome.runtime.lastError) {
                                console.warn('[内存监控] heal 失败:', chrome.runtime.lastError.message);
                                return;
                            }
                            if (r && r.ok) console.log('[内存监控] heal 已批准 mode=', r.mode || 'recreate');
                            else console.log('[内存监控] heal 被拒绝:', (r && r.reason) || 'unknown');
                        });
                    } catch (eHeal) {
                        console.warn('[内存监控] sendMessage 异常:', eHeal && eHeal.message);
                    }
                    return;
                }
                // 非自动模式：保留手动场景下的原 reload 行为
                if (sessionStorage.getItem('dan_auto_run') === 'true') {
                    localStorage.setItem('dan_recovery_auto_run', 'true');
                    localStorage.setItem('dan_recovery_time', Date.now().toString());
                    clearAllTimers();
                    cleanupInjectedDOM();
                    window.location.reload();
                }
            }
        }
    }, 5 * 60 * 1000); // 每 5 分钟检查一次
    
    // ==============================================================================
    // 探针模块 (V11.4 修复：心跳始终上报，不受 matrix_auto_run 限制)
    // 4.6.113：未运行时降频到 60s（保留白屏自愈检测，减网络心跳）
    // ==============================================================================
    var _lastChatProbeAt = 0;
    safeSetInterval(() => {
        var _chatRunning = sessionStorage.getItem('dan_auto_run') === 'true';
        if (!_chatRunning && Date.now() - _lastChatProbeAt < 60000) return;
        _lastChatProbeAt = Date.now();

        let workerId = getWorkerId();
        
        // 根据引擎实际状态设置心跳状态
        let isEngineRunning = sessionStorage.getItem('dan_auto_run') === 'true';
        let currentStatus = isEngineRunning ? "正在列表中寻敌..." : "私信引擎待机";
        let target = sessionStorage.getItem('current_target') || "无";
        let detailStr = `当前操作目标: @${target}`;

        if (sessionStorage.getItem('dan_cooling_down') === 'true') {
            currentStatus = "风控强制休眠中";
        }
        
        let lastHealthy = parseInt(sessionStorage.getItem('dan_last_healthy_time') || Date.now());
        if (Date.now() - lastHealthy > 25000) {
            currentStatus = "⚠️ 页面白屏卡死 (请求刷新中)";
            detailStr = "DOM节点无响应";
            // 4.1.26：私信心跳发现白屏也请求 heal（旧文案「待命」实际从不刷新）
            try {
                var healAt = parseInt(sessionStorage.getItem('dan_white_heal_req_at') || '0', 10) || 0;
                if (Date.now() - lastHealthy > 45000 && Date.now() - healAt > 60000) {
                    var blockHeal = false;
                    try {
                        if (typeof ChallengeGuard !== 'undefined' && ChallengeGuard.shouldBlockHeal) {
                            blockHeal = !!ChallengeGuard.shouldBlockHeal();
                        }
                    } catch (eBh) {}
                    if (!blockHeal) {
                        sessionStorage.setItem('dan_white_heal_req_at', String(Date.now()));
                        chrome.runtime.sendMessage({
                            action: 'sg_request_heal',
                            reason: 'white_screen_chat',
                            pausedTill: parseInt(sessionStorage.getItem('sg_paused_till') || '0', 10) || 0,
                            challenge: false
                        }, function () { /* ignore */ });
                        console.warn('[私信] 白屏≥45s，已请求 sg_request_heal');
                    }
                }
            } catch (eWh) {}
        } else if (sessionStorage.getItem('dan_auto_step') === '2_waiting') {
            currentStatus = "私信分析与发送中...";
        }
        
        // V11.5.7: 读取内存状态
        let memMB = sessionStorage.getItem('dan_memory_mb') || '0';
        let domCount = sessionStorage.getItem('dan_dom_count') || '0';

        // 读取本地累计统计，随心跳同步到 NAS（解决大屏显示为0的问题）
        let rawStats = GM_getValue('dan_local_stats', '');
        let localStats = rawStats ? JSON.parse(rawStats) : {ice:0, ad:0, corpse:0, reject:0};
        if (localStats.ignored !== undefined && localStats.corpse === undefined) {
            localStats.corpse = localStats.ignored; localStats.reject = 0;
        }

        // 通过 background.js 上报（避免 HTTPS 页面的 Mixed Content 问题）
        try {
            chrome.runtime.sendMessage({
                action: "send_report",
                payload: {
                    worker_id: workerId,
                    engine: "chat",
                    status: isEngineRunning ? "running" : "idle",
                    detail: detailStr,
                    stats: {
                        ice: localStats.ice || 0,
                        ad: localStats.ad || 0,
                        corpse: localStats.corpse || 0,
                        reject: localStats.reject || 0
                    },
                    memory_mb: parseInt(memMB) || 0,
                    dom_count: parseInt(domCount) || 0
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('[心跳] Service Worker 未就绪');
                }
            });
        } catch(e) {}
    }, 15000); // V11.5.7: 15秒心跳（降低3倍负载，防止网络堆积）


    // 【自动化检测接口】
    window.matrixTabRole = 'chat';
    window.matrixStatus = function() {
        return {
            follow: localStorage.getItem('dan_follow_status') || 'stopped',
            chat: localStorage.getItem('dan_chat_status') || 'stopped'
        };
    };

    // ==================== Coordinator 命令监听 ====================
    window.addEventListener('sg-chat-command', function (e) {
        var d = e.detail || {};
        if (d.command === 'start') {
            // 启动时清理 48h 未回复目标（每日一次）
            try { pruneStaleIfNeeded(); } catch (ePr) {}
            var recStart = null;
            try { recStart = reconcileChatHostIdentity('chat_command_start'); } catch (eRecS) { recStart = null; }
            var myH = (recStart && recStart.live) || getMyHandle();
            if (myH) sessionStorage.setItem('dan_target_username', myH);
            var wasRunning = sessionStorage.getItem('dan_auto_run') === 'true';
            var dest = (d.targetUrl || '').split('?')[0];
            // 守箱废除：任何 CHAT URL 改资料页（先读 F 再进粉丝列表）
            if (isDmPath(dest)) {
                dest = myH ? ('https://x.com/' + myH) : dest;
                console.warn('[私信] start 目标是 CHAT，已改资料页');
            } else if (dest && /\/followers(?:\/|$|\?|#)/i.test(dest) && myH) {
                dest = 'https://x.com/' + myH;
            }
            // 4.6.76：空 dest = coRehydrate 补活，禁止清 F-ready/nav_phase（否则主页↔列表乒乓）
            if (dest) {
                try { clearOwnProfileFollowerReady('chat_command_start'); } catch (ePfClr) {}
            } else {
                console.log('[私信] start 补活（空 dest），保留 nav_phase/F-ready');
            }
            var softPhase = '';
            try {
                softPhase = (JSON.parse(localStorage.getItem('sg_state') || '{}').softRiskPhase) || '';
            } catch (eSp) {}
            var isChat2 = softPhase === 'chat2';
            var keepInboxPulse = false;
            if (false && isDmPath(dest)) {
                // 守箱路径已废除，保留块避免误进
            } else if (dest) {
                setChatPhase('outbound');
                resetChatIdentityState(isChat2 ? 'chat_command_chat2_start' : 'chat_command_outbound_start');
            }
            sessionStorage.setItem('dan_auto_run', 'true');
            localStorage.setItem('dan_chat_status', 'running');
            try { ensureLedgerSyncHeartbeat(); } catch (eHb0) {}
            if (!keepInboxPulse && (dest || !wasRunning)) {
                sessionStorage.removeItem('dan_auto_step');
                var reuseScan = false;
                if (!isChat2) {
                    try {
                        reuseScan = hasFanRosterBaseline() && hasSoftWindowRosterScanDone();
                    } catch (eRu) { reuseScan = false; }
                    if (reuseScan) {
                        // 4.3.11：同软窗已浅扫过 → 不清队/不清已见，只补债，禁止再「浅扫回顶」
                        // 4.6.62：不从缓存偷标 F-ready；start 已清标记，须再经资料页读 F
                        // 4.6.67/70：同步灌本地债 + OPS 全量对齐回写
                        try { seedUnfinishedFanDebtToQueue('chat1_reuse_window'); } catch (eSeedR) {}
                        try { iceQueuePromoteDeferred('chat1_reuse_window'); } catch (ePromR) {}
                        try { sortIceQueueForDrain(); } catch (eSortR) {}
                        syncLedgerWithOps({ reason: 'chat1_reuse_ops', allowPost: true }, function (res) {
                            try { sortIceQueueForDrain(); } catch (eSort2) {}
                            var nOps = (res && res.added) || 0;
                            var qReuse = loadIceTaskQueue();
                            var stRu = iceQueueStats(qReuse);
                            if ((stRu.pending + stRu.doing) > 0) {
                                if (!qReuse.sealed) {
                                    qReuse.sealed = true;
                                    saveIceTaskQueue(qReuse);
                                }
                                showToast('📋 本软窗已浅扫，跳过重扫→逐条', '#1d9bf0', 1800);
                            } else if (countUnicedBacklogInDb() > 0 || nOps > 0) {
                                forceRescanForRosterGap('chat1_reuse_empty');
                                showToast('📋 台账仍有债，取消空复用→再扫', '#faad14', 2500);
                            } else if (!qReuse.sealed) {
                                // 真无债：可 sealed，但不走 iceQueueSeal 上传空快照
                                qReuse.sealed = true;
                                saveIceTaskQueue(qReuse);
                                showToast('📋 本软窗已浅扫，暂无待办', '#1d9bf0', 1800);
                            }
                        });
                        console.log('[粉丝队列] 同软窗复用登记，跳过重扫（含 OPS 全量同步）');
                    } else {
                        sessionStorage.setItem('dan_session_scanned', '[]');
                        sessionStorage.setItem('dan_scroll_fail_count', '0');
                        sessionStorage.setItem('dan_bottom_hit_count', '0');
                        try { clearIceTaskQueue('chat_start'); } catch (eClrIce) {}
                        try { seedUnfinishedFanDebtToQueue('chat1_start'); } catch (eSeed1) {}
                        try { iceQueuePromoteDeferred('chat1_start'); } catch (eProm2) {}
                        try { syncLedgerWithOps({ reason: 'chat1_start_ops', allowPost: false }); } catch (ePull1) {}
                    }
                } else {
                    try { prepareSoftRiskChat2Queue('chat_command_start'); } catch (eP2) {}
                    try { syncLedgerWithOps({ reason: 'chat2_start_ops', allowPost: true }); } catch (ePull2) {}
                }
            }
            try { ensureChatMainEngine(); } catch (eEng) {}
            sessionStorage.setItem('sg_module_chat', JSON.stringify({ running: true, phase: 'starting', targetUrl: dest || '', startedAt: Date.now(), lastActive: Date.now() }));
            // targetUrl 为空 = 仅补活，绝不跳转
            // 同面免跳：已在收箱且目标收箱 / 已在本人粉丝页且目标粉丝页；inbox↔followers 必须跳（修「完工停错页」）
            var path = (window.location.pathname || '').toLowerCase();
            var onOwnFollowers = myH && path.indexOf('/' + myH.toLowerCase() + '/followers') === 0;
            var onOwnProfile = myH && path === '/' + myH.toLowerCase();
            var onMessages = isDmPath(path);
            var destIsDm = dest ? isDmPath(dest) : false;
            var alreadyOnDest = false;
            if (dest) {
                if (destIsDm && onMessages) alreadyOnDest = true;
                else if (!destIsDm && onOwnFollowers && /\/followers/i.test(dest)) alreadyOnDest = true;
                else if (onOwnProfile && dest.indexOf('/' + myH) >= 0 && !/\/followers/i.test(dest)) alreadyOnDest = true;
                else if (window.location.href.indexOf(dest) >= 0) alreadyOnDest = true;
            }
            if (dest && !alreadyOnDest) {
                chatGo(dest, false);
                return;
            }
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 500).toString());
            updateMasterBtn();
            if (dest) showToast('📩 调度启动私信', '#1d9bf0', 1500);
            try {
                window.dispatchEvent(new CustomEvent('sg-runtime-push', { detail: { reason: 'chat_on' } }));
            } catch (eOn) {}
        } else if (d.command === 'stop') {
            sessionStorage.setItem('dan_auto_run', 'false');
            localStorage.setItem('dan_chat_status', 'stopped');
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.removeItem('dan_inbox_opening');
            sessionStorage.setItem('sg_module_chat', JSON.stringify({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() }));
            try { clearAllTimers(); } catch (err) {}
            updateMasterBtn();
            try {
                window.dispatchEvent(new CustomEvent('sg-runtime-push', { detail: { reason: 'chat_off' } }));
            } catch (eOff) {}
        }
    });

    function bindSgModularChatHooks() {
        try {
            if (window.SgTargetDb && window.SgTargetDb.bind) {
                window.SgTargetDb.bind({
                    getMyHandle: typeof getMyHandle === 'function' ? getMyHandle : null,
                    saveToDB: typeof saveToDB === 'function' ? saveToDB : null
                });
            }
        } catch (e1) {}
        try {
            if (window.SgChatGates && window.SgChatGates.bind) {
                window.SgChatGates.bind({
                    normalizeChatHandle: normalizeChatHandle,
                    loadTargetDB: loadTargetDB,
                    saveTargetDB: saveTargetDB,
                    loadSgState: typeof loadSgState === 'function' ? loadSgState : function () { try { return JSON.parse(localStorage.getItem('sg_state') || '{}'); } catch (e) { return {}; } },
                    chatShanghaiDate: typeof chatShanghaiDate === 'function' ? chatShanghaiDate : function () { return ''; },
                    isMessagesPage: typeof isMessagesPage === 'function' ? isMessagesPage : function () { return false; }
                });
            }
        } catch (e2) {}
        try {
            if (window.SgPromoLinks && window.SgPromoLinks.bind) {
                window.SgPromoLinks.bind({
                    getBotKey: getBotKey,
                    onLinksUpdated: typeof updateLinksUI === 'function' ? updateLinksUI : null
                });
            }
        } catch (e3) {}
        try { bindSgInboxWatchHooks(); } catch (e4) {}
        try { bindSgDmPinHooks(); } catch (e5) {}
    }

    try { bindSgModularChatHooks(); } catch (eMod) {}
    window.__sgChatAge = {
        parseAgeFromText: parseAgeFromText,
        collectPeerDmTexts: collectPeerDmTexts
    };
    try {
        try { bindSgInboxWatchHooks(); } catch (eInboxBind) {}
    } catch (eInboxReg) {}
    // 4.6.4：守箱移除时误删的收件箱 DOM 工具函数（仍被 live 流程/bridge 引用），从备份恢复
    function extractInboxRowPreviewData(row) {
        return (window.SgInboxWatch && window.SgInboxWatch.extractInboxRowPreviewData)
            ? window.SgInboxWatch.extractInboxRowPreviewData(row)
            : { preview: '', fromSelf: false, source: 'none', handle: '', unreadFromAria: false };
    }
    function pickActionableInboxRows() {
        return (window.SgInboxWatch && window.SgInboxWatch.pickActionableInboxRows)
            ? (window.SgInboxWatch.pickActionableInboxRows() || []) : [];
    }
    /** 从收件箱行 testid dm-conversation-item-<peerId>:<myId> 提取并回写对方数字ID。
     *  写入前用行 aria-description 中的 @handle 交叉验证，防止匹配错行导致 peerId 污染。 */
    function captureDmPeerIdFromRow(targetHandle, row) {
        targetHandle = normalizeChatHandle(targetHandle);
        if (!targetHandle || !row) return '';
        var tid = row.getAttribute('data-testid') || '';
        var m = tid.match(/dm-conversation-item-(\d{6,}):(\d{6,})/);
        if (!m) return '';
        var peerId = m[1];
        try {
            var desc = String(row.getAttribute('aria-description') || row.getAttribute('aria-label') || '');
            var mh = desc.match(/@(\S+)/i);
            var rowHandle = mh ? String(mh[1]).replace(/[,\s].*$/, '').toLowerCase() : '';
            if (rowHandle && rowHandle !== targetHandle.toLowerCase()) {
                console.warn('[captureDmPeerId] 行 handle 不匹配，拒绝回写 @' + targetHandle + ' (row=@' + rowHandle + ') peerId=' + peerId);
                return '';
            }
        } catch (eV) {}
        try {
            var db = loadTargetDB();
            if (!db[targetHandle]) db[targetHandle] = { round: 0, firstSeen: Date.now(), lastDM: null };
            if (String(db[targetHandle].peerId || '') !== peerId) {
                db[targetHandle].peerId = peerId;
                saveTargetDB(db);
                console.log('[captureDmPeerId] 回写 @' + targetHandle + ' peerId=' + peerId);
            }
        } catch (e) {}
        return peerId;
    }

    function findInboxConversationElement(handle) {
        handle = normalizeChatHandle(handle);
        if (!handle) return null;
        var entry = loadTargetDB()[handle] || {};
        // 新版 X：收件箱行无 handle，仅 testid dm-conversation-item-<peerId>:<myId> 与链接 /i/chat/<peerId>-<myId>
        // 通道1：按对方数字ID精确匹配（outbound/inbox 打开会话时已 captureDmPeerId）
        // 注意：匹配后必须用行 aria-description 的 @handle 交叉验证，防止 DB peerId 污染后错配
        var pid = String(entry.peerId || '').replace(/\D/g, '');
        if (pid && pid.length >= 6) {
            try {
                var byId = document.querySelector('[data-testid^="dm-conversation-item-' + pid + ':"]');
                if (byId) {
                    var desc = String(byId.getAttribute('aria-description') || '');
                    var dm = desc.match(/@(\S+)/i);
                    var rh = dm ? String(dm[1]).replace(/[,\s].*$/, '').toLowerCase() : '';
                    if (!rh || rh === handle.toLowerCase()) return byId;
                    // 通道1 被污染：行 handle 与目标不一致，回退到通道2/3
                }
            } catch (eP) {}
            try {
                var byHref = document.querySelector(
                    'a[href*="/i/chat/' + pid + '-"], a[href*="/messages/' + pid + '-"], a[href*="/i/chat/' + pid + '"], a[href*="/messages/' + pid + '"]'
                );
                if (byHref) return byHref.closest('[data-testid^="dm-conversation-item-"]') || byHref.closest('[data-testid="conversation"]') || byHref.closest('[data-testid="DMConversation"]') || byHref.closest('[role="listitem"]') || byHref;
            } catch (eP2) {}
        }
        // 通道2：按显示名匹配行首（粉丝页扫描时已 discoverTarget 存 displayName）
        var dnKey = normalizeDisplayName(entry.displayName);
        if (dnKey) {
            try {
                var dnRows = document.querySelectorAll('[data-testid^="dm-conversation-item-"]');
                for (var d2 = 0; d2 < dnRows.length; d2++) {
                    var firstLine = ((dnRows[d2].innerText || '').split('\n')[0] || '');
                    if (normalizeDisplayName(firstLine) === dnKey) return dnRows[d2];
                }
            } catch (eD2) {}
        }
        // 通道3：旧版 handle 匹配（兼容）
        var selectors = [
            '[data-testid^="dm-conversation-item-"] a[href*="/' + handle + '"]',
            '[data-testid^="dm-conversation-item-"] [href*="/' + handle + '"]',
            '[data-testid="conversation"] a[href*="/' + handle + '"]',
            '[data-testid="DMConversation"] a[href*="/' + handle + '"]',
            '[data-testid="conversation"] [href*="/' + handle + '"]',
            '[data-testid="DMConversation"] [href*="/' + handle + '"]',
            'a[href="/' + handle + '"]',
            'a[href*="/' + handle + '?"]',
            'a[href*="/' + handle + '/"]'
        ];
        for (var s = 0; s < selectors.length; s++) {
            try {
                var el = document.querySelector(selectors[s]);
                if (el) return el.closest('[data-testid^="dm-conversation-item-"]') || el.closest('[data-testid="conversation"]') || el.closest('[data-testid="DMConversation"]') || el.closest('[role="listitem"]') || el.closest('article') || el;
            } catch (eS) {}
        }
        var rows = document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"], [data-testid="DMConversation"], [role="listitem"], article');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var txt = (row.innerText || '').toLowerCase();
            if (txt.indexOf('@' + handle) >= 0 || txt.indexOf(handle) >= 0) return row;
            try {
                var links = row.querySelectorAll('a[href*="/messages/"] , a[href*="/i/chat/"] , a[href*="/' + handle + '"]');
                for (var k = 0; k < links.length; k++) {
                    var ah = (links[k].getAttribute('href') || '').toLowerCase();
                    if (ah.indexOf('/' + handle) >= 0) return row;
                }
            } catch (eL) {}
        }
        // 头像 alt / title 兜底
        try {
            var avatarRows = document.querySelectorAll('[data-testid="conversation"], [data-testid="DMConversation"], [role="listitem"], article');
            for (var a = 0; a < avatarRows.length; a++) {
                var rt = (avatarRows[a].getAttribute('aria-label') || avatarRows[a].innerText || '').toLowerCase();
                if (rt.indexOf(handle) >= 0) return avatarRows[a];
                var imgs = avatarRows[a].querySelectorAll('img[alt], img[title]');
                for (var m2 = 0; m2 < imgs.length; m2++) {
                    var al = String(imgs[m2].getAttribute('alt') || imgs[m2].getAttribute('title') || '').toLowerCase();
                    if (al.indexOf(handle) >= 0) return avatarRows[a];
                }
            }
        } catch (eA) {}
        return null;
    }

    /** 收件箱列表（左栏）滚动容器识别：X 虚拟滚动，window.scrollBy 滚不到列表容器 */
    function getInboxListScroller() {
        try {
            var cands = document.querySelectorAll('[data-testid="DmActivityContainer"], [data-testid="dm-inbox-panel"], [data-testid="dm-conversation-list"], [data-testid="DMDrawer"]');
            for (var c = 0; c < cands.length; c++) {
                if (cands[c].scrollHeight > cands[c].clientHeight + 10) return cands[c];
            }
            var row = document.querySelector('[data-testid^="dm-conversation-item-"]');
            if (row) {
                var p = row.parentElement;
                var depth = 0;
                while (p && p !== document.body && depth < 12) {
                    try {
                        var st = window.getComputedStyle(p);
                        if ((st.overflowY === 'auto' || st.overflowY === 'scroll' || st.overflowY === 'overlay') && p.scrollHeight > p.clientHeight + 5) return p;
                    } catch (eC) {}
                    p = p.parentElement;
                    depth++;
                }
            }
        } catch (e) {}
        return null;
    }

    /** 收件箱列表是否已滚动到底（虚拟滚动触底） */
    function isInboxListAtBottom() {
        try {
            var sc = getInboxListScroller();
            if (sc) return (sc.scrollTop + sc.clientHeight) >= (sc.scrollHeight - 160);
            var se = document.scrollingElement || document.documentElement;
            return (se.scrollTop + window.innerHeight) >= (se.scrollHeight - 160);
        } catch (e) { return true; }
    }

    /** 滚动收件箱列表容器（找不到容器时退回 window 滚动） */
    function scrollInboxListBy(amount) {
        try {
            var sc = getInboxListScroller();
            if (sc) {
                sc.scrollBy({ top: amount, behavior: 'smooth' });
                return true;
            }
        } catch (e) {}
        try { window.scrollBy({ top: amount, behavior: 'smooth' }); } catch (e2) {}
        return false;
    }

    try { bindSgDmPinHooks(); } catch (ePinRebind) {}
    window.__sgChatBridge = {
        isDmPath: isDmPath,
        detectDmMailboxSource: detectDmMailboxSource,
        isMessagesPage: isMessagesPage,
        isDmConversationView: isDmConversationView,
        resolveActiveChatHandle: resolveActiveChatHandle,
        getDmMessageListRoot: getDmMessageListRoot,
        repairMissingIceSentAtInDb: repairMissingIceSentAtInDb,
        parseInboxAriaDescription: parseInboxAriaDescription,
        getDmConversationRoot: getDmConversationRoot,
        getDmConversationRootTestid: getDmConversationRootTestid,
        collectPeerDmMessages: collectPeerDmMessages,
        collectPeerDmTexts: collectPeerDmTexts,
        collectExtraPeerTexts: collectExtraPeerTexts,
        isOwnScriptText: isOwnScriptText,
        isLinkShellText: isLinkShellText,
        isDmChromeNoise: isDmChromeNoise,
        isSystemDmLine: isSystemDmLine,
        rebuildOwnScriptCorpus: rebuildOwnScriptCorpus,
        fallbackCollectPeerDmTexts: fallbackCollectPeerDmTexts,
        findBottomAwakeningTarget: findBottomAwakeningTarget,
        hasSendableDmComposer: hasSendableDmComposer,
        classifyDmSendability: classifyDmSendability,
        detectDmSendUnavailable: detectDmSendUnavailable,
        debugDmSendability: debugDmSendability,
        clearFalseDmBlocks: clearFalseDmBlocks,
        findDmSendButton: findDmSendButton,
        findInboxConversationElement: findInboxConversationElement,
        pickActionableInboxRows: pickActionableInboxRows,
        captureDmPeerId: captureDmPeerId,
        captureDmPeerIdFromRow: captureDmPeerIdFromRow,
        threadSafeSendAndConfirm: threadSafeSendAndConfirm,
        detectDmReplyState: detectDmReplyState,
        parseAgeFromInbound: parseAgeFromInbound,
        parseAgeFromText: parseAgeFromText,
        debugPredictAgeRoute: function (texts) {
            var list = [];
            if (typeof texts === 'string') list = [texts];
            else if (Array.isArray(texts)) list = texts;
            var peerTexts = list.map(function (t) { return String(t || ''); }).filter(Boolean);
            var age = parseAgeFromInbound(peerTexts);
            var pool = getScriptPoolMode();
            var rejectBelow = getAgeRejectBelow();
            var intent = pool === 'job' ? parseJobIntent(peerTexts) : 'n/a';
            var route = 'need_age';
            var reason = 'need_age';
            if (pool === 'job') {
                if (intent === 'no') { route = 'reject'; reason = 'job_intent_no'; }
                else if (peerTexts.length) { route = 'ad'; reason = intent === 'yes' ? 'job_yes' : 'job_reply_soft'; }
                else { route = 'deferred'; reason = 'no_reply'; }
            } else {
                if (age != null && age < rejectBelow) { route = 'reject'; reason = 'age_below_' + rejectBelow; }
                else if (age != null) { route = 'ad'; reason = 'age_ok'; }
                else { route = 'ad'; reason = 'greeting_ad'; }
            }
            return {
                texts: peerTexts.slice(0, 5),
                age: age,
                ageRejectBelow: rejectBelow,
                scriptPool: pool,
                jobIntent: intent,
                minorKeyword: false,
                route: route,
                reason: reason,
                note: route === 'reject'
                    ? '将发婉拒话术并 round→3'
                    : (route === 'ad'
                        ? (pool === 'job' ? '兼职粉有回复且非拒绝 → 完整话术' : '将发广告话术（需直播链接）')
                        : (route === 'deferred' ? '无回复 → deferred' : '无年龄 → need_age'))
            };
        },
        getScriptPoolMode: getScriptPoolMode,
        parseJobIntent: parseJobIntent,
        /** 直接导航到目标 DM 会话页（绕过收件箱行可见性限制）。
         *  url 形如 /i/chat/<peerId>-<myId> 或完整链接；导航后等待 3~4 秒再运行 detectDmReplyState */
        debugOpenDmConversation: function (handle, url) {
            handle = normalizeChatHandle(handle);
            if (!handle || !url) return { error: 'need handle and conversation url' };
            var rawUrl = String(url).trim();
            if (!/^\//.test(rawUrl) && !/^https?:\/\//.test(rawUrl)) rawUrl = '/' + rawUrl;
            var m = rawUrl.match(/(?:i\/chat|messages)\/(\d{5,})-(\d{5,})/);
            if (!m) m = rawUrl.match(/(?:i\/chat|messages)\/(\d{5,})(?:\/|$|\?|#)/);
            var peerId = m ? m[1] : '';
            if (m && m[2]) {
                try { sessionStorage.setItem('dan_inbox_my_id', String(m[2])); } catch (eMy2) {}
            }
            if (peerId) {
                try {
                    var db = loadTargetDB();
                    if (db[handle] && String(db[handle].peerId || '') !== peerId) {
                        db[handle].peerId = peerId;
                        saveTargetDB(db);
                        console.log('[debugOpenDmConversation] 回写 @' + handle + ' peerId=' + peerId);
                    }
                } catch (e) {}
            }
            sessionStorage.setItem('dan_inbox_opening', handle);
            sessionStorage.setItem('current_target', handle);
            sessionStorage.setItem('dan_auto_step', '2');
            sessionStorage.setItem('dan_wait_count', '0');
            chatGo(rawUrl, true);
            return { ok: true, handle: handle, url: rawUrl, peerId: peerId, note: '已导航，等待加载后运行 detectDmReplyState(\'' + handle + '\')' };
        },
        getChatPhase: getChatPhase,
        getDnaCore: function () { return MY_DNA_CORE || []; },
        debugDumpTargetDb: function (handle) {
            handle = normalizeChatHandle(handle);
            var root = loadRootTargetDB();
            var bot = getBotKey() || FALLBACK_BOT_KEY;
            var db = loadTargetDB();
            var out = { bot: bot, root_keys: Object.keys(root), target: null, row_count: document.querySelectorAll('[data-testid^="dm-conversation-item-"]').length, scroller: null };
            if (handle && db[handle]) {
                var e = db[handle];
                out.target = {
                    peerId: e.peerId || '',
                    displayName: e.displayName || '',
                    round: e.round || 0,
                    firstSeen: e.firstSeen || 0,
                    lastDM: e.lastDM || 0,
                    iceSentAt: e.iceSentAt || 0,
                    adSentAt: e.adSentAt || 0,
                    lastInboundAt: e.lastInboundAt || 0,
                    replySeenAt: e.replySeenAt || 0,
                    done: !!e.done
                };
            }
            try {
                var sc = getInboxListScroller();
                if (sc) {
                    out.scroller = { tag: sc.tagName, testid: (sc.getAttribute && sc.getAttribute('data-testid')) || '', sh: sc.scrollHeight, ch: sc.clientHeight, st: sc.scrollTop };
                }
            } catch (eSc) {}
            return out;
        },
        /** 一键链路诊断：DB 状态 → 收件箱发现 → 会话页回复检测 → 发送闸门，逐环节给出 通过/失败+原因 */
        debugTraceReplyChain: function (handle) {
            handle = normalizeChatHandle(handle);
            if (!handle) return { error: 'need handle' };
            var entry = loadTargetDB()[handle] || {};
            var out = {
                handle: handle,
                db: {
                    peerId: entry.peerId || '',
                    displayName: entry.displayName || '',
                    round: entry.round || 0,
                    done: !!entry.done,
                    firstSeen: entry.firstSeen || 0,
                    lastDM: entry.lastDM || 0,
                    iceSentAt: entry.iceSentAt || 0,
                    adSentAt: entry.adSentAt || 0,
                    lastInboundAt: entry.lastInboundAt || 0,
                    replySeenAt: entry.replySeenAt || 0
                },
                mailbox: null,
                inboxListVisible: false,
                rowCount: 0,
                inbox: null,
                onConversation: false,
                reply: null,
                gate: null
            };
            try {
                out.mailbox = detectDmMailboxSource();
                out.inboxListVisible = isDmInboxListVisible();
                out.rowCount = document.querySelectorAll('[data-testid^="dm-conversation-item-"]').length;
                if (out.inboxListVisible) {
                    var row = findInboxConversationElement(handle);
                    out.inbox = { rowVisible: !!row };
                    if (row) {
                        var tid = row.getAttribute('data-testid') || '';
                        var m = tid.match(/dm-conversation-item-(\d+):(\d+)/);
                        var previewData = extractInboxRowPreviewData(row);
                        var previewScore = scoreInboxPreview(previewData.preview);
                        var unreadInfo = getInboxRowUnread(row);
                        out.inbox.testid = tid;
                        out.inbox.peerIdFromRow = m ? m[1] : '';
                        out.inbox.myIdFromRow = m ? m[2] : '';
                        out.inbox.preview = previewData.preview;
                        out.inbox.previewFromSelf = previewData.fromSelf;
                        out.inbox.previewSource = previewData.source;
                        out.inbox.confidence = previewData.fromSelf ? 'own' : previewScore.confidence;
                        out.inbox.replied = inboxPreviewIndicatesPeerReply(previewData.preview, previewData, previewScore);
                        out.inbox.unread = unreadInfo.unread;
                        out.inbox.unreadSource = unreadInfo.source;
                        out.inbox.unreadPrecise = unreadInfo.precise;
                    }
                }
            } catch (eInbox) { out.inboxError = String((eInbox && eInbox.message) || eInbox); }
            try {
                out.onConversation = isDmConversationPage();
                if (out.onConversation) {
                    var cm = (window.location.pathname || '').match(/(?:i\/chat|messages)\/(\d{6,})-(\d{6,})/);
                    if (cm) out.conversationPeerId = cm[1];
                    out.reply = detectDmReplyState(handle);
                }
            } catch (eReply) { out.replyError = String((eReply && eReply.message) || eReply); }
            var iceAt = entry.iceSentAt || 0;
            var lastInboundAt = entry.lastInboundAt || 0;
            var adMinWaitMs = getAdMinWaitMs();
            var blockers = [];
            if (entry.done) blockers.push('目标已完成(done=true)，不再处理');
            if ((entry.round || 0) !== 1) blockers.push('非 round1（当前 round=' + (entry.round || 0) + '），回复检测仅适用 round1');
            if (!iceAt) blockers.push('缺 iceSentAt（本地未记录破冰发送时间）');
            // adMinWait 仅影响收件箱探测打开，不作为发送闸门 blocker
            if (!(lastInboundAt > iceAt)) blockers.push('缺 lastInboundAt（尚未确认收到对方回复）');
            out.gate = {
                iceSentAt: iceAt,
                lastInboundAt: lastInboundAt,
                adMinWaitMs: adMinWaitMs,
                waitLeftMin: iceAt ? Math.max(0, Math.ceil((iceAt + adMinWaitMs - Date.now()) / 60000)) : null,
                canSendAd: !!(iceAt && lastInboundAt && lastInboundAt > iceAt),
                note: 'adMinWait 仅约束列表探测时机，差集确认后 canSendAdNow 不再校验等待期',
                blockers: blockers
            };
            // 分段结论：逐环节给出 通过/失败/跳过 + 原因 + 建议动作，用于锁定卡点环节
            var gateNow = canSendAdNow(handle, (out.reply && out.reply.texts) || [], entry);
            var chain = [];
            var rawSteps = [
                { step: 'db', label: '目标入库', ok: !!(entry && (entry.round !== undefined || entry.firstSeen !== undefined)), reason: 'DB 中无此目标', detail: (entry && entry.round !== undefined) ? ('round=' + (entry.round || 0) + (entry.done ? ' done' : '')) : '', suggest: '先在粉丝页发现目标，或检查 chat_target_db 是否被清空' },
                { step: 'round', label: '轮次状态', ok: !!(entry && !entry.done && (entry.round || 0) === 1), reason: (entry && entry.done) ? 'done=true 已完成' : '非 round1（round=' + ((entry && entry.round) || 0) + '）', detail: '', suggest: '回复检测仅适用 round1，已完成/晋级目标无需处理' },
                { step: 'peer_id', label: '对方数字ID', ok: !!(entry && entry.peerId), reason: '缺 peerId（无法直接导航/行匹配）', detail: (entry && entry.peerId) || '', suggest: '收件箱命中目标行会自动回写，或 debugOpenDmConversation(handle, url) 导航时回写' },
                { step: 'ice_sent', label: '破冰发送', ok: !!iceAt, reason: '缺 iceSentAt（本地未记录破冰发送时间）', detail: iceAt ? new Date(iceAt).toLocaleString('zh-CN', { hour12: false }) : '', suggest: '等待调度执行 round1 破冰，破冰后自动补齐' },
                { step: 'wait', label: '列表探测等待', ok: !iceAt || Date.now() - iceAt >= adMinWaitMs, reason: '破冰后列表探测等待未过（剩 ' + Math.max(0, Math.ceil((iceAt + adMinWaitMs - Date.now()) / 60000)) + ' 分钟）', detail: 'adMinWait=' + (adMinWaitMs / 60000) + 'min（仅 probe，非发送闸门）', suggest: '等待期只影响何时主动打开会话探测；差集已确认回复后发送不再卡此项' },
                { step: 'inbox_row', label: '收件箱行', ok: !out.inboxListVisible || !!(out.inbox && out.inbox.rowVisible), reason: '可视区未找到目标行', na: !out.inboxListVisible, detail: out.inboxListVisible ? (out.rowCount + ' 行' + (out.inbox && out.inbox.testid ? (' / ' + out.inbox.testid) : '')) : '当前不在收件箱列表页，跳过', suggest: '到 /i/chat 打开收件箱下滑扫描；或 debugOpenDmConversation(handle, url) 直接导航' },
                { step: 'inbox_signal', label: '收件箱回复信号', ok: !(out.inboxListVisible && out.inbox && out.inbox.rowVisible) || !!(out.inbox.replied || out.inbox.unread), reason: '行可见但未判为回复/未读', na: !(out.inboxListVisible && out.inbox && out.inbox.rowVisible), detail: (out.inbox && out.inbox.rowVisible) ? ('replied=' + !!out.inbox.replied + ' unread=' + !!out.inbox.unread + ' confidence=' + (out.inbox.confidence || '') + ' preview=' + String(out.inbox.preview || '').slice(0, 40)) : '行不可见，跳过', suggest: '对方确已回复时跑 debugCalibrateInboxUnread / debugDumpInboxRowHTML；previewFromSelf 则等对方回；否则写入未读 selector 缓存' },
                { step: 'reply', label: '会话回复', ok: !out.onConversation || !!(out.reply && (out.reply.hasReply || out.reply.unreadSeen)), reason: out.replyError ? ('检测出错: ' + out.replyError) : '对方尚无新回复', na: !out.onConversation, detail: out.onConversation ? ('对方气泡=' + ((out.reply && out.reply.texts || []).length) + ' 未读=' + (out.reply && out.reply.unreadSeen ? '是' : '否') + ' decision=' + (out.reply && out.reply.decision) + ' source=' + (out.reply && out.reply.source)) : '当前不在会话页，跳过', suggest: '会话页会自动滚动读取；若对方确已回复仍未检出，用 debugDumpConversationState(handle) 查容器识别' },
                { step: 'gate', label: '发送闸门', ok: !out.onConversation || gateNow.ok, reason: gateNow.reason || '闸门未通过', na: !out.onConversation, detail: 'lastInboundAt=' + (lastInboundAt ? new Date(lastInboundAt).toLocaleString('zh-CN', { hour12: false }) : '无') + ' gate=' + gateNow.reason + '（不含 adMinWait）', suggest: ({ no_peer_texts: '对方无可用气泡文本，等待对方来消息', missing_ice_sent_at: '缺 iceSentAt，尚未破冰', reply_not_confirmed: '破冰后尚未确认对方回复，守箱检测会持续跟踪' })[gateNow.reason] || '闸门未通过，按原因逐项修复' }
            ];
            for (var ri = 0; ri < rawSteps.length; ri++) {
                var rs = rawSteps[ri];
                chain.push({ step: rs.step, label: rs.label, ok: !!rs.ok, na: !!rs.na, reason: rs.ok ? '' : rs.reason, detail: rs.detail, suggest: rs.suggest });
            }
            var firstFail = null;
            for (var ci = 0; ci < chain.length; ci++) {
                if (!chain[ci].ok && !chain[ci].na) { firstFail = chain[ci]; break; }
            }
            out.chain = chain;
            out.stuckAt = firstFail ? firstFail.step : '';
            out.verdict = firstFail ? ('卡在「' + firstFail.label + '」' + (firstFail.reason ? ' — ' + firstFail.reason : '')) : '链路全通，可发送广告';
            return out;
        },
        /** 手动补写 lastInboundAt（SOP 故障 E 恢复）；写入后返回最新 DB 字段 */
        markLastInboundAt: function (handle) {
            handle = normalizeChatHandle(handle);
            if (!handle) return { error: 'need handle' };
            markLastInboundAt(handle);
            var entry = loadTargetDB()[handle] || {};
            return {
                ok: true,
                handle: handle,
                lastInboundAt: entry.lastInboundAt || 0,
                iceSentAt: entry.iceSentAt || 0,
                canSendAd: !!(entry.iceSentAt && entry.lastInboundAt && entry.lastInboundAt > entry.iceSentAt)
            };
        },
        /** 实机验收：检查 bridge 接线、持久化层、SOP 五类场景归类 */
        debugVerifyReplyChainSetup: function (handle) {
            handle = normalizeChatHandle(handle);
            var replyKey = getReplyStateKey();
            var report = {
                at: Date.now(),
                handle: handle || '',
                pass: true,
                wiring: {},
                persistence: {},
                sop: null,
                checks: [],
                trace: null
            };
            var requiredFns = [
                'debugTraceReplyChain',
                'debugTraceReplyChainAsync',
                'markLastInboundAt',
                'debugDumpConversationState',
                'detectDmReplyState',
                'debugOpenDmConversation',
                'isMessagesPage',
                'getInboxRowUnread',
                'scoreInboxPreview',
                'debugCalibrateInboxUnread',
                'debugAcceptRouteA'
            ];
            for (var wi = 0; wi < requiredFns.length; wi++) {
                var fnName = requiredFns[wi];
                var fnOk = typeof (window.__sgChatBridge || {})[fnName] === 'function';
                report.wiring[fnName] = fnOk;
                if (!fnOk) {
                    report.pass = false;
                    report.checks.push({ id: 'wiring_' + fnName, ok: false, note: fnName + ' 未挂载' });
                }
            }
            try {
                report.persistence.replyStateKey = replyKey;
                report.persistence.localMirror = !!localStorage.getItem(replyKey);
                report.persistence.sessionCopy = !!sessionStorage.getItem(replyKey);
                report.persistence.chatTargetDb = !!localStorage.getItem('chat_target_db');
            } catch (ePersist) {
                report.persistence.error = String((ePersist && ePersist.message) || ePersist);
                report.pass = false;
            }
            if (handle) {
                var entry = loadTargetDB()[handle] || {};
                report.persistence.replySeenAt = entry.replySeenAt || 0;
                report.persistence.lastInboundAt = entry.lastInboundAt || 0;
                report.persistence.iceSentAt = entry.iceSentAt || 0;
                report.persistence.peerId = entry.peerId || '';
                if (!(entry && (entry.round !== undefined || entry.firstSeen !== undefined))) {
                    report.sop = { scenario: 'A', label: '目标未入库', fix: '粉丝页扫描或手动写入 chat_target_db' };
                } else if (!entry.peerId) {
                    report.sop = { scenario: 'B', label: '缺 peerId', fix: '打开 /i/chat 守箱扫描或 debugOpenDmConversation' };
                } else if (!entry.iceSentAt) {
                    report.sop = { scenario: 'C', label: '缺 iceSentAt', fix: '等待 round1 破冰或手动补写' };
                } else if (!(entry.lastInboundAt && entry.lastInboundAt > entry.iceSentAt)) {
                    report.sop = { scenario: 'E', label: '尚未确认对方回复', fix: '差集确认额外文本后自动 markLastInboundAt，或守箱扫描' };
                } else if (Date.now() - entry.iceSentAt < getAdMinWaitMs()) {
                    report.sop = {
                        scenario: 'D',
                        label: '列表探测等待期（非发送闸门）',
                        waitLeftMin: Math.max(0, Math.ceil((entry.iceSentAt + getAdMinWaitMs() - Date.now()) / 60000)),
                        fix: '仅影响何时主动打开会话探测；证据已齐时可发'
                    };
                } else {
                    report.sop = { scenario: 'OK', label: '本地证据齐全', fix: '可运行 debugTraceReplyChainAsync 做 OPS 复核' };
                }
                try {
                    var snap = window.__sgChatBridge.debugTraceReplyChain(handle);
                    report.trace = { stuckAt: snap.stuckAt, verdict: snap.verdict, chainLen: (snap.chain || []).length };
                    if (snap.inbox) {
                        report.inbox = {
                            rowVisible: !!snap.inbox.rowVisible,
                            preview: snap.inbox.preview || '',
                            previewFromSelf: !!snap.inbox.previewFromSelf,
                            confidence: snap.inbox.confidence || '',
                            replied: !!snap.inbox.replied,
                            unread: !!snap.inbox.unread,
                            unreadSource: snap.inbox.unreadSource || '',
                            unreadPrecise: !!snap.inbox.unreadPrecise
                        };
                    }
                } catch (eTrace) {
                    report.trace = { error: String((eTrace && eTrace.message) || eTrace) };
                }
            } else {
                report.checks.push({ id: 'handle_optional', ok: true, note: '未传 handle，仅检查接线与持久化层' });
            }
            return report;
        },
        /** 读取最近一次 async 闭环诊断结果（跨页导航 resume 后写入） */
        debugGetReplyTraceAsyncResult: function () {
            try {
                var raw = sessionStorage.getItem(REPLY_TRACE_RESULT_KEY);
                return raw ? JSON.parse(raw) : (window.__sgReplyTraceResult || null);
            } catch (e) { return { error: String((e && e.message) || e) }; }
        },
        /** 内部：导航 resume 后继续 async 诊断 */
        _continueReplyTraceAsync: function (pending) {
            pending = pending || loadReplyTracePending();
            if (!pending || !pending.handle) return { error: 'no pending trace' };
            clearReplyTracePending();
            return window.__sgChatBridge.debugTraceReplyChainAsync(pending.handle, pending, pending);
        },
        /** 闭环诊断：必要时导航收件箱/会话页后重跑，并追加 OPS 发送许可步 */
        debugTraceReplyChainAsync: function (handle, options, resumeState) {
            handle = normalizeChatHandle(handle);
            if (!handle) return Promise.resolve({ error: 'need handle' });
            options = options || {};
            var waitMs = options.waitMs || 3500;
            var maxNav = options.maxNav != null ? options.maxNav : 2;
            var navigate = options.navigate !== false;
            var state = resumeState || {
                handle: handle,
                phases: options.phases || [],
                navCount: options.navCount || 0,
                maxNav: maxNav,
                waitMs: waitMs,
                navigate: navigate,
                startedAt: options.startedAt || Date.now()
            };
            var self = window.__sgChatBridge;

            function decideNavTarget(trace) {
                var stuck = trace.stuckAt;
                if (stuck === 'inbox_row' && !trace.inboxListVisible) return '/i/chat';
                if (!trace.onConversation) {
                    if (state.navCount === 0 && !trace.inboxListVisible) return '/i/chat';
                }
                return '';
            }

            function runStep() {
                var trace = self.debugTraceReplyChain(state.handle);
                state.phases.push({
                    phase: 'trace_' + state.phases.length,
                    at: Date.now(),
                    trace: summarizeReplyTrace(trace)
                });

                if (navigate && state.navCount < state.maxNav) {
                    var navTarget = decideNavTarget(trace);
                    if (navTarget) {
                        state.navCount++;
                        state.phases[state.phases.length - 1].willNavigate = navTarget;
                        saveReplyTracePending({
                            handle: state.handle,
                            phases: state.phases,
                            navCount: state.navCount,
                            maxNav: state.maxNav,
                            waitMs: waitMs,
                            navigate: navigate,
                            startedAt: state.startedAt,
                            resumeAfterNav: true
                        });
                        sessionStorage.setItem('current_target', state.handle);
                        if (navTarget.indexOf('/i/chat/') === 0) {
                            sessionStorage.setItem('dan_inbox_opening', state.handle);
                            sessionStorage.setItem('dan_auto_step', '2');
                        }
                        debugNavigateForTrace(navTarget);
                        return Promise.resolve({
                            pending: true,
                            handle: state.handle,
                            note: '已导航 ' + navTarget + '，重载后将自动继续诊断；完成后见 debugGetReplyTraceAsyncResult() 或控制台',
                            phases: state.phases
                        });
                    }
                }

                return opsDmCheck(state.handle).then(function (ops) {
                    appendOpsStepToTrace(trace, ops);
                    var result = {
                        pending: false,
                        handle: state.handle,
                        phases: state.phases,
                        final: trace,
                        resumed: !!resumeState,
                        elapsedMs: Date.now() - state.startedAt
                    };
                    storeReplyTraceResult(result);
                    console.log('[回复链路-async] 闭环诊断完成 @' + state.handle, result);
                    return result;
                });
            }

            if (resumeState && resumeState.resumeAfterNav) {
                return new Promise(function (resolve) {
                    setTimeout(function () { resolve(runStep()); }, waitMs);
                });
            }
            return runStep();
        },
        /** 会话页 DOM 诊断：根容器、收集到的对方文本及分类、composer 状态、reply 判定 */
        debugDumpConversationState: function (handle) {
            handle = resolveActiveChatHandle(handle);
            var scanRoot = getDmMessageScanRoot();
            var listRoot = getDmMessageListRoot();
            var out = {
                handle: handle,
                handleResolvedFrom: handle ? (normalizeChatHandle(handle) === normalizeChatHandle(sessionStorage.getItem('current_target') || '') ? 'current_target' : 'inferred') : 'none',
                onConversation: isDmConversationView(),
                onConversationUrl: isDmConversationPage(),
                rootTestid: getDmConversationRootTestid(),
                scanRootTestid: (function () {
                    try { return scanRoot === document.body ? 'body' : (scanRoot.getAttribute('data-testid') || scanRoot.tagName); } catch (e) { return 'unknown'; }
                })(),
                listRootTestid: (function () {
                    try { return listRoot === document.body ? 'body' : (listRoot.getAttribute('data-testid') || listRoot.tagName); } catch (e) { return 'unknown'; }
                })(),
                rawBubbleCount: 0,
                composerFilteredCount: 0,
                allBubbles: [],
                currentTarget: sessionStorage.getItem('current_target') || '',
                messages: [],
                composer: null,
                reply: null
            };
            try {
                var rawLeaves = scanRoot.querySelectorAll('[data-testid^="message-text-"], [data-testid="messageText"]');
                out.rawBubbleCount = rawLeaves.length;
                for (var rl = 0; rl < rawLeaves.length; rl++) {
                    if (isDmComposerNode(rawLeaves[rl])) out.composerFilteredCount++;
                    var bText = getDmMessageText(rawLeaves[rl]);
                    if (!bText) continue;
                    out.allBubbles.push({
                        text: String(bText).slice(0, 120),
                        cls: classifyDmNode(rawLeaves[rl]),
                        filteredAsComposer: isDmComposerNode(rawLeaves[rl])
                    });
                }
            } catch (eRaw) {}
            try {
                var msgs = collectPeerDmMessages();
                for (var i = 0; i < msgs.length; i++) {
                    out.messages.push({
                        text: String(msgs[i].text || '').slice(0, 120),
                        cls: classifyDmNode(msgs[i].source)
                    });
                }
            } catch (eMsg) { out.messagesError = String((eMsg && eMsg.message) || eMsg); }
            try {
                var input = findBottomAwakeningTarget();
                var sendBtn = findDmSendButton();
                out.composer = {
                    inputFound: !!input,
                    inputDisabled: input ? !!input.disabled : null,
                    sendBtnFound: !!sendBtn,
                    sendBtnDisabled: sendBtn ? !!sendBtn.disabled : null
                };
            } catch (eComp) { out.composerError = String((eComp && eComp.message) || eComp); }
            try { out.reply = detectDmReplyState(handle); } catch (eRep) { out.replyError = String((eRep && eRep.message) || eRep); }
            try {
                var entry = loadTargetDB()[handle] || {};
                var peerTexts = collectPeerDmTexts();
                var gate = canSendAdNow(handle, peerTexts, entry);
                out.db = {
                    inDb: !!(entry && (entry.round !== undefined || entry.firstSeen)),
                    round: entry.round || 0,
                    iceSentAt: entry.iceSentAt || 0,
                    lastInboundAt: entry.lastInboundAt || 0,
                    replySeenAt: entry.replySeenAt || 0,
                    peerId: entry.peerId || ''
                };
                out.gate = gate;
                out.peerTextCount = peerTexts.length;
            } catch (eGate) { out.gateError = String((eGate && eGate.message) || eGate); }
            try {
                var dmRoot = document.querySelector('[data-testid="dm-container"], [data-testid="dm-conversation-panel"]') || scanRoot;
                var inv = {};
                var invNodes = dmRoot.querySelectorAll('[data-testid]');
                for (var iv = 0; iv < invNodes.length && iv < 500; iv++) {
                    var itk = invNodes[iv].getAttribute('data-testid') || '';
                    if (!itk || !/message|chat|bubble|conversation|dm/i.test(itk)) continue;
                    inv[itk] = (inv[itk] || 0) + 1;
                }
                out.dmTestids = inv;
            } catch (eInv) {}
            return out;
        },
        /** 清除目标错误的 peerId，让引擎回退到显示名匹配自动修复 */
        debugClearTargetPeerId: function (handle) {
            handle = normalizeChatHandle(handle);
            if (!handle) return { error: 'no handle' };
            try {
                var db = loadTargetDB();
                if (!db[handle]) return { error: 'target not found', handle: handle };
                var oldPeerId = db[handle].peerId || '';
                delete db[handle].peerId;
                saveTargetDB(db);
                return { handle: handle, clearedPeerId: oldPeerId, status: 'done' };
            } catch (e) { return { error: String(e), handle: handle }; }
        },
        /** 从收件箱行 aria-description 提取预览及置信度 */
        extractInboxRowPreview: function (handle) {
            handle = normalizeChatHandle(handle);
            var row = handle ? findInboxConversationElement(handle) : null;
            if (!row) return { error: 'row not found', handle: handle };
            var previewData = extractInboxRowPreviewData(row);
            var previewScore = scoreInboxPreview(previewData.preview);
            var unreadInfo = getInboxRowUnread(row);
            return {
                handle: handle,
                preview: previewData.preview,
                previewFromSelf: previewData.fromSelf,
                previewSource: previewData.source,
                confidence: previewData.fromSelf ? 'own' : previewScore.confidence,
                replied: inboxPreviewIndicatesPeerReply(previewData.preview, previewData, previewScore),
                unread: unreadInfo.unread,
                unreadSource: unreadInfo.source,
                unreadPrecise: unreadInfo.precise,
                ariaDescription: (row.getAttribute && row.getAttribute('aria-description')) || ''
            };
        },
        getInboxRowUnread: getInboxRowUnread,
        scoreInboxPreview: scoreInboxPreview,
        isInboxPreviewFromSelf: isInboxPreviewFromSelf,
        loadInboxUnreadSelectors: loadInboxUnreadSelectors,
        /** 批量采样收件箱行（实机校准未读 selector） */
        debugCalibrateInboxUnread: function (handles) {
            var list = [];
            if (typeof handles === 'string') list = [handles];
            else if (Array.isArray(handles)) list = handles;
            var samples = [];
            for (var ci = 0; ci < list.length; ci++) {
                var h = normalizeChatHandle(list[ci]);
                if (!h) continue;
                var row = findInboxConversationElement(h);
                if (!row) {
                    samples.push({ handle: h, error: 'row not visible' });
                    continue;
                }
                var previewData = extractInboxRowPreviewData(row);
                var previewScore = scoreInboxPreview(previewData.preview);
                var unreadInfo = getInboxRowUnread(row);
                var conf = previewData.fromSelf ? 'own' : previewScore.confidence;
                samples.push({
                    handle: h,
                    testid: (row.getAttribute && row.getAttribute('data-testid')) || '',
                    preview: previewData.preview,
                    previewFromSelf: previewData.fromSelf,
                    previewSource: previewData.source,
                    confidence: conf,
                    replied: inboxPreviewIndicatesPeerReply(previewData.preview, previewData, previewScore),
                    unread: unreadInfo.unread,
                    unreadSource: unreadInfo.source,
                    unreadPrecise: unreadInfo.precise,
                    ariaLabels: Array.prototype.slice.call(row.querySelectorAll('[aria-label]')).map(function (n) {
                        return (n.getAttribute('aria-label') || '').slice(0, 60);
                    }).slice(0, 10),
                    testids: Array.prototype.slice.call(row.querySelectorAll('[data-testid]')).map(function (n) {
                        return (n.getAttribute('data-testid') || '').slice(0, 60);
                    }).slice(0, 15)
                });
            }
            return { at: Date.now(), samples: samples, cached: loadInboxUnreadSelectors() };
        },
        /** 扫描当前可见收件箱行：验证 You:/Unread/replied 识别（对照截图） */
        debugDumpVisibleInboxSignals: function (limit) {
            limit = Math.min(Number(limit) || 12, 30);
            var rows = document.querySelectorAll('[data-testid^="dm-conversation-item-"]');
            var samples = [];
            for (var i = 0; i < rows.length && samples.length < limit; i++) {
                var row = rows[i];
                var previewData = extractInboxRowPreviewData(row);
                var previewScore = scoreInboxPreview(previewData.preview);
                var unreadInfo = getInboxRowUnread(row);
                samples.push({
                    tid: String((row.getAttribute && row.getAttribute('data-testid')) || '').slice(0, 48),
                    handle: previewData.handle || '',
                    preview: String(previewData.preview || '').slice(0, 50),
                    fromSelf: !!previewData.fromSelf,
                    confidence: previewData.fromSelf ? 'own' : previewScore.confidence,
                    replied: inboxPreviewIndicatesPeerReply(previewData.preview, previewData, previewScore),
                    unread: unreadInfo.unread,
                    unreadSource: unreadInfo.source || ''
                });
            }
            return { at: Date.now(), count: samples.length, samples: samples };
        },
        getExtensionVersion: function () {
            var v = '';
            try { v = chrome.runtime.getManifest().version; } catch (e) {}
            var fr = null;
            try {
                if (typeof SgDiagContract !== 'undefined' && SgDiagContract.readFreeze) fr = SgDiagContract.readFreeze();
            } catch (eFr) {}
            return {
                version: v || 'unknown',
                hasStaleOpeningClear: typeof clearStaleInboxOpeningIfOnList === 'function',
                hasCruiseAlive: typeof ensureInboxCruiseAlive === 'function',
                hasFinalKick: false,
                hasKickCount: !!(window.SgChatGates && window.SgChatGates.getKickCount),
                kickMax: (window.SgChatGates && window.SgChatGates.KICK_MAX_COUNT) || 2,
                hasUnstick: typeof unstickInboxAndPulse === 'function',
                hasDiagUnfreeze: typeof clearDiagFreezeLocal === 'function',
                hasFollowupQueue: typeof runFollowupQueueTick === 'function',
                hasFanRoster: typeof classifyFanRosterAction === 'function',
                hasFanRosterReclassify: typeof reclassifyIceQueueFromOps === 'function',
                hasFanRosterPromote: typeof iceQueuePromoteDeferred === 'function',
                inboxWatchEnabled: isInboxWatchEnabled(),
                diagFrozen: !!(fr && fr.on),
                diagFreezeHint: fr ? (fr.hint || fr.reason || fr.code || '') : ''
            };
        },
        clearDiagFreeze: function (why) {
            var prev = clearDiagFreezeLocal(why || 'console');
            return { ok: true, cleared: !!prev, prev: prev };
        },
        unstickInboxAndPulse: function (mins) {
            return unstickInboxAndPulse(mins || 20);
        },
        /**
         * 路线 A 分层验收：A1 收件箱信号 / A2 会话气泡 / A3 闸门证据。
         * 在对应页面打开时检查该层；未打开的层标记 checked=false。
         */
        debugAcceptRouteA: function (handle) {
            handle = resolveActiveChatHandle(handle);
            if (!handle) return { error: 'need handle', pass: false, hint: 'sessionStorage.current_target 为空；请打开目标会话或执行 sessionStorage.setItem("current_target","对方handle")' };
            var entry = loadTargetDB()[handle] || {};
            var layers = {};
            var blockers = [];

            // A1 收件箱
            var a1 = { layer: 'A1_inbox', checked: false, ok: false, detail: '' };
            try {
                if (isDmInboxListVisible()) {
                    a1.checked = true;
                    var row = findInboxConversationElement(handle);
                    if (!row) {
                        a1.ok = false;
                        a1.detail = 'row not visible';
                        blockers.push('A1: 目标行不在可视区');
                    } else {
                        var pd = extractInboxRowPreviewData(row);
                        var ps = scoreInboxPreview(pd.preview);
                        var ur = getInboxRowUnread(row);
                        var replied = inboxPreviewIndicatesPeerReply(pd.preview, pd, ps);
                        a1.ok = !!(replied || ur.unread);
                        a1.detail = 'replied=' + replied + ' unread=' + ur.unread + ' confidence=' + (pd.fromSelf ? 'own' : ps.confidence) + ' preview=' + String(pd.preview || '').slice(0, 48);
                        if (!a1.ok) blockers.push('A1: 行可见但无回复/未读信号');
                    }
                } else {
                    a1.detail = 'not on inbox list — skip';
                }
            } catch (eA1) {
                a1.checked = true;
                a1.ok = false;
                a1.detail = String((eA1 && eA1.message) || eA1);
                blockers.push('A1: ' + a1.detail);
            }
            layers.A1_inbox = a1;

            // A2 会话气泡
            var a2 = { layer: 'A2_bubbles', checked: false, ok: false, detail: '' };
            try {
                if (isDmConversationView()) {
                    a2.checked = true;
                    var dump = window.__sgChatBridge.debugDumpConversationState(handle);
                    var msgN = (dump.messages && dump.messages.length) || 0;
                    var rawN = dump.rawBubbleCount || 0;
                    var filt = dump.composerFilteredCount || 0;
                    a2.ok = msgN > 0;
                    a2.detail = 'messages=' + msgN + ' rawBubbleCount=' + rawN + ' composerFiltered=' + filt + ' scanRoot=' + (dump.scanRootTestid || '');
                    if (dump.allBubbles && dump.allBubbles.length) {
                        a2.allBubbles = dump.allBubbles;
                    }
                    if (dump.reply) {
                        a2.replyTexts = (dump.reply.texts || []).slice(0, 5);
                        a2.replySource = dump.reply.source || '';
                    }
                    if (!a2.ok) {
                        if (rawN > 0 && filt >= rawN) blockers.push('A2: 气泡全被 composer 误滤');
                        else if (rawN === 0) blockers.push('A2: DOM 无 message-text 气泡');
                        else blockers.push('A2: 有气泡但未判为对方');
                    }
                } else {
                    a2.detail = 'not on conversation — skip';
                }
            } catch (eA2) {
                a2.checked = true;
                a2.ok = false;
                a2.detail = String((eA2 && eA2.message) || eA2);
                blockers.push('A2: ' + a2.detail);
            }
            layers.A2_bubbles = a2;

            // A3 闸门
            var a3 = { layer: 'A3_gate', checked: true, ok: false, detail: '' };
            try {
                var peerTexts = [];
                if (isDmConversationView()) {
                    try { peerTexts = collectPeerDmTexts(); } catch (eT) {}
                }
                // 无会话页时只检查字段关系，不要求 peerTexts
                if (!isDmConversationView()) {
                    var iceAt = entry.iceSentAt || 0;
                    var lastIn = entry.lastInboundAt || 0;
                    a3.ok = !!(iceAt && lastIn && lastIn > iceAt);
                    a3.detail = 'iceSentAt=' + (iceAt || 0) + ' lastInboundAt=' + (lastIn || 0) + ' fieldGate=' + a3.ok;
                    if (!iceAt) blockers.push('A3: 缺 iceSentAt');
                    else if (!(lastIn > iceAt)) blockers.push('A3: 缺 lastInboundAt（打开有回复会话后应自动写入）');
                } else {
                    var gateReal = canSendAdNow(handle, peerTexts, entry);
                    a3.ok = !!gateReal.ok;
                    a3.detail = 'gate=' + gateReal.reason + ' peerTexts=' + peerTexts.length + ' lastInboundAt=' + (entry.lastInboundAt || 0);
                    if (!a3.ok) blockers.push('A3: ' + (gateReal.reason || 'gate_fail'));
                }
            } catch (eA3) {
                a3.ok = false;
                a3.detail = String((eA3 && eA3.message) || eA3);
                blockers.push('A3: ' + a3.detail);
            }
            layers.A3_gate = a3;

            var checked = [a1, a2, a3].filter(function (l) { return l.checked; });
            var pass = checked.length > 0 && checked.every(function (l) { return l.ok; });
            var stuckAt = '';
            if (!pass) {
                if (a1.checked && !a1.ok) stuckAt = 'A1_inbox';
                else if (a2.checked && !a2.ok) stuckAt = 'A2_bubbles';
                else if (a3.checked && !a3.ok) stuckAt = 'A3_gate';
            }
            if (!entry || !(entry.round !== undefined || entry.firstSeen)) {
                blockers.push('DB: handle 不在 chat_target_db，守箱无法发广告');
            }
            var next = '';
            if (!entry || !(entry.round !== undefined || entry.firstSeen)) next = '先在粉丝页扫描入库，或手动写入 chat_target_db[handle]';
            else if (!a1.checked && !a2.checked) next = '打开 /i/chat 列表或目标会话后再跑';
            else if (a1.checked && !a1.ok) next = '跑 await __sgCalibrateInboxUnread([\'' + handle + '\']) 或 debugDumpInboxRowHTML';
            else if (a2.checked && !a2.ok) next = '跑 await __sgDumpConversation() 看 gate/dmTestids/messages；rawBubbleCount=0 时贴 dmTestids 反馈';
            else if (!a3.ok && a3.detail.indexOf('no_peer_texts') >= 0) next = '会话无对方文本：确认已打开正确会话；或贴 dmTestids';
            else if (!a3.ok && a3.detail.indexOf('missing_ice_sent_at') >= 0) next = 'DB 缺 iceSentAt：需先完成破冰或手动补写';
            else if (!a3.ok && a3.detail.indexOf('reply_not_confirmed') >= 0) next = 'await __sgChatCmd("markLastInboundAt", ["' + handle + '"]) 后重跑';
            else if (!a3.ok) next = '确认 iceSentAt / lastInboundAt / peerTexts';
            else next = '本页分层通过；做 A4 端到端：守箱自动打开并发送';

            return {
                at: Date.now(),
                handle: handle,
                route: 'A',
                pass: pass,
                stuckAt: stuckAt,
                summary: {
                    A1_inbox: a1.checked ? (a1.ok ? 'pass' : 'fail') : 'skip',
                    A2_bubbles: a2.checked ? (a2.ok ? 'pass' : 'fail') : 'skip',
                    A3_gate: a3.checked ? (a3.ok ? 'pass' : 'fail') : 'skip'
                },
                layers: layers,
                blockers: blockers,
                next: next,
                db: {
                    round: entry.round || 0,
                    iceSentAt: entry.iceSentAt || 0,
                    lastInboundAt: entry.lastInboundAt || 0,
                    replySeenAt: entry.replySeenAt || 0,
                    peerId: entry.peerId || ''
                }
            };
        },
        /** 保存实机校准得到的未读 selector（写入 localStorage.sg_dm_unread_selectors） */
        debugSaveInboxUnreadSelectors: function (payload) {
            try {
                var next = {
                    version: (payload && payload.version) || 1,
                    testids: (payload && payload.testids) || [],
                    ariaLabels: (payload && payload.ariaLabels) || []
                };
                localStorage.setItem(SG_DM_UNREAD_SELECTORS_KEY, JSON.stringify(next));
                return { ok: true, saved: next };
            } catch (e) {
                return { ok: false, error: String((e && e.message) || e) };
            }
        },
        debugScrollInboxBy: function (amount) {
            return scrollInboxListBy(Number(amount) || 300);
        },
        debugInboxListAtBottom: function () {
            return isInboxListAtBottom();
        },
        /** 下滑一步收件箱列表并尝试匹配目标行；主世界循环调用即可实现整列扫描 */
        debugInboxScrollStep: function (handle, amount) {
            handle = normalizeChatHandle(handle);
            var found = null;
            try {
                var row = findInboxConversationElement(handle);
                if (row) {
                    found = { tag: row.tagName, testid: (row.getAttribute && row.getAttribute('data-testid')) || '', href: '', text: '' };
                    try {
                        var a = row.querySelector('a[href*="/i/chat/"], a[href*="/messages/"]');
                        if (a && a.getAttribute) found.href = a.getAttribute('href') || '';
                    } catch (eH) {}
                    try { found.text = String((row.innerText || row.textContent || '')).split('\n')[0].slice(0, 60); } catch (eT) {}
                }
            } catch (eF) {}
            var atBottom = isInboxListAtBottom();
            if (!found) scrollInboxListBy(Number(amount) || 320);
            try {
                var sc = getInboxListScroller();
                return {
                    found: found,
                    atBottom: atBottom,
                    scrollTop: sc ? sc.scrollTop : 0,
                    scrollHeight: sc ? sc.scrollHeight : 0,
                    clientHeight: sc ? sc.clientHeight : 0,
                    rowCount: document.querySelectorAll('[data-testid^="dm-conversation-item-"]').length,
                    totalRenderedIds: Array.prototype.slice.call(document.querySelectorAll('[data-testid^="dm-conversation-item-"]')).map(function (r) {
                        return (r.getAttribute('data-testid') || '').split(':')[0];
                    }).slice(0, 30)
                };
            } catch (eSc) {
                return { found: found, atBottom: atBottom, error: String(eSc) };
            }
        },
        /** 输出目标行/任意行的收件箱 DOM 结构，用于判断新版 X 未读标记的准确选择器 */
        debugDumpInboxRowHTML: function (handle) {
            handle = normalizeChatHandle(handle);
            var row = handle ? findInboxConversationElement(handle) : null;
            if (!row && handle) {
                // 目标行不可见时明确报错，避免用其他行误导调试
                return {
                    error: 'target row not visible',
                    handle: handle,
                    totalRows: document.querySelectorAll('[data-testid^="dm-conversation-item-"]').length,
                    hint: '请滚动收件箱使该会话行可见后再试'
                };
            }
            if (!row) {
                var rows = document.querySelectorAll('[data-testid^="dm-conversation-item-"]');
                if (rows.length) row = rows[0];
            }
            if (!row) return { error: 'no inbox row found', handle: handle };
            var html = '';
            try { html = row.outerHTML; } catch (eH) { html = String(row.innerHTML || ''); }
            // 扫描行内所有带 aria-label / data-testid 的元素，找出可能的未读标记
            var ariaLabels = [];
            var testids = [];
            var clsHits = [];
            try {
                var labeled = row.querySelectorAll('[aria-label]');
                for (var i = 0; i < labeled.length; i++) {
                    var al = labeled[i].getAttribute('aria-label') || '';
                    if (al) ariaLabels.push(al.slice(0, 60));
                }
                var tids = row.querySelectorAll('[data-testid]');
                for (var j = 0; j < tids.length; j++) {
                    var td = tids[j].getAttribute('data-testid') || '';
                    if (td) testids.push(td.slice(0, 60));
                }
                if (/unread|未读|new message|新消息/i.test(html)) clsHits.push('html-has-unread-keyword');
            } catch (eScan) {}
            var previewData = extractInboxRowPreviewData(row);
            var previewScore = scoreInboxPreview(previewData.preview);
            var unreadInfo = getInboxRowUnread(row);
            return {
                handle: handle,
                testid: (row.getAttribute && row.getAttribute('data-testid')) || '',
                unreadByCurrentCheck: unreadInfo.unread,
                unreadSource: unreadInfo.source,
                unreadPrecise: unreadInfo.precise,
                ariaDescription: (row.getAttribute && row.getAttribute('aria-description')) || '',
                previewByExtract: previewData.preview,
                previewFromSelf: previewData.fromSelf,
                previewSource: previewData.source,
                confidence: previewData.fromSelf ? 'own' : previewScore.confidence,
                previewIsOwn: previewData.fromSelf || previewScore.confidence === 'own',
                replied: inboxPreviewIndicatesPeerReply(previewData.preview, previewData, previewScore),
                firstLine: String((row.innerText || '').split('\n')[0] || '').slice(0, 80),
                innerText: String(row.innerText || '').slice(0, 200),
                ariaLabels: ariaLabels.slice(0, 15),
                testids: testids.slice(0, 25),
                clsHits: clsHits,
                htmlHead: html.slice(0, 4000),
                htmlLen: html.length,
                cachedSelectors: loadInboxUnreadSelectors()
            };
        },
        /** 主世界可调：开软风控扫箱窗 + 等列表就绪再 tick（同步 tick 会空 ok） */
        forceInboxPulse: function (mins) {
            // 守箱已废除，统一走粉丝页强制私信
            return Promise.resolve(startFanRosterForce(mins || 20, 'forceInboxPulse'));
        },
    };

    /** 上线前清误杀拉黑：控制台执行 __sgClearFalseDmBlocks() 或 __sgClearFalseDmBlocks({dryRun:true}) */
    window.__sgClearFalseDmBlocks = function (opts) {
        return clearFalseDmBlocks(opts || {});
    };
    /** 诊断：打印/返回粉丝台账快照 */
    window.__sgFanLedgerSnapshot = function (reason) {
        try {
            var snap = buildFanLedgerSnapshot(reason || 'diag');
            console.log('[台账]', snap.botHandle, 'F=' + snap.profileFollowers, 'seen=' + snap.cellsSeen, 'queue=' + snap.queueTotal, 'pending=' + snap.pending, 'items=' + (snap.items && snap.items.length));
            return snap;
        } catch (e) {
            console.warn('[台账] snapshot 失败', e);
            return null;
        }
    };

    // ==================== 主世界控制台桥 ====================
    // page-diag-bridge.js（MAIN world）的 window.__sgChatCmd 通过 postMessage 调到这里
    /** postMessage 无法克隆 DOM 元素，这里把返回值转成可传输的纯数据 */
    function sanitizeBridgeValue(v, depth) {
        depth = depth || 0;
        if (depth > 4) return String(v);
        if (v === null || v === undefined) return v;
        var t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') return v;
        if (t === 'function') return String(v).slice(0, 200);
        // DOM 元素 / Node
        if (t === 'object' && (v.nodeType === 1 || v.nodeType === 9)) {
            var nodeInfo = { tag: String(v.tagName || ''), testid: (v.getAttribute && v.getAttribute('data-testid')) || '', href: '', text: '' };
            try {
                var a = v.querySelector && v.querySelector('a[href]');
                if (a && a.getAttribute) nodeInfo.href = a.getAttribute('href') || '';
            } catch (eH) {}
            try {
                nodeInfo.text = String((v.innerText || v.textContent || '')).split('\n')[0].slice(0, 60);
            } catch (eT) {}
            return nodeInfo;
        }
        try {
            // 数组/普通对象：逐字段清理
            if (Array.isArray(v)) return v.map(function (x) { return sanitizeBridgeValue(x, depth + 1); });
            var out = {};
            for (var k in v) {
                if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
                try { out[k] = sanitizeBridgeValue(v[k], depth + 1); } catch (eK) { out[k] = String(v[k]); }
            }
            return out;
        } catch (e) {
            return String(v);
        }
    }

    window.addEventListener('message', function (eBridge) {
        try {
            var bData = eBridge && eBridge.data;
            if (!bData || bData.type !== '__sg_chat_cmd_request' || !bData.id) return;
            var bFn = (window.__sgChatBridge || {})[bData.fn];
            var bValue;
            if (typeof bFn !== 'function') {
                bValue = { error: 'bridge fn not found: ' + String(bData.fn) };
                try {
                    window.postMessage({ type: '__sg_chat_cmd_result', id: bData.id, value: sanitizeBridgeValue(bValue) }, '*');
                } catch (eSer0) {}
            } else {
                try {
                    bValue = bFn.apply(null, (bData.args || []));
                    if (bValue && typeof bValue.then === 'function') {
                        bValue.then(function (res) {
                            try {
                                window.postMessage({ type: '__sg_chat_cmd_result', id: bData.id, value: sanitizeBridgeValue(res) }, '*');
                            } catch (eSerP) {
                                window.postMessage({ type: '__sg_chat_cmd_result', id: bData.id, value: { error: 'serialize failed: ' + String((eSerP && eSerP.message) || eSerP) } }, '*');
                            }
                        }).catch(function (err) {
                            window.postMessage({ type: '__sg_chat_cmd_result', id: bData.id, value: { error: String((err && err.message) || err) } }, '*');
                        });
                        return;
                    }
                } catch (eCall) {
                    bValue = { error: String((eCall && eCall.message) || eCall) };
                }
                try {
                    window.postMessage({ type: '__sg_chat_cmd_result', id: bData.id, value: sanitizeBridgeValue(bValue) }, '*');
                } catch (eSer) {
                    window.postMessage({ type: '__sg_chat_cmd_result', id: bData.id, value: { error: 'serialize failed: ' + String((eSer && eSer.message) || eSer) } }, '*');
                }
            }
        } catch (eBridge2) {}
    });

    // ==================== DM 流程追踪（跨导航持久化 + 浮动面板 + 调试快照） ====================
    var DM_TRACE_KEY = 'sg_dm_flow_trace';
    var _dmTracePanelEl = null;
    var _dmTracePanelVisible = null;

    function dmTraceIsPanelVisible() {
        if (_dmTracePanelVisible !== null) return _dmTracePanelVisible;
        try { _dmTracePanelVisible = localStorage.getItem('sg_dm_trace_visible') === '1'; } catch (e) { _dmTracePanelVisible = false; }
        return _dmTracePanelVisible;
    }

    function dmTraceGet() {
        try { return JSON.parse(sessionStorage.getItem(DM_TRACE_KEY) || '[]'); } catch (e) { return []; }
    }

    var DM_TRACE_STAGE_LABEL = {
        list_scan: '📋 列表扫描',
        open: '🖱 打开会话',
        read_reply: '💬 读取回复',
        route: '🧭 分流决策',
        send: '📤 发送',
        finish: '✅ 完成',
        back_to_list: '🔙 返回列表',
        round_end: '🏁 轮次结束',
        dm_panel: '🪟 DM面板'
    };

    var DM_TRACE_STAGE_COLOR = {
        list_scan: '#1d9bf0',
        open: '#1d9bf0',
        read_reply: '#a371f7',
        route: '#faad14',
        send: '#00ba7c',
        finish: '#5b7083',
        back_to_list: '#5b7083',
        round_end: '#ff8c00',
        dm_panel: '#5b7083'
    };

    function dmTracePush(stage, detail) {
        detail = detail || {};
        var trace = dmTraceGet();
        trace.push({
            ts: Date.now(),
            time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
            stage: stage,
            label: DM_TRACE_STAGE_LABEL[stage] || stage,
            detail: detail
        });
        if (trace.length > 60) trace = trace.slice(-60);
        try { sessionStorage.setItem(DM_TRACE_KEY, JSON.stringify(trace)); } catch (e) {}
        try {
            if (typeof SgDebugLog !== 'undefined' && SgDebugLog.push) {
                SgDebugLog.push('chat', detail.level || 'info', '[DM流程] ' + (DM_TRACE_STAGE_LABEL[stage] || stage) + ' ' + (detail.text || ''), Object.assign({ step: 'dm_trace', dm_stage: stage }, detail));
            }
        } catch (e) {}
        renderDmTracePanel();
        return trace;
    }

    function ensureDmTracePanel() {
        if (_dmTracePanelEl) return _dmTracePanelEl;
        try {
            _dmTracePanelEl = document.createElement('div');
            _dmTracePanelEl.id = 'sg-dm-trace-panel';
            _dmTracePanelEl.style.cssText = 'position:fixed;right:10px;bottom:64px;z-index:2147483640;width:340px;max-height:320px;overflow-y:auto;background:rgba(15,20,25,0.92);color:#e7e9ea;border:1px solid rgba(255,255,255,0.16);border-radius:10px;padding:8px;font:12px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.45);display:none;';
            _dmTracePanelEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 2px 6px;border-bottom:1px solid rgba(255,255,255,0.12);margin-bottom:6px;">' +
                '<b style="color:#fff;font-size:12px;">📊 DM流程追踪</b>' +
                '<span style="display:flex;gap:4px;">' +
                '<button id="sg-dm-trace-clear" style="background:rgba(255,255,255,0.1);border:none;color:#8899a6;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:11px;">清空</button>' +
                '<button id="sg-dm-trace-close" style="background:rgba(255,255,255,0.1);border:none;color:#8899a6;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:11px;">✕</button>' +
                '</span></div>' +
                '<div id="sg-dm-trace-body" style="max-height:260px;overflow-y:auto;"></div>';
            document.body.appendChild(_dmTracePanelEl);
            try {
                _dmTracePanelEl.querySelector('#sg-dm-trace-close').addEventListener('click', function () {
                    try { localStorage.setItem('sg_dm_trace_visible', '0'); } catch (e) {}
                    _dmTracePanelVisible = false;
                    _dmTracePanelEl.style.display = 'none';
                });
                _dmTracePanelEl.querySelector('#sg-dm-trace-clear').addEventListener('click', function () {
                    try { sessionStorage.removeItem(DM_TRACE_KEY); } catch (e) {}
                    renderDmTracePanel();
                });
            } catch (e) {}
        } catch (e) {}
        return _dmTracePanelEl;
    }

    function renderDmTracePanel() {
        var panel = ensureDmTracePanel();
        if (!panel) return;
        if (!dmTraceIsPanelVisible()) { panel.style.display = 'none'; return; }
        panel.style.display = 'block';
        var body = panel.querySelector('#sg-dm-trace-body');
        if (!body) return;
        var trace = dmTraceGet().slice(-16);
        var html = '';
        for (var i = trace.length - 1; i >= 0; i--) {
            var t = trace[i];
            var color = DM_TRACE_STAGE_COLOR[t.stage] || '#8899a6';
            var detailText = '';
            var d = t.detail || {};
            if (d.target) detailText += '<span style="color:#a5d6ff;">@' + String(d.target).slice(0, 20) + '</span> ';
            if (d.text) detailText += String(d.text).slice(0, 40);
            else if (d.action) detailText += String(d.action);
            else if (d.reason) detailText += String(d.reason);
            else if (d.round != null) detailText += 'round=' + d.round;
            if (d.peer_count != null) detailText += ' 对方气泡=' + d.peer_count;
            if (d.decision) detailText += ' decision=' + d.decision;
            html += '<div style="display:flex;gap:6px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);">' +
                '<span style="color:' + color + ';white-space:nowrap;flex:0 0 auto;">' + t.label + '</span>' +
                '<span style="color:#8899a6;flex:0 0 auto;font-size:11px;">' + (t.time || '').slice(11, 19) + '</span>' +
                '<span style="color:#c4cfd6;word-break:break-all;">' + detailText + '</span></div>';
        }
        if (!html) html = '<div style="color:#5b7083;padding:8px 2px;">暂无流程记录 — 等下次 DM 任务运行时自动记录</div>';
        body.innerHTML = html;
    }

    function dmTraceTogglePanel() {
        var vis = !dmTraceIsPanelVisible();
        try { localStorage.setItem('sg_dm_trace_visible', vis ? '1' : '0'); } catch (e) {}
        _dmTracePanelVisible = vis;
        renderDmTracePanel();
    }

    // 页面主世界可通过 __sgRunDmDebug() 快照查看；另暴露浮动面板开关事件
    try {
        window.addEventListener('message', function (e) {
            if (e.source !== window || !e.data) return;
            if (e.data.type === '__sg_dm_trace_toggle') {
                dmTraceTogglePanel();
                try { window.postMessage({ type: '__sg_dm_trace_toggle_result', id: e.data.id || 0, visible: dmTraceIsPanelVisible() }, '*'); } catch (eT) {}
                return;
            }
        });
    } catch (e) {}

    // ==================== DM 调试桥（响应页面主世界 __sgRunDmDebug） ====================
    function buildDmDebugSnapshot() {
        try {
            var bridge = window.__sgChatBridge || {};
            var isDmPathFn = bridge.isDmPath || isDmPath;
            var getRootFn = bridge.getDmConversationRoot || function () { return document.querySelector('[data-testid="DmActivityContainer"]') || document.body; };
            var getRootTestidFn = bridge.getDmConversationRootTestid || (function () { return getRootFn() === document.body ? 'body' : (getRootFn().getAttribute('data-testid') || getRootFn().tagName); });
            var collectPeerFn = bridge.collectPeerDmMessages || (function () { return []; });
            var fallbackFn = bridge.fallbackCollectPeerDmTexts || (function () { return []; });
            var findComposerFn = bridge.findBottomAwakeningTarget || (function () { return null; });
            var getPhaseFn = bridge.getChatPhase || (function () { return 'unknown'; });
            var getDnaFn = bridge.getDnaCore || (function () { return []; });
            var mailSrc = (function () {
                try {
                    var path = (window.location.pathname || '').toLowerCase();
                    var href = String(window.location.href || '').toLowerCase();
                    if (isDmPathFn(path) || isDmPathFn(href)) return 'messages';
                    if (path.indexOf('/dm') >= 0) return 'messages';
                    if (document.querySelector('[data-testid="DMDrawer"]') || document.querySelector('[data-testid="DmActivityContainer"]')) return 'messages';
                } catch (e) {}
                return null;
            })();
            var root = getRootFn();
            var entryCount = 0, bubbleCount = 0, convItemCount = 0;
            try { entryCount = document.querySelectorAll('[data-testid^="message-"]:not([data-testid^="message-text-"])').length; } catch (eE) {}
            try { bubbleCount = document.querySelectorAll('[data-testid^="message-text-"], [data-testid="messageBubble"]').length; } catch (eB) {}
            try { convItemCount = document.querySelectorAll('[data-testid="conversationItem"]').length; } catch (eC) {}
            var testidInventory = {};
            var dmTestids = {};
            try {
                var tidNodes = document.querySelectorAll('[data-testid]');
                for (var t = 0; t < tidNodes.length; t++) {
                    var tk = tidNodes[t].getAttribute('data-testid') || '';
                    if (!tk) continue;
                    testidInventory[tk] = (testidInventory[tk] || 0) + 1;
                    if (/dm|chat|conversation|message|inbox|thread|cell|unread/i.test(tk)) {
                        dmTestids[tk] = (dmTestids[tk] || 0) + 1;
                    }
                }
            } catch (eT) {}
            var peerMsgs = collectPeerFn();
            var peerTexts = [];
            for (var p = 0; p < peerMsgs.length; p++) peerTexts.push(peerMsgs[p].text);
            var fbMsgs = fallbackFn(root);
            var fbTexts = [];
            for (var f = 0; f < fbMsgs.length; f++) fbTexts.push(fbMsgs[f].text);
            var unreadMarkers = [];
            try {
                if (root && root.querySelectorAll) {
                    var unreadNodes = root.querySelectorAll('[data-testid="unreadIndicator"], [data-testid*="unread" i], [aria-label*="未读" i], [aria-label*="Unread" i], [aria-label*="新消息" i]');
                    for (var u = 0; u < unreadNodes.length; u++) unreadMarkers.push(unreadNodes[u].getAttribute('data-testid') || unreadNodes[u].getAttribute('aria-label') || unreadNodes[u].tagName);
                }
            } catch (eU) {}
            var composerInput = null;
            try { composerInput = findComposerFn(); } catch (eCIn) {}
            var sendBtn = null;
            try {
                var findSendBtnFn = bridge.findDmSendButton || (function () { return null; });
                sendBtn = findSendBtnFn();
            } catch (eS) {}
            return {
                ts: Date.now(),
                url: window.location.href,
                path: window.location.pathname,
                isMessagesPage: !!mailSrc,
                mailSource: mailSrc || 'none',
                rootTestid: getRootTestidFn(),
                rootFound: !!root,
                rootTagName: root ? root.tagName : 'N/A',
                entryCount: entryCount,
                bubbleCount: bubbleCount,
                convItemCount: convItemCount,
                testidInventory: testidInventory,
                dmTestids: dmTestids,
                peerCount: peerTexts.length,
                peerTexts: peerTexts.slice(-12),
                fallbackCount: fbTexts.length,
                fallbackTexts: fbTexts.slice(-12),
                unreadMarkers: unreadMarkers,
                unreadSeen: unreadMarkers.length > 0,
                composerFound: !!composerInput,
                composerDisabled: composerInput ? !!composerInput.disabled : 'N/A',
                sendBtnFound: !!sendBtn,
                sendBtnDisabled: sendBtn ? !!sendBtn.disabled : 'N/A',
                currentTarget: sessionStorage.getItem('current_target') || '',
                chatPhase: getPhaseFn(),
                autoStep: sessionStorage.getItem('dan_auto_step') || '',
                dnaCore: getDnaFn().slice(0, 12)
            };
        } catch (e) {
            return { error: String(e && e.message || e), ts: Date.now() };
        }
    }

    function installDmDebugBridge() {
        try {
            if (window.__sgDmDebugBridgeListening) return;
            window.__sgDmDebugBridgeListening = true;
            window.addEventListener('message', function (e) {
                if (e.source !== window || !e.data) return;
                if (e.data.type === '__sg_dm_debug_request') {
                    var payload = buildDmDebugSnapshot();
                    window.postMessage({ type: '__sg_dm_debug_result', payload: payload, id: e.data.id || 0 }, '*');
                    return;
                }
            });
            try { window.__sgDmDebugReady = true; } catch (eD) {}
            console.log('[DM调试] 应答桥已就绪');
        } catch (e) {}
    }

    installDmDebugBridge();
    setTimeout(installDmDebugBridge, 500);

})();

// =============================================================================
// 【V16.6.0 后端联动】话术模板统一管理模块 (MatrixChatTemplates)
// 基于 1-Extension V12.5.1 的 getTemplate/setTemplate/syncTemplates/sanitize
// 嫁接到 DeepSeek content_chat.js 末尾，不影响现有 chat 引擎
// =============================================================================
// 职责：
//   1. 首次加载从 chat_scripts.json 导入为默认模板（持久化到 localStorage）
//   2. 提供热更新 API（setTemplate / syncTemplates）
//   3. 模板变更时自动重新提取 DNA 词库
//   4. 提供 sanitize 函数给其他模块用
//   5. 监听 ui-console 的 settings-changed 事件
// =============================================================================
(function() {
    'use strict';
    var MTPL_VER = 'V3.3.5';
    var SCRIPTS_BOOT_KEY = 'dan_scripts_boot_ver';
    var EXT_SCRIPTS_VER = '3.3.5';

    const TEMPLATES_KEY = 'dan_scripts';
    const DNA_AUX_KEY = 'dan_dna_aux';
    const SCRIPTS_FILE = 'chat_scripts.json';
    const TPL_STORAGE_MAP = {
        'icebreaker': 'dan_tpl_1',
        'ad':         'dan_tpl_2',
        'reject':     'dan_tpl_4',
        'kick':       'dan_tpl_5',
        'foreigner_reject': 'dan_tpl_3'  // ui-console 暂未用，保留
    };

    // ==================== Sanitize ====================
    function sanitize(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')
            .trim();
    }

    // ==================== DNA 词条提取 ====================
    function updateDNAFromTemplates() {
        try {
            const tpl = getCurrentTemplates();
            const allText = [tpl.icebreaker, tpl.ad, tpl.kick, tpl.reject, tpl.foreigner_reject].join(' ');

            const stopWords = new Set([
                'です', 'ます', 'ました', 'ありがとう', 'すみません', 'お願い',
                'こんにちは', 'こんばんは', 'さようなら', 'おはよう', 'おやすみ',
                'いただきます', 'ごちそうさま'
            ]);
            const words = (allText.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]{4,}/g) || [])
                .filter(w => !stopWords.has(w));

            let existingAux = [];
            try {
                const saved = localStorage.getItem(DNA_AUX_KEY);
                if (saved) existingAux = JSON.parse(saved);
            } catch (_) {}

            const newAux = [...new Set([...existingAux, ...words])];
            localStorage.setItem(DNA_AUX_KEY, JSON.stringify(newAux));
            console.log('[MatrixChatTemplates] DNA 词库已更新:', newAux.length, '个词');
        } catch (e) {
            console.warn('[MatrixChatTemplates] DNA 词条提取失败:', e);
        }
    }

    // ==================== 初始化（从 chat_scripts.json 导入全部话术）====================
    function shouldForceScriptBootstrap() {
        try {
            if (localStorage.getItem(SCRIPTS_BOOT_KEY) !== EXT_SCRIPTS_VER) return true;
            var raw = localStorage.getItem(TEMPLATES_KEY);
            if (!raw) return true;
            var cfg = JSON.parse(raw);
            if (!cfg.imported_from_json) return true;
            var ver = String(cfg.version || '0');
            if (ver < '2.1') return true;
            var ice = (cfg.templates && cfg.templates.icebreaker) || (cfg.scripts && cfg.scripts.v1 && cfg.scripts.v1.icebreaker) || '';
            if (ice.indexOf('大人') < 0 && ice.indexOf('おいくつ') < 0) return true;
        } catch (e) { return true; }
        return false;
    }

    function bindParseAgeApi() {
        var fn = (window.__sgChatAge && window.__sgChatAge.parseAgeFromText) || function () { return null; };
        var collect = (window.__sgChatAge && window.__sgChatAge.collectPeerDmTexts) || function () { return []; };
        return { parseAgeFromText: fn, collectPeerDmTexts: collect };
    }

    async function bootstrapFromJSON() {
        if (!shouldForceScriptBootstrap()) {
            console.log('[MatrixChatTemplates] 话术池已是最新 (' + EXT_SCRIPTS_VER + ')，跳过 JSON 导入');
            return;
        }
        try {
            var url = chrome.runtime.getURL(SCRIPTS_FILE);
            var resp = await fetch(url);
            if (!resp.ok) throw new Error('fetch failed: ' + resp.status);
            var json = await resp.json();

            // 构建全部 5 套话术
            var scriptsObj = {};
            var allTexts = [];
            Object.keys(json.scripts).forEach(function(key) {
                var s = json.scripts[key];
                if (!s) return;
                scriptsObj[key] = {
                    name: s.name || key,
                    icebreaker: sanitize(s.icebreaker || ''),
                    ad_template: sanitize(s.ad_template || ''),
                    kick_message: sanitize(s.kick_message || ''),
                    reject_message: sanitize(s.reject_message || ''),
                    foreigner_reject: sanitize(s.foreigner_reject || '')
                };
                allTexts.push(s.icebreaker || '');
                allTexts.push(s.ad_template || '');
                allTexts.push(s.kick_message || '');
                allTexts.push(s.reject_message || '');
                allTexts.push(s.foreigner_reject || '');
            });

            // 从随机池中选第一套作为当前模板
            var pool = json.random_pool || Object.keys(scriptsObj);
            var firstId = pool[0];
            var first = scriptsObj[firstId];

            var allCombined = allTexts.join(' ').replace(/{LINK}/g, '');
            var allCombinedClean = allCombined.replace(/[\u{1F300}-\u{1FFFF}]/gu, '').replace(/[💦💕🫣👀😭😱💔😣💋🥺❤️😊✨😌…—、。，！？,.!?\n\r]/g, ' ');
            var tokens = allCombinedClean.split(/\s+/).filter(function(t) { return t.length >= 3 && !/^\d+$/.test(t); });
            var seen = {};
            var uniqueTokens = tokens.filter(function(t) { var l=t.toLowerCase(); if(seen[l]) return false; seen[l]=true; return true; });
            var core = uniqueTokens.filter(function(t) { return t.length >= 4; });
            var aux = uniqueTokens.filter(function(t) { return t.length < 4; });
            var mustCore = ["line.me", "http", "秘密のアカウント", "👇", "25歳以上で探してて", "日本語しか分からないです"];
            mustCore.forEach(function(m) { if(core.indexOf(m)===-1) core.push(m); });

            var config = {
                version: json.version || '2.1',
                mode: json.mode || 'random',
                random_pool: pool,
                active_script: firstId,
                scripts: scriptsObj,
                templates: {
                    icebreaker: first.icebreaker,
                    ad: first.ad_template,
                    kick: first.kick_message,
                    reject: first.reject_message,
                    foreigner_reject: first.foreigner_reject
                },
                dna_core: core,
                dna_aux: aux,
                corpse_days: 3,
                kick_days: 2,
                imported_from_json: true,
                imported_at: Date.now()
            };
            localStorage.setItem(TEMPLATES_KEY, JSON.stringify(config));
            localStorage.setItem(SCRIPTS_BOOT_KEY, EXT_SCRIPTS_VER);

            localStorage.setItem(TPL_STORAGE_MAP.icebreaker, config.templates.icebreaker);
            localStorage.setItem(TPL_STORAGE_MAP.ad, config.templates.ad);
            localStorage.setItem(TPL_STORAGE_MAP.reject, config.templates.reject);
            localStorage.setItem(TPL_STORAGE_MAP.kick, config.templates.kick);

            // DNA 词库从全部话术合并提取
            try {
                var dnaText = allTexts.join(' ');
                var stopWords = new Set(['です','ます','ました','ありがとう','すみません','お願い','こんにちは','こんばんは','さようなら','おはよう','おやすみ','いただきます','ごちそうさま']);
                var words = (dnaText.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]{4,}/g) || []).filter(function(w) { return !stopWords.has(w); });
                localStorage.setItem(DNA_AUX_KEY, JSON.stringify(words));
            } catch(e) {}

            console.log('[MatrixChatTemplates] 已从 chat_scripts.json 导入全部 ' + Object.keys(scriptsObj).length + ' 套话术');
            try {
                window.dispatchEvent(new CustomEvent('sg-scripts-updated'));
            } catch (eEv) {}
        } catch (e) {
            console.warn('[MatrixChatTemplates] 从 JSON 导入失败（可能文件不存在）:', e.message);
        }
    }

    // ==================== CRUD ====================
    function getCurrentTemplates() {
        try {
            const raw = localStorage.getItem(TEMPLATES_KEY);
            if (raw) {
                const cfg = JSON.parse(raw);
                if (cfg.templates) {
                    return {
                        icebreaker: cfg.templates.icebreaker || '',
                        ad: cfg.templates.ad || '',
                        kick: cfg.templates.kick || '',
                        reject: cfg.templates.reject || '',
                        foreigner_reject: cfg.templates.foreigner_reject || ''
                    };
                }
            }
        } catch (e) {}
        // 降级到 ui-console 的 matrix_tpl_* 存储
        return {
            icebreaker: localStorage.getItem(TPL_STORAGE_MAP.icebreaker) || '',
            ad: localStorage.getItem(TPL_STORAGE_MAP.ad) || '',
            kick: localStorage.getItem(TPL_STORAGE_MAP.kick) || '',
            reject: localStorage.getItem(TPL_STORAGE_MAP.reject) || '',
            foreigner_reject: localStorage.getItem(TPL_STORAGE_MAP.foreigner_reject) || ''
        };
    }

    function getTemplate(key) {
        const tpl = getCurrentTemplates();
        return tpl[key] || '';
    }

    function setTemplate(key, value) {
        const safe = sanitize(value);
        try {
            const raw = localStorage.getItem(TEMPLATES_KEY);
            const cfg = raw ? JSON.parse(raw) : { templates: {} };
            if (!cfg.templates) cfg.templates = {};
            cfg.templates[key] = safe;
            cfg.updated_at = Date.now();
            localStorage.setItem(TEMPLATES_KEY, JSON.stringify(cfg));
        } catch (e) {
            console.error('[MatrixChatTemplates] setTemplate 失败:', e);
        }
        // 同步到 matrix_tpl_*
        if (TPL_STORAGE_MAP[key]) {
            localStorage.setItem(TPL_STORAGE_MAP[key], safe);
        }
        syncTemplates();
    }

    function syncTemplates() {
        // 重新提取 DNA
        updateDNAFromTemplates();
        // 广播事件
        document.dispatchEvent(new CustomEvent('matrix-templates-changed', {
            detail: getCurrentTemplates()
        }));
        // 通知 ui-console
        if (window.__matrix_console__ && window.__matrix_console__.showToast) {
            window.__matrix_console__.showToast('话术已更新', 'success');
        }
    }

    // ==================== 便捷 getter ====================
    function getICEBREAKER_MESSAGE() { return getTemplate('icebreaker'); }
    function getAD_MESSAGE_TEMPLATE() { return getTemplate('ad'); }
    function getKICK_MESSAGE() { return getTemplate('kick'); }
    function getREJECT_MESSAGE() { return getTemplate('reject'); }
    function getFOREIGNER_REJECT_MESSAGE() { return getTemplate('foreigner_reject'); }

    // ==================== 监听 ui-console 的设置变更 ====================
    document.addEventListener('matrix-settings-changed', (e) => {
        // ui-console 保存时已经把话术写到 matrix_tpl_*，这里只触发同步
        try {
            var raw = localStorage.getItem(TEMPLATES_KEY);
            var existing = {};
            try { if (raw) existing = JSON.parse(raw); } catch(_) {}

            const newCfg = {
                version: existing.version || '2.1',
                mode: existing.mode || 'random',
                random_pool: existing.random_pool || ['v1','v2','v3','v4','v5'],
                active_script: existing.active_script || 'v1',
                scripts: existing.scripts || {},
                templates: {
                    icebreaker: localStorage.getItem(TPL_STORAGE_MAP.icebreaker) || '',
                    ad:         localStorage.getItem(TPL_STORAGE_MAP.ad) || '',
                    kick:       localStorage.getItem(TPL_STORAGE_MAP.kick) || '',
                    reject:     localStorage.getItem(TPL_STORAGE_MAP.reject) || '',
                    foreigner_reject: localStorage.getItem(TPL_STORAGE_MAP.foreigner_reject) || ''
                },
                updated_at: Date.now(),
                source: 'ui-console',
                dna_core: existing.dna_core || [],
                dna_aux: existing.dna_aux || []
            };
            localStorage.setItem(TEMPLATES_KEY, JSON.stringify(newCfg));
            updateDNAFromTemplates();
            console.log('[MatrixChatTemplates] 已从 ui-console 同步话术（保留 scripts 池）');
        } catch (err) {
            console.warn('[MatrixChatTemplates] 从 ui-console 同步失败:', err);
        }
    });

    // ==================== 暴露 API ====================
    var ageApi = bindParseAgeApi();
    window.MatrixChatTemplates = {
        getCurrentTemplates,
        getTemplate,
        setTemplate,
        syncTemplates,
        updateDNAFromTemplates,
        sanitize,
        getICEBREAKER_MESSAGE,
        getAD_MESSAGE_TEMPLATE,
        getKICK_MESSAGE,
        getREJECT_MESSAGE,
        getFOREIGNER_REJECT_MESSAGE,
        parseAgeFromText: ageApi.parseAgeFromText,
        collectPeerDmTexts: ageApi.collectPeerDmTexts,
        version: MTPL_VER
    };

    // 自动初始化（异步，不阻塞主流程）
    bootstrapFromJSON();

    console.log('[MatrixChatTemplates] 模板管理模块已加载 (' + MTPL_VER + ')');
})();
