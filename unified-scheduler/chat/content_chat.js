// X-Matrix-Bot 插件版 - 私信聊天 (V16.6.0 后端联动 — 消息回传/话术同步)
(function() {

    function safeAppendToHead(el) {
        if (!document.head) {
            setTimeout(() => safeAppendToHead(el), 100);
            return;
        }
        if (el && !document.getElementById(el.id)) document.head.appendChild(el);
    }

    'use strict';


    // ==============================================================================
    // 【全局配置与存储引擎】
    // ==============================================================================
    // NAS地址已从config.js统一管理，此处不再硬编码


    // ================= 【诊断日志】 =================
    console.log('[诊断-注入] content_chat.js 已加载');
    localStorage.setItem('dan_chat_ready', 'true');
    sessionStorage.setItem('dan_tab_role', 'chat');
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

    // 【V11.9.0】统一使用 @handle#guard 格式，多开由 GuardAgent 通过 window_id 区分
    function getWorkerId() {
        let workerId = sessionStorage.getItem('dan_worker_id');
        if (!workerId || workerId.includes('null') || workerId.includes('undefined')) {
            let myHandleEl = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
            let myHandle = (myHandleEl && myHandleEl.href) ? myHandleEl.href.split('/').pop() : null;
            if (!myHandle || myHandle === 'null') {
                myHandle = String(Math.floor(Math.random() * 90000 + 10000));
            }
            workerId = "@" + myHandle + "#guard";
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
    let current_live_links = [];
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
        try {
            const saved = localStorage.getItem(MY_LINKS_KEY);
            if (saved) {
                const links = JSON.parse(saved);
                if (Array.isArray(links) && links.length > 0) return links;
            }
        } catch (e) {}
        return [];
    }

    async function fetchLinksFromServer() {
        try {
            const data = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: "pool_links" }, (response) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(response);
                });
            });
            if (data && data.ok && Array.isArray(data.links) && data.links.length > 0) {
                console.log('[推广链接] 从服务器同步:', data.links);
                return data.links;
            }
        } catch (e) {
            console.warn('[推广链接] 服务器不可达:', e.message);
        }
        return null;
    }

    // 保存链接到 localStorage + 服务器
    async function saveMyLinks(links, syncToServer = true) {
        try {
            localStorage.setItem(MY_LINKS_KEY, JSON.stringify(links));
            current_live_links = links;
            console.log('[推广链接] ✅ 已保存:', links);

            // 同步到服务器（让其他实例也能看到）
            if (syncToServer) {
                try {
                    await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            action: "pool_links_save",
                            links: links
                        }, (response) => {
                            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                            else resolve(response);
                        });
                    });
                    console.log('[推广链接] ☁️ 已同步到服务器');
                } catch (e) {
                    console.warn('[推广链接] 同步到服务器失败（不影响本地使用）');
                }
            }
            return true;
        } catch (e) {
            console.error('[推广链接] 保存失败:', e);
            return false;
        }
    }

    // 启动时加载：服务器 → 本地 → 默认
    async function loadMyLinks() {
        const serverLinks = await fetchLinksFromServer();
        if (serverLinks) {
            current_live_links = serverLinks;
            localStorage.setItem(MY_LINKS_KEY, JSON.stringify(serverLinks));
            localStorage.setItem(LINKS_SYNC_KEY, String(Date.now()));
            console.log('[推广链接] ✅ 使用服务器链接:', serverLinks);
            return true;
        }

        try {
            const saved = localStorage.getItem(MY_LINKS_KEY);
            if (saved) {
                const links = JSON.parse(saved);
                if (Array.isArray(links) && links.length > 0) {
                    current_live_links = links;
                    console.log('[推广链接] ⚠️ 服务器不可达，使用本地缓存:', links);
                    return true;
                }
            }
        } catch (e) {
            console.warn('[推广链接] 本地缓存加载失败:', e);
        }

        current_live_links = [];
        console.warn('[推广链接] ❌ 无可用链接 — 服务器不可达且无本地缓存，广告消息将跳过');
        return false;
    }

    // 定时从服务器同步链接
    function startLinkSync() {
        setInterval(async () => {
            const serverLinks = await fetchLinksFromServer();
            if (serverLinks && JSON.stringify(serverLinks) !== JSON.stringify(current_live_links)) {
                current_live_links = serverLinks;
                localStorage.setItem(MY_LINKS_KEY, JSON.stringify(serverLinks));
                localStorage.setItem(LINKS_SYNC_KEY, String(Date.now()));
                console.log('[推广链接] 🔄 服务器链接已更新:', serverLinks);
                updateLinksUI();
            }
        }, LINK_SYNC_INTERVAL);
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

    function applyServerScripts(poolData) {
        if (!poolData || !poolData.scripts) return false;
        try {
            const raw = localStorage.getItem('dan_scripts');
            let existing = raw ? JSON.parse(raw) : {};
            if (!existing.scripts) existing.scripts = {};

            Object.keys(poolData.scripts).forEach(function(k) {
                existing.scripts[k] = {
                    name: poolData.scripts[k].name || k,
                    icebreaker: poolData.scripts[k].icebreaker || '',
                    ad_template: poolData.scripts[k].ad_template || '',
                    kick_message: poolData.scripts[k].kick_message || '',
                    reject_message: poolData.scripts[k].reject_message || '',
                    foreigner_reject: poolData.scripts[k].foreigner_reject || ''
                };
            });
            existing.random_pool = poolData.random_pool || Object.keys(existing.scripts);
            existing.mode = poolData.mode || 'random';
            existing.version = poolData.version || '2.0';
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
    loadMyLinks().then(() => startLinkSync());
    setTimeout(() => { syncScriptsFromServer(true); startScriptSync(); }, 3000);

    function getLiveLink() {
        if (current_live_links && current_live_links.length > 0) {
            console.log("[推广链接] 使用服务器同步链接:", current_live_links[0]);
            return current_live_links[0];
        }
        console.log("[推广链接] 无可用链接，跳过广告");
        return null;
    }

    // ==================== 三轮状态管理 ====================
    var ROUND_STATE_KEY = 'dan_round_states';

    function getRoundState(myHandle) {
        try {
            var raw = localStorage.getItem(ROUND_STATE_KEY);
            if (!raw) return {};
            var state = JSON.parse(raw);
            return state[myHandle] || {};
        } catch(e) { return {}; }
    }

    function getUserRound(myHandle, userHandle) {
        var state = getRoundState(myHandle);
        return state[userHandle] || 0;
    }

    function markUserDone(myHandle, userHandle) {
        try {
            var raw = localStorage.getItem(ROUND_STATE_KEY);
            var allState = raw ? JSON.parse(raw) : {};
            if (!allState[myHandle]) allState[myHandle] = {};
            var current = allState[myHandle][userHandle] || 0;
            allState[myHandle][userHandle] = current + 1;
            localStorage.setItem(ROUND_STATE_KEY, JSON.stringify(allState));
        } catch(e) {}
    }

    function getRoundMessage(myHandle, userHandle) {
        var round = getUserRound(myHandle, userHandle);
        switch(round) {
            case 0: return getPoolMessage('icebreaker') || ICEBREAKER_MESSAGE;
            case 1: {
                var link = getLiveLink();
                if (!link) return null;
                return (getPoolMessage('ad') || AD_MESSAGE_TEMPLATE).replace('{LINK}', link);
            }
            case 2: return getPoolMessage('kick') || KICK_MESSAGE;
            default: return null;
        }
    }

    // ==================== DM 面板加载检测 ====================
    async function waitForDMReady(timeoutMs) {
        timeoutMs = timeoutMs || 30000;
        var start = Date.now();
        while (Date.now() - start < timeoutMs) {
            var input = findBottomAwakeningTarget();
            var sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]') ||
                          document.querySelector('button[aria-label*="Send" i]') ||
                          document.querySelector('button[data-testid$="-send"]');
            if (input && !input.disabled && sendBtn) {
                await new Promise(function(r) { setTimeout(r, 2000); });
                return true;
            }
            await new Promise(function(r) { setTimeout(r, 500); });
        }
        return false;
    }

    // ==============================================================================
    // 【话术系统 — 可配置版本，参考原始版】
    // ==============================================================================
    var SCRIPT_DEFAULTS = {
        version: '2.0',
        mode: 'random',
        random_pool: ['v1','v2','v3','v4','v5','v6','v7','v8','v9','v10'],
        active_script: 'v1',
        scripts: {
            "v1": { "name": "话术1", "icebreaker": "ヤロー / どうも😳", "ad_template": "もしデートできるなら、メッセージちょうだいね〜♡💕\n{LINK}", "kick_message": "まだかなー🥺\nこっちの方が話しやすいよ！待ってる💕", "reject_message": "", "foreigner_reject": "" },
            "v2": { "name": "话术2", "icebreaker": "こんちわ〜😊", "ad_template": "デートできそうだったら教えてくれると嬉しいな💕\n{LINK}", "kick_message": "お返事待ってるね〜😊\nこっちで話そっか💕", "reject_message": "", "foreigner_reject": "" },
            "v3": { "name": "话术3", "icebreaker": "おっす！🙌", "ad_template": "デートしてみたいな〜 良かったらメッセージ待ってるね😊\n{LINK}", "kick_message": "連絡くれないかな？🥺\nこっちの方がすぐ返せるよ！", "reject_message": "", "foreigner_reject": "" },
            "v4": { "name": "话术4", "icebreaker": "やっほー✌️", "ad_template": "デートしたいなって思ったら連絡してね♡\n{LINK}", "kick_message": "待ちくたびれちゃった😭\nこっちでお話しよ💕", "reject_message": "", "foreigner_reject": "" },
            "v5": { "name": "话术5", "icebreaker": "はいはーい🤗", "ad_template": "デートできそう？もしそうならメッセージ待ってるよ😊\n{LINK}", "kick_message": "まだ〜？🥺\nLINEの方が話しやすいんだ〜待ってる💕", "reject_message": "", "foreigner_reject": "" },
            "v6": { "name": "话术6", "icebreaker": "やあ😳", "ad_template": "デートしてみない？メッセージ待ってるね♡\n{LINK}", "kick_message": "あれ？まだかな😳\nこっちで待ってるよ💕", "reject_message": "", "foreigner_reject": "" },
            "v7": { "name": "话术7", "icebreaker": "こんばんは😊", "ad_template": "暇なときデートどうかな？連絡ちょうだい💕\n{LINK}", "kick_message": "もしよかったら、こっちでも話さない？😊💕", "reject_message": "", "foreigner_reject": "" },
            "v8": { "name": "话术8", "icebreaker": "お疲れ様🙌", "ad_template": "LINEで話さない？デートできる人探してるんだ〜💕\n{LINK}", "kick_message": "返信遅くなりそうだからこっちで話そう💕\n待ってるね！", "reject_message": "", "foreigner_reject": "" },
            "v9": { "name": "话术9", "icebreaker": "初めまして🤗", "ad_template": "デートしてくれる？気軽にメッセージちょうだいね♡\n{LINK}", "kick_message": "ねぇ、まだ〜？🥺\nこっちの方がいいよ💕", "reject_message": "", "foreigner_reject": "" },
            "v10": { "name": "话术10", "icebreaker": "どもども😳", "ad_template": "よかったらデートしようよ〜メッセージ待ってる😊\n{LINK}", "kick_message": "おーい😳\nこっちの方が便利だよ！待ってる💕", "reject_message": "", "foreigner_reject": "" }
        },
        templates: {
            icebreaker: "ヤロー / どうも😳",
            ad: "もしデートできるなら、メッセージちょうだいね〜♡💕\n{LINK}",
            kick: "まだかなー🥺\nこっちの方が話しやすいよ！待ってる💕",
            reject: "ごめんね😭 24歳以上で探してて💦 また機会があれば！",
            foreigner_reject: "Sorry, I only speak Japanese 💦 ごめんなさい、日本語しか分からないです😭"
        },
        dna_core: ["line.me", "http", "デート", "メッセージ", "👇", "24歳以上で探してて", "日本語しか分からないです"],
        dna_aux: [],
        corpse_days: 3,
        kick_days: 2
    };

    function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

    function autoExtractDNA(templates) {
        var allText = (templates.icebreaker||'') + ' ' + (templates.ad||'') + ' ' + (templates.kick||'') + ' ' + (templates.reject||'') + ' ' + (templates.foreigner_reject||'');
        allText = allText.replace(/{LINK}/g, '').replace(/[\u{1F300}-\u{1FFFF}]/gu, '').replace(/[💦💕🫣👀😭😱💔😣💋🥺❤️😊✨😌…—、。，！？,.!?\n\r]/g, ' ');
        var tokens = allText.split(/\s+/).filter(function(t) { return t.length >= 3 && !/^\d+$/.test(t); });
        var seen = {};
        var unique = tokens.filter(function(t) { var l=t.toLowerCase(); if(seen[l]) return false; seen[l]=true; return true; });
        var core = unique.filter(function(t) { return t.length >= 4; });
        var aux = unique.filter(function(t) { return t.length < 4; });
        var mustCore = ["line.me", "http", "秘密のアカウント", "👇", "デートとかもしてみたいな", "24歳以上で探してて", "年上の方が好みで", "日本語しか分からないです"];
        mustCore.forEach(function(m) { if(core.indexOf(m)===-1) core.push(m); });
        return { core: core, aux: aux };
    }

    var ICEBREAKER_MESSAGE, AD_MESSAGE_TEMPLATE, KICK_MESSAGE, REJECT_MESSAGE, FOREIGNER_REJECT_MESSAGE;
    var MY_DNA_CORE, MY_DNA_AUX;
    var CORPSE_DAYS = 3;
    var KICK_DAYS = 2;

    // 从话术池随机获取消息（每次调用随机选一套）
    function getPoolMessage(type) {
        try {
            var raw = localStorage.getItem('dan_scripts');
            var cfg;
            if (!raw) { cfg = SCRIPT_DEFAULTS; }
            else { try { cfg = JSON.parse(raw); } catch(e) { cfg = SCRIPT_DEFAULTS; } }
            // 合并：用 SCRIPT_DEFAULTS 确保 5 套话术齐全，同时保留用户已保存的内容
            var mergedScripts = {};
            var pool = SCRIPT_DEFAULTS.random_pool;
            Object.keys(SCRIPT_DEFAULTS.scripts).forEach(function(k) {
                mergedScripts[k] = (cfg.scripts && cfg.scripts[k]) || SCRIPT_DEFAULTS.scripts[k];
            });
            if (pool.length > 0 && mergedScripts) {
                var poolKey = pool[Math.floor(Math.random() * pool.length)];
                var chosen = mergedScripts[poolKey];
                if (!chosen) return null;
                if (type === 'icebreaker') return chosen.icebreaker;
                if (type === 'ad') return chosen.ad_template;
                if (type === 'kick') return chosen.kick_message;
                if (type === 'reject') return chosen.reject_message;
                if (type === 'foreigner_reject') return chosen.foreigner_reject;
            }
        } catch(e) {}
        return null;
    }

    function loadScripts() {
        var raw = localStorage.getItem('dan_scripts');
        var config;
        if (!raw) { config = deepClone(SCRIPT_DEFAULTS); }
        // 注意：不写回 localStorage —— 首次写入由 bootstrapFromJSON 负责
        else { try { config = JSON.parse(raw); } catch(e) { config = deepClone(SCRIPT_DEFAULTS); } }

        // 确保 scripts 池始终有 5 套（合并 SCRIPT_DEFAULTS 缺失的）
        if (!config.scripts) config.scripts = {};
        Object.keys(SCRIPT_DEFAULTS.scripts).forEach(function(k) {
            if (!config.scripts[k]) config.scripts[k] = deepClone(SCRIPT_DEFAULTS.scripts[k]);
        });
        if (!config.random_pool) config.random_pool = SCRIPT_DEFAULTS.random_pool;
        if (config.mode !== 'random' && config.mode !== 'fixed') config.mode = SCRIPT_DEFAULTS.mode;

        // 随机池：如果 mode=random 且有 scripts 池，随机选一套
        if (config.mode === 'random' && config.scripts && Array.isArray(config.random_pool) && config.random_pool.length > 0) {
            var poolKey = config.random_pool[Math.floor(Math.random() * config.random_pool.length)];
            var chosen = config.scripts[poolKey];
            if (chosen) {
                config.templates = {
                    icebreaker: chosen.icebreaker || '',
                    ad: chosen.ad_template || '',
                    kick: chosen.kick_message || config.templates.kick || '',
                    reject: chosen.reject_message || config.templates.reject || '',
                    foreigner_reject: chosen.foreigner_reject || config.templates.foreigner_reject || ''
                };
                console.log('[话术池] 随机选中:', chosen.name || poolKey);
            }
        }

        ICEBREAKER_MESSAGE = config.templates.icebreaker || SCRIPT_DEFAULTS.templates.icebreaker;
        AD_MESSAGE_TEMPLATE = config.templates.ad || SCRIPT_DEFAULTS.templates.ad;
        KICK_MESSAGE = config.templates.kick || SCRIPT_DEFAULTS.templates.kick;
        REJECT_MESSAGE = config.templates.reject || SCRIPT_DEFAULTS.templates.reject;
        FOREIGNER_REJECT_MESSAGE = config.templates.foreigner_reject || SCRIPT_DEFAULTS.templates.foreigner_reject;
        MY_DNA_CORE = config.dna_core || SCRIPT_DEFAULTS.dna_core;
        MY_DNA_AUX = config.dna_aux || SCRIPT_DEFAULTS.dna_aux;
        if (config.corpse_days) CORPSE_DAYS = config.corpse_days;
        if (config.kick_days) KICK_DAYS = config.kick_days;
        return config;
    }

    function saveScripts(config) {
        var extracted = autoExtractDNA(config.templates);
        config.dna_core = extracted.core;
        config.dna_aux = extracted.aux;
        localStorage.setItem('dan_scripts', JSON.stringify(config));
        loadScripts();
    }

    loadScripts();

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
    function showToast(msg, color = '#1d9bf0', time = 2500) {
        toast.innerText = msg;
        toast.style.background = color;
        toast.style.display = 'block';
        setTimeout(() => {
            if (toast && toast.parentNode) {
                toast.style.display = 'none';
            }
        }, time);
    }

    // Master button (Chat)
    const masterBtn = document.createElement('button');
    masterBtn.id = 'matrix-switch-btn';
    masterBtn.innerText = '\u{1F680}';
    if (document.body) document.body.appendChild(masterBtn);

    // Settings button
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'matrix-settings-btn';
    settingsBtn.innerText = '\u2699\uFE0F';
    if (document.body) document.body.appendChild(settingsBtn);

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
                    <label class="mcp-label" style="margin-top:12px;">\u8FFD\u5355\u5929\u6570\uFF08\u5929\u540E\u53D1\u9001\u8FFD\u5355\u6D88\u606F\uFF09</label>
                    <input class="mcp-input" type="number" id="mcp-setting-kick-days" min="1" max="14" value="2">
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
    if (document.body) document.body.appendChild(configPanel);

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
        return current_live_links && current_live_links.length > 0 ? current_live_links : [];
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
        current_live_links = links;
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
            current_live_links = serverLinks;
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
        config.kick_days = parseInt(configPanel.querySelector('#mcp-setting-kick-days').value) || 2;
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
    function isMyFollowersPage() {
        if (!window.location.pathname.includes('/followers')) return false;
        let pathHandle = window.location.pathname.split('/')[1].toLowerCase();
        let myHandle = getMyHandle();
        if (!myHandle) {
            // 无法确定，默认不启动（避免在错误的页面启动）
            console.log('[隔离] 无法确定当前用户，跳过自动启动');
            return false;
        }
        return pathHandle === myHandle;
    }

    function tryAutoStart() {
        // 自动启动条件检查
        if (!isAutoStartEnabled()) return false;
        if (sessionStorage.getItem('dan_auto_run') === 'true') return false;
        // 【Tab 隔离】只在自己的 followers 页面启动
        // 已移除页面限制，自动导航到自己的 followers
        if (!current_live_links || current_live_links.length === 0) {
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
        showToast('🤖 私信引擎自动启动！', '#00ba7c', 2000);
        window.location.href = 'https://x.com/' + myHandleAuto + '/followers';
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
            showToast('🛑 引擎已停止', '#f91880');
        } else {
            // 启动引擎（手动）
            // 检查活水链接是否有效
            if (!current_live_links || current_live_links.length === 0) { 
                alert('⚠️ 推广链接未就绪！请在设置面板中配置。'); 
                return; 
            }
            // 已移除页面限制，启动后自动导航到自己的 followers
            let myHandle = getMyHandle();
            if (!myHandle) { showToast('无法获取当前用户', '#f91880', 3000); return; }
            sessionStorage.setItem('dan_auto_run', 'true');
            localStorage.setItem('dan_chat_status', 'running');
            sessionStorage.removeItem('dan_auto_step');
            sessionStorage.setItem('dan_session_scanned', '[]');
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 1000).toString());
            sessionStorage.setItem('dan_target_username', myHandle);
            showToast(`🚀 引擎启动，正在导航...`, '#1d9bf0', 2000);
            window.location.href = 'https://x.com/' + myHandle + '/followers';
            renderStats();
        }
        updateMasterBtn();
    };

    updateMasterBtn();
    renderStats();

    // 页面加载后尝试自动启动
    async function initAutoStart() {
        // 确保 dan_target_username 始终有值（step 4 跳回依赖此值）
        if (!sessionStorage.getItem('dan_target_username')) {
            var hh = localStorage.getItem('matrix_my_handle');
            if (hh) {
                hh = hh.replace('@','').replace('#guard','').toLowerCase();
                sessionStorage.setItem('dan_target_username', hh);
                console.log('[初始化] dan_target_username 修复为:', hh);
            }
        }
        console.log('[初始化] ✅ 推广链接已就绪:', current_live_links);
        // 从后端加载今日已完成名单
        try {
            var h = sessionStorage.getItem('dan_target_username') || localStorage.getItem('matrix_my_handle');
            if (h) {
                h = h.replace('@','').replace('#guard','').toLowerCase();
                chrome.runtime.sendMessage({ action: 'ops_dm_rounds', handle: h }, function(r) {
                    if (r && r.ok) {
                        sessionStorage.setItem('dan_completed_targets', JSON.stringify(r.completed_targets || []));
                        console.log('[私信-后端] 已完成:', (r.completed_targets||[]).length, '待处理:', (r.pending_leads||[]).length);
                    }
                });
            }
        } catch(e) { console.log('[私信-后端] 查询跳过:', e.message); }
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
    function findBottomAwakeningTarget() {
        const targets = document.querySelectorAll(`[contenteditable="true"], [data-testid*="dmComposer"], [data-testid*="DmComposer"], div[role="textbox"], textarea, input[type="text"], [role="textbox"], [role="combobox"], [aria-label*="Message" i], [aria-label*="消息"], [placeholder*="Message" i], [placeholder*="消息"], [data-testid*="messageTextarea"]`);
        let validTargets = Array.from(targets).filter(el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top > 0; });
        if (validTargets.length > 0) { validTargets.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top); return validTargets[0]; }
        var fallback = document.querySelector('[contenteditable="true"]');
        console.log('[DM-INPUT] findBottomAwakeningTarget: validTargets=0, total matches:', targets.length, 'fallback:', fallback ? true : false);
        return fallback || null;
    }

    function threadSafeSend(inputElement, text) {
        inputElement.click(); inputElement.focus();
        const sel = window.getSelection(); const range = document.createRange();
        range.selectNodeContents(inputElement); range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
        let success = document.execCommand('insertText', false, text);
        if (!success) { inputElement.textContent = text; inputElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); }
        setTimeout(() => {
            const sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]') ||
                            document.querySelector('button[aria-label*="Send" i]') ||
                            document.querySelector('[data-testid$="-send"]') ||
                            document.querySelector('[role="button"][aria-label*="发送" i]');
            if (sendBtn && !sendBtn.disabled) { sendBtn.click(); }
            else { inputElement.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 })); }
        }, 1500); 
    }


    // ========== getChatDecision 已移除 — 改为三轮 push 模式 ==========


    // ========== 【主巡航引擎】 ==========
    let mainEngine = safeSetInterval(() => {
        const isRunning = sessionStorage.getItem('dan_auto_run') === 'true';
        if (!isRunning) return;

        let errorButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        let retryBtn = errorButtons.find(btn => btn.innerText && (btn.innerText.includes('重试') || btn.innerText.includes('Retry') || btn.innerText.includes('限制')));
        if (retryBtn && window.location.href.includes('/followers')) { retryBtn.click(); }

        let lastHealthyTime = parseInt(sessionStorage.getItem('dan_last_healthy_time') || Date.now().toString());
        let isHealthyDOM = document.querySelector('[data-testid="UserCell"]') || document.querySelector('[data-testid="dmComposerTextInput"]') || document.querySelector('[data-testid="sendDMFromProfile"]');

        if (isHealthyDOM) {
            sessionStorage.setItem('dan_last_healthy_time', Date.now().toString());
        } else if (Date.now() - lastHealthyTime > 40000) { 
            showToast('⚠️ 页面无响应，跳脱清理...', '#ff4d4f', 3000);
            sessionStorage.setItem('dan_last_healthy_time', Date.now().toString());
            sessionStorage.removeItem('dan_auto_step'); 
            let hostUser = sessionStorage.getItem('dan_target_username');
            if (hostUser && !window.location.href.includes('/followers')) { window.location.replace(`/${hostUser}/followers?_t=${Date.now()}`); } 
            else { let cleanUrl = window.location.href.split('?')[0]; window.location.replace(`${cleanUrl}?_t=${Date.now()}`); }
            return;
        }

        if (window.location.href.includes('/followers')) {
            let allCells = document.querySelectorAll('[data-testid="UserCell"]');
            if (allCells.length > 60) { for (let i = 0; i < 20; i++) { if (allCells[i] && allCells[i].parentNode) allCells[i].parentNode.removeChild(allCells[i]); } }
        }

        let warmupTime = parseInt(sessionStorage.getItem('dan_warmup_timer') || '0');
        if (Date.now() < warmupTime) return;

        let memCount = parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0');
        if (memCount >= 35) {
            showToast('🧹 内存防爆击穿释放中...', '#f91880', 3000);
            sessionStorage.setItem('dan_mem_cleaner_count', '0');
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 5000).toString()); 
            let cleanUrl = window.location.href.split('?')[0];
            setTimeout(() => { window.location.replace(`${cleanUrl}?_t=${Date.now()}`); }, 1500);
            return;
        }

        const currentStep = sessionStorage.getItem('dan_auto_step');

        if (!currentStep) {
            if (!window.location.href.includes('/followers')) return;

            const userCells = document.querySelectorAll('[data-testid="UserCell"]');
            const scannedList = getSessionList();
            const rejectDB = getDB('dan_reject_users');
            const completedBackend = JSON.parse(sessionStorage.getItem('dan_completed_targets') || '[]');
            let targetToClick = null;

            for (let cell of userCells) {
                let profileLink = cell.querySelector('a[role="link"]');
                if (profileLink) {
                    let rawHref = profileLink.getAttribute('href');
                    let userHandle = rawHref.split('?')[0].split('/').pop().toLowerCase();
                    if (rejectDB.has(userHandle)) { addSessionList(userHandle); continue; }
                    if (scannedList.includes(userHandle)) continue;
                    // 后端完成名单 skip
                    if (completedBackend.includes(userHandle)) { addSessionList(userHandle); continue; }
                    // 本地 dan_round_states >= 3 skip
                    if (getUserRound(myHandle, userHandle) >= 3) { addSessionList(userHandle); continue; }
                    if (!targetToClick) { targetToClick = { link: profileLink, handle: userHandle }; }
                }
            }

            if (targetToClick) {
                addSessionList(targetToClick.handle);
                sessionStorage.setItem('current_target', targetToClick.handle);
                sessionStorage.setItem('dan_auto_step', '1');
                let randomReadTime = Math.floor(Math.random() * 2); 
                sessionStorage.setItem('dan_profile_wait', randomReadTime.toString());
                targetToClick.link.click();
                sessionStorage.setItem('dan_scroll_fail_count', '0');
                sessionStorage.setItem('dan_bottom_hit_count', '0');
            } else {
                window.scrollBy({ top: 200, behavior: 'smooth' });
                let failCount = parseInt(sessionStorage.getItem('dan_scroll_fail_count') || '0');
                sessionStorage.setItem('dan_scroll_fail_count', failCount + 1);
                
                let isPhysicalBottom = (window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 50;
                
                if (isPhysicalBottom) {
                    let hasLoader = document.querySelector('[role="progressbar"]');
                    let bottomHitCount = parseInt(sessionStorage.getItem('dan_bottom_hit_count') || '0');
                    sessionStorage.setItem('dan_bottom_hit_count', bottomHitCount + 1);
                    
                    if (!hasLoader && bottomHitCount >= 2) {
                        showToast('✅ 彻底触底！确认无新数据，重置...', '#1d9bf0', 3000);
                        sessionStorage.setItem('dan_session_scanned', '[]');
                        sessionStorage.setItem('dan_scroll_fail_count', '0');
                        sessionStorage.setItem('dan_bottom_hit_count', '0');
                        sessionStorage.setItem('dan_warmup_timer', (Date.now() + 3000).toString());
                        let cleanUrl = window.location.href.split('?')[0];
                        setTimeout(() => { window.scrollTo(0,0); window.location.replace(`${cleanUrl}?_t=${Date.now()}`); }, 1500);
                    } else if (hasLoader) {
                        sessionStorage.setItem('dan_bottom_hit_count', '0');
                        showToast('⏳ 等待拉取新粉丝中...', '#faad14', 1500);
                    } else {
                        showToast('⏬ 触底辅助确认中...', '#faad14', 1500);
                    }
                } else {
                    sessionStorage.setItem('dan_bottom_hit_count', '0');
                    if (failCount > 100) {
                        sessionStorage.setItem('dan_session_scanned', '[]');
                        sessionStorage.setItem('dan_scroll_fail_count', '0');
                        let cleanUrl = window.location.href.split('?')[0];
                        window.location.replace(`${cleanUrl}?_t=${Date.now()}`);
                    }
                }
            }
        }

        if (currentStep === '1') {
            let pageText = document.body.innerText;
            if (pageText.includes('此账号不存在') || pageText.includes('This account doesn\'t exist') || pageText.includes('账号已冻结') || pageText.includes('Account suspended')) {
                showToast('💀 账号已阵亡，跳过！', '#000', 3000);
                let deadHandle = sessionStorage.getItem('current_target');
                if (deadHandle) { saveToDB('dan_reject_users', deadHandle); sendLogToNAS(deadHandle, 'CORPSE', '封号阵亡'); }
                sessionStorage.setItem('dan_auto_step', '4');
                return;
            }

            let dmButton = document.querySelector('[data-testid="sendDMFromProfile"]') ||
                           document.querySelector('[aria-label*="Direct Message" i]') ||
                           document.querySelector('[aria-label*="发送私信" i]') ||
                           document.querySelector('[data-testid*="dm" i]');
            if (dmButton) {
                sessionStorage.setItem('dan_auto_step', '2');
                sessionStorage.setItem('dan_chat_wait_time', '0');
                sessionStorage.removeItem('dan_profile_wait');
                setTimeout(() => { dmButton.click(); }, 600);
            } else {
                let failDMCount = parseInt(sessionStorage.getItem('dan_wait_count') || '0');
                if (failDMCount > 8) {
                    showToast('⚠️ 未开启私信，跳过！', '#f91880');
                    let targetHandle = sessionStorage.getItem('current_target');
                    sendLogToNAS(targetHandle, 'REJECT', '未开启私信');
                    sessionStorage.setItem('dan_auto_step', '4');
                } else { sessionStorage.setItem('dan_wait_count', failDMCount + 1); }
            }
        }

        if (currentStep === '2') {
            const wakeUpTarget = findBottomAwakeningTarget();
            if (!wakeUpTarget) return;

            const targetHandle = sessionStorage.getItem('current_target');
            if (!targetHandle) { sessionStorage.setItem('dan_auto_step', '4'); return; }

            // 查询三轮状态：已完成3轮的跳过
            var myHandle = sessionStorage.getItem('dan_target_username');
            var userRound = getUserRound(myHandle, targetHandle);
            if (userRound >= 3) {
                sessionStorage.setItem('dan_mem_cleaner_count', (parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0') + 1).toString());
                sessionStorage.setItem('dan_auto_step', '4');
                return;
            }

            // DM 面板加载检测
            var waitKey = 'dan_dm_ready_wait_' + targetHandle;
            var waitCount = parseInt(sessionStorage.getItem(waitKey) || '0');
            var isReady = (function() {
                var input = findBottomAwakeningTarget();
                // 强化兜底：全局搜任何可编辑元素
                if (!input) {
                    var allEditable = document.querySelectorAll('[contenteditable="true"], textarea, div[role="textbox"], [role="textbox"][contenteditable], [data-text="true"]');
                    var visibleOne = Array.from(allEditable).find(el => { var r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10 && r.top > 0; });
                    if (visibleOne) { input = visibleOne; console.log('[DM检测] 全局兜底找到input:', input.tagName); }
                }
                var sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]') ||
                              document.querySelector('button[aria-label*="Send" i]') ||
                              document.querySelector('button[data-testid$="-send"]') ||
                              document.querySelector('[role="button"][aria-label*="发送" i]') ||
                              document.querySelector('button[aria-label]');
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
                return input && !input.disabled && sendBtn;
            })();

            if (!isReady) {
                if (waitCount >= 5) {
                    showToast('❌ DM加载超时，跳过', '#ff4d4f', 2000);
                    sessionStorage.setItem('dan_mem_cleaner_count', (parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0') + 1).toString());
                    sessionStorage.setItem('dan_auto_step', '4');
                    sessionStorage.removeItem(waitKey);
                    return;
                }
                sessionStorage.setItem(waitKey, (waitCount + 1).toString());
                showToast('⏳ DM面板加载中... (' + waitCount + 's)', '#faad14', 2000);
                return;
            }
            sessionStorage.removeItem(waitKey);

            // 根据轮次获取消息
            var msgToSend = getRoundMessage(myHandle, targetHandle);
            if (!msgToSend) {
                if (userRound === 1) {
                    markUserDone(myHandle, targetHandle);
                    console.log('[跳过] 无可用链接，跳过广告轮，推进到第3轮');
                }
                sessionStorage.setItem('dan_mem_cleaner_count', (parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0') + 1).toString());
                sessionStorage.setItem('dan_auto_step', '4');
                return;
            }

            var roundNames = ['❄️ 破冰', '🎣 广告', '🛡️ 催加'];
            var roundName = roundNames[userRound] || '未知';
            var actionTypes = ['ICEBREAKER', 'AD', 'AD'];

            sessionStorage.setItem('dan_auto_step', '2_waiting');
            showToast(roundName + '！(第' + (userRound + 1) + '轮)', '#1d9bf0');
            sendLogToNAS(targetHandle, actionTypes[userRound], '第' + (userRound + 1) + '轮:' + roundName, msgToSend);

            threadSafeSend(wakeUpTarget, msgToSend);
            markUserDone(myHandle, targetHandle);

            // 上传 DM 记录到后端 + 存本地历史
            try {
                chrome.runtime.sendMessage({
                    action: 'ops_dm_record',
                    bot_id: getWorkerId(),
                    target_handle: targetHandle,
                    round_number: (userRound || 0) + 1,
                    message_content: msgToSend,
                    result: 'success'
                }).catch(function() {});
            } catch(e) {}
            try {
                var dmHist = JSON.parse(localStorage.getItem('sg_dm_history') || '[]');
                dmHist.push({ target: targetHandle, round: (userRound||0)+1, msg: msgToSend, time: new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}), result: 'success' });
                if (dmHist.length > 200) dmHist = dmHist.slice(-200);
                localStorage.setItem('sg_dm_history', JSON.stringify(dmHist));
            } catch(e) {}

            sessionStorage.setItem('dan_sent_' + targetHandle, 'true');
            setTimeout(function() {
                sessionStorage.setItem('dan_mem_cleaner_count', (parseInt(sessionStorage.getItem('dan_mem_cleaner_count') || '0') + 1).toString());
                sessionStorage.setItem('dan_auto_step', '4');
            }, 2500 + Math.floor(Math.random() * 1500));
            return;
        }

        if (currentStep === '4') {
            sessionStorage.removeItem('dan_auto_step');
            showToast('🔙 跳回...', '#1d9bf0', 1000);
            let hostUser = sessionStorage.getItem('dan_target_username');
            // 安全网：如果 hostUser 为空，从 localStorage 恢复
            if (!hostUser) {
                var mh = localStorage.getItem('matrix_my_handle');
                if (mh) { hostUser = mh.replace('@','').replace('#guard','').toLowerCase(); }
            }
            if (hostUser) { window.location.replace(`/${hostUser}/followers?_t=${Date.now()}`); } 
            else { let cleanUrl = window.location.href.split('?')[0]; window.location.replace(`${cleanUrl}?_t=${Date.now()}`); }
            sessionStorage.setItem('dan_warmup_timer', (Date.now() + 3000).toString());
        }

    }, 5000 + Math.floor(Math.random() * 2000));

    // ==============================================================================
    // 【V11.5.7 自动刷新机制 — 定时释放内存，防止长时间运行卡顿】
    // ==============================================================================
    safeSetInterval(() => {
        // 每 30 分钟自动刷新页面，释放内存
        if (sessionStorage.getItem('dan_auto_run') === 'true') {
            console.log('[自动刷新] 30分钟周期到，保存状态并刷新...');
            // 保存关键状态到 localStorage（sessionStorage 刷新后会丢失）
            localStorage.setItem('dan_recovery_auto_run', 'true');
            localStorage.setItem('dan_recovery_time', Date.now().toString());
            localStorage.setItem('dan_recovery_target', sessionStorage.getItem('dan_target_username') || '');
            localStorage.setItem('dan_recovery_links', JSON.stringify(current_live_links));
            // 清理资源后刷新
            clearAllTimers();
            cleanupInjectedDOM();
            window.location.reload();
        }
    }, 30 * 60 * 1000); // 30分钟
    
    // 刷新后自动恢复状态
    (function recoverAfterRefresh() {
        const recoveryTime = localStorage.getItem('dan_recovery_time');
        if (recoveryTime && Date.now() - parseInt(recoveryTime) < 60000) { // 1分钟内刷新过
            console.log('[自动刷新] 恢复运行状态...');
            const autoRun = localStorage.getItem('dan_recovery_auto_run');
            if (autoRun === 'true') {
                sessionStorage.setItem('dan_auto_run', 'true');
                localStorage.setItem('dan_chat_status', 'running');
                // V15: 链接已在 localStorage 永久保存，无需单独恢复
            }
            // 清理恢复标记
            localStorage.removeItem('dan_recovery_auto_run');
            localStorage.removeItem('dan_recovery_time');
            localStorage.removeItem('dan_recovery_target');
            localStorage.removeItem('dan_recovery_links');
        }
    })();
    
    // ==============================================================================
    // 【V11.5.7 内存监控 — 超过阈值自动刷新】
    // ==============================================================================
    safeSetInterval(() => {
        if (window.performance && window.performance.memory) {
            const mem = window.performance.memory;
            const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
            const totalMB = Math.round(mem.totalJSHeapSize / 1024 / 1024);
            console.log(`[内存监控] 已用: ${usedMB}MB / 总量: ${totalMB}MB`);
            
            // 内存超过 200MB 或 DOM 节点超过 3000 时自动刷新
            const domCount = document.getElementsByTagName('*').length;
            if (usedMB > 200 || domCount > 3000) {
                console.warn(`[内存监控] 资源过高(内存${usedMB}MB/DOM${domCount})，触发刷新...`);
                if (sessionStorage.getItem('dan_auto_run') === 'true') {
                    localStorage.setItem('dan_recovery_auto_run', 'true');
                    localStorage.setItem('dan_recovery_time', Date.now().toString());
                    clearAllTimers();
                    cleanupInjectedDOM();
                    window.location.reload();
                }
            }
            
            // 保存内存状态到 sessionStorage，随心跳上报
            sessionStorage.setItem('dan_memory_mb', usedMB.toString());
            sessionStorage.setItem('dan_dom_count', domCount.toString());
        }
    }, 5 * 60 * 1000); // 每 5 分钟检查一次
    
    // ==============================================================================
    // 探针模块 (V11.4 修复：心跳始终上报，不受 matrix_auto_run 限制)
    // ==============================================================================
    safeSetInterval(() => {
        // 移除 if (sessionStorage.getItem('dan_auto_run') !== 'true') return; 限制
        
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
            currentStatus = "⚠️ 页面白屏卡死 (看门狗待命中)";
            detailStr = "DOM节点无响应";
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
                    status: currentStatus,
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
    if (window.MatrixChatTemplates) return;

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

    // ==================== 初始化（从 chat_scripts.json 导入全部5套话术，无条件覆盖）====================
    async function bootstrapFromJSON() {
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
            var mustCore = ["line.me", "http", "秘密のアカウント", "👇", "24歳以上で探してて", "日本語しか分からないです"];
            mustCore.forEach(function(m) { if(core.indexOf(m)===-1) core.push(m); });

            var config = {
                version: json.version || '2.0',
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
                version: existing.version || '2.0',
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
        version: 'V16.6.0'
    };

    // 自动初始化（异步，不阻塞主流程）
    bootstrapFromJSON();

    console.log('[MatrixChatTemplates] 模板管理模块已加载 (V16.6.0)');
})();
