// X-Matrix 自动关注引擎 (V18.3.1 | 任务锁 + 防封阶梯 + 养号 + 配额满转纯养号 + 天数覆盖)
// V18.3.0 (扩展 3.6.2)：软风控填窗保留博主任务锁 + 页面不匹配自动跳回粉丝列表续点
// V18.3.1 (扩展 3.7.18+)：修复「SCAN 停在个人主页」永久卡死（心跳写 running:false + 恢复条件修正）
(function() {
    'use strict';

    // 同页禁止重复注入（否则两套 runEngine 并行 → 双读简介后二次点击变成取关）
    if (window.__matrix_follow_engine__) {
        console.log('[Follow] 引擎已注入，跳过重复加载');
        return;
    }
    window.__matrix_follow_engine__ = true;

    // ================= 【配置区】 =================
    const CONFIG = {
        localStorageKey: 'matrix_target_handles',
        completedKey: 'matrix_completed_handles',
        autoJumpEnabled: true,
        jumpDelayMin: 2000,
        jumpDelayMax: 4000,
    };

    function isAntiBanEnabled() {
        try {
            if (typeof RemoteSettings !== 'undefined' && RemoteSettings.antiBanEnabled) {
                var ra = RemoteSettings.antiBanEnabled();
                if (ra !== null) return !!ra;
            }
        } catch (e0) {}
        if (localStorage.getItem('matrix_antiban_enabled') === 'true') return true;
        if (localStorage.getItem('matrix_antiban_enabled') === 'false') return false;
        try {
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            if (settings.antiBanMode !== undefined) return settings.antiBanMode === true;
        } catch (e) {}
        return false;
    }

    function isOnlyJapaneseEnabled() {
        try {
            if (typeof RemoteSettings !== 'undefined' && RemoteSettings.onlyJapanese) {
                var rj = RemoteSettings.onlyJapanese();
                if (rj !== null) return !!rj;
            }
        } catch (e0) {}
        try {
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            return settings.onlyJapanese !== false;
        } catch (e) { return true; }
    }

    function isNurtureLockEnabled() {
        if (localStorage.getItem('matrix_nurture_lock') === 'true') return true;
        try {
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            return settings.nurtureLock === true;
        } catch (e) { return false; }
    }

    (function initSettingsSync() {
        try {
            chrome.storage.local.get(['matrix_console_settings'], function(r) {
                if (r.matrix_console_settings) {
                    syncSettingsFromStorage(r.matrix_console_settings);
                } else {
                    localStorage.setItem('matrix_antiban_enabled', 'true');
                }
            });
        } catch(e) {}
    })();

    function syncSettingsFromStorage(settings) {
        localStorage.setItem('matrix_console_settings', JSON.stringify(settings));
        localStorage.setItem('matrix_antiban_enabled', settings.antiBanMode !== false ? 'true' : 'false');
        if (settings.nurtureLock !== undefined) localStorage.setItem('matrix_nurture_lock', settings.nurtureLock ? 'true' : 'false');
        if (settings.burstMode !== undefined) localStorage.setItem('matrix_burst_mode', settings.burstMode ? 'true' : 'false');
        if (settings.dayOverride !== undefined) {
            var dov = parseInt(settings.dayOverride, 10) || 0;
            if (dov > 0) localStorage.setItem('matrix_day_offset', (dov - 1).toString());
            else localStorage.removeItem('matrix_day_offset');
        }
        try { if (followPanel && followPanel.classList.contains('active')) renderFollowPanel(); } catch(e) {}
    }

    try {
        chrome.storage.onChanged.addListener(function(changes, namespace) {
            if (namespace !== 'local') return;
            var s = changes.matrix_console_settings;
            if (s && s.newValue) syncSettingsFromStorage(s.newValue);
        });
    } catch(e) {}

    var _followSyncTimer = setInterval(function() {
        try {
            chrome.storage.local.get(['matrix_console_settings'], function(r) {
                if (!r.matrix_console_settings) return;
                var cur = localStorage.getItem('matrix_console_settings');
                var nxt = JSON.stringify(r.matrix_console_settings);
                if (cur !== nxt) syncSettingsFromStorage(r.matrix_console_settings);
            });
        } catch(e) { clearInterval(_followSyncTimer); }
    }, 10000);

    try {
        chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
            if (msg.action === 'sync_console_settings' && msg.settings) {
                syncSettingsFromStorage(msg.settings);
                sendResponse({ok: true});
                return true;
            }
            if (msg.action === 'get_follow_status') {
                var s = getAccountStats();
                sendResponse({
                    running: isRunning,
                    nurturing: __nurtureState.running,
                    step: localStorage.getItem('matrix_step') || 'IDLE',
                    risk: checkLimits(),
                    cooldown: getMatrixCooldownUntil() > Date.now() ? formatCooldownText(getMatrixCooldownUntil() - Date.now()) : '-',
                    blogger: localStorage.getItem('matrix_current_creator') || '',
                    todayCount: s.follows_today,
                    dailyLimit: getDailyLimit(s.day_count),
                    dayCount: s.day_count
                });
                return true;
            }
        });
    } catch(e) {}

    function formatCooldownText(ms) {
        var m = Math.floor(ms / 60000);
        var sec = Math.floor((ms % 60000) / 1000);
        return m + 'm' + sec + 's';
    }

    // 获取关注间隔：远程后台优先，本地面板兜底
    function getFollowInterval() {
        try {
            if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followIntervalSec) {
                var remote = RemoteSettings.followIntervalSec();
                if (remote) {
                    return { min: remote.min * 1000, max: remote.max * 1000 };
                }
            }
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            const min = Math.max(2, settings.followIntervalMin || 2);
            const max = Math.max(min, settings.followIntervalMax || 4);
            return { min: min * 1000, max: max * 1000 };
        } catch (e) {
            return { min: 2000, max: 4000 };
        }
    }

    // ================= 【数据上报（立即发送）】 =================

    function queueReport(type, data) {
        // 立即发送，不入队列
        const stats = getAccountStats();
        const payload = {
            tp: type, 
            ct: data,
            mc: localStorage.getItem('matrix_client_name') || localStorage.getItem('matrix_machine_code') || 'unknown',
            inst: sessionStorage.getItem('matrix_tab_id') || '',
            blogger: localStorage.getItem('matrix_current_creator') || '',
            bot_id: getWorkerId(),
            action_type: "FOLLOW",
            count: stats.follows_today,
            day_count: stats.day_count,
            timestamp: Date.now() 
        };
        
        // 添加到 localStorage 备份队列（防止 Service Worker 终止时数据丢失）
        try {
            let backupQueue = JSON.parse(localStorage.getItem('matrix_follow_backup') || '[]');
            backupQueue.push({payload: payload, time: Date.now()});
            // 限制备份队列长度，防止 localStorage 溢出
            if (backupQueue.length > 50) {
                backupQueue = backupQueue.slice(-50);
            }
            localStorage.setItem('matrix_follow_backup', JSON.stringify(backupQueue));
        } catch (e) {
            console.warn('[上报] 备份队列写入失败:', e);
        }
        
        // 通过 background.js 发送到 NAS
        chrome.runtime.sendMessage({
            action: 'report_followed',
            tp: type,
            data: payload
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[上报] 发送失败:', chrome.runtime.lastError);
            } else if (response && response.ok) {
                console.log('[上报] 发送成功:', type, data.handle || '');
                // 发送成功后从备份队列移除
                try {
                    let backupQueue = JSON.parse(localStorage.getItem('matrix_follow_backup') || '[]');
                    backupQueue = backupQueue.filter(item => item.payload.timestamp !== payload.timestamp);
                    localStorage.setItem('matrix_follow_backup', JSON.stringify(backupQueue));
                } catch (e) {
                    // 忽略清理错误
                }
            } else {
                console.warn('[上报] 响应异常:', response);
            }
        });
    }

    // ================= 【配额与风控系统】 =================
    let memCount = 0; // 防爆计数器

    function getBeijingDateString() {
        // 与 ConfigSync 统一用 YYYY-MM-DD，避免格式不一致导致跨日不清零
        try {
            return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        } catch (e) {
            const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
            return bj.toISOString().slice(0, 10);
        }
    }

    function sameShanghaiDay(a, b) {
        function key(v) {
            if (!v) return '';
            const m = String(v).trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
            if (!m) return String(v);
            return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
        }
        return key(a) === key(b);
    }

    function normalizeHandleValue(raw) {
        if (!raw) return null;
        const match = String(raw).trim().match(/@?([^#\/\s]+)/);
        return match && match[1] ? match[1].toLowerCase() : null;
    }

    function getProfileId() {
        const handle = normalizeHandleValue(localStorage.getItem('matrix_my_handle')) ||
            normalizeHandleValue(localStorage.getItem('matrix_extracted_handle'));
        return handle ? `@${handle}#guard` : null;
    }

    function getMyHandle() {
        // 先从 localStorage 读取
        let handle = normalizeHandleValue(localStorage.getItem('matrix_my_handle'));
        if (handle && handle !== '未知账号') {
            return handle;
        }
        
        // 从页面获取
        let myHandleEl = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        if (myHandleEl && myHandleEl.href) {
            handle = myHandleEl.href.split('/').pop().toLowerCase();
            // 保存到 localStorage
            localStorage.setItem('matrix_my_handle', `@${handle}#guard`);
            
            // 通知中控台
            document.dispatchEvent(new CustomEvent('matrix-account-info', {
                detail: { username: '@' + handle }
            }));
            
            return handle;
        }
        
        return '未知账号';
    }

    function getAccountStats() {
        const handle = getMyHandle();
        const key = `matrix_stats_${handle}`;
        let stats = JSON.parse(localStorage.getItem(key) || '{"date":"","follows_today":0,"day_count":0}');
        let today = getBeijingDateString();
        var hadDay = (parseInt(stats.day_count, 10) || 0) > 0;
        if (!sameShanghaiDay(stats.date, today)) {
            stats.date = today; stats.follows_today = 0;
            delete stats.daily_limit; // 跨日重抽配额
            if (!hasManualDayOverride()) {
                // 空本地/换插件：day_count=0 时不要 +1 冒充 Day1，等 OPS 同步
                if (hadDay) {
                    stats.day_count = (typeof stats.day_count === 'number' ? stats.day_count : 0) + 1;
                } else {
                    stats.day_count = 0;
                }
            }
            localStorage.setItem(key, JSON.stringify(stats));
            if (hadDay && isAntiBanEnabled()) {
                var c = parseInt(localStorage.getItem('matrix_day_offset') || '0', 10) || 0;
                localStorage.setItem('matrix_day_offset', (c + 1).toString());
            }
            const nurtureKey = `matrix_nurture_sessions_${handle}`;
            localStorage.setItem(nurtureKey, JSON.stringify({ date: today, sessions: 0, lastTime: 0 }));
        } else if (stats.date !== today) {
            // 旧格式日期（如 2026/8/1）归一成 YYYY-MM-DD，不改计数
            stats.date = today;
            localStorage.setItem(key, JSON.stringify(stats));
        }
        var dov = getManualDayOverride();
        if (dov > 0) {
            return { date: stats.date, follows_today: stats.follows_today, day_count: dov, daily_limit: stats.daily_limit };
        }
        return stats;
    }

    function followDayRangeFor(dayCount) {
        try {
            if (typeof RemoteSettings !== 'undefined' && RemoteSettings.followDayRange) {
                return RemoteSettings.followDayRange(dayCount || 1);
            }
        } catch (e) {}
        var day = Math.max(1, parseInt(dayCount, 10) || 1);
        var table = { 1: [15, 20], 2: [45, 50], 3: [90, 100], 4: [150, 160], 5: [200, 210], 6: [250, 260] };
        var slot = day >= 6 ? 6 : day;
        var r = table[slot];
        return { min: r[0], max: r[1], slot: slot };
    }

    function getManualDayOverride() {
        try {
            var s = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            return parseInt(s.dayOverride, 10) || 0;
        } catch(e) { return 0; }
    }

    function hasManualDayOverride() {
        return getManualDayOverride() > 0;
    }

    function incrementFollowCount() {
        const handle = getMyHandle();
        const key = `matrix_stats_${handle}`;
        let stats = getAccountStats();
        stats.follows_today++;
        localStorage.setItem(key, JSON.stringify(stats));
        return stats.follows_today;
    }

    function getDailyLimit(dayCount) {
        // 紧急本机覆盖（人工钉死）
        let customLimit = localStorage.getItem('matrix_custom_limit');
        if (customLimit && !isNaN(parseInt(customLimit))) {
            return parseInt(customLimit);
        }

        const handle = getMyHandle();
        const key = `matrix_stats_${handle}`;
        let stats = getAccountStats();
        var day = Math.max(0, parseInt(dayCount != null ? dayCount : stats.day_count, 10) || 0);
        // 尚未拿到 OPS Day：不要按 Day1(15) 锁死老号
        if (day < 1) {
            var pendingLock = parseInt(stats.daily_limit, 10);
            if (!isNaN(pendingLock) && pendingLock > 0 && sameShanghaiDay(stats.date, getBeijingDateString())) {
                return pendingLock;
            }
            return 80;
        }
        var locked = parseInt(stats.daily_limit, 10);
        if (!isNaN(locked) && locked > 0 && sameShanghaiDay(stats.date, getBeijingDateString())) {
            return locked;
        }

        var range = followDayRangeFor(day);
        var picked = randomInt(range.min, range.max);
        try {
            stats = JSON.parse(localStorage.getItem(key) || '{}') || stats;
            stats.daily_limit = picked;
            stats.date = getBeijingDateString();
            if (stats.follows_today == null) stats.follows_today = 0;
            if (stats.day_count == null || stats.day_count < 1) stats.day_count = day;
            localStorage.setItem(key, JSON.stringify(stats));
        } catch (eLock) {}
        return picked;
    }

    function isFrozenText(raw) {
        var t = String(raw || '');
        var low = t.toLowerCase();
        // 只认横幅完整句，避免整页正文里「冻结/Follow」零散命中误报
        if (t.indexOf('你的账号已被冻结') >= 0) return true;
        if (t.indexOf('你的账号已被停用') >= 0 || t.indexOf('账号已被停用') >= 0) return true;
        if (t.indexOf('帳號已被凍結') >= 0 || t.indexOf('帳號已被冻结') >= 0) return true;
        if (t.indexOf('帳號已被停用') >= 0) return true;
        // 首页永久冻结 interstitial（只读模式文案，勿单独认「只读」以免误伤私信）
        if (t.indexOf('永远处于只读模式') >= 0 && (t.indexOf('冻结') >= 0 || t.indexOf('凍結') >= 0 || t.indexOf('你的账号') >= 0 || t.indexOf('你的帳號') >= 0)) return true;
        if (t.indexOf('无法发帖、转帖或点赞') >= 0 && (t.indexOf('冻结') >= 0 || t.indexOf('凍結') >= 0)) return true;
        if (t.indexOf('無法發帖、轉帖或點讚') >= 0 && (t.indexOf('凍結') >= 0 || t.indexOf('停用') >= 0)) return true;
        // 同句：不能关注 + 冻结（节点文案通常很短，整页正文勿用此宽松规则）
        if (t.indexOf('不能关注用户') >= 0 && (t.indexOf('冻结') >= 0 || t.indexOf('凍結') >= 0 || t.indexOf('停用') >= 0)) return true;
        if (t.indexOf('不能關注用戶') >= 0 && (t.indexOf('冻结') >= 0 || t.indexOf('凍結') >= 0 || t.indexOf('停用') >= 0)) return true;
        if (t.indexOf('账号已被冻结') >= 0 && t.indexOf('不能关注') >= 0) return true;
        if (t.indexOf('不允许关注') >= 0 && (t.indexOf('停用') >= 0 || t.indexOf('冻结') >= 0 || t.indexOf('暫停') >= 0)) return true;
        if (low.indexOf('your account has been frozen') >= 0) return true;
        if (low.indexOf('account has been frozen') >= 0) return true;
        if (low.indexOf('account is frozen') >= 0 && low.indexOf('follow') >= 0) return true;
        // X 英文正式句：suspended（旧逻辑只认 frozen，会漏检）
        if (low.indexOf('your account is suspended') >= 0) return true;
        if (low.indexOf('your account has been suspended') >= 0) return true;
        if (low.indexOf('account is suspended') >= 0 && low.indexOf('not permitted to follow') >= 0) return true;
        if (low.indexOf('not permitted to follow') >= 0) return true;
        if (low.indexOf('is not permitted to follow users') >= 0) return true;
        // 日文：本号停用/冻结（toast 短句）
        if (t.indexOf('アカウントが凍結') >= 0 || t.indexOf('アカウントは凍結') >= 0) return true;
        if (t.indexOf('アカウントは停止') >= 0 || t.indexOf('アカウントが停止') >= 0) return true;
        if (t.indexOf('フォローできません') >= 0 && (t.indexOf('凍結') >= 0 || t.indexOf('停止') >= 0 || t.indexOf('制限') >= 0)) return true;
        return false;
    }

    /** 整页兜底：仅极精确句，禁止组合关键词（勿用裸 Account suspended，会误伤他人主页） */
    function isFrozenBodyExact(raw) {
        var t = String(raw || '');
        var low = t.toLowerCase();
        if (t.indexOf('你的账号已被冻结') >= 0) return true;
        if (t.indexOf('你的账号已被停用') >= 0) return true;
        if (t.indexOf('帳號已被凍結') >= 0) return true;
        // 永久只读冻结层：标题+只读确认同屏
        if (t.indexOf('永远处于只读模式') >= 0 && (t.indexOf('你的账号已被冻结') >= 0 || t.indexOf('账号已被冻结') >= 0 || t.indexOf('違反了 X 规则') >= 0 || t.indexOf('违反了 X 规则') >= 0)) return true;
        if (t.indexOf('永远处于只读模式') >= 0 && t.indexOf('无法发帖、转帖或点赞') >= 0) return true;
        if (t.indexOf('無法發帖、轉帖或點讚') >= 0 && t.indexOf('永遠處於唯讀模式') >= 0) return true;
        if (low.indexOf('your account has been frozen') >= 0) return true;
        if (low.indexOf('your account is suspended') >= 0) return true;
        if (low.indexOf('your account has been suspended') >= 0) return true;
        if (low.indexOf('is not permitted to follow users') >= 0) return true;
        if (low.indexOf('your account is suspended and is not permitted to follow') >= 0) return true;
        if (low.indexOf('read-only mode') >= 0 && low.indexOf('your account') >= 0 && (low.indexOf('frozen') >= 0 || low.indexOf('suspended') >= 0)) return true;
        return false;
    }

    /** 平台「暂时不能关注」蓝条：自动模式应走软风控填窗，勿当 HARD 熔断 */
    function isTempFollowCapText(raw) {
        var t = String(raw || '');
        var low = t.toLowerCase();
        if (t.indexOf('你暂时不能关注更多用户') >= 0) return true;
        if (t.indexOf('无法再关注') >= 0) return true;
        if (t.indexOf('不能再关注') >= 0) return true;
        if (t.indexOf('达到每天的关注上限') >= 0) return true;
        if (low.indexOf('unable to follow more') >= 0) return true;
        if (low.indexOf("can't follow more") >= 0 || low.indexOf('cannot follow more') >= 0) return true;
        if (low.indexOf('follow limit reached') >= 0) return true;
        return false;
    }

    function __queryTextChunks(selector) {
        var nodes = document.querySelectorAll(selector);
        var chunks = [];
        for (var i = 0; i < nodes.length; i++) {
            var raw = (nodes[i].innerText || nodes[i].textContent || '').trim();
            if (raw) chunks.push(raw);
        }
        return chunks;
    }

    function checkLimits() {
        // 冻结：toast/alert/banner + 首页 mask/emptyState interstitial；整页精确句兜底
        var frozenChunks = __queryTextChunks([
            '[data-testid="toast"]',
            '[data-testid*="toast"]',
            '[role="alertdialog"]',
            '[role="dialog"]',
            '[role="alert"]',
            '[role="status"]',
            '[data-testid="sheetDialog"]',
            '[data-testid="confirmationSheetDialog"]',
            '[data-testid="banner"]',
            '[data-testid="mask"]',
            'main [data-testid="emptyState"]',
            'main [data-testid="error-detail"]',
            '[data-testid="emptyState"]'
        ].join(', '));
        var bodyRaw = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        for (var i = 0; i < frozenChunks.length; i++) {
            if (isFrozenText(frozenChunks[i])) return 'FROZEN';
        }
        if (isFrozenBodyExact(bodyRaw)) return 'FROZEN';

        // 蓝条常在 status/banner/底部条，不在 dialog —— 精确句命中即 SOFT（填窗），禁止漏检空转
        for (var c = 0; c < frozenChunks.length; c++) {
            if (isTempFollowCapText(frozenChunks[c])) return 'SOFT';
        }
        if (isTempFollowCapText(bodyRaw)) return 'SOFT';

        // HARD / SOFT：dialog/toast；关注上限已上移为 SOFT，HARD 仅留更严重熔断句（若有）
        var riskChunks = __queryTextChunks([
            '[data-testid="toast"]',
            '[role="alertdialog"]',
            '[role="dialog"]',
            '[data-testid="sheetDialog"]',
            '[data-testid="confirmationSheetDialog"]'
        ].join(', '));

        for (var j = 0; j < riskChunks.length; j++) {
            var hardTxt = String(riskChunks[j] || '').toLowerCase();
            if (hardTxt.indexOf('action blocked') >= 0 || hardTxt.indexOf('操作被阻止') >= 0 ||
                hardTxt.indexOf('暂时被锁') >= 0 || hardTxt.indexOf('account locked') >= 0) {
                return 'HARD';
            }
        }

        for (var k = 0; k < riskChunks.length; k++) {
            var softTxt = String(riskChunks[k] || '').toLowerCase();
            if (softTxt.indexOf('速度限制') >= 0 || softTxt.indexOf('rate limit') >= 0 ||
                softTxt.indexOf('稍后再试') >= 0 || softTxt.indexOf('try again') >= 0 ||
                softTxt.indexOf('请稍等') >= 0 || softTxt.indexOf('抱歉') >= 0 ||
                softTxt.indexOf('too many') >= 0 || softTxt.indexOf('slow down') >= 0 ||
                softTxt.indexOf('しばらく') >= 0 ||
                softTxt.indexOf('please wait') >= 0 || softTxt.indexOf('retry later') >= 0) {
                return 'SOFT';
            }
        }

        var bodyText = String(bodyRaw || '').toLowerCase();
        if (bodyText.indexOf('你受到速度限制') >= 0 || bodyText.indexOf('rate limit exceeded') >= 0 ||
            bodyText.indexOf('you are being rate limited') >= 0) {
            return 'SOFT';
        }

        return 'NONE';
    }

    /** 关注时检测到账号冻结：停全模块 + Push 通知 */
    function handleAccountFrozen(source) {
        var handle = getMyHandle();
        var handleKnown = !!(handle && handle !== '未知账号');
        if (!handleKnown) handle = 'unknown';
        var today = '';
        try {
            today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        } catch (e) {
            today = String(new Date().getDate());
        }
        var dedupeKey = 'matrix_account_frozen_' + handle + '_' + today;
        var already = false;
        try { already = localStorage.getItem(dedupeKey) === '1'; } catch (e0) {}

        updateStats('账号已冻结，停止所有模块');
        (window.__matrix_notify__ || function (m) { console.log('[Toast]', m); })(
            '账号已被冻结，已停止所有模块并推送告警', 'error', 8000
        );

        try { stopBot(); } catch (e1) {}

        // 停调度 + 私信 + 养号
        try {
            var sg = {};
            try { sg = JSON.parse(localStorage.getItem('sg_state') || '{}') || {}; } catch (e2) { sg = {}; }
            sg.running = false;
            sg.engine = 'idle';
            sg.followPhase = 'idle';
            sg.accountFrozen = true;
            sg.accountFrozenAt = Date.now();
            localStorage.setItem('sg_state', JSON.stringify(sg));
        } catch (e3) {}
        try { sessionStorage.setItem('dan_auto_run', 'false'); } catch (e4) {}
        try { sessionStorage.removeItem('dan_auto_run'); } catch (e4b) {}
        try { sessionStorage.setItem('sg_nurture_running', 'false'); } catch (e5) {}
        try { sessionStorage.removeItem('sg_scheduler_booted'); } catch (e6) {}
        try {
            document.dispatchEvent(new CustomEvent('sg-account-frozen', {
                detail: { handle: handle, source: source || 'follow' }
            }));
        } catch (e7) {}
        try {
            chrome.runtime.sendMessage({ action: 'sg_scheduler_pause' }, function () {});
        } catch (e8) {}

        // 已成功上报过则不再打 OPS；失败不写去重，短间隔节流后可重试
        if (already) return 'frozen';
        if (!handleKnown) {
            console.warn('[Frozen] handle 未解析，跳过 OPS 上报（本地已停机，待下次重试）');
            return 'frozen';
        }
        var throttleKey = 'matrix_account_frozen_try_' + handle;
        try {
            var lastTry = parseInt(localStorage.getItem(throttleKey) || '0', 10) || 0;
            if (Date.now() - lastTry < 60000) return 'frozen';
            localStorage.setItem(throttleKey, String(Date.now()));
        } catch (eTh) {}

        try {
            chrome.runtime.sendMessage({
                action: 'ops_account_frozen',
                bot_id: getWorkerId(),
                reason: source || 'follow_toast'
            }, function (resp) {
                if (chrome.runtime.lastError) {
                    console.warn('[Frozen] report transport failed', chrome.runtime.lastError.message);
                    return;
                }
                if (resp && resp.ok) {
                    try { localStorage.setItem(dedupeKey, '1'); } catch (eOk) {}
                    console.log('[Frozen]', resp.message || 'ok', resp.push);
                } else {
                    console.warn('[Frozen] report rejected', resp);
                }
            });
        } catch (e10) {
            console.warn('[Frozen] report failed', e10);
        }
        return 'frozen';
    }

    /** 供调度心跳：扫页若冻结则停全模块并上报。返回 true=已冻结处理 */
    function checkAndHandleAccountFrozen(source) {
        try {
            if (checkLimits() === 'FROZEN') {
                handleAccountFrozen(source || 'heartbeat');
                return true;
            }
        } catch (eChk) {
            console.warn('[Frozen] checkAndHandle failed', eChk);
        }
        return false;
    }

    try {
        if (typeof window !== 'undefined') {
            window.__sgCheckAccountFrozen = checkAndHandleAccountFrozen;
            window.SgFollowRisk = {
                checkLimits: checkLimits,
                handleAccountFrozen: handleAccountFrozen,
                checkAndHandleFrozen: checkAndHandleAccountFrozen
            };
        }
    } catch (eExp) {}

    function getMatrixCooldownUntil() {
        return parseInt(localStorage.getItem('matrix_global_cooldown_until') || '0', 10) || 0;
    }

    function setMatrixCooldown(ms) {
        localStorage.setItem('matrix_global_cooldown_until', (Date.now() + ms).toString());
    }

    function getNextGlobalFollowTime() {
        return parseInt(localStorage.getItem('matrix_global_next_follow_time') || '0', 10) || 0;
    }

    function setNextGlobalFollowTime(ms) {
        localStorage.setItem('matrix_global_next_follow_time', (Date.now() + ms).toString());
    }

    async function waitForGlobalFollowSlot() {
        const nextTime = getNextGlobalFollowTime();
        const now = Date.now();
        if (now < nextTime) {
            const waitMs = nextTime - now;
            updateStats(`矩阵节奏控制，等待 ${Math.round(waitMs/1000)}s`);
            await sleep(waitMs);
        }
    }

    function getWorkerId() {
        let handle = getMyHandle();
        if (!handle || handle === "未知账号" || handle === "unknown") {
            try {
                handle = String(localStorage.getItem('matrix_my_handle') || '')
                    .replace(/^@/, '').replace(/#guard$/i, '').toLowerCase().trim();
            } catch (e) { handle = ''; }
        }
        if (!handle || handle === "未知账号" || handle === "unknown" || /^\d{4,5}$/.test(handle)) {
            return '';
        }
        return "@" + handle + "#guard";
    }

    // 物理 DOM 单例锁
    function normalizeOpsTargetHandle(raw) {
        const handle = normalizeHandleValue(raw);
        return handle ? `@${handle}` : '';
    }

    async function reportOpsFollowResult(accountHandle, targetHandle, result, meta = {}) {
        if (!targetHandle || typeof chrome === 'undefined' || !chrome.runtime) return;
        try {
            await chrome.runtime.sendMessage({
                action: 'ops_activity_report',
                payload: {
                    account_handle: accountHandle,
                    target_handle: targetHandle,
                    action_type: 'follow',
                    result,
                    source: 'plugin',
                    event_time: new Date().toISOString(),
                    meta
                }
            });
        } catch (e) {
            console.warn('[OPS] follow report failed:', e.message);
        }
    }

    function cleanupOldFollowUI() {
        const ids = [
            'matrix_follow_injected_lock',
            'matrix-follow-btn',
            'matrix-follow-settings-btn',
            'matrix-follow-panel'
        ];
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
        });
    }

    function injectFollowLock() {
        if (!document.body) {
            setTimeout(injectFollowLock, 100);
            return;
        }
        cleanupOldFollowUI();
        let injectLock = document.createElement('div');
        injectLock.id = 'matrix_follow_injected_lock';
        injectLock.style.display = 'none';
        document.body.appendChild(injectLock);
        window.__matrix_follow_injected__ = true;
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectFollowLock);
    } else {
        injectFollowLock();
    }

    // 心跳上报（每5秒，只在引擎运行时更新 lastActive）
    setInterval(() => {
        let workerId = getWorkerId();
        let stats = getAccountStats();
        let currentStatus = isRunning ? '推土扫荡中...' : '待机就绪';

        // 更新模块统一状态（引擎空闲时写 running:false，供调度幽灵旗标检测；运行中刷新 lastActive）
        try {
            var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
            ms.running = isRunning;
            if (isRunning) ms.lastActive = Date.now();
            ms.phase = isRunning ? 'active' : 'idle';
            sessionStorage.setItem('sg_module_follow', JSON.stringify(ms));
        } catch (e) {}

        // 发送状态到中控台
        document.dispatchEvent(new CustomEvent('matrix-follow-status', {
            detail: {
                running: isRunning,
                status: isRunning ? 'running' : 'idle',
                count: stats.follows_today
            }
        }));

        // 更新按钮状态
        updateFollowButtonState();
        
        try {
            chrome.runtime.sendMessage({
                action: "send_report",
                payload: {
                    worker_id: workerId,
                    engine: "follow",
                    status: isRunning ? "running" : "idle",
                    detail: "",
                    stats: {
                        added: stats.follows_today || 0
                    }
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('[心跳] Service Worker 未就绪');
                }
            });
        } catch(e) {}
    }, 5000);

    // 监听中控台事件
    document.addEventListener('matrix-follow-toggle', () => {
        toggleFollow();
    });

    // 监听中控台设置变更
    document.addEventListener('matrix-settings-changed', (e) => {
        const settings = e.detail;
    });

    console.log('[X扩展] auto-follow.js 已加载');

    let isRunning = false;
    let lastMsg = "初始化...";
    // 单飞锁：防止 tryAutoStart + sg-follow-command 同时拉起两个 while 循环
    let _engineLoopRunning = false;
    let _engineToken = 0;

    function followGo(url) {
        if (!url) return false;
        // 软风控 stopFollow 会留下 stopped_by_user；已授权关注时先治愈，否则 Gate 一律「未授权」
        // soft_fill：软窗内禁止治愈成 true（否则关注自恢复盖掉填窗旗）
        try {
            if (localStorage.getItem('matrix_follow_running') === 'true') {
                var tabGo = sessionStorage.getItem('matrix_tab_running');
                if (tabGo === 'stopped_by_user') {
                    sessionStorage.setItem('matrix_tab_running', 'true');
                } else if (tabGo === 'soft_fill') {
                    var inSoftGo = false;
                    try {
                        var sgGo = JSON.parse(localStorage.getItem('sg_state') || '{}');
                        inSoftGo = !!(sgGo.softRiskUntil && Date.now() < sgGo.softRiskUntil);
                    } catch (eSgG) {}
                    if (!inSoftGo) sessionStorage.setItem('matrix_tab_running', 'true');
                }
            }
        } catch (eHeal) {}
        if (typeof SchedulerGate !== 'undefined') {
            return SchedulerGate.go('follow', url);
        }
        try { window.location.href = url; return true; } catch (e) { return false; }
    }

    /** 漂移/换博主：绕过跳页节流，避免「锁已换、页未跳」静默卡死 */
    function followGoForce(url) {
        if (!url) return false;
        try {
            if (localStorage.getItem('matrix_follow_running') === 'true') {
                var tabF = sessionStorage.getItem('matrix_tab_running');
                if (tabF === 'stopped_by_user') {
                    sessionStorage.setItem('matrix_tab_running', 'true');
                } else if (tabF === 'soft_fill') {
                    var inSoftF = false;
                    try {
                        var sgF = JSON.parse(localStorage.getItem('sg_state') || '{}');
                        inSoftF = !!(sgF.softRiskUntil && Date.now() < sgF.softRiskUntil);
                    } catch (eSgF) {}
                    if (!inSoftF) sessionStorage.setItem('matrix_tab_running', 'true');
                }
            }
        } catch (eHealF) {}
        if (typeof SchedulerGate !== 'undefined' && SchedulerGate.go) {
            return SchedulerGate.go('follow', url, { force: true });
        }
        try { window.location.href = url; return true; } catch (e2) { return false; }
    }

    /** 跳到锁定博主期望页；同 URL 白壳不 Force（改软愈）；真错页 Force 最多再补 1 次且吃导航间隔 */
    function navigateToLockedCreator(reason) {
        var cr = normalizeCr(localStorage.getItem('matrix_current_creator') || '');
        if (!cr || RESERVED_PAGE_HANDLES[cr]) return false;
        var step = localStorage.getItem('matrix_step') || 'SCAN';
        var dest = 'https://x.com/' + cr + (step === 'PROFILE' ? '' : '/followers');
        if (isAtFollowTarget(dest)) {
            if (step !== 'PROFILE' && pageLooksFollowersShell()) {
                requestSharedSoftHeal('align_shell_' + (reason || ''));
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '🔄 已在目标 URL 但未灌水，禁 Force 对齐 (' + (reason || '') + ')' }
                }));
            }
            return true;
        }
        try {
            localStorage.setItem('matrix_follow_running', 'true');
            sessionStorage.setItem('matrix_tab_running', 'true');
        } catch (eAuth) {}
        markStepChange();
        var ok = followGoForce(dest);
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '🔄 对齐锁定博主 @' + cr + (ok ? ' 已跳转' : ' 跳转待重试') + (reason ? ' (' + reason + ')' : '') }
        }));
        if (!ok) {
            var gapMs = 13000;
            try {
                if (typeof SchedulerGate !== 'undefined' && SchedulerGate.navMinIntervalMs) {
                    gapMs = SchedulerGate.navMinIntervalMs() || 13000;
                }
            } catch (eGap) {}
            setTimeout(function () {
                if (isAtFollowTarget(dest)) return;
                try {
                    localStorage.setItem('matrix_follow_running', 'true');
                    sessionStorage.setItem('matrix_tab_running', 'true');
                } catch (e2) {}
                followGoForce(dest);
            }, gapMs);
        }
        return ok;
    }

    /** 延迟跳页：自动模式须仍授权，避免刷 Gate「follow 未授权」 */
    function followGoWhenAllowed(url) {
        try {
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode && SchedulerGate.isAutoMode()
                && SchedulerGate.canNavigate && !SchedulerGate.canNavigate('follow')) {
                return false;
            }
        } catch (eNav) {}
        return followGo(url);
    }

    function isAtFollowTarget(url) {
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

    // ================= 【页面漂移判定与纠错】
    // 统一入口：判断「当前页面」与「锁定任务期望页面」是否一致，
    // 不一致时按等级纠错（单次回跳 → 放弃旧锁交回调度）。
    var DRIFT_KEY = 'sg_follow_drift';            // sessionStorage 漂移计数（跨刷新累积）
    var DRIFT_LOG_KEY = 'sg_follow_drift_log';    // localStorage 最近纠错日志（面板/诊断用）
    var DRIFT_LIMIT = 3;                          // 同一任务连续漂移上限
    var DRIFT_RESET_MS = 60 * 1000;               // 超过此时间视为新任务，计数重置

    function readDrift() {
        try { return JSON.parse(sessionStorage.getItem(DRIFT_KEY) || '{}'); } catch (e) { return {}; }
    }
    function writeDrift(s) { try { sessionStorage.setItem(DRIFT_KEY, JSON.stringify(s)); } catch (e) {} }
    function clearDrift() { try { sessionStorage.removeItem(DRIFT_KEY); } catch (e) {} }

    function pushDriftLog(entry) {
        try {
            var arr = JSON.parse(localStorage.getItem(DRIFT_LOG_KEY) || '[]');
            entry.at = Date.now();
            arr.push(entry);
            if (arr.length > 20) arr = arr.slice(-20);
            localStorage.setItem(DRIFT_LOG_KEY, JSON.stringify(arr));
        } catch (e) {}
    }

    function normalizeCr(h) {
        return String(h || '').replace(/^@+/, '').replace(/#guard$/i, '').toLowerCase().trim();
    }

    var RESERVED_PAGE_HANDLES = {
        home: true, explore: true, notifications: true, messages: true,
        settings: true, compose: true, search: true, i: true,
        intent: true, share: true, login: true, signup: true, logout: true,
        bookmarks: true, lists: true, followers: true, following: true,
        verified_followers: true, followers_you_follow: true, status: true,
        account: true, admin: true, root: true, guest: true, unknown: true
    };

    function normalizeBloggerHandle(raw) {
        var h = normalizeCr(raw);
        return /^[a-z0-9_]{1,15}$/.test(h) && !RESERVED_PAGE_HANDLES[h] ? h : '';
    }

    function isFollowersUrl(url) {
        var u = String(url || '').toLowerCase();
        return /\/followers(?:[/?#]|$)/.test(u) || /\/verified_followers(?:[/?#]|$)/.test(u) || /\/followers_you_follow(?:[/?#]|$)/.test(u);
    }

    /** 页面归属：当前 URL 属于哪个页面形态 */
    function classifyPage() {
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
        if (RESERVED_PAGE_HANDLES[page.handle]) {
            page.kind = 'other';
            page.handle = '';
        }
        return page;
    }

    /** 按锁定博主与 step 计算引擎「应该在」的页面 */
    function expectedPageFor(cr, step) {
        var crl = normalizeCr(cr);
        if (!crl || RESERVED_PAGE_HANDLES[crl]) return null;
        if (step === 'PROFILE') return { kind: 'profile', handle: crl };
        return { kind: 'followers', handle: crl };
    }

    /** 其他模块是否持有标签页（禁止关注引擎抢页） */
    function otherModuleOwnsTab() {
        try {
            if (sessionStorage.getItem('dan_auto_run') === 'true' || localStorage.getItem('dan_chat_status') === 'running') return 'chat';
            if (sessionStorage.getItem('sg_nurture_running') === 'true') return 'nurture';
            if (sessionStorage.getItem('sg_repost_running') === 'true' || sessionStorage.getItem('sg_repost_auto_slot') === 'true') return 'repost';
        } catch (e) {}
        return '';
    }

    /** 页面是否已加载出 X 导航（用于避免 SPA 转场中误判漂移） */
    function pageLoadedEnough() {
        try {
            return !!(document.querySelector('main') && document.querySelector('a[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"]'));
        } catch (e) { return true; }
    }

    /** 标记步骤/目标切换时间：切页宽限期内不判漂移（防正常换博主被误判） */
    function markStepChange() {
        try { localStorage.setItem('matrix_step_changed_at', String(Date.now())); } catch (e) {}
    }
    function stepChangeGraceLeft() {
        try {
            var at = parseInt(localStorage.getItem('matrix_step_changed_at') || '0', 10) || 0;
            if (!at) return 0;
            return Math.max(0, 8000 - (Date.now() - at));
        } catch (e) { return 0; }
    }

    /** 回到账号自己的粉丝列表（调度基础页），引擎空闲时不把标签页留在博主主页 */
    function followHomeBase(reason) {
        try {
            var myH = normalizeCr(getMyHandle());
            pushDriftLog({ type: 'home_base', reason: reason || '', dest: (myH && myH !== '未知账号') ? '@' + myH + '/followers' : '/home' });
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '🏠 空闲归位' + (reason ? '（' + reason + '）' : '') + ' → ' + ((myH && myH !== '未知账号') ? '@' + myH + '/followers' : '/home') }
            }));
            try { updateStats('🏠 空闲归位，回到自己的粉丝列表...'); } catch (eStats) {}
            var dest = (myH && myH !== '未知账号') ? ('https://x.com/' + myH + '/followers') : 'https://x.com/home';
            setTimeout(function () {
                if (isRunning) return;
                // 自动模式未授权时禁止空跳（否则刷「follow 未授权」+ 幽灵旗标）
                try {
                    if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode && SchedulerGate.isAutoMode()
                        && SchedulerGate.canNavigate && !SchedulerGate.canNavigate('follow')) {
                        return;
                    }
                } catch (eNav) {}
                followGoWhenAllowed(dest);
            }, 800);
        } catch (e) {}
    }

    /**
     * 漂移纠错统一入口。
     * 返回 true = 已处理（回跳或放弃）；false = 无需处理（页面正常/不应插手）。
     * 判定优先级：无锁→不处理；他模块持页→不处理；页面匹配→不处理；加载中→等待；
     * SCAN 误进粉丝主页→优先 history.back（保滚动位置）；超限→放弃旧锁；否则整页回期望页。
     */
    function handlePageDrift(opts) {
        opts = opts || {};
        var cr = normalizeCr(localStorage.getItem('matrix_current_creator') || '');
        var step = localStorage.getItem('matrix_step') || 'SCAN';
        if (!cr) { clearDrift(); return false; }
        if (RESERVED_PAGE_HANDLES[cr]) { clearDrift(); return false; }

        var owner = otherModuleOwnsTab();
        if (owner) {
            pushDriftLog({ type: 'skip', reason: 'owner_' + owner, cr: cr });
            clearDrift();
            return false;
        }

        var page = classifyPage();
        var expected = expectedPageFor(cr, step);
        var match = !!(expected && expected.kind === page.kind && expected.handle === page.handle);
        if (match) { clearDrift(); return false; }

        // 切页宽限期：刚切换目标/步骤不久，页面正在加载，不判漂移
        var graceMs = stepChangeGraceLeft();
        if (graceMs > 0) {
            pushDriftLog({ type: 'wait_transition', cr: cr, grace_left_ms: graceMs });
            return false;
        }

        if (!pageLoadedEnough() && opts.allowWait) {
            pushDriftLog({ type: 'wait_loading', cr: cr, page: page.kind + ':' + page.handle });
            return false;
        }

        // SCAN 时期望在博主粉丝列表，却落到「别的用户主页」：多为点关注误进主页
        // 优先 history.back 一层，避免 followGo 整页重开列表（滚动回到顶部 = 用户说的「页面偏移」）
        var fanProfileDivert = !!(
            expected && expected.kind === 'followers' &&
            page.kind === 'profile' && page.handle && page.handle !== cr
        );
        if (fanProfileDivert) {
            var softKey = 'sg_follow_soft_back_at';
            var lastSoft = parseInt(sessionStorage.getItem(softKey) || '0', 10) || 0;
            var softRecently = (Date.now() - lastSoft) < 4000;
            try { __markFanProcessed(cr, page.handle); } catch (eMk) {}
            if (!softRecently) {
                sessionStorage.setItem(softKey, String(Date.now()));
                markStepChange();
                pushDriftLog({
                    type: 'soft_back',
                    cr: cr,
                    page: page.kind + ':' + page.handle,
                    to: expected.kind + ':' + expected.handle
                });
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '↩️ 误进粉丝主页 @' + page.handle + '，history.back 回列表（保位置）' }
                }));
                try { history.back(); } catch (eBack) {
                    followGo('https://x.com/' + cr + '/followers');
                    return 'hard';
                }
                // SPA back 不重载脚本：返回 soft，调用方继续跑引擎，禁止 isRunning=false 杀循环
                return 'soft';
            }
            // 短窗内 back 过仍停在错误主页 → 再走下面整页回跳
            pushDriftLog({ type: 'soft_back_fallback', cr: cr, page: page.kind + ':' + page.handle });
        }

        // 累计同一任务的漂移次数（跨刷新），超限则放弃旧任务
        var st = readDrift();
        var now = Date.now();
        var sameKey = cr + '|' + step + '|' + (expected ? expected.kind + ':' + expected.handle : '?');
        if (st.key !== sameKey || (now - (st.at || 0)) > DRIFT_RESET_MS) {
            st = { key: sameKey, count: 0, at: now };
        }
        st.count = (st.count || 0) + 1;
        st.at = now;
        st.cr = cr;
        st.step = step;
        st.page = page.kind + ':' + page.handle;
        st.expected = expected ? expected.kind + ':' + expected.handle : '?';
        writeDrift(st);

        if (st.count > DRIFT_LIMIT) {
            clearDrift();
            pushDriftLog({ type: 'abandon', cr: cr, count: st.count, page: page.kind + ':' + page.handle });
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '⚠️ @' + cr + ' 连续漂移 ' + st.count + ' 次，放弃旧任务，交回调度' }
            }));
            try {
                releasePoolTask('drift_abandon');
                localStorage.removeItem('matrix_current_task_id');
                localStorage.removeItem('matrix_current_task_assigned_at');
                localStorage.removeItem('matrix_current_creator');
                try { clearBloggerFollowCount(cr); } catch (eClrDr) {}
                localStorage.removeItem('matrix_step');
                localStorage.removeItem('matrix_follow_running');
                sessionStorage.setItem('sg_module_follow', JSON.stringify({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() }));
            } catch (eAb) {}
            followHomeBase('漂移超限 @' + cr);
            return 'hard';
        }

        // 单次回跳期望页（强制跳，避免节流导致锁已换页未动）
        pushDriftLog({ type: 'recover', cr: cr, count: st.count, page: page.kind + ':' + page.handle, to: expected ? expected.kind + ':' + expected.handle : '?' });
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '🔄 漂移纠错#' + st.count + ' page=' + page.kind + ':' + page.handle + ' step=' + step + ' → 期望 ' + (expected ? expected.kind + ':' + expected.handle : '?') }
        }));
        try { updateStats('🔄 漂移纠错：跳回 ' + (expected ? expected.kind + ':' + expected.handle : '') + ' 续点'); } catch (eStats2) {}
        localStorage.setItem('matrix_step', (expected && expected.kind === 'followers') ? 'SCAN' : 'PROFILE');
        navigateToLockedCreator('drift_recover#' + st.count);
        return 'hard';
    }

    if (typeof window !== 'undefined') {
        window.classifyPage = classifyPage;
        window.expectedPageFor = expectedPageFor;
        window.isAtFollowTarget = isAtFollowTarget;
        window.normalizeBloggerHandle = normalizeBloggerHandle;
        window.RESERVED_PAGE_HANDLES = RESERVED_PAGE_HANDLES;
        window.__sgFollowDebug__ = window.__sgFollowDebug__ || {};
        window.__sgFollowDebug__.classifyPage = classifyPage;
        window.__sgFollowDebug__.expectedPageFor = expectedPageFor;
        window.__sgFollowDebug__.isAtFollowTarget = isAtFollowTarget;
        window.__sgFollowDebug__.normalizeBloggerHandle = normalizeBloggerHandle;
        window.__sgFollowDebug__.RESERVED_PAGE_HANDLES = RESERVED_PAGE_HANDLES;
    }

    let myTabId = sessionStorage.getItem('matrix_tab_id');
    if (!myTabId) {
        myTabId = Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('matrix_tab_id', myTabId);
    }

    function isAnotherTabRunning() {
        let activeTab = localStorage.getItem('matrix_active_tab');
        let heartbeat = parseInt(localStorage.getItem('matrix_heartbeat') || '0');
        if (activeTab && activeTab !== myTabId && (Date.now() - heartbeat < 8000)) return true;
        return false;
    }

    function releaseLock() {
        localStorage.setItem('matrix_active_tab', '');
        localStorage.setItem('matrix_heartbeat', '0');
    }

    setInterval(() => {
        if (isRunning) {
            localStorage.setItem('matrix_active_tab', myTabId);
            localStorage.setItem('matrix_heartbeat', Date.now());
        }
    }, 2000);

    const __followSleepTimers = [];
    function cancelAllFollowSleep() { try { __followSleepTimers.forEach(t=>clearTimeout(t)); } catch(_){} __followSleepTimers.length=0; }
    const sleep = (ms) => new Promise((resolve)=>{
        if (!isRunning) return resolve();
        const id=setTimeout(()=>{ const idx=__followSleepTimers.indexOf(id); if(idx>=0) __followSleepTimers.splice(idx,1); resolve(); }, ms);
        __followSleepTimers.push(id);
    });
    const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    /**
     * 检测页面是否已滚动到底部
     * @param {number} threshold - 距离底部的阈值（像素）
     * @returns {boolean}
     */
    function isNearBottom(threshold = 200) {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollHeight = document.documentElement.scrollHeight;
        const clientHeight = document.documentElement.clientHeight;
        return (scrollTop + clientHeight) >= (scrollHeight - threshold);
    }

    // ==================== 批次管理器 ====================
    class BatchManager {
        constructor(batchSize = 50) {
            this.batchSize = batchSize;
            this.currentBatch = [];
            this.processedCount = 0;
            this.batchKey = 'matrix_follow_batch';
            this.processedKey = 'matrix_follow_processed';
        }

        // 从 sessionStorage 加载当前批次（只存 handle，不存 DOM 元素）
        loadBatch() {
            try {
                const saved = sessionStorage.getItem(this.batchKey);
                if (saved) {
                    const handles = JSON.parse(saved);
                    if (Array.isArray(handles) && handles.length > 0) {
                        this.currentBatch = handles.map(h => ({
                            handle: h,
                            element: null,
                            processed: false
                        }));
                        this.processedCount = parseInt(sessionStorage.getItem(this.processedKey) || '0');
                        return true;
                    }
                }
            } catch (e) {
                console.warn('[批次管理] 加载失败:', e);
            }
            return false;
        }

        // 保存当前批次到 sessionStorage（只存 handle 列表）
        saveBatch() {
            try {
                const handles = this.currentBatch.map(item => item.handle);
                sessionStorage.setItem(this.batchKey, JSON.stringify(handles));
                sessionStorage.setItem(this.processedKey, this.processedCount.toString());
            } catch (e) {
                console.warn('[批次管理] 保存失败:', e);
            }
        }

        // 从页面 DOM 中抓取下一批粉丝
        fetchNextBatch() {
            const cells = document.querySelectorAll('[data-testid="UserCell"]:not([data-matrix-processed="true"])');
            const batch = [];

            for (let i = 0; i < Math.min(this.batchSize, cells.length); i++) {
                const cell = cells[i];
                const handleEl = cell.querySelector('a[href^="/"]');
                if (handleEl) {
                    const href = handleEl.getAttribute('href') || '';
                    const handle = href.replace(/^\//, '');
                    if (handle) {
                        batch.push({
                            handle: handle,
                            element: cell,
                            processed: false
                        });
                    }
                }
            }

            this.currentBatch = batch;
            this.processedCount = 0;
            this.saveBatch();

            console.log(`[批次管理] 获取新批次: ${batch.length} 个粉丝`);
            return batch;
        }

        // 根据 handle 在当前页面中查找对应 DOM 元素
        findElement(handle) {
            const cells = document.querySelectorAll('[data-testid="UserCell"]');
            for (const cell of cells) {
                const link = cell.querySelector('a[href^="/"]');
                if (link) {
                    const href = link.getAttribute('href') || '';
                    if (href.replace(/^\//, '') === handle) return cell;
                }
            }
            return null;
        }

        // 获取下一个未处理的粉丝（跳过找不到 DOM 的条目）
        getNext() {
            while (this.processedCount < this.currentBatch.length) {
                const item = this.currentBatch[this.processedCount];
                this.processedCount++;
                this.saveBatch();

                // 重新解析 DOM 元素（页面滚动后新元素可能已加载）
                if (!item.element || !item.element.isConnected) {
                    item.element = this.findElement(item.handle);
                }

                if (item.element) {
                    return item;
                } else {
                    console.warn(`[批次管理] 找不到 @${item.handle} 的DOM元素，跳过`);
                }
            }
            return null;
        }

        // 标记当前批次所有元素为已处理，然后清空
        markBatchComplete() {
            this.currentBatch.forEach(item => {
                if (item.element && item.element.isConnected) {
                    item.element.setAttribute('data-matrix-processed', 'true');
                }
            });

            this.currentBatch = [];
            this.processedCount = 0;
            sessionStorage.removeItem(this.batchKey);
            sessionStorage.removeItem(this.processedKey);

            console.log('[批次管理] 批次完成，准备获取下一批');
        }

        // 清除批次数据（停止引擎或切换博主时调用）
        clearBatch() {
            this.currentBatch = [];
            this.processedCount = 0;
            sessionStorage.removeItem(this.batchKey);
            sessionStorage.removeItem(this.processedKey);
        }

        // 检查当前批次是否已全部处理完
        isBatchComplete() {
            return this.processedCount >= this.currentBatch.length;
        }

        // 获取当前批次进度
        getProgress() {
            return {
                total: this.currentBatch.length,
                processed: this.processedCount,
                remaining: this.currentBatch.length - this.processedCount
            };
        }
    }

    // 全局批次管理器实例（每批50个）
    const batchManager = new BatchManager(50);

    // ================= 【本地缓存操作】 =================
    function getTargetHandles() {
        try {
            const data = localStorage.getItem(CONFIG.localStorageKey);
            if (data) {
                const handles = JSON.parse(data);
                if (Array.isArray(handles) && handles.length > 0) return handles;
            }
        } catch (e) { console.error('读取本地缓存失败:', e); }
        return [];
    }

    function markHandleCompleted(handle) {
        try {
            let completed = JSON.parse(localStorage.getItem(CONFIG.completedKey) || '[]');
            if (!completed.includes(handle)) {
                completed.push(handle);
                localStorage.setItem(CONFIG.completedKey, JSON.stringify(completed));
            }
        } catch (e) { console.error('标记完成失败:', e); }
    }

    // ================= 【NAS 号池领号】 =================
    async function popFromPool() {
        if (window.SgPoolApi && window.SgPoolApi.popFromPool) return window.SgPoolApi.popFromPool();
        return { ok: false, reason: 'no_module' };
    }
    function isHandleInDeadList(handle) {
        return !!(window.SgPoolApi && window.SgPoolApi.isHandleInDeadList && window.SgPoolApi.isHandleInDeadList(handle));
    }
    // 按博主持久化已处理粉丝（DOM data-matrix-processed 跳转后会丢）
    var __PROCESSED_FANS_KEY = 'matrix_follow_processed_fans';
    function __loadProcessedFansMap() {
        return (window.SgPoolApi && window.SgPoolApi.__loadProcessedFansMap) ? window.SgPoolApi.__loadProcessedFansMap() : {};
    }
    function __getProcessedFanSet(blogger) {
        return (window.SgPoolApi && window.SgPoolApi.__getProcessedFanSet) ? window.SgPoolApi.__getProcessedFanSet(blogger) : new Set();
    }
    function __markFanProcessed(blogger, handle) {
        if (window.SgPoolApi && window.SgPoolApi.__markFanProcessed) window.SgPoolApi.__markFanProcessed(blogger, handle);
    }
    function __clearProcessedFans(blogger) {
        if (window.SgPoolApi && window.SgPoolApi.__clearProcessedFans) window.SgPoolApi.__clearProcessedFans(blogger);
    }
    var DEAD_SKIP_FILL_THRESHOLD = 3;

    /** 隐私/保护号文案（中英日韩）；短句「帖子受到保护」也要命中，否则漏判→粉丝页空跳 */
    function isProtectedProfileText(t) {
        var s = String(t || '');
        if (!s) return false;
        if (/这些帖子受到保护|帖子受到保护|這些貼文受到保護|這些帖子受到保護|貼文受到保護/.test(s)) return true;
        if (/These posts are protected|Posts are protected|Only approved followers|This account.?s posts are protected/i.test(s)) return true;
        if (/このアカウントは非公開|承認されたフォロワーだけ|ツイートは非公開/.test(s)) return true;
        if (/보호된 게시물|비공개 계정|승인된 팔로워/.test(s)) return true;
        if (/只有经过批准的关注者|只有獲批准的跟隨者|若要申请访问|才可查看.*的帖子|才可查看.*的貼文/.test(s)) return true;
        return false;
    }

    /** 本博主可点的粉丝列表链接（勿用全局 a[href*=followers]，会误命中侧栏/他处） */
    function findBloggerFollowersLink(handle) {
        var h = String(handle || '').replace(/^@/, '').toLowerCase().trim();
        if (!h) return null;
        var hrefs = [
            '/' + h + '/followers',
            '/' + h + '/verified_followers',
            '/' + h + '/followers_you_follow'
        ];
        var links = document.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var href = '';
            try { href = (a.getAttribute('href') || '').split('?')[0].toLowerCase(); } catch (eH) { continue; }
            if (!href) continue;
            for (var j = 0; j < hrefs.length; j++) {
                if (href === hrefs[j] || href.indexOf(hrefs[j] + '/') === 0) {
                    // 保护号常见：数字不可点（无 a）或 a 不可见
                    try {
                        if (a.offsetParent === null && a.getClientRects && !a.getClientRects().length) continue;
                    } catch (eVis) {}
                    return a;
                }
            }
        }
        return null;
    }

    function pageLooksProtected() {
        try {
            // 只扫主栏/空态文案；禁止 document 级锁标（粉丝列表里别人的锁会误杀当前公开博主）
            var t = '';
            var empty = document.querySelector('[data-testid="emptyState"], [data-testid="error-detail"], [data-testid="emptyStateHeader"]');
            if (empty) t += '\n' + (empty.textContent || '');
            var primary = document.querySelector('[data-testid="primaryColumn"]');
            if (primary) t += '\n' + (primary.textContent || '');
            else {
                var main = document.querySelector('main');
                if (main) t += '\n' + (main.textContent || '');
            }
            if (isProtectedProfileText(t)) return true;

            // 锁标仅认：空态内，或非粉丝列表时的主栏头像/用户名区
            if (empty && empty.querySelector('[data-testid="icon-lock"], [aria-label*="Protected"], [aria-label*="保护"], [aria-label*="非公開"]')) {
                return true;
            }
            var path = String(window.location.pathname || '').toLowerCase();
            var onFollowersList = /\/followers|\/verified_followers|\/followers_you_follow/.test(path);
            if (!onFollowersList && primary) {
                var headerLock = primary.querySelector(
                    '[data-testid="UserName"] [data-testid="icon-lock"],' +
                    '[data-testid="UserName"] [aria-label*="Protected"],' +
                    '[data-testid="UserName"] [aria-label*="保护"],' +
                    '[data-testid="UserName"] [aria-label*="非公開"],' +
                    '[data-testid="UserAvatar-Container"] [data-testid="icon-lock"]'
                );
                if (headerLock) return true;
            }
            return false;
        } catch (e) { return false; }
    }

    /** 当前锁博主主页/粉丝页若已是保护号 → 死号上报并换号 */
    async function skipProtectedBloggerIfNeeded(reason) {
        try {
            var cr = localStorage.getItem('matrix_current_creator') || '';
            if (!cr) return false;
            if (!pageLooksProtected()) return false;
            updateStats('🔒 @' + cr + ' 保护号不可进粉（' + (reason || 'protected') + '），上报死号');
            try {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '🔒 保护号→dead @' + cr + ' via=' + (reason || '') }
                }));
            } catch (eD) {}
            markHandleCompleted(cr);
            await markPoolTaskDead();
            await sleep(1200);
            await jumpToNextBloggerAfterDeadSkip();
            return true;
        } catch (e) { return false; }
    }

    /** X 粉丝列表加载失败页：「出错了。请尝试重新加载。」— 多为限流/慢网，勿立刻 dead */
    function pageLooksFollowersBroken() {
        try {
            var main = document.querySelector('main') || document.body;
            if (!main) return false;
            var t = String(main.textContent || '');
            if (/出错了/.test(t) && (/重新加载|重试/.test(t))) return true;
            if (/Something went wrong/i.test(t) && (/Try again|Reload/i.test(t))) return true;
            if (/Try reloading/i.test(t)) return true;
            // 有重试按钮 + 错误文案
            var retryBtn = main.querySelector('[role="button"]');
            if (retryBtn && /重试|Retry|Reload/i.test(retryBtn.textContent || '') && /出错|wrong|error/i.test(t)) {
                return true;
            }
            return false;
        } catch (e) { return false; }
    }

    /** 慢网等待本博粉丝入口；明确保护号提前返回 */
    async function waitForBloggerFollowersLink(handle, maxMs) {
        var budget = (typeof maxMs === 'number' && maxMs > 0) ? maxMs : 12000;
        var deadline = Date.now() + budget;
        while (Date.now() < deadline) {
            if (pageLooksProtected()) return { link: null, protected: true };
            var hit = findBloggerFollowersLink(handle);
            if (hit) return { link: hit, protected: false };
            await sleep(2000);
        }
        return {
            link: findBloggerFollowersLink(handle),
            protected: pageLooksProtected()
        };
    }

    /** 进粉失败但非真保护：释放任务，勿 pool_dead（慢网/半加载误杀） */
    async function skipBloggerSoftFail(reason) {
        var cr = localStorage.getItem('matrix_current_creator') || '';
        updateStats('⏳ @' + cr + ' 进粉未就绪，释放换号（不标死号） ' + (reason || ''));
        try {
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '⏳ 进粉软失败→fail @' + cr + ' via=' + (reason || '') }
            }));
        } catch (eD) {}
        try { await releasePoolTask(reason || 'followers_entry_soft'); } catch (eRel) {}
        localStorage.removeItem('matrix_current_task_id');
        localStorage.removeItem('matrix_current_task_assigned_at');
        if (cr) {
            try { clearBloggerFollowCount(cr); } catch (eClr) {}
        }
        await sleep(1500);
        await jumpToNextBlogger();
    }

    /** 真·空粉列表（有空态文案、无 UserCell）——可 done，勿当白壳永卡 */
    function pageLooksFollowersEmptyList() {
        try {
            if (document.querySelector('[data-testid="UserCell"]')) return false;
            var chunks = [];
            var empty = document.querySelector('[data-testid="emptyState"], [data-testid="emptyStateHeader"], [data-testid="error-detail"]');
            if (empty) chunks.push(empty.textContent || '');
            var primary = document.querySelector('[data-testid="primaryColumn"]');
            if (primary) chunks.push(primary.textContent || '');
            var t = chunks.join('\n');
            if (!t) return false;
            if (/还没有任何关注者|还没有关注者|还没有任何粉丝|Doesn'?t have any followers|Does not have any followers|No followers yet|isn'?t followed by anyone|フォロワーはいません|フォロワーがいません|フォロワーはまだいません/i.test(t)) {
                return true;
            }
            return false;
        } catch (eE) { return false; }
    }

    /** 粉丝列表已灌水：有 UserCell，或明确空列表文案 */
    function pageLooksFollowersHydrated() {
        try {
            if (document.querySelector('[data-testid="UserCell"]')) return true;
            if (pageLooksFollowersEmptyList()) return true;
            return false;
        } catch (eH) { return false; }
    }

    /** 白壳/未灌水：已在粉丝 URL 但无列表也无空态（大白 X 常见） */
    function pageLooksFollowersShell() {
        try {
            var path = String(window.location.pathname || '').toLowerCase();
            if (!/\/followers|\/verified_followers|\/followers_you_follow/.test(path)) return false;
            if (pageLooksFollowersBroken()) return false;
            if (pageLooksFollowersHydrated()) return false;
            return true;
        } catch (eS) { return false; }
    }

    function isInSoftRiskFillWindow() {
        try {
            var sg = JSON.parse(localStorage.getItem('sg_state') || '{}');
            return !!(sg.softRiskUntil && Date.now() < sg.softRiskUntil);
        } catch (eSr) { return false; }
    }

    /** 点页内重试；失败则共用冷却 soft_reload（三引擎同 key，防连环握手） */
    function requestSharedSoftHeal(reason) {
        var CD = 60000;
        try {
            var last = parseInt(sessionStorage.getItem('sg_shared_soft_heal_at') || '0', 10) || 0;
            if (last > 0 && Date.now() - last < CD) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⏳ 共用软愈冷却中 remain=' + Math.ceil((CD - (Date.now() - last)) / 1000) + 's (' + (reason || '') + ')' }
                }));
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
                        try { sessionStorage.setItem('sg_shared_soft_heal_at', String(Date.now())); } catch (eSet1) {}
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                            detail: { text: '🔄 未灌水·点重试 (' + (reason || '') + ')' }
                        }));
                        return true;
                    }
                }
            }
        } catch (eBtn) {}
        try { sessionStorage.setItem('sg_shared_soft_heal_at', String(Date.now())); } catch (eSet2) {}
        try {
            var pausedTill = 0;
            try { pausedTill = parseInt(sessionStorage.getItem('sg_paused_till') || '0', 10) || 0; } catch (eP) {}
            chrome.runtime.sendMessage({
                action: 'sg_request_heal',
                reason: reason || 'followers_shell',
                mode: 'soft_reload',
                pausedTill: pausedTill,
                challenge: false
            }, function () {});
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '🩹 未灌水·soft_reload (' + (reason || '') + ')' }
            }));
        } catch (eHeal) {}
        return true;
    }

    /** 白壳处理：软窗只愈；窗外累计后 pool_fail 短歇，禁止假 done */
    async function handleFollowersShellStall(via) {
        requestSharedSoftHeal(via || 'followers_shell');
        updateStats('粉丝页未灌水，等愈/重试（不换号）');
        if (isInSoftRiskFillWindow()) {
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '❄ 软窗内 shell·只愈不释放 via=' + (via || '') }
            }));
            await sleep(4000);
            return { stalled: true, released: false };
        }
        var shellN = 0;
        try {
            shellN = (parseInt(sessionStorage.getItem('sg_follow_shell_wait_n') || '0', 10) || 0) + 1;
            sessionStorage.setItem('sg_follow_shell_wait_n', String(shellN));
        } catch (eN) { shellN = 1; }
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '⏳ shell 等待×' + shellN + ' via=' + (via || '') + '（禁假触底换号）' }
        }));
        if (shellN >= 6) {
            try { sessionStorage.removeItem('sg_follow_shell_wait_n'); } catch (eClr) {}
            updateStats('粉丝页白壳超时，释放任务短歇（不标完成）');
            try { await releasePoolTask('followers_shell_timeout'); } catch (eRel) {}
            handOffFollowRoundNoSoft('followers_shell_timeout');
            return { stalled: true, released: true };
        }
        await sleep(5000);
        return { stalled: true, released: false };
    }

    /** 「出错了」页：慢网常见；软愈重试，满次 pool_fail 短歇，禁止立刻 dead */
    async function handleFollowersBrokenStall(via) {
        requestSharedSoftHeal(via || 'followers_broken');
        updateStats('粉丝页加载失败，重试中（不标死号）');
        var brokenN = 0;
        try {
            brokenN = (parseInt(sessionStorage.getItem('sg_follow_broken_wait_n') || '0', 10) || 0) + 1;
            sessionStorage.setItem('sg_follow_broken_wait_n', String(brokenN));
        } catch (eN) { brokenN = 1; }
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '🔄 broken 等待×' + brokenN + ' via=' + (via || '') + '（禁立刻 dead）' }
        }));
        if (brokenN >= 5) {
            try { sessionStorage.removeItem('sg_follow_broken_wait_n'); } catch (eClr) {}
            updateStats('粉丝页多次加载失败，释放任务短歇（不标死号）');
            try { await releasePoolTask('followers_broken_timeout'); } catch (eRel) {}
            handOffFollowRoundNoSoft('followers_broken_timeout');
            return { stalled: true, released: true };
        }
        await sleep(6000);
        return { stalled: true, released: false };
    }

    function dispatchFollowRoundEnd(reason) {
        try {
            window.dispatchEvent(new CustomEvent('sg-follow-round-end', { detail: { reason: reason || 'round_end' } }));
        } catch (eD) {}
    }

    /** 软风控唯一入口：平台下方风控条（soft_*），约点满十余粉后出现 */
    function isPlatformSoftReason(reason) {
        var r = String(reason || '');
        return r.indexOf('soft_') === 0;
    }

    /**
     * 非平台风控的轮次交回：停关注、短歇，绝不进 softRiskUntil 填窗。
     */
    function handOffFollowRoundNoSoft(reason) {
        reason = String(reason || 'round_end');
        dispatchFollowRoundEnd(reason);
        try {
            var sg = JSON.parse(localStorage.getItem('sg_state') || '{}');
            // 一律清软窗残留（含 softRiskPhase），避免相位挡关注、假软风控
            sg.softRiskUntil = 0;
            sg.softRiskMode = '';
            sg.softFillMode = '';
            sg.softRiskChatDone = false;
            sg.softRiskOutboundDone = false;
            sg.softRiskIceExtendMs = 0;
            sg.softRiskOvertimeMs = 0;
            sg.softRiskPhase = '';
            sg.softRiskChatPass = 0;
            sg.softRiskStartedAt = 0;
            try {
                sessionStorage.removeItem('sg_soft_risk_pulse_ran');
                sessionStorage.removeItem('sg_soft_risk_pulse_retry');
                sessionStorage.removeItem('sg_soft_risk_pulse_reason');
                sessionStorage.removeItem('sg_soft_unread_retry');
            } catch (ePulse) {}
            sg.followNextDelayUntil = Date.now() + 12 * 1000;
            sg.followRoundEndedAt = Date.now();
            localStorage.setItem('sg_state', JSON.stringify(sg));
            localStorage.removeItem('matrix_follow_running');
            sessionStorage.setItem('sg_module_follow', JSON.stringify({
                running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now()
            }));
            try { sessionStorage.removeItem('matrix_tab_running'); } catch (eTab) {}
        } catch (eSg) {}
        updateStats('关注轮交回调度（非平台风控）: ' + reason);
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '↩️ 关注交回 | ' + reason + ' | 不进软风控' }
        }));
        try {
            if (typeof Logger !== 'undefined' && Logger.info) Logger.info('关注', '交回调度无软风控 reason=' + reason);
        } catch (eL) {}
        try {
            if (typeof isRunning !== 'undefined' && isRunning) stopBot({ keepTask: false });
        } catch (eStop) {}
    }

    function notifyFollowRoundEndAndFill(reason) {
        reason = String(reason || '');
        if (isPlatformSoftReason(reason)) {
            dispatchFollowRoundEnd(reason);
            enterSoftRiskDiversion(reason);
            return;
        }
        handOffFollowRoundNoSoft(reason);
    }

    function tryDeadSkipFillWindow(source) {
        // 死号跳过不是平台风控：只计数，满阈值也不进软风控
        if (!isSchedulerAutoMode()) return false;
        var n = parseInt(sessionStorage.getItem('sg_follow_dead_skip_count') || '0', 10) + 1;
        sessionStorage.setItem('sg_follow_dead_skip_count', String(n));
        if (n >= DEAD_SKIP_FILL_THRESHOLD) {
            sessionStorage.setItem('sg_follow_dead_skip_count', '0');
            updateStats('死号跳过 ' + DEAD_SKIP_FILL_THRESHOLD + ' 次 → 换号续跑（不进软风控）');
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '💀 死号跳过×' + DEAD_SKIP_FILL_THRESHOLD + ' → 换号 (' + (source || '') + ') 不进软风控' }
            }));
        }
        return false;
    }

    async function jumpToNextBloggerAfterDeadSkip() {
        if (tryDeadSkipFillWindow('profile_dead')) return;
        await jumpToNextBlogger();
    }

    async function jumpToNextBlogger() {
        // 调用方应先 pool_done/dead；若仍残留任务，尝试 completed（避免 fail 回流半成品）
        // 必须 done ACK 成功后才领下一号，否则保留锁
        const oldTaskId = localStorage.getItem('matrix_current_task_id');
        const oldCreator = localStorage.getItem('matrix_current_creator') || '';
        if (oldTaskId) {
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '⚠️ 切换前残留任务 #' + oldTaskId + ' @' + oldCreator + '，尝试标记完成（避免回流）' }
            }));
            let doneRes = { ok: false };
            try { doneRes = await markPoolTaskDone(); } catch (e) { doneRes = { ok: false }; }
            if (!doneRes || !doneRes.ok) {
                updateStats('⚠️ 残留任务 done 失败，中止换号');
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⚠️ jumpToNextBlogger 中止：pool_done 未确认 #' + oldTaskId }
                }));
                return;
            }
        }
        if (oldCreator) __clearProcessedFans(oldCreator);
        updateStats('领取中...');

        // 带死号过滤的领号循环（最多10次跳过死号）
        let result;
        for (let __deadRetry = 0; __deadRetry < 10; __deadRetry++) {
            result = await popFromPool();
            if (!result || result.ok === false) {
                // 网络/插件通道失败，不是号池真空
                updateStats('领号失败，稍后重试');
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⚠️ 领号失败: ' + ((result && (result.error || result.reason)) || 'no response') }
                }));
                localStorage.removeItem('matrix_follow_running');
                isRunning = false;
                __nurtureState.running = false;
                stopDiagnostic();
                try {
                    var sgNet = JSON.parse(localStorage.getItem('sg_state') || '{}');
                    sgNet.followNextDelayUntil = Date.now() + 60 * 1000;
                    localStorage.setItem('sg_state', JSON.stringify(sgNet));
                    var msNet = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
                    msNet.running = false;
                    msNet.lastActive = Date.now();
                    sessionStorage.setItem('sg_module_follow', JSON.stringify(msNet));
                } catch (eNet) {}
                document.dispatchEvent(new CustomEvent('matrix-follow-status', {
                    detail: { running: false, status: 'error', message: '领号失败（网络），60s 后重试' }
                }));
                followHomeBase('领号失败（网络）');
                return;
            }
            if (!result.handle) {
                // 真·暂无 pending（轮换池里 completed 要满天数才回 pending；assigned 占着也不算 pending）
                break;
            }
            const handle = normalizeBloggerHandle(result.handle);
            if (!handle) {
                if (result.id) {
                    try { await new Promise(function (resolve) {
                        chrome.runtime.sendMessage({ action: 'pool_fail', id: result.id }, function () { resolve(); });
                    }); } catch (eBadHandle) {}
                }
                continue;
            }
            if (isHandleInDeadList(handle)) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '💀 跳过死号 @' + handle + ' (id:' + result.id + ')' }
                }));
                try {
                    await new Promise((resolve) => {
                        chrome.runtime.sendMessage({ action: 'pool_fail', id: result.id }, (r) => { resolve(r); });
                    });
                } catch (e) {}
                if (tryDeadSkipFillWindow('pool_pop_dead')) return;
                continue;
            }
            break;
        }

        if (!result || !result.handle) {
            localStorage.removeItem('matrix_follow_running');
            localStorage.removeItem('matrix_current_task_id');
            localStorage.removeItem('matrix_current_task_assigned_at');
            localStorage.removeItem('matrix_current_creator');
            isRunning = false;
            __nurtureState.running = false;
            stopDiagnostic();
            var retryDelaySec = 300;
            try {
                var cfgIntv = JSON.parse(localStorage.getItem('sg_config_intervals') || '{}');
                if (cfgIntv.followRetryDelaySec) retryDelaySec = cfgIntv.followRetryDelaySec;
            } catch (eCfg) {}
            updateStats('暂无待领取博主，' + retryDelaySec + 's 后重试');
            try {
                var sgSt = JSON.parse(localStorage.getItem('sg_state') || '{}');
                sgSt.followNextDelayUntil = Date.now() + retryDelaySec * 1000;
                localStorage.setItem('sg_state', JSON.stringify(sgSt));
                var msPf = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
                msPf.running = false;
                msPf.lastActive = Date.now();
                sessionStorage.setItem('sg_module_follow', JSON.stringify(msPf));
            } catch (e) {}
            document.dispatchEvent(new CustomEvent('matrix-follow-status', {
                detail: { running: false, status: 'completed', message: '暂无 pending，稍后重试（非号池报废）' }
            }));
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '⏳ 号池暂无 pending（可能均在 assigned/completed 轮换中），' + retryDelaySec + 's 后重试' }
            }));
            followHomeBase('暂无待领取博主');
            return;
        }
        const handle = normalizeBloggerHandle(result.handle);
        if (!handle) {
            if (result.id) {
                try { await new Promise(function (resolve) {
                    chrome.runtime.sendMessage({ action: 'pool_fail', id: result.id }, function () { resolve(); });
                }); } catch (eBadHandle) {}
            }
            updateStats('号池返回无效博主，已释放任务');
            localStorage.removeItem('matrix_follow_running');
            isRunning = false;
            try {
                var msInvalid = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
                msInvalid.running = false;
                msInvalid.phase = 'idle';
                msInvalid.lastActive = Date.now();
                sessionStorage.setItem('sg_module_follow', JSON.stringify(msInvalid));
            } catch (eInvalidState) {}
            followHomeBase('号池返回无效博主');
            return;
        }
        localStorage.setItem('matrix_current_creator', handle);
        localStorage.setItem('matrix_current_task_id', String(result.id));
        localStorage.setItem('matrix_current_task_assigned_at', String(Date.now()));
        try { clearBloggerFollowCount(handle); } catch (eClr) {}
        localStorage.setItem('matrix_step', 'SCAN');
        localStorage.setItem('matrix_follow_running', 'true');
        markStepChange();
        updateStats('领取到 @' + handle + ' ，进入粉丝列表...');
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '领取到 @' + handle + ' (id:' + result.id + ')' } }));
        // 强制跳：否则节流失败会留下「锁=新博主、页=旧列表」
        if (!followGoForce('https://x.com/' + handle + '/followers')) {
            navigateToLockedCreator('pool_pop_nav');
        }
    }

    // ================= 【UI 创建】 =================
    // ================= 【新UI系统】 =================
    let followBtn, followSettingsBtn, followPanel, followStatusDot;

    function createFollowUI() {
        // v3：功能已合并到 #sg-panel，停用右下角悬浮球与设置面板
        return;

        if (!document.body) {
            setTimeout(createFollowUI, 100);
            return;
        }

        // 注入样式
        const style = document.createElement('style');
        style.innerHTML = `
            /* Follow 按钮 - 蓝色渐变 */
            #matrix-follow-btn {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 44px;
                height: 44px;
                border-radius: 50%;
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                background: linear-gradient(135deg, #1d9bf0, #0d8ecf);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                transition: all 0.2s ease;
                z-index: 2147483640;
            }
            #matrix-follow-btn:hover {
                transform: scale(1.1);
                box-shadow: 0 4px 20px rgba(29, 155, 240, 0.4);
            }
            #matrix-follow-btn:active {
                transform: scale(0.95);
            }
            #matrix-follow-btn svg {
                width: 22px;
                height: 22px;
                color: white;
            }
            #matrix-follow-btn .status-dot {
                position: absolute;
                top: -2px;
                right: -2px;
                width: 12px;
                height: 12px;
                background: #71767b;
                border-radius: 50%;
                border: 2px solid #15202b;
            }
            #matrix-follow-btn .status-dot.active {
                background: #00ba7c;
            }
            @keyframes follow-pulse {
                0% { box-shadow: 0 0 0 0 rgba(29, 155, 240, 0.4); }
                70% { box-shadow: 0 0 0 12px rgba(29, 155, 240, 0); }
                100% { box-shadow: 0 0 0 0 rgba(29, 155, 240, 0); }
            }
            #matrix-follow-btn.running {
                animation: follow-pulse 1.5s infinite;
            }
            #matrix-follow-btn.cooling {
                animation: follow-pulse-yellow 2s infinite;
                background: linear-gradient(135deg, #ffd700, #ffaa00) !important;
            }
            #matrix-follow-btn.hard-cooling {
                background: linear-gradient(135deg, #f4212e, #cc0000) !important;
                box-shadow: 0 2px 8px rgba(244,33,46,0.4) !important;
            }
            @keyframes follow-pulse-yellow {
                0% { box-shadow: 0 0 0 0 rgba(255,215,0,0.4); }
                70% { box-shadow: 0 0 0 12px rgba(255,215,0,0); }
                100% { box-shadow: 0 0 0 0 rgba(255,215,0,0); }
            }
            
            /* Follow 设置按钮 */
            #matrix-follow-settings-btn {
                position: fixed;
                bottom: 72px;
                right: 29px;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                background: linear-gradient(135deg, #444, #555);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
                transition: all 0.3s ease;
                z-index: 2147483640;
            }
            #matrix-follow-settings-btn:hover {
                background: linear-gradient(135deg, #555, #666);
            }
            #matrix-follow-settings-btn svg {
                width: 16px;
                height: 16px;
                color: white;
                transition: transform 0.3s ease;
            }
            #matrix-follow-settings-btn:hover svg {
                transform: rotate(90deg);
            }
            
            /* Follow 设置面板 */
            #matrix-follow-panel {
                position: fixed;
                bottom: 114px;
                right: 20px;
                width: 260px;
                background: #1c2732;
                border: 1px solid #38444d;
                border-radius: 12px;
                padding: 16px;
                z-index: 2147483639;
                max-height: 400px;
                overflow-y: auto;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #e7e9ea;
                font-size: 13px;
                opacity: 0;
                visibility: hidden;
                transform: translateY(10px);
                transition: all 0.3s ease;
            }
            #matrix-follow-panel.active {
                opacity: 1;
                visibility: visible;
                transform: translateY(0);
            }
            #matrix-follow-panel .panel-title {
                font-size: 16px;
                font-weight: 600;
                color: #e7e9ea;
                margin-bottom: 12px;
                padding-bottom: 8px;
                border-bottom: 1px solid #38444d;
                line-height: 1.4;
                min-height: 24px;
                display: flex;
                align-items: center;
                gap: 8px;
                white-space: nowrap;
            }
            #matrix-follow-panel .section-label {
                font-size: 12px;
                color: #71767b;
                margin-bottom: 6px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            #matrix-follow-panel .blogger-list {
                max-height: 108px;
                overflow-y: auto;
                margin-bottom: 12px;
            }
            #matrix-follow-panel .current-blogger-card {
                background: #253341;
                border-radius: 8px;
                padding: 10px 12px;
                margin-bottom: 6px;
            }
            #matrix-follow-panel .current-blogger-main {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            #matrix-follow-panel .current-blogger-title {
                font-size: 10px;
                color: #71767b;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            #matrix-follow-panel .current-blogger-handle {
                font-size: 14px;
                font-weight: 700;
                color: #1d9bf0;
            }
            #matrix-follow-panel .current-blogger-meta {
                font-size: 11px;
                color: #536471;
            }
            #matrix-follow-panel .empty-msg {
                text-align: center;
                color: #71767b;
                font-size: 12px;
                padding: 16px 0;
            }

            /* 风控状态区域 */
            #matrix-follow-panel .risk-status {
                margin-bottom: 12px;
                padding: 10px 12px;
                border-radius: 8px;
                background: #253341;
                border-left: 3px solid #71767b;
                font-size: 12px;
                line-height: 1.6;
            }
            #matrix-follow-panel .risk-status.status-ok {
                border-left-color: #00ba7c;
            }
            #matrix-follow-panel .risk-status.status-cooling {
                border-left-color: #ffd700;
                background: #2d3320;
            }
            #matrix-follow-panel .risk-status.status-hard {
                border-left-color: #f4212e;
                background: #331a1a;
            }
            #matrix-follow-panel .risk-status .risk-header {
                font-weight: 600;
                margin-bottom: 6px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #matrix-follow-panel .risk-status .risk-row {
                display: flex;
                justify-content: space-between;
                padding: 2px 0;
            }
            #matrix-follow-panel .risk-status .risk-label {
                color: #71767b;
            }
            #matrix-follow-panel .risk-status .risk-value {
                font-weight: 500;
            }
            #matrix-follow-panel .risk-status .cooldown-timer {
                font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
                font-size: 14px;
                font-weight: 700;
                letter-spacing: 0.5px;
            }
        
`;
        document.head.appendChild(style);

        // Follow 按钮
        followBtn = document.createElement('button');
        followBtn.id = 'matrix-follow-btn';
        followBtn.innerHTML = `
            <span class="status-dot" id="matrix-follow-status-dot"></span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="8.5" cy="7" r="4"/>
                <line x1="20" y1="8" x2="20" y2="14"/>
                <line x1="23" y1="11" x2="17" y2="11"/>
            </svg>
        `;
        followBtn.addEventListener('click', toggleFollow);
        document.body.appendChild(followBtn);

        // Follow 设置按钮
        followSettingsBtn = document.createElement('button');
        followSettingsBtn.id = 'matrix-follow-settings-btn';
        followSettingsBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
        `;
        followSettingsBtn.addEventListener('click', toggleFollowPanel);
        document.body.appendChild(followSettingsBtn);

        // Follow 设置面板
        followPanel = document.createElement('div');
        followPanel.id = 'matrix-follow-panel';
        document.body.appendChild(followPanel);

        // 点击其他地方关闭面板
        document.addEventListener('click', (e) => {
            if (!followPanel.contains(e.target) && 
                e.target.id !== 'matrix-follow-settings-btn' && 
                !e.target.closest('#matrix-follow-settings-btn')) {
                followPanel.classList.remove('active');
                stopPanelRefresh();
            }
        });

        // 阻止面板内部点击冒泡
        followPanel.addEventListener('click', (e) => e.stopPropagation());

        // 更新按钮状态
        updateFollowButtonState();
    }

    function toggleFollow() {
        const __nurtureActive = isNurtureLockEnabled();
        if (__nurtureActive && !isRunning) {
            const _n = window.__matrix_notify__ || ((m) => console.log('[Toast]', m));
            _n('🟢 纯养号模式启动', 'success', 2000);
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            const dur = __nr_rand(15, 17);
            localStorage.setItem('matrix_pure_nurture_mode', 'true');
            isRunning = true;
            sessionStorage.setItem('matrix_tab_running', 'true');
            localStorage.setItem('matrix_follow_running', 'true');
            updateFollowButtonState();
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '🟢 纯养号模式：Day 0 不关注，仅定时养号' } }));
            navigateToHomeForWarmup('pure_nurture_day0', dur);
            return;
        }
        if (__nurtureActive && isRunning) {
            // 已在运行中，点击停止
            sessionStorage.setItem('matrix_tab_running', 'stopped_by_user');
            stopBot();
            updateFollowButtonState();
            return;
        }
        const _n = window.__matrix_notify__ || ((m) => console.log('[Toast]', m));
        if (window.__MATRIX_DISABLED__) {
            _n('⚠️ 授权无效，请先激活授权', 'warning', 3000);
            return;
        }
        if (isAnotherTabRunning()) {
            _n('⚠️ 检测到另一个标签页正在执行关注任务', 'warning', 3000);
            return;
        }
        if (!isRunning) {
            const s = getAccountStats();
            if (s.follows_today >= getDailyLimit(s.day_count)) {
                if (isSchedulerAutoMode()) {
                    _n('关注配额已满，由调度切养号', 'info', 3000);
                    finishFollowQuotaForScheduler('quota_full_toggle').catch(function () {});
                    return;
                }
                const _tNsData = getNurtureSessionsToday();
                const _tNsSettings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
                const _tNsTarget = _tNsSettings.nurtureSessionsPerDay ?? 3;
                if (_tNsTarget <= 0 || _tNsData.sessions >= _tNsTarget) {
                    _n('⚠️ 今日配额及养号均已达成，无需运行', 'warning', 4000);
                    return;
                }
                localStorage.setItem('matrix_pure_nurture_mode', 'true');
                isRunning = true;
                sessionStorage.setItem('matrix_tab_running', 'true');
                localStorage.setItem('matrix_follow_running', 'true');
                updateStats('配额已满，转入纯养号模式');
                updateFollowButtonState();
                setTimeout(function() { if (isRunning) followGoWhenAllowed('https://x.com/home'); }, 1000);
                return;
            }
            // 🔒 锁检查：有未完成的任务则恢复，不领新号
            const _lockedTaskId = localStorage.getItem('matrix_current_task_id');
            const _lockedCreator = localStorage.getItem('matrix_current_creator');
            if (_lockedTaskId && _lockedCreator) {
                isRunning = true;
                sessionStorage.setItem('matrix_tab_running', 'true');
                localStorage.setItem('matrix_follow_running', 'true');
                localStorage.setItem('matrix_step', 'SCAN');
                updateFollowButtonState();
                startDiagnostic();
                updateStats('🔒 恢复锁定任务 @' + _lockedCreator);
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '🔒 恢复锁定任务 @' + _lockedCreator + ' (id:' + _lockedTaskId + ')' } }));
                if (isOthersFollowersPage() && normalizeCr(window.location.pathname.split('/')[1]) === normalizeCr(_lockedCreator)) {
                    runEngine();
                } else {
                    navigateToLockedCreator('manual_resume_lock');
                }
                return;
            }
            isRunning = true;
            localStorage.removeItem('matrix_global_cooldown_until');
            localStorage.removeItem('matrix_global_next_follow_time');
            sessionStorage.setItem('matrix_tab_running', 'true');
            localStorage.setItem('matrix_follow_running', 'true');
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '🟢 点击开始：准备领取下一个博主' } }));
            // 检测当前页面：如果已经在粉丝列表页，直接开始扫描
            if (isOthersFollowersPage()) {
                const pathHandle = window.location.pathname.split('/')[1];
                if (pathHandle) {
                    localStorage.setItem('matrix_current_creator', pathHandle);
                    localStorage.setItem('matrix_step', 'SCAN');
                    updateStats('📥 检测到当前在 @' + pathHandle + ' 粉丝列表，直接开始扫描..');
                    runEngine();
                    return;
                }
            }
            // 不在粉丝列表页，从号池领取下一个博主
            jumpToNextBlogger();
        } else {
            sessionStorage.setItem('matrix_tab_running', 'stopped_by_user');
            stopBot();
        }
        updateFollowButtonState();
    }

    function toggleFollowPanel() {
        followPanel.classList.toggle('active');
        if (followPanel.classList.contains('active')) {
            renderFollowPanel();
            startPanelRefresh();
        } else {
            stopPanelRefresh();
        }
    }

    function formatCooldownTime(ms) {
        if (ms <= 0) return '0s';
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
        if (mins > 0) return `${mins}m ${secs}s`;
        return `${secs}s`;
    }

    let _panelRefreshInterval = null;
    function startPanelRefresh() {
        if (_panelRefreshInterval) return;
        _panelRefreshInterval = setInterval(() => {
            // 只更新风控状态区域，不重渲染整个面板（避免闪烁）
            const riskEl = document.getElementById('matrix-risk-status');
            if (!riskEl) return;

            const cooldownUntil = getMatrixCooldownUntil();
            const now = Date.now();
            const isCooling = now < cooldownUntil;
            const cooldownRemaining = isCooling ? cooldownUntil - now : 0;
            const nextFollowTime = getNextGlobalFollowTime();
            const isWaiting = now < nextFollowTime;
            const waitRemaining = isWaiting ? nextFollowTime - now : 0;

            // 更新冷却计时器
            const timerEl = document.getElementById('matrix-cooldown-timer');
            if (timerEl) {
                if (isCooling) {
                    timerEl.textContent = formatCooldownTime(cooldownRemaining);
                } else {
                    // 冷却结束，刷新整个面板
                    renderFollowPanel();
                    return;
                }
            }

            // 更新间隔等待计时器
            const waitEl = document.getElementById('matrix-wait-timer');
            if (waitEl) {
                if (isWaiting) {
                    waitEl.textContent = Math.ceil(waitRemaining / 1000) + 's';
                } else {
                    waitEl.parentElement.remove();
                }
            }

            // 更新状态样式
            let riskClass = 'status-ok';
            if (isCooling) {
                riskClass = cooldownRemaining > 2 * 3600000 ? 'status-hard' : 'status-cooling';
            }
            riskEl.className = 'risk-status ' + riskClass;
        }, 1000);
    }

    function stopPanelRefresh() {
        if (_panelRefreshInterval) { clearInterval(_panelRefreshInterval); _panelRefreshInterval = null; }
    }

    
    
    
    
    function renderFollowPanel() {
        if (!followPanel) return;

        const handles = getTargetHandles();
        const completed = JSON.parse(localStorage.getItem(CONFIG.completedKey) || '[]');
        const pendingHandles = handles.filter(h => !completed.includes(h));
        const cooldownUntil = getMatrixCooldownUntil();
        const now = Date.now();
        const isCooling = now < cooldownUntil;
        const cooldownRemaining = isCooling ? cooldownUntil - now : 0;
        const stats = getAccountStats();
        const limit = getDailyLimit(stats.day_count);
        const step = localStorage.getItem('matrix_step') || 'IDLE';
        const blogger = localStorage.getItem('matrix_current_creator') || '';
        const nextFollowTime = getNextGlobalFollowTime();
        const isWaiting = now < nextFollowTime;
        const waitRemaining = isWaiting ? nextFollowTime - now : 0;

        let riskClass = 'status-ok';
        let riskIcon = '\u6b63\u5e38';
        let riskText = '\u6b63\u5e38';
        if (isCooling) {
            if (cooldownRemaining > 2 * 3600000) {
                riskClass = 'status-hard';
                riskIcon = '\u786c\u98ce\u63a7';
                riskText = '\u786c\u98ce\u63a7\u51b7\u5374';
            } else {
                riskClass = 'status-cooling';
                riskIcon = '\u8f6f\u98ce\u63a7';
                riskText = '\u8f6f\u98ce\u63a7\u51b7\u5374';
            }
        } else if (isRunning) {
            riskIcon = '\u8fd0\u884c';
            riskText = '\u8fd0\u884c\u4e2d';
        }

        let html = `
        <div class="risk-status ${riskClass}" id="matrix-risk-status">
            <div class="risk-header">${riskIcon} ${riskText}</div>
            <div class="risk-row">
                <span class="risk-label">\u5f15\u64ce</span>
                <span class="risk-value">${isRunning ? '\u8fd0\u884c' : '\u505c\u6b62'}</span>
            </div>
            <div class="risk-row">
                <span class="risk-label">\u6b65\u9aa4</span>
                <span class="risk-value">${step}</span>
            </div>
            <div class="risk-row">
                <span class="risk-label">\u5f53\u524d\u535a\u4e3b</span>
                <span class="risk-value">${blogger ? '@' + blogger : '-'}</span>
            </div>
            <div class="risk-row">
                <span class="risk-label">\u5929\u6570</span>
                <span class="risk-value">${stats.day_count}</span>
            </div>
            <div class="risk-row">
                <span class="risk-label">\u914d\u989d</span>
                <span class="risk-value">${stats.follows_today} / ${limit}</span>
            </div>
            ${isCooling ? `
            <div class="risk-row">
                <span class="risk-label">\u51b7\u5374</span>
                <span class="risk-value cooldown-timer" id="matrix-cooldown-timer">${formatCooldownTime(cooldownRemaining)}</span>
            </div>
            ` : ''}
            ${isWaiting ? `
            <div class="risk-row">
                <span class="risk-label">\u7b49\u5f85</span>
                <span class="risk-value" id="matrix-wait-timer">${Math.ceil(waitRemaining / 1000)}s</span>
            </div>
            ` : ''}

        ${__nurtureState.running ? `
        <div class="nurture-status" style="margin-bottom:12px;padding:10px;background:rgba(29,155,240,0.1);border-radius:8px;border:1px solid rgba(29,155,240,0.3);">
            <div style="font-size:12px;font-weight:700;color:#1d9bf0;margin-bottom:6px;">\u517b\u53f7\u4e2d...</div>
            <div class="risk-row"><span class="risk-label">\u6d4f\u89c8</span><span class="risk-value">${__nurtureState.browseCount}</span></div>
            <div class="risk-row"><span class="risk-label">\u70b9\u8d5e</span><span class="risk-value">${__nurtureState.likesDone}</span></div>
            <div class="risk-row"><span class="risk-label">\u8bc4\u8bba</span><span class="risk-value">${__nurtureState.commentsDone}</span></div>
            <div class="risk-row"><span class="risk-label">\u8fdb\u5e16</span><span class="risk-value">${__nurtureState.entersDone}</span></div>
        </div>
        ` : ''}
        <div style="margin-bottom: 12px;">
            <div class="section-label">\u5f53\u524d\u76ee\u6807</div>
            <div class="blogger-list" id="matrix-blogger-list"></div>
        </div>
        `;

        followPanel.innerHTML = html;

        const bloggerList = document.getElementById('matrix-blogger-list');
        if (bloggerList) {
            if (blogger) {
                bloggerList.innerHTML = `
                    <div class="current-blogger-card">
                        <div class="current-blogger-main">
                            <div class="current-blogger-title">\u8fd0\u884c\u4e2d</div>
                            <div class="current-blogger-handle">@${blogger}</div>
                            <div class="current-blogger-meta">\u5269\u4f59 ${pendingHandles.length}</div>
                        </div>
                    </div>
                `;
            } else if (pendingHandles.length > 0) {
                bloggerList.innerHTML = `
                    <div class="current-blogger-card">
                        <div class="current-blogger-main">
                            <div class="current-blogger-title">\u4e0b\u4e00\u4e2a</div>
                            <div class="current-blogger-handle">@${pendingHandles[0]}</div>
                            <div class="current-blogger-meta">\u5269\u4f59 ${pendingHandles.length}</div>
                        </div>
                    </div>
                `;
            } else {
                bloggerList.innerHTML = '<div class="empty-msg">\u65e0\u5f85\u5904\u7406\u535a\u4e3b</div>';
            }
        }

        if (isRunning) { startPanelRefresh(); }
        else { stopPanelRefresh(); }
    }

    function updateFollowButtonState() {
        const btn = document.getElementById('matrix-follow-btn');
        const dot = document.getElementById('matrix-follow-status-dot');
        if (!btn || !dot) return;
        btn.style.opacity = '';
        btn.style.filter = '';
        btn.style.pointerEvents = '';

        const cooldownUntil = getMatrixCooldownUntil();
        const now = Date.now();
        const isCooling = now < cooldownUntil;
        const cooldownRemaining = isCooling ? cooldownUntil - now : 0;

        if (!isRunning) {
            // 停止状态：灰色
            btn.classList.remove('running', 'cooling', 'hard-cooling');
            dot.classList.remove('active');
            dot.style.background = '#71767b';
        } else if (isCooling && cooldownRemaining > 2 * 3600000) {
            // HARD 风控：红色
            btn.classList.remove('running', 'cooling');
            btn.classList.add('hard-cooling');
            dot.classList.add('active');
            dot.style.background = '#f4212e';
        } else if (isCooling) {
            // SOFT 风控：黄色
            btn.classList.remove('running', 'hard-cooling');
            btn.classList.add('cooling');
            dot.classList.add('active');
            dot.style.background = '#ffd700';
        } else {
            // 正常运行：绿色
            btn.classList.remove('cooling', 'hard-cooling');
            btn.classList.add('running');
            dot.classList.add('active');
            dot.style.background = '#00ba7c';
        }
    }

    // 兼容性函数 - 保留updateStats以避免调用错误
    function updateStats(msg) {
        lastMsg = msg;
        console.log('[Follow状态]', msg);
        updateFollowButtonState();
        
        // 向中控台发送状态更新（含风控信息）
        if (isRunning) {
            const cooldownUntil = getMatrixCooldownUntil();
            const now = Date.now();
            const isCooling = now < cooldownUntil;
            document.dispatchEvent(new CustomEvent('matrix-follow-status', {
                detail: { 
                    running: true, 
                    status: isCooling ? 'cooling' : 'running', 
                    message: msg,
                    count: getAccountStats().follows_today,
                    limit: getDailyLimit(getAccountStats().day_count),
                    cooldownRemaining: isCooling ? cooldownUntil - now : 0
                }
            }));
        }
    }

    // 初始化UI
    createFollowUI();

    // ================= 【看门狗】 =================
    setInterval(() => {
        if (!isRunning) return;
        let lastHealth = parseInt(sessionStorage.getItem('matrix_watchdog_time') || Date.now());
        let cr = localStorage.getItem('matrix_current_creator') || "unknown";
        let currentPath = window.location.pathname.toLowerCase();

        if (document.querySelector('[data-testid="UserCell"]') || pageLooksFollowersHydrated()
            || currentPath === '/' + cr || currentPath === '/home') {
            sessionStorage.setItem('matrix_watchdog_time', Date.now());
            try { sessionStorage.removeItem('sg_follow_shell_wait_n'); } catch (eOkW) {}
        } else if (Date.now() - lastHealth > 35000) {
            updateStats('【防卡死】未灌水，点重试/软愈（禁 ?_t= 硬跳）');
            requestSharedSoftHeal('follow_watchdog');
            sessionStorage.setItem('matrix_watchdog_time', Date.now());
        }
    }, 5000);

    // ================= 【号池任务标记】 =================
    var POOL_DONE_MIN_FOLLOWS = (window.SgPoolApi && window.SgPoolApi.POOL_DONE_MIN_FOLLOWS) || 5;
    var POOL_DONE_MAX_DIST_PX = (window.SgPoolApi && window.SgPoolApi.POOL_DONE_MAX_DIST_PX) || 250;

    function bloggerFollowCountKey(blogger) {
        return (window.SgPoolApi && window.SgPoolApi.bloggerFollowCountKey) ? window.SgPoolApi.bloggerFollowCountKey(blogger) : '';
    }
    function getBloggerFollowCount(blogger) {
        return (window.SgPoolApi && window.SgPoolApi.getBloggerFollowCount) ? window.SgPoolApi.getBloggerFollowCount(blogger) : 0;
    }
    function incBloggerFollowCount(blogger) {
        if (window.SgPoolApi && window.SgPoolApi.incBloggerFollowCount) window.SgPoolApi.incBloggerFollowCount(blogger);
    }
    function clearBloggerFollowCount(blogger) {
        if (window.SgPoolApi && window.SgPoolApi.clearBloggerFollowCount) window.SgPoolApi.clearBloggerFollowCount(blogger);
    }
    async function poolFail(taskId) {
        if (window.SgPoolApi && window.SgPoolApi.poolFail) return window.SgPoolApi.poolFail(taskId);
        return { ok: false };
    }
    async function poolFailByHandle(handle) {
        if (window.SgPoolApi && window.SgPoolApi.poolFailByHandle) return window.SgPoolApi.poolFailByHandle(handle);
        return { ok: false };
    }
    async function releasePoolTask(reason) {
        if (window.SgPoolApi && window.SgPoolApi.releasePoolTask) return window.SgPoolApi.releasePoolTask(reason);
        return { ok: true };
    }
    function isSchedulerAutoMode() {
        try {
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode) {
                return !!SchedulerGate.isAutoMode();
            }
        } catch (e) {}
        try {
            return !!(JSON.parse(localStorage.getItem('sg_state') || '{}').running);
        } catch (e2) {
            return false;
        }
    }

    /**
     * 自动模式：关注配额满 → 干净停 follow，交回调度开养号。
     * 禁止再进 matrix_pure_nurture_mode（会占着 follow_running，挡住 NurtureEngine）。
     */
    async function finishFollowQuotaForScheduler(reason) {
        await releasePoolTask(reason || 'quota_full');
        localStorage.removeItem('matrix_pure_nurture_mode');
        updateStats('今日关注配额已满，交回调度');
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '✅ 关注配额满 → 交回调度（不进软风控）' }
        }));
        try {
            if (typeof Logger !== 'undefined' && Logger.info) {
                Logger.info('关注', '配额满，交回调度（不进软风控）');
            }
        } catch (eL) {}
        handOffFollowRoundNoSoft(reason || 'quota_full');
    }

    async function markPoolTaskDone() {
        var taskId = localStorage.getItem('matrix_current_task_id');
        if (!taskId) return { ok: true, skipped: true };
        var resp = null;
        for (var attempt = 0; attempt < 3; attempt++) {
            try {
                resp = await new Promise(function (resolve) {
                    chrome.runtime.sendMessage({ action: 'pool_done', id: taskId }, function (r) {
                        if (chrome.runtime.lastError) {
                            resolve({ ok: false, error: chrome.runtime.lastError.message });
                            return;
                        }
                        resolve(r || { ok: false, error: 'no response' });
                    });
                });
            } catch (e) {
                resp = { ok: false, error: (e && e.message) || String(e) };
            }
            if (resp && resp.ok) break;
            await sleep(400 + attempt * 300);
        }
        if (resp && resp.ok) {
            var creator = localStorage.getItem('matrix_current_creator') || '';
            localStorage.removeItem('matrix_current_task_id');
            localStorage.removeItem('matrix_current_task_assigned_at');
            if (creator) clearBloggerFollowCount(creator);
            return { ok: true };
        }
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '⚠️ pool_done 失败 #' + taskId + ' ' + ((resp && (resp.error || resp.msg)) || '') + '，保留锁不领下一号' }
        }));
        return { ok: false, error: (resp && (resp.error || resp.msg)) || 'done failed' };
    }

    /**
     * 触底换号：近底 +（本博关注够 / 已处理够多 / 连续假触底）→ pool_done → 软风控填窗。
     * 回流半成品常见「本趟关注&lt;5 但列表已刷完」，不能永久卡死。
     * @returns {Promise<boolean>} true=已结束本博（调用方应 return）
     */
    async function tryFinishBloggerAtBottom(via) {
        // 白壳假触底：禁止 pool_done / 连环换号
        if (pageLooksFollowersShell()) {
            var shellStall = await handleFollowersShellStall(via || 'finish_shell');
            return !!(shellStall && shellStall.released);
        }
        try { sessionStorage.removeItem('sg_follow_shell_wait_n'); } catch (eShellOk) {}
        var scrollH = document.documentElement.scrollHeight || 0;
        var scrollY = window.scrollY || 0;
        var innerH = window.innerHeight || 0;
        var distBottom = scrollH - scrollY - innerH;
        var currentBlogger = localStorage.getItem('matrix_current_creator') || '';
        var bf = getBloggerFollowCount(currentBlogger);
        var processedN = __getProcessedFanSet(currentBlogger).size;
        var nearBottom = distBottom <= POOL_DONE_MAX_DIST_PX;
        var enoughWork = bf >= POOL_DONE_MIN_FOLLOWS || processedN >= Math.max(POOL_DONE_MIN_FOLLOWS * 3, 15);
        var stuckKey = 'sg_follow_fake_bottom_n';
        var stuckN = parseInt(sessionStorage.getItem(stuckKey) || '0', 10) || 0;
        if (nearBottom && !enoughWork) {
            stuckN += 1;
            sessionStorage.setItem(stuckKey, String(stuckN));
        } else if (!nearBottom) {
            sessionStorage.setItem(stuckKey, '0');
            stuckN = 0;
        }
        // 连续假触底仍不够「真实关注」：视为列表耗尽（回流/已关注占满）
        // 刷不出新粉（刷新不出来）时 processed 可能一直 <3 —— 不得永久卡在关注轮
        var forceExhausted = nearBottom && stuckN >= 3 && processedN >= 3;
        var forceNoLoad = nearBottom && stuckN >= 5; // 近底等加载多次仍无进展
        var forceSpin = stuckN >= 8; // 距底抖动也算空转
        if (!forceExhausted && !forceNoLoad && !forceSpin && (!nearBottom || !enoughWork)) {
            updateStats(
                '触底存疑: 距底' + Math.round(distBottom) + 'px 关注' + bf +
                '/' + POOL_DONE_MIN_FOLLOWS + ' 已处理' + processedN +
                ' stuck=' + stuckN + '，继续等加载'
            );
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: {
                    text: '⚠️ 假触底拦截: via=' + (via || '') +
                        ' dist=' + Math.round(distBottom) +
                        'px near=' + nearBottom + ' follows=' + bf +
                        ' processed=' + processedN + ' stuck=' + stuckN + '，不 pool_done'
                }
            }));
            return false;
        }

        sessionStorage.removeItem(stuckKey);
        try { sessionStorage.removeItem('sg_follow_scroll_stuck_n'); } catch (eClrS) {}
        var forceTag = forceSpin ? ' 空转耗尽' : (forceNoLoad ? ' 刷不出耗尽' : (forceExhausted ? ' 强制耗尽' : ''));
        updateStats(
            '📄 确认到底（距底' + Math.round(distBottom) + 'px，关注' + bf +
            ' 处理' + processedN + forceTag + '），切换下一个博主'
        );
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: {
                text: '✅ 触底换号 via=' + (via || '') +
                    ' follows=' + bf + ' processed=' + processedN +
                    (forceTag ? ' force=1' : '')
            }
        }));
        await sleep(2000);

        if (currentBlogger) markHandleCompleted(currentBlogger);
        var doneRes = await markPoolTaskDone();
        if (!doneRes || !doneRes.ok) {
            var _dfailN = parseInt(localStorage.getItem('sg_follow_done_fail_count') || '0', 10) || 0;
            _dfailN++;
            localStorage.setItem('sg_follow_done_fail_count', String(_dfailN));
            if (_dfailN >= 3) {
                localStorage.removeItem('sg_follow_done_fail_count');
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⚠️ pool_done 连续失败 ' + _dfailN + ' 次，放弃任务交回调度' }
                }));
                try {
                    releasePoolTask('done_fail_exhausted');
                    localStorage.removeItem('matrix_step');
                    localStorage.removeItem('matrix_follow_running');
                    sessionStorage.setItem('sg_module_follow', JSON.stringify({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() }));
                } catch (eDf) {}
                followHomeBase('pool_done 失败超限');
                return true;
            }
            updateStats('⚠️ pool_done 未成功(' + _dfailN + '/3)，保留当前任务不换号');
            await sleep(5000);
            return false;
        }
        localStorage.removeItem('sg_follow_done_fail_count');
        if (currentBlogger) {
            try { __clearProcessedFans(currentBlogger); } catch (eClrP) {}
        }

        updateStats('📄 当前博主粉丝已全部处理，换号续跑');
        await sleep(2000);
        handOffFollowRoundNoSoft('blogger_exhausted');
        return true;
    }

    async function markPoolTaskFail() {
        let taskId = localStorage.getItem('matrix_current_task_id');
        if (!taskId) return { ok: true };
        try { await poolFail(taskId); } catch (e) {}
        var creator = localStorage.getItem('matrix_current_creator') || '';
        localStorage.removeItem('matrix_current_task_id');
        localStorage.removeItem('matrix_current_task_assigned_at');
        if (creator) clearBloggerFollowCount(creator);
        return { ok: true };
    }

    async function markPoolTaskDead() {
        let taskId = localStorage.getItem('matrix_current_task_id');
        const handle = (localStorage.getItem('matrix_current_creator') || '').toLowerCase();

        if (taskId) {
            let idDeadOk = false;
            try {
                const resp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ action: "pool_dead", id: taskId }, (r) => { resolve(r); });
                });
                if (resp && resp.ok) idDeadOk = true;
            } catch (e) {
                console.warn('[死号] pool_dead by id 异常:', e.message || String(e));
            }
            if (!idDeadOk && handle) {
                try {
                    const resp2 = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({ action: "pool_dead_by_handle", handle: handle }, (r) => { resolve(r); });
                    });
                    if (resp2 && resp2.ok) {
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '🔒 通过 handle 兜底标记死号: ' + handle } }));
                    }
                } catch (e2) {
                    console.warn('[死号] pool_dead_by_handle 兜底也失败:', e2.message || String(e2));
                }
            }
            localStorage.removeItem('matrix_current_task_id');
            localStorage.removeItem('matrix_current_task_assigned_at');
        } else if (handle) {
            // 无 task_id 时仍按 handle 上报，避免保护号只本地跳过、号池继续派发
            try {
                await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ action: "pool_dead_by_handle", handle: handle }, (r) => { resolve(r); });
                });
            } catch (eH) {}
        }

        // 本地死号记录，防止重新领取（即使服务端标记失败也不重复领）
        if (handle) {
            try {
                let deadSet = JSON.parse(localStorage.getItem('matrix_dead_handles') || '[]');
                if (deadSet.indexOf(handle) < 0) {
                    deadSet.push(handle);
                    if (deadSet.length > 500) deadSet = deadSet.slice(-500);
                    localStorage.setItem('matrix_dead_handles', JSON.stringify(deadSet));
                }
            } catch (e) {}
        }
    }

    // ================= 【关注逻辑】 =================
    

    // ==================== [Nurture/Warmup Helpers] ====================
    const __nurtureState = {
        running: false,
        interactedTweets: new Set(),
        enteredTweets: new Set(),
        usedComments: new Set(),
        likesDone: 0,
        commentsDone: 0,
        entersDone: 0,
        browseCount: 0,
        failCount: 0,
        heartbeatTime: 0
    };

    function __nr_rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
    function __nr_sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function __nr_pickRandom(arr) { return arr[__nr_rand(0, arr.length - 1)]; }
    function __nr_pickUnusedComment(texts) {
        const unused = texts.filter(t => !__nurtureState.usedComments.has(t));
        if (!unused.length) { __nurtureState.usedComments.clear(); return __nr_pickRandom(texts); }
        const picked = __nr_pickRandom(unused);
        __nurtureState.usedComments.add(picked);
        return picked;
    }

    function __normFollowText(s) {
        return String(s || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, '')
            .toLowerCase();
    }

    // 可点击「关注」文案（精确匹配，避免命中「フォロー中」）
    var __FOLLOW_ACTION_LABELS = [
        // EN
        'follow',
        // 简体
        '关注',
        // 繁体
        '跟隨', '追踪', '追蹤', '關注',
        // 日文（仅「フォロー」前缀；「フォロー中」由 already 拦截）
        'フォロー', 'フォローする',
        // 韩文
        '팔로우'
    ];

    // 已关注 / 待确认 / 点下去会取关 — 长词优先
    var __FOLLOW_ALREADY_LABELS = [
        // EN
        'followingyou', 'following', 'unfollow', 'pending', 'requested',
        'cancelrequest', 'awaiting', 'followsyou',
        // 简体
        '正在关注', '已关注', '关注中', '取消关注', '互相关注', '请求已发送',
        '等待确认', '等待对方确认', '已请求', '请求中', '取消请求',
        // 繁体
        '正在跟隨', '已跟隨', '跟隨中', '取消跟隨', '互相跟隨',
        '正在追蹤', '已追蹤', '追蹤中', '取消追蹤', '互相追蹤',
        '正在關注', '已關注', '關注中', '取消關注', '互相關注',
        '請求已傳送', '請求已發送', '等待確認', '已請求', '取消請求',
        // 日文
        'フォロー中', 'フォロー解除', 'フォローしています', 'フォローするのをやめる',
        'リクエスト済み', 'リクエスト中', '承認待ち', 'キャンセル',
        // 韩文
        '팔로잉', '언팔로우', '팔로우중', '요청됨', '요청중'
    ].slice().sort(function (a, b) { return b.length - a.length; });

    function __matchAlreadyLabel(text) {
        var t = __normFollowText(text);
        if (!t) return '';
        for (var i = 0; i < __FOLLOW_ALREADY_LABELS.length; i++) {
            var k = __normFollowText(__FOLLOW_ALREADY_LABELS[i]);
            if (k && t.indexOf(k) >= 0) return __FOLLOW_ALREADY_LABELS[i];
        }
        return '';
    }

    function __isExactFollowActionLabel(text) {
        var t = __normFollowText(text);
        if (!t) return false;
        // 已是「已关注」类则绝不当作可点关注
        if (__matchAlreadyLabel(t)) return false;
        for (var i = 0; i < __FOLLOW_ACTION_LABELS.length; i++) {
            var k = __normFollowText(__FOLLOW_ACTION_LABELS[i]);
            if (!k) continue;
            if (t === k) return true;
            // aria 常见：Follow @user / 关注 @user / フォロー @user
            if (t.indexOf(k) === 0) {
                if (k === 'follow' && t.indexOf('following') === 0) continue;
                if (k === 'フォロー' && (t.indexOf('フォロー中') === 0 || t.indexOf('フォロー解除') === 0 || t.indexOf('フォローしています') === 0)) continue;
                if (k === 'フォローする' && t.indexOf('フォローするのをやめる') === 0) continue;
                return true;
            }
        }
        return false;
    }

    function __followBtnState(btn) {
        if (!btn) return { state: 'missing', reason: 'no_btn' };
        var testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        var aria = btn.getAttribute('aria-label') || '';
        var text = btn.textContent || btn.innerText || '';
        var cls = (btn.className && btn.className.toString) ? btn.className.toString() : String(btn.className || '');
        var pressed = (btn.getAttribute('aria-pressed') || '').toLowerCase();

        // 1) testid：最可靠。xxx-unfollow / xxx-follow
        if (testId.indexOf('unfollow') >= 0) {
            return { state: 'already', reason: 'testid=unfollow', testId: testId, text: text, aria: aria };
        }
        if (testId.indexOf('following') >= 0) {
            return { state: 'already', reason: 'testid=following', testId: testId, text: text, aria: aria };
        }
        // 明确的可关注按钮（user-xxx-follow）
        if (/-follow$/.test(testId) || /(^|-)follow$/.test(testId)) {
            var hitOnFollowTid = __matchAlreadyLabel(text) || __matchAlreadyLabel(aria);
            if (hitOnFollowTid) {
                return { state: 'already', reason: 'testid=follow但文案=' + hitOnFollowTid, testId: testId, text: text, aria: aria };
            }
            return { state: 'can_follow', reason: 'testid=follow', testId: testId, text: text, aria: aria };
        }

        // 2) aria-pressed
        if (pressed === 'true') {
            return { state: 'already', reason: 'aria-pressed=true', testId: testId, text: text, aria: aria };
        }

        // 3) 文案 / aria（多语言）— 先判已关注
        var hitText = __matchAlreadyLabel(text);
        if (hitText) return { state: 'already', reason: 'text=' + hitText, testId: testId, text: text, aria: aria };
        var hitAria = __matchAlreadyLabel(aria);
        if (hitAria) return { state: 'already', reason: 'aria=' + hitAria, testId: testId, text: text, aria: aria };

        // 4) class
        var cl = cls.toLowerCase();
        if (cl.indexOf('unfollow') >= 0 || cl.indexOf('following') >= 0) {
            return { state: 'already', reason: 'class', testId: testId, text: text, aria: aria };
        }

        // 5) 「关注」文案 / aria → 可点
        if (__isExactFollowActionLabel(text) || __isExactFollowActionLabel(aria)) {
            return { state: 'can_follow', reason: 'label=follow', testId: testId, text: text, aria: aria };
        }

        return { state: 'unknown', reason: 'unrecognized', testId: testId, text: text, aria: aria };
    }
    function __findFollowButton(cell) {
        // 优先精确 -follow（排除 unfollow）
        var nodes = cell.querySelectorAll('[role="button"][data-testid], button[data-testid], [data-testid]');
        var unfollowBtn = null;
        var followBtn = null;
        for (var i = 0; i < nodes.length; i++) {
            var tid = (nodes[i].getAttribute('data-testid') || '').toLowerCase();
            if (!tid) continue;
            if (tid.indexOf('unfollow') >= 0) { unfollowBtn = nodes[i]; continue; }
            if (tid.indexOf('follow') >= 0) { followBtn = nodes[i]; break; }
        }
        if (unfollowBtn && !followBtn) return { btn: unfollowBtn, hint: 'only_unfollow' };
        if (followBtn) return { btn: followBtn, hint: 'testid_follow' };

        // 文案精确匹配「关注」
        var allBtns = cell.querySelectorAll('[role="button"], button');
        for (var j = 0; j < allBtns.length; j++) {
            var st = __followBtnState(allBtns[j]);
            if (st.state === 'can_follow') return { btn: allBtns[j], hint: 'label_follow' };
        }
        // 只有「已关注」类按钮
        for (var k = 0; k < allBtns.length; k++) {
            var st2 = __followBtnState(allBtns[k]);
            if (st2.state === 'already') return { btn: allBtns[k], hint: 'label_already' };
        }
        return { btn: null, hint: 'none' };
    }

    function __followDetectReason(btnText, testId, ariaLabel, btnClass) {
        var st = __followBtnState({
            getAttribute: function (n) {
                if (n === 'data-testid') return testId;
                if (n === 'aria-label') return ariaLabel;
                if (n === 'aria-pressed') return '';
                return '';
            },
            textContent: btnText,
            innerText: btnText,
            className: btnClass || ''
        });
        return st.reason || 'unknown';
    }

    const __NURTURE_COMMENTS = [
        'いいね！',
        'すごいですね 😊',
        '素敵です✨',
        'わかります',
        '共感します',
        'ありがとうございます',
        '参考になりました',
        '勉強になります',
        '面白いですね',
        '感動しました',
        '素晴らしいです',
        'そう思います',
        'その通りですね',
        'なるほど',
        'めっちゃいい！',
        'とても良いですね',
        '考えさせられました',
        '応援してます',
        '見習いたいです',
        '最近どうですか？',
        '私もそう思います',
        'すごくいいですね',
        'とても参考になります',
        'いつも楽しみにしてます',
        '素敵な投稿ありがとう',
        'また見に来ました',
        '今日もお疲れ様です',
        '嬉しいです',
        'これは良い！',
        '本当にその通り',
        '確かにそうですね',
        'いい情報ありがとう',
        '参考にさせてもらいます',
        'とても共感します',
        'ステキな考え方ですね',
        'また読みたいです',
        'ありがとう、助かりました',
        'いい視点ですね',
        '深いですね',
        'なるほど、そういうことか',
        'すごい！感動',
        'これ好きです',
        '素敵な写真ですね',
        'いい感じ〜',
        'とてもいいと思います',
        '考え方が素敵です',
        '毎回楽しみです',
        'また来ます',
        '参考にします',
        'とてもためになりました',
        'うんうん、わかります',
        'なるほど、勉強になります',
        'いいね！参考になります',
        'これすごくいい',
    ];

    function __nr_getAllTweets() { return document.querySelectorAll('article[data-testid="tweet"]'); }
    function __nr_isPromotedTweet(article) {
        return !!article.querySelector('[data-testid="placementTracking"]') ||
               article.textContent.includes("Promoted") ||
               article.textContent.includes("Ad");
    }
    function __nr_isDetailOpen() {
        return !!document.querySelector('[data-testid="primaryColumn"] a[href*="/status/"]');
    }

    function __nr_hasKana(s) {
        return /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/.test(String(s || ''));
    }
    function __nr_hasForeignScript(s) {
        return /[\u0900-\u097F\u0600-\u06FF\u0400-\u04FF\u0E00-\u0E7F\uAC00-\uD7AF\u0370-\u03FF]/.test(String(s || ''));
    }
    /** 填窗养号：只要日语（须假名；拒印地/中文/英文/纯图）；与关注「只点日粉」开关无关 */
    function __nr_isJapaneseTweet(article) {
        if (!article) return false;
        try {
            if (typeof window.NurtureEngine !== 'undefined' && window.NurtureEngine.isJapaneseTweet) {
                return !!window.NurtureEngine.isJapaneseTweet(article);
            }
        } catch (eNe) {}
        var textEl = article.querySelector('[data-testid="tweetText"]');
        if (!textEl) return false;
        var raw = (textEl.innerText || textEl.textContent || '').trim();
        if (!raw) return false;
        if (__nr_hasForeignScript(raw)) return false;
        return __nr_hasKana(raw);
    }

    async function __nr_revealOriginal(article) {
        if (!article) return false;
        var nodes = article.querySelectorAll('button, [role="button"], span[role="button"], a');
        for (var i = 0; i < nodes.length; i++) {
            var lab = ((nodes[i].innerText || nodes[i].getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim();
            if (!lab || lab.length > 60) continue;
            if (/Translate|翻译|翻訳/i.test(lab) && !/original|原文/i.test(lab)) continue;
            if (/Show original|See original|查看原文|顯示原文|原文を表示|원문 보기/i.test(lab)) {
                try { nodes[i].click(); } catch (eC) {}
                await __nr_sleep(450);
                return true;
            }
        }
        return false;
    }

    function __nr_getVisibleRealTweets() {
        const articles = __nr_getAllTweets();
        const vh = window.innerHeight;
        const result = [];
        for (const article of articles) {
            if (__nr_isPromotedTweet(article)) continue;
            // 养号互动硬闸：始终只要日语（不读 onlyJapanese——那个开关只管关注对象）
            if (!__nr_isJapaneseTweet(article)) continue;
            const rect = article.getBoundingClientRect();
            if (rect.top >= vh + 100 || rect.bottom <= -100) continue;
            const link = article.querySelector('a[href*="/status/"]');
            const tweetId = link && link.href && link.href.match(/\/status\/(\d+)/);
            if (!tweetId) continue;
            if (__nurtureState.interactedTweets.has(tweetId[1])) continue;
            result.push({ el: article, id: tweetId[1] });
        }
        return result;
    }

    async function __nr_humanClick(el) {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await __nr_sleep(__nr_rand(300, 800));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await __nr_sleep(__nr_rand(50, 200));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await __nr_sleep(__nr_rand(30, 100));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await __nr_sleep(__nr_rand(200, 500));
        return true;
    }

    async function __nr_scrollAndRead() {
        const dir = Math.random() > 0.3 ? 1 : -1;
        const scrollAmount = __nr_rand(300, 800) * dir;
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        await __nr_sleep(__nr_rand(1500, 3500));
    }

    async function __nr_findTweetsWithRetry(maxRetries) {
        for (let i = 0; i < (maxRetries || 5); i++) {
            const tweets = __nr_getVisibleRealTweets();
            if (tweets.length) return tweets;
            window.scrollBy({ top: __nr_rand(400, 800) });
            await __nr_sleep(__nr_rand(1500, 2500));
        }
        return __nr_getVisibleRealTweets();
    }

    async function __nr_enterTweet(article) {
        const tweetText = article.querySelector('[data-testid="tweetText"]');
        if (!tweetText) return false;
        const originalUrl = window.location.href;
        await __nr_humanClick(tweetText);
        await __nr_sleep(__nr_rand(2000, 3500));
        if (window.location.href === originalUrl) {
            const timeLink = article.querySelector('a[href*="/status/"] time, a[href*="/status/"]');
            if (timeLink) {
                await __nr_humanClick(timeLink);
                await __nr_sleep(__nr_rand(2000, 3500));
            }
        }
        return window.location.href !== originalUrl;
    }

    async function __nr_closeDetail() {
        for (let i = 0; i < 3; i++) {
            const closeBtn = document.querySelector('[data-testid="app-bar-back"], [aria-label="Back"]');
            if (closeBtn) { await __nr_humanClick(closeBtn); return; }
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            await __nr_sleep(__nr_rand(300, 600));
            if (!__nr_isDetailOpen()) return;
        }
        if (__nr_isDetailOpen()) {
            window.history.back();
            await __nr_sleep(__nr_rand(1000, 2000));
        }
    }

    async function __nr_browseDetailComments() {
        const scrolls = __nr_rand(3, 6);
        for (let i = 0; i < scrolls; i++) {
            window.scrollBy({ top: __nr_rand(300, 700), behavior: 'smooth' });
            await __nr_sleep(__nr_rand(1500, 3500));
        }
    }

    async function __nr_actionBrowse() {
        try {
            __nurtureState.browseCount++;
            await __nr_scrollAndRead();
            return 'browse';
        } catch (e) {
            __nurtureState.failCount++;
            console.warn('[Nurture] browse失败:', e.message || String(e));
            return false;
        }
    }

    async function __nr_actionLike() {
        try {
            const tweets = await __nr_findTweetsWithRetry(5);
            if (!tweets.length) { await __nr_scrollAndRead(); return false; }
            const target = __nr_pickRandom(tweets);
            await __nr_revealOriginal(target.el);
            if (!__nr_isJapaneseTweet(target.el)) return false;
            const btn = target.el.querySelector('button[data-testid="like"]');
            if (!btn) return false;
            await __nr_humanClick(btn);
            __nurtureState.interactedTweets.add(target.id);
            __nurtureState.likesDone++;
            return true;
        } catch (e) {
            __nurtureState.failCount++;
            console.warn('[Nurture] like失败:', e.message || String(e));
            return false;
        }
    }

    function __nr_detectCommentRejectBanner() {
        try {
            var t = String((document.body && document.body.innerText) || '').slice(0, 6000);
            return /再试一次|别担心|发生了错误|出了点问题|Something went wrong|Try again|错了[，,]/i.test(t);
        } catch (e) { return false; }
    }

    async function __nr_insertCommentText(editor, text) {
        if (!editor) return false;
        var want = String(text || '');
        if (!want) return false;
        try { editor.focus(); } catch (_) {}
        await __nr_sleep(120);
        function read() {
            return ((editor.innerText || editor.textContent || '') + '').trim();
        }
        function looksOk(got) {
            if (!got) return false;
            if (got === want) return true;
            var n = Math.min(12, want.length);
            return n > 0 && got.indexOf(want.slice(0, n)) >= 0;
        }
        try {
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, want);
        } catch (e0) {}
        await __nr_sleep(200);
        if (looksOk(read())) return true;
        try {
            var dt = new DataTransfer();
            dt.setData('text/plain', want);
            editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch (e1) {}
        await __nr_sleep(250);
        if (looksOk(read())) return true;
        try {
            editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: want, bubbles: true, cancelable: true }));
            editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: want, bubbles: true, cancelable: true }));
        } catch (e2) {
            try {
                editor.textContent = want;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (e3) {}
        }
        await __nr_sleep(200);
        return looksOk(read());
    }

    async function __nr_leaveCommentComposer() {
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (eEsc) {}
        await __nr_sleep(400);
        try {
            if (/\/status\//.test(window.location.pathname || '')) window.history.back();
        } catch (eB) {}
    }

    async function __nr_actionComment() {
        try {
            const tweets = await __nr_findTweetsWithRetry(5);
            if (!tweets.length) { await __nr_scrollAndRead(); return false; }
            const target = __nr_pickRandom(tweets);
            await __nr_revealOriginal(target.el);
            if (!__nr_isJapaneseTweet(target.el)) return false;
            const replyBtn = target.el.querySelector('button[data-testid="reply"]');
            if (!replyBtn) return false;
            const origUrl = window.location.href;
            await __nr_humanClick(replyBtn);
            let textarea = null;
            for (let i = 0; i < 15; i++) {
                await __nr_sleep(1000);
                textarea = Array.from(document.querySelectorAll('[contenteditable="true"]'))
                    .reverse().find(e => e.offsetParent !== null);
                if (textarea) break;
                if (document.querySelector('[data-testid="sheetDialog"], [role="dialog"]')) {
                    /* keep waiting for box */
                }
            }
            // 打开后二次确认：失败则 fail-closed，禁止 catch 后继续发
            var _prim = null;
            if (/\/status\//.test(window.location.pathname || '')) {
                _prim = document.querySelector('article[data-testid="tweet"]');
            }
            if (!_prim) {
                var _sheet = document.querySelector('[data-testid="sheetDialog"], [aria-modal="true"], [role="dialog"]');
                if (_sheet) _prim = _sheet.querySelector('article[data-testid="tweet"]');
            }
            if (!_prim) _prim = target.el;
            await __nr_revealOriginal(_prim);
            if (!_prim || !__nr_isJapaneseTweet(_prim)) {
                updateStats('评论跳过：非日语帖');
                await __nr_leaveCommentComposer();
                await __nr_sleep(1000);
                return false;
            }
            if (!textarea) {
                for (let i = 0; i < 10; i++) {
                    textarea = Array.from(document.querySelectorAll('[contenteditable="true"]'))
                        .reverse().find(e => e.offsetParent !== null);
                    if (textarea) break;
                    await __nr_sleep(1000);
                }
            }
            if (!textarea) return false;
            const text = __nr_pickUnusedComment(__NURTURE_COMMENTS);
            await __nr_humanClick(textarea);
            await __nr_sleep(300);
            const wrote = await __nr_insertCommentText(textarea, text);
            if (!wrote) {
                updateStats('评论写入失败');
                await __nr_leaveCommentComposer();
                return false;
            }
            await __nr_sleep(400);
            const panel = textarea.closest('[role="dialog"], [data-testid="sheetDialog"], [aria-modal="true"]');
            const scope = panel || document;
            const sendBtn = scope.querySelector('button[data-testid="tweetButtonInline"]:not([disabled])')
                || scope.querySelector('button[data-testid="tweetButton"]:not([disabled])')
                || document.querySelector('button[data-testid="tweetButtonInline"]:not([disabled]), button[data-testid="tweetButton"]:not([disabled])');
            if (!sendBtn || sendBtn.disabled) {
                await __nr_leaveCommentComposer();
                return false;
            }
            await __nr_humanClick(sendBtn);
            for (let i = 0; i < 12; i++) {
                await __nr_sleep(1000);
                if (__nr_detectCommentRejectBanner()) {
                    updateStats('评论平台打回');
                    console.warn('[Nurture] 评论-平台打回');
                    await __nr_leaveCommentComposer();
                    await __nr_sleep(__nr_rand(2500, 4500));
                    return false;
                }
                if (window.location.href === origUrl || window.location.href.includes('/home')) {
                    __nurtureState.interactedTweets.add(target.id);
                    __nurtureState.commentsDone++;
                    try {
                        if (typeof NurtureTracker !== 'undefined' && NurtureTracker.didOne) NurtureTracker.didOne('comments');
                        else localStorage.setItem('sg_nurture_last_comment_at', String(Date.now()));
                    } catch (eLc1) {}
                    return true;
                }
                if (!document.querySelector('[data-testid="sheetDialog"], [role="dialog"]') &&
                    !/\/status\//.test(window.location.pathname || '')) {
                    __nurtureState.interactedTweets.add(target.id);
                    __nurtureState.commentsDone++;
                    try {
                        if (typeof NurtureTracker !== 'undefined' && NurtureTracker.didOne) NurtureTracker.didOne('comments');
                        else localStorage.setItem('sg_nurture_last_comment_at', String(Date.now()));
                    } catch (eLc2) {}
                    return true;
                }
            }
            await __nr_leaveCommentComposer();
            return false;
        } catch (e) {
            __nurtureState.failCount++;
            console.warn('[Nurture] comment失败:', e.message || String(e));
            try { await __nr_leaveCommentComposer(); } catch (_) {}
            await __nr_sleep(__nr_rand(1000, 2000));
            return false;
        }
    }

    async function __nr_actionEnter() {
        try {
            const tweets = await __nr_findTweetsWithRetry(3);
            if (!tweets.length) { await __nr_scrollAndRead(); return false; }
            const target = __nr_pickRandom(tweets);
            __nurtureState.interactedTweets.add(target.id);
            __nurtureState.enteredTweets.add(target.id);
            const entered = await __nr_enterTweet(target.el);
            if (entered) {
                __nurtureState.entersDone++;
                await __nr_sleep(__nr_rand(1500, 2500));
                await __nr_browseDetailComments();
                await __nr_closeDetail();
                await __nr_sleep(__nr_rand(1000, 2000));
                return true;
            }
            return false;
        } catch (e) {
            __nurtureState.failCount++;
            console.warn('[Nurture] enter失败:', e.message || String(e));
            await __nr_closeDetail();
            return false;
        }
    }
async function handleFollowButton(cell) {
        if (!isRunning) return 'engine_stopped';

        // 蓝条已挂着时先拦（含上一轮未识别的冻结），再点只会继续「假跳过」
        var preLimit = checkLimits();
        if (preLimit === 'FROZEN') {
            handleAccountFrozen('follow_pre_click');
            return 'frozen';
        }
        if (preLimit === 'HARD') {
            if (typeof MatrixRisk !== "undefined") {
                MatrixRisk.applyLimitBackoff("follow");
            }
            setMatrixCooldown(randomInt(3 * 3600000, 4 * 3600000));
            updateStats("触发最高风控！脚本已紧急熔断！");
            (window.__matrix_notify__ || ((m,t,d) => {}))('🚨 检测到推特最高风控，脚本已自动挂起保护账号！', 'error', 5000);
            stopBot();
            return 'hard_risk';
        }
        if (preLimit === 'SOFT') {
            notifyFollowRoundEndAndFill('soft_pre_click');
            return 'soft_cooldown';
        }
        
        // 配额检查
        const stats = getAccountStats();
        const limit = getDailyLimit(stats.day_count);
        if (stats.follows_today >= limit) {
            updateStats("今日配额已满，停止关注");
            if (isSchedulerAutoMode()) {
                await finishFollowQuotaForScheduler('quota_full_btn');
            }
            return 'quota_full';
        }
        
        let userLink = cell.querySelector('a[role="link"][href^="/"]') || cell.querySelector('a[href^="/"]');
        if (!userLink) {
            console.warn('[关注] 找不到用户链接，cell innerHTML:', cell.innerHTML.substring(0, 200));
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '⚠️ 找不到用户链接' } }));
            return 'no_user_link';
        }
        
        let href = userLink.getAttribute('href');
        if (!href) return 'no_href';
        
        let handle = href.split('/').filter(Boolean)[0];
        if (!handle) return 'no_handle';
        handle = String(handle).replace(/^@/, '').toLowerCase();

        const currentBlogger = (localStorage.getItem('matrix_current_creator') || '').replace(/^@/, '').toLowerCase();
        if (currentBlogger && __getProcessedFanSet(currentBlogger).has(handle)) {
            cell.setAttribute('data-matrix-processed', 'true');
            document.dispatchEvent(new CustomEvent('matrix-follow-detect', {
                detail: { handle: handle, decision: 'already_processed', reason: 'local_progress' }
            }));
            return 'already_followed';
        }

        let found = __findFollowButton(cell);
        let followBtn = found.btn;
        if (!followBtn) {
            console.warn('[关注] 找不到关注按钮，cell data-testid:', cell.getAttribute('data-testid'), 'cell buttons:', cell.querySelectorAll('[role="button"]').length);
            return 'no_follow_btn';
        }

        let btnState = __followBtnState(followBtn);
        let btnText = __normFollowText(followBtn.textContent || followBtn.innerText || '');
        let testId = (followBtn.getAttribute('data-testid') || '').toLowerCase();
        let ariaLabel = (followBtn.getAttribute('aria-label') || '').toLowerCase();
        let btnClass = (followBtn.className && followBtn.className.toString)
            ? followBtn.className.toString().toLowerCase()
            : String(followBtn.className || '').toLowerCase();

        // 仅有 unfollow / 文案已是已关注 → 跳过，绝不点击
        if (found.hint === 'only_unfollow' || btnState.state === 'already') {
            document.dispatchEvent(new CustomEvent('matrix-follow-detect', {
                detail: {
                    handle: handle,
                    btnText: btnText,
                    testId: testId,
                    ariaLabel: ariaLabel,
                    decision: 'already_followed',
                    reason: btnState.reason || found.hint,
                    hint: found.hint
                }
            }));
            cell.setAttribute('data-matrix-processed', 'true');
            __markFanProcessed(currentBlogger, handle);
            return 'already_followed';
        }

        // 未识别状态：宁可跳过，避免误点取关
        if (btnState.state !== 'can_follow') {
            document.dispatchEvent(new CustomEvent('matrix-follow-detect', {
                detail: {
                    handle: handle,
                    btnText: btnText,
                    testId: testId,
                    ariaLabel: ariaLabel,
                    decision: 'skip_unknown',
                    reason: btnState.reason || 'unknown',
                    hint: found.hint
                }
            }));
            console.warn('[关注] 按钮状态未识别，跳过 @' + handle, btnState);
            cell.setAttribute('data-matrix-processed', 'true');
            __markFanProcessed(currentBlogger, handle);
            return 'unknown_btn_state';
        }

        document.dispatchEvent(new CustomEvent('matrix-follow-detect', {
            detail: {
                handle: handle,
                btnText: btnText,
                testId: testId,
                ariaLabel: ariaLabel,
                decision: 'proceed_to_follow',
                reason: btnState.reason,
                hint: found.hint
            }
        }));

        // 防老外：获取用户简介内容，检测是否是日语用户
        let rawText = cell.innerText || "";
        let lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let rawBtnText = followBtn.innerText ? followBtn.innerText.trim() : '';
        let content = lines.filter(l => l !== rawBtnText).join(' | ');

        const isJp = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(content);
        const isPureEng = /[a-zA-Z]/.test(content) && !isJp;
        const isSubstantial = content.length > 8;

        // 读取"只点击日本人"设置（远程优先）
        const onlyJapanese = isOnlyJapaneseEnabled();

        if (onlyJapanese) {
            // 只点击日本人模式
            if (isPureEng || !isJp || !isSubstantial) {
                cell.style.cssText += 'opacity: 0.15; filter: grayscale(100%); border: 1px solid red;';
                updateStats("【防线】非目标号，剔除...");
                cell.setAttribute('data-matrix-processed', 'true');
                { const _r = cell.getBoundingClientRect(); if (_r.bottom > window.innerHeight) window.scrollBy({ top: _r.bottom - window.innerHeight + 50, behavior: 'smooth' }); }
                await sleep(randomInt(700, 1200));
                __markFanProcessed(currentBlogger, handle);
                return 'filtered';
            }
        } else {
            // 全部点击模式 - 只过滤太短的内容
            if (!isSubstantial) {
                cell.style.cssText += 'opacity: 0.15; filter: grayscale(100%); border: 1px solid red;';
                updateStats("【防线】内容过短，剔除...");
                cell.setAttribute('data-matrix-processed', 'true');
                { const _r = cell.getBoundingClientRect(); if (_r.bottom > window.innerHeight) window.scrollBy({ top: _r.bottom - window.innerHeight + 50, behavior: 'smooth' }); }
                await sleep(randomInt(700, 1200));
                __markFanProcessed(currentBlogger, handle);
                return 'filtered';
            }
        }

        // 获取用户设置的总间隔时间
        const followInterval = getFollowInterval();
        const totalInterval = randomInt(followInterval.min, followInterval.max);
        
        // 固定开销：滚动(0.3s) + 风控检测(2s) = 约2.3s
        const FIXED_OVERHEAD = 2300;
        
        // 深度阅读时间 = 总间隔 - 固定开销（最少1秒）
        const readIntroWait = Math.max(1000, totalInterval - FIXED_OVERHEAD - randomInt(500, 1500));
        { const _r = cell.getBoundingClientRect(); if (_r.bottom > window.innerHeight) window.scrollBy({ top: _r.bottom - window.innerHeight + 50, behavior: 'smooth' }); }
        await sleep(300);
        updateStats(`📖 阅读简介 (${Math.round(readIntroWait/1000)}s)...`);
        await sleep(readIntroWait);

        updateStats(`正在关注 @${handle} ...`);

        try {
            // 等待全局关注节奏槽位
            await humanPauseMaybe(10);
            await waitForGlobalFollowSlot();
            {
                const risk = typeof MatrixRisk !== "undefined" ? MatrixRisk.tryAcquire("follow", 1) : { ok: true };
                if (!risk.ok) {
                    const riskWait = Math.min(60000, Math.max(2000, risk.waitMs || 5000));
                    updateStats("频率令牌不足，等待后再关注...");
                    await sleep(riskWait);
                    return 'token_fail';
                }
            }
            // 轻总控拦截：关注前检查是否允许
            try {
                const opsCheck = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(null), 2000);
                    chrome.runtime.sendMessage({
                        action: "ops_activity_check",
                        payload: { account_handle: getWorkerId(), target_handle: handle, action_type: "follow" }
                    }, (resp) => { clearTimeout(timer); resolve(resp); });
                });
                if (opsCheck && opsCheck.allowed === false) {
                    updateStats(`⛔ 轻总控拦截 @${handle}: ${opsCheck.reason || "blocked"}`);
                    cell.setAttribute("data-matrix-processed", "true");
                    return "blocked";
                }
            } catch (e) { /* 后台不可达时放行 */ }

            // 点前先记进度：若误进粉丝主页被纠回，不会对同一人死循环
            try {
                cell.setAttribute('data-matrix-processed', 'true');
                __markFanProcessed(currentBlogger, handle);
            } catch (ePreMark) {}

            // 安全点击：只点按钮，阻止冒泡到 UserCell 头像/链接（否则会进 profile 触发整页纠偏）
            try {
                var clickOpts = { bubbles: true, cancelable: true, view: window };
                followBtn.dispatchEvent(new MouseEvent('pointerdown', clickOpts));
                followBtn.dispatchEvent(new MouseEvent('mousedown', clickOpts));
                followBtn.dispatchEvent(new MouseEvent('mouseup', clickOpts));
                followBtn.dispatchEvent(new MouseEvent('click', clickOpts));
            } catch (eClkSafe) {
                try { followBtn.click(); } catch (eClk2) {}
            }
            // 截断父级 <a> 导航：点击后若已离开粉丝列表，立刻 soft back
            try {
                if (!isOthersFollowersPage()) {
                    var pgNow = classifyPage();
                    if (pgNow.kind === 'profile' && pgNow.handle && pgNow.handle !== currentBlogger) {
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                            detail: { text: '⚠️ 关注点击后进了 @' + pgNow.handle + ' 主页，立即 back' }
                        }));
                        markStepChange();
                        sessionStorage.setItem('sg_follow_soft_back_at', String(Date.now()));
                        try { history.back(); } catch (eHb) {}
                    }
                }
            } catch (eNavGuard) {}
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '✅ 已点击关注: @' + handle } }));
            
            // 点击后风控检测（蓝条可能略晚出现，未确认前再扫一次）
            await sleep(2000);
            let postClickLimit = checkLimits();
            if (postClickLimit === 'FROZEN') {
                handleAccountFrozen('follow_post_click');
                return 'frozen';
            }
            if (postClickLimit === 'HARD') {
                if (typeof MatrixRisk !== "undefined") {
                    MatrixRisk.applyLimitBackoff("follow");
                }
                setMatrixCooldown(randomInt(3 * 3600000, 4 * 3600000));
                updateStats("触发最高风控！脚本已紧急熔断！");
                (window.__matrix_notify__ || ((m,t,d) => {}))('🚨 检测到推特最高风控，脚本已自动挂起保护账号！', 'error', 5000);
                stopBot();
                return 'hard_risk';
            } else if (postClickLimit === 'SOFT') {
            notifyFollowRoundEndAndFill('soft_post_click');
            return 'soft_cooldown';
            }

            // 仅确认变成「已关注」才计入日配额（跳过/过滤/未确认不计）
            var confirmBtn = followBtn;
            try {
                var foundAgain = __findFollowButton(cell);
                if (foundAgain && foundAgain.btn) confirmBtn = foundAgain.btn;
            } catch (eFind) {}
            var confirmState = __followBtnState(confirmBtn);
            if (confirmState.state !== 'already' && found.hint !== 'only_unfollow') {
                // 冻结常见表现：点了仍是「关注」+ 底部蓝条；绝不能当普通跳过
                await sleep(800);
                var unconfirmedLimit = checkLimits();
                if (unconfirmedLimit === 'FROZEN') {
                    handleAccountFrozen('follow_unconfirmed');
                    return 'frozen';
                }
                if (unconfirmedLimit === 'HARD') {
                    if (typeof MatrixRisk !== "undefined") {
                        MatrixRisk.applyLimitBackoff("follow");
                    }
                    setMatrixCooldown(randomInt(3 * 3600000, 4 * 3600000));
                    updateStats("触发最高风控！脚本已紧急熔断！");
                    stopBot();
                    return 'hard_risk';
                }
                if (unconfirmedLimit === 'SOFT') {
                    notifyFollowRoundEndAndFill('soft_unconfirmed');
                    return 'soft_cooldown';
                }
                updateStats(`⚠️ 已点击但未确认关注 @${handle}，不计配额`);
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⚠️ follow_unconfirmed @' + handle + ' ' + (confirmState.reason || '') }
                }));
                return 'follow_unconfirmed';
            }
            
            let count = incrementFollowCount();
            try { incBloggerFollowCount(currentBlogger); } catch (eInc) {}
            
            // 通过 reportToNAS 上报战报
            reportToNAS(handle, count, stats.day_count);
            
            // 设置下一次全局关注时间
            setNextGlobalFollowTime(totalInterval);

            updateStats(`✅ 已关注 @${handle} (${count}/${limit}) | 间隔 ${Math.round(totalInterval/1000)}s`);
            __markFanProcessed(currentBlogger, handle);
            return 'followed';
            
        } catch (e) {
            updateStats(`❌ 关注 @${handle} 失败`);
            return 'click_error';
        }
    }

    // ================= 【扫描页面（DeepSeek 简单逻辑）】 =================
    async function scanPage() {
        if (!isRunning) return;

        // 页≠锁：禁止在错误博主列表点关注（防 berkayt0 页锁 nana 类事故）
        try {
            var _scanCr = normalizeCr(localStorage.getItem('matrix_current_creator') || '');
            var _scanPage = classifyPage();
            if (_scanCr && _scanPage.kind === 'followers' && _scanPage.handle && _scanPage.handle !== _scanCr) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⛔ 拒绝扫描：页=@' + _scanPage.handle + ' 锁=@' + _scanCr + '，先对齐' }
                }));
                navigateToLockedCreator('scan_refuse_mismatch');
                return;
            }
        } catch (eScanAlign) {}

        const __scanStats = { already: 0, filtered: 0, followed: 0, error: 0, retry: 0, blocked: 0, no_btn: 0, skipped: 0 };

        // 取未处理的 cell
        const cells = document.querySelectorAll('[data-testid="UserCell"]:not([data-matrix-processed="true"])');
        const allCells = document.querySelectorAll('[data-testid="UserCell"]');
        const processedCells = document.querySelectorAll('[data-testid="UserCell"][data-matrix-processed="true"]');

        // 诊断：报告 cell 状态
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: `scanPage: 总${allCells.length} 已处理${processedCells.length} 未处理${cells.length}` }
        }));

        if (cells.length > 0) {
            // 有未处理的 cell，逐个处理
            for (const cell of cells) {
                if (!isRunning) return;

                // 跳过已处理 / 正在被占用的（防双引擎抢同一 cell）
                if (cell.getAttribute('data-matrix-processed') === 'true') continue;
                if (cell.getAttribute('data-matrix-busy') === 'true') continue;

                // 配额检查
                const stats = getAccountStats();
                const limit = getDailyLimit(stats.day_count);
                if (stats.follows_today >= limit) {
                    updateStats("今日配额已满，停止关注");
                    if (isSchedulerAutoMode()) {
                        await finishFollowQuotaForScheduler('quota_full_scan');
                    }
                    return;
                }

                // 认领后再 await，避免并发循环对同一行「阅读简介」后二次点击取关
                cell.setAttribute('data-matrix-busy', 'true');
                let result;
                try {
                    result = await handleFollowButton(cell);
                } finally {
                    cell.removeAttribute('data-matrix-busy');
                }

                if (result === 'already_followed') {
                    __scanStats.already++;
                    cell.style.cssText += 'opacity: 0.3 !important; filter: grayscale(100%) !important; border: 1px dashed #00ba7c;';
                    cell.setAttribute('data-matrix-processed', 'true');
                    window.scrollBy({ top: randomInt(35, 75), behavior: 'smooth' });
                    await sleep(randomInt(700, 1200));
                    continue;
                }

                if (result === 'unknown_btn_state') {
                    __scanStats.skipped++;
                    cell.style.cssText += 'opacity: 0.25 !important; filter: grayscale(100%) !important; border: 1px dashed orange;';
                    cell.setAttribute('data-matrix-processed', 'true');
                    window.scrollBy({ top: randomInt(35, 75), behavior: 'smooth' });
                    await sleep(randomInt(500, 900));
                    continue;
                }

                if (result === 'filtered') {
                    __scanStats.filtered++;
                    // handleFollowButton 已经标记了 processed
                    window.scrollBy({ top: randomInt(35, 75), behavior: 'smooth' });
                    await sleep(randomInt(700, 1200));
                    continue;
                }

                if (result === 'followed') {
                    __scanStats.followed++;
                    const rowHandle = cell.querySelector('a[href^="/"]')?.getAttribute('href')?.replace(/^\//, '') || '';
                    await reportOpsFollowResult(getWorkerId(), normalizeOpsTargetHandle(rowHandle), 'success', {
                        sourceUrl: location.href,
                        blogger_handle: String(localStorage.getItem('matrix_current_creator') || '').replace(/^@/, '').toLowerCase()
                    });
                    cell.setAttribute('data-matrix-processed', 'true');
                    // 操作完后小幅滚动
                    window.scrollBy({ top: randomInt(50, 80), behavior: 'smooth' });
                    await sleep(randomInt(1000, 1500));
                    continue;
                }

                // 点击了但未变成已关注：再扫冻结横幅，避免当成普通跳过
                if (result === 'follow_unconfirmed') {
                    var lateLimit = checkLimits();
                    if (lateLimit === 'FROZEN') {
                        handleAccountFrozen('scan_unconfirmed');
                        return;
                    }
                    if (lateLimit === 'HARD') {
                        setMatrixCooldown(randomInt(3 * 3600000, 4 * 3600000));
                        updateStats("触发最高风控！脚本已紧急熔断！");
                        stopBot();
                        return;
                    }
                    if (lateLimit === 'SOFT') {
                        notifyFollowRoundEndAndFill('soft_late_scan');
                        return;
                    }
                    __scanStats.error++;
                    const retryKey = 'data-matrix-retry-unconfirmed';
                    let retryCount = parseInt(cell.getAttribute(retryKey) || '0', 10) + 1;
                    cell.setAttribute(retryKey, String(retryCount));
                    if (retryCount >= 3) {
                        cell.setAttribute('data-matrix-processed', 'true');
                        cell.style.cssText += 'opacity: 0.2 !important; filter: grayscale(100%) !important; border: 1px dashed #f4212e;';
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                            detail: { text: '⚠️ 未确认关注，跳过（不计配额）重试' + retryCount }
                        }));
                    }
                    window.scrollBy({ top: randomInt(35, 75), behavior: 'smooth' });
                    await sleep(randomInt(800, 1400));
                    continue;
                }

                if (result === 'soft_cooldown') {
                    __scanStats.skipped++;
                    return;
                }

                if (result === 'blocked') {
                    __scanStats.blocked++;
                    cell.setAttribute('data-matrix-processed', 'true');
                    continue;
                }

                // 冻结 / 硬风控 / 停机：立刻退出扫描，禁止当「跳过」继续往下刷
                if (result === 'frozen' || result === 'hard_risk' || result === 'engine_stopped' || result === 'quota_full') {
                    __scanStats.skipped++;
                    cell.setAttribute('data-matrix-processed', 'true');
                    return;
                }

                if (result === 'click_error' || result === 'token_fail') {
                    __scanStats.error++;
                    cell.setAttribute('data-matrix-processed', 'true');
                    continue;
                }

                // === 可重试的临时错误：不标记processed，下次扫描重试 ===
                if (result === 'no_follow_btn' || result === 'no_user_link' || result === 'no_href' || result === 'no_handle') {
                    if (result === 'no_follow_btn') __scanStats.no_btn++;
                    else __scanStats.retry++;
                    const retryKey = 'data-matrix-retry';
                    let retryCount = parseInt(cell.getAttribute(retryKey) || '0', 10) + 1;
                    cell.setAttribute(retryKey, retryCount.toString());
                    if (retryCount >= 3) {
                        __scanStats.skipped++;
                        cell.setAttribute('data-matrix-processed', 'true');
                        cell.style.cssText += 'opacity: 0.2 !important; filter: grayscale(100%) !important;';
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                            detail: { text: '⚠️ ' + result + ': 重试' + retryCount + '次仍失败，标记跳过' }
                        }));
                    } else {
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                            detail: { text: '⏳ ' + result + ' 重试' + retryCount + '/3' }
                        }));
                    }
                    continue;
                }

                // 未知结果（兜底）
                __scanStats.skipped++;
                cell.setAttribute('data-matrix-processed', 'true');
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⚠️ 未知结果: ' + (result || 'undefined') + ', 已标记跳过' }
                }));
            }

            // 本轮统计
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: `scanPage统计: 已关注${__scanStats.followed} 已关${__scanStats.already} 过滤${__scanStats.filtered} 错误${__scanStats.error} 拦截${__scanStats.blocked} 无按钮${__scanStats.no_btn} 重试${__scanStats.retry} 跳过${__scanStats.skipped}` }
            }));

            // 本轮 0 次新关注 ≠ 博主做完：常见于回到已刷过一半的列表顶部（全是已关注）
            // 继续向下滚动找新粉；若已近底则走触底换号（回流半成品常见 0 新关注）
            if (__scanStats.followed === 0) {
                if (pageLooksFollowersShell()) {
                    var _zShell = await handleFollowersShellStall('zero_follow_shell');
                    if (_zShell && _zShell.released) return;
                    return;
                }
                var _zScrollH = document.documentElement.scrollHeight || 0;
                var _zScrollY = window.scrollY || 0;
                var _zInnerH = window.innerHeight || 0;
                var _zDist = _zScrollH - _zScrollY - _zInnerH;
                if (_zDist <= POOL_DONE_MAX_DIST_PX) {
                    document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                        detail: { text: '⬇️ 本轮0关注且已近底 dist=' + Math.round(_zDist) + '，尝试触底换号' }
                    }));
                    var _zFin = await tryFinishBloggerAtBottom('zero_follow_near_bottom');
                    if (_zFin) return;
                }
                updateStats("本轮无新关注（多为已关注/过滤），继续向下寻找...");
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⬇️ 本轮0关注但不换博主: already=' + __scanStats.already + ' filtered=' + __scanStats.filtered + ' skipped=' + __scanStats.skipped }
                }));
                window.scrollBy({ top: randomInt(250, 400), behavior: 'smooth' });
                await sleep(randomInt(2000, 3500));
                return;
            }
        } else {
            // 0 cell：优先识别保护号空态，禁止滚动空刷来回跳
            if (await skipProtectedBloggerIfNeeded('scan_zero_cell')) return;
            if (pageLooksFollowersShell()) {
                var _0Shell = await handleFollowersShellStall('scan_zero_cell_shell');
                if (_0Shell && _0Shell.released) return;
                return;
            }
            // 没有未处理的 cell，向下滚动找新的
            updateStats("向下寻找新粉中...");
            let scrollAttempts = 0;
            let foundNewContent = false;
            while (scrollAttempts < 3 && !foundNewContent) {
                let beforeScroll = window.scrollY;
                window.scrollBy({ top: randomInt(250, 400), behavior: 'smooth' });
                await sleep(randomInt(2500, 4000));
                let afterScroll = window.scrollY;
                if (Math.abs(afterScroll - beforeScroll) >= 10) {
                    foundNewContent = true;
                } else {
                    scrollAttempts++;
                    if (scrollAttempts < 3) {
                        updateStats("滚动未变化，等待内容加载 (第" + (scrollAttempts + 1) + "次)...");
                        await sleep(randomInt(3000, 5000));
                    }
                }
            }
            if (!foundNewContent) {
                // 白壳滚动不动：禁 list_refresh_stuck 连环换号
                if (pageLooksFollowersShell()) {
                    var _shellStuck = await handleFollowersShellStall('scroll_stuck_shell');
                    if (_shellStuck && _shellStuck.released) return;
                    return;
                }
                var _fin = await tryFinishBloggerAtBottom('scroll_stuck');
                if (_fin) return;
                // 滚动多次仍无新内容 + 触底未通过：列表刷不出，勿空转关注（风控危险）→ 软风控养号
                var scrollStuckN = 0;
                try {
                    scrollStuckN = (parseInt(sessionStorage.getItem('sg_follow_scroll_stuck_n') || '0', 10) || 0) + 1;
                    sessionStorage.setItem('sg_follow_scroll_stuck_n', String(scrollStuckN));
                } catch (eSs) { scrollStuckN = 1; }
                if (scrollStuckN >= 4) {
                    try { sessionStorage.removeItem('sg_follow_scroll_stuck_n'); } catch (eClr) {}
                    updateStats('列表刷不出（滚动卡死×' + scrollStuckN + '）→ 换号续跑');
                    document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                        detail: { text: '🛡️ 列表刷新失败×' + scrollStuckN + ' → 换号（不进软风控）' }
                    }));
                    try { await releasePoolTask('list_refresh_stuck'); } catch (eRel) {}
                    handOffFollowRoundNoSoft('list_refresh_stuck');
                    return;
                }
                window.scrollBy({ top: randomInt(80, 180), behavior: 'smooth' });
                await sleep(randomInt(4000, 7000));
                return;
            }
            try { sessionStorage.setItem('sg_follow_scroll_stuck_n', '0'); } catch (eOk) {}
        }
    }


    // ================= 【诊断系统】 =================
    let _diagInterval = null;
    function startDiagnostic() {
        if (_diagInterval) return;
        _diagInterval = setInterval(() => {
            try {
                const allCells = document.querySelectorAll('[data-testid="UserCell"]');
                const processed = document.querySelectorAll('[data-testid="UserCell"][data-matrix-processed="true"]');
                const unprocessed = allCells.length - processed.length;
                const scrollY = window.scrollY;
                const scrollH = document.documentElement.scrollHeight;
                const innerH = window.innerHeight;
                const distBottom = scrollH - scrollY - innerH;
                const step = localStorage.getItem('matrix_step') || 'SCAN';
                const running = typeof isRunning !== 'undefined' ? isRunning : false;
                const blogger = localStorage.getItem('matrix_current_creator') || '无';
                const stats = getAccountStats();
                const limit = getDailyLimit(stats.day_count);

                // 风控状态
                const cooldownUntil = getMatrixCooldownUntil();
                const now = Date.now();
                const isCooling = now < cooldownUntil;
                const cooldownRemaining = isCooling ? cooldownUntil - now : 0;
                const nextFollowTime = getNextGlobalFollowTime();
                const isWaiting = now < nextFollowTime;
                const waitRemaining = isWaiting ? nextFollowTime - now : 0;

                let riskStatus = 'NORMAL';
                if (isCooling) {
                    riskStatus = cooldownRemaining > 2 * 3600000 ? 'HARD' : 'SOFT';
                }

                const diag = [
                    `🔍 诊断 | 引擎:${running ? 'ON' : 'OFF'} | 步骤:${step}`,
                    `📊 Cell: 总${allCells.length} 已处理${processed.length} 未处理${unprocessed}`,
                    `📜 滚动: Y=${scrollY} H=${scrollH} 距底${distBottom}px`,
                    `👤 博主: @${blogger} | 配额: ${stats.follows_today}/${limit}`,
                    `🛡️ 风控: ${riskStatus}${isCooling ? ' 剩余' + formatCooldownTime(cooldownRemaining) : ''}${isWaiting ? ' | 间隔等待' + Math.ceil(waitRemaining/1000) + 's' : ''}`
                ].join(' | ');

                console.log('[诊断]', diag);
                // 通过自定义事件传递给中控台（结构化数据）
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: {
                        text: diag,
                        engine: running,
                        step: step,
                        cells: { total: allCells.length, processed: processed.length, unprocessed: unprocessed },
                        scroll: { y: scrollY, height: scrollH, distBottom: distBottom },
                        quota: { used: stats.follows_today, limit: limit, dayCount: stats.day_count },
                        risk: {
                            status: riskStatus,
                            cooling: isCooling,
                            cooldownRemaining: cooldownRemaining,
                            cooldownFormatted: isCooling ? formatCooldownTime(cooldownRemaining) : null,
                            waiting: isWaiting,
                            waitRemaining: waitRemaining
                        },
                        blogger: blogger,
                        timestamp: Date.now()
                    }
                }));
            } catch(e) {
                console.error('[诊断错误]', e);
            }
        }, 10000); // 每10秒输出一次
    }

    function stopDiagnostic() {
        if (_diagInterval) { clearInterval(_diagInterval); _diagInterval = null; }
    }

    function isOthersFollowersPage() {
        const path = window.location.pathname;
        if (!path.includes('/followers') && !path.includes('/verified_followers') && !path.includes('/followers_you_follow')) return false;
        
        // 获取当前页面的博主 handle
        const pathHandle = path.split('/')[1];
        if (!pathHandle) return false;
        
        // 获取我的 handle
        const myHandle = getMyHandle();
        
        // 如果我的 handle 未知，可能是首次使用，允许启动
        if (!myHandle || myHandle === '未知账号') {
            console.log('[Follow] 无法确定当前用户，但在粉丝页面，允许启动');
            return true;
        }
        
        // 如果是我的粉丝页面，不允许启动
        if (pathHandle === myHandle) {
            return false;
        }
        
        return true;
    }


    // ==================== [Nurture - Scheduled Check] ====================
    function getNurtureSessionsToday() {
        const handle = getMyHandle();
        const nurtureKey = `matrix_nurture_sessions_${handle}`;
        try {
            const data = JSON.parse(localStorage.getItem(nurtureKey) || '{"date":"","sessions":0,"lastTime":0}');
            const today = getBeijingDateString();
            if (data.date !== today) {
                const fresh = { date: today, sessions: 0, lastTime: 0 };
                localStorage.setItem(nurtureKey, JSON.stringify(fresh));
                return fresh;
            }
            return data;
        } catch (e) { return { date: '', sessions: 0, lastTime: 0 }; }
    }

    function incrementNurtureSessionsToday() {
        const handle = getMyHandle();
        const nurtureKey = `matrix_nurture_sessions_${handle}`;
        const data = getNurtureSessionsToday();
        data.sessions++;
        data.lastTime = Date.now();
        localStorage.setItem(nurtureKey, JSON.stringify(data));
    }

    function checkScheduledNurture() {
        const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
        const sessionsPerDay = settings.nurtureSessionsPerDay ?? 3;
        if (!sessionsPerDay || sessionsPerDay <= 0) return false;

        const data = getNurtureSessionsToday();
        if (data.sessions >= sessionsPerDay) return false;

        // 按10小时活动窗口分摊间隔
        const ACTIVE_HOURS = 10;
        const intervalMs = Math.max(30 * 60000, (ACTIVE_HOURS * 3600000) / sessionsPerDay);

        if (data.lastTime > 0 && Date.now() - data.lastTime < intervalMs) return false;

        return true;
    }

    // ==================== [Soft Risk Diversion]（B4 → follow/soft-risk.js）====================
    function canEnterSoftRiskChat() {
        return !!(window.SgSoftRisk && window.SgSoftRisk.canEnterSoftRiskChat && window.SgSoftRisk.canEnterSoftRiskChat());
    }
    function enterSoftRiskDiversion(reason) {
        if (window.SgSoftRisk && window.SgSoftRisk.enterSoftRiskDiversion) {
            window.SgSoftRisk.enterSoftRiskDiversion(reason);
            return;
        }
        updateStats('软风控模块未加载');
    }
    function bindSgSoftRiskHooks() {
        if (!window.SgSoftRisk || typeof window.SgSoftRisk.bind !== 'function') return;
        window.SgSoftRisk.bind({
            rand: __nr_rand,
            updateStats: updateStats,
            stopBot: stopBot,
            isRunning: function () { return !!isRunning; },
            getAccountStats: getAccountStats,
            getDailyLimit: getDailyLimit
        });
    }
    try { bindSgSoftRiskHooks(); } catch (eBindSr) {}

    // ==================== [Nurture - Navigate to Home for Warmup] ====================
    function navigateToHomeForWarmup(reason, durationMinutes) {
        const dur = durationMinutes || 5;
        updateStats('\u77ac\u95f4\u505c\u6b62: ' + reason);
        try {
            var sgSt = JSON.parse(localStorage.getItem('sg_state') || '{}');
            sgSt.followNextDelayUntil = Date.now() + dur * 60000;
            localStorage.setItem('sg_state', JSON.stringify(sgSt));
            var msPf = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
            msPf.running = false; msPf.lastActive = Date.now();
            sessionStorage.setItem('sg_module_follow', JSON.stringify(msPf));
        } catch (e) {}
        stopBot();
    }

    // ==================== [Nurture - Run Warmup on /home] ====================
    function runHomeWarmup(durationMs) {
        if (__nurtureState.running || !isRunning) return;
        __nurtureState.running = true;
        // warmup_needed 保留到养号完成后才删除，防止期间页面刷新导致引擎丢失
        const endTime = Date.now() + durationMs;
        const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
        const likeTarget = __nr_rand(settings.nurtureLikeMin || 1, settings.nurtureLikeMax || 3);
        // 软窗默认不评（0）；显式配置 nurtureCommentMin/Max 才评
        var _cMin = (settings.nurtureCommentMin != null) ? Number(settings.nurtureCommentMin) : 0;
        var _cMax = (settings.nurtureCommentMax != null) ? Number(settings.nurtureCommentMax) : 0;
        if (isNaN(_cMin)) _cMin = 0;
        if (isNaN(_cMax)) _cMax = 0;
        const commentTarget = __nr_rand(_cMin, _cMax);
        const enterTarget = __nr_rand(settings.nurtureEnterMin || 1, settings.nurtureEnterMax || 3);
        const actionInterval = (settings.nurtureInterval || settings.nurtureActionInterval || 45) * 1000;

        updateStats('\u517b\u53f7\u4e2d... \u70b9\u8d5e:' + likeTarget + ' \u8bc4\u8bba:' + commentTarget + ' \u8fdb\u5e16:' + enterTarget);

        (async () => {
            let lastActionTime = 0;
            const nurtureHeartbeat = setInterval(() => {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '💚 养号心跳: likes=' + __nurtureState.likesDone + '/' + likeTarget + ' comments=' + __nurtureState.commentsDone + '/' + commentTarget + ' enters=' + __nurtureState.entersDone + '/' + enterTarget + ' 浏览=' + __nurtureState.browseCount + ' 失败=' + __nurtureState.failCount + ' 剩余=' + Math.round(Math.max(0, endTime - Date.now()) / 1000) + 's' }
                }));
            }, 60000);
            while (Date.now() < endTime && __nurtureState.running) {
                const now = Date.now();
                if (now - lastActionTime < actionInterval) {
                    await __nr_sleep(__nr_rand(2000, 5000));
                    continue;
                }
                const roll = Math.random();
                if (__nurtureState.likesDone < likeTarget && roll < 0.25) {
                    await __nr_actionLike();
                } else if (__nurtureState.commentsDone < commentTarget && roll < 0.08) {
                    var _cOk = true;
                    try {
                        if (typeof NurtureTracker !== 'undefined' && NurtureTracker.canCommentNow) {
                            _cOk = !!NurtureTracker.canCommentNow();
                        } else {
                            var _lastC = parseInt(localStorage.getItem('sg_nurture_last_comment_at') || '0', 10) || 0;
                            if (_lastC > 0 && Date.now() - _lastC < 45 * 60000) _cOk = false;
                        }
                    } catch (eCd) {}
                    if (_cOk) await __nr_actionComment();
                } else if (__nurtureState.entersDone < enterTarget && roll < 0.60) {
                    await __nr_actionEnter();
                } else {
                    await __nr_actionBrowse();
                }
                lastActionTime = Date.now();
                renderFollowPanel();
            }
            clearInterval(nurtureHeartbeat);
            __nurtureState.running = false;
            // 若引擎已被用户手动停止，不再执行后续导航
            if (!isRunning) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '⚠️ 养号中途停止: likes=' + __nurtureState.likesDone + ' comments=' + __nurtureState.commentsDone + ' enters=' + __nurtureState.entersDone + ' fails=' + __nurtureState.failCount + ', 待恢复' }
                }));
                return;
            }
            // 软风控填窗内的养号结束：禁止写回 matrix_follow_running（否则调度狂清幽灵旗标）
            var _inSoftFill = false;
            try {
                var _sgFill = JSON.parse(localStorage.getItem('sg_state') || '{}');
                _inSoftFill = !!( _sgFill.softRiskUntil && Date.now() < _sgFill.softRiskUntil );
            } catch (eSf) {}
            if (_inSoftFill || sessionStorage.getItem('matrix_tab_running') === 'soft_fill') {
                try { localStorage.removeItem('matrix_follow_running'); } catch (eClrF) {}
                updateStats('养号完成（软风控余窗），等待调度恢复关注');
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '💚 软风控余窗养号结束，不抢 follow 旗标' }
                }));
                return;
            }
            updateStats('\u517b\u53f7\u5b8c\u6210\uff0c\u8fd4\u56de\u7c89\u4e1d\u5217\u8868...');
            const savedCreator = localStorage.getItem('matrix_warmup_saved_creator');
            localStorage.removeItem('matrix_warmup_needed');
            localStorage.removeItem('matrix_warmup_end_time');
            localStorage.removeItem('matrix_warmup_reason');
            localStorage.removeItem('matrix_warmup_duration');
            localStorage.setItem('matrix_follow_running', 'true');
            localStorage.setItem('matrix_step', 'SCAN');
            if (savedCreator) {
                setTimeout(function () { if (isRunning) followGoWhenAllowed('https://x.com/' + savedCreator + '/followers'); }, 2000);
            } else if (localStorage.getItem('matrix_pure_nurture_mode') === 'true') {
                updateStats('\u517b\u53f7\u5b8c\u6210\uff0c\u56de\u4e3b\u9875\u4f11\u606f...');
                setTimeout(function () { if (isRunning) followGoWhenAllowed('https://x.com/home'); }, 2000);
            } else {
                setTimeout(function () {
                    if (!isRunning) return;
                    const cr = localStorage.getItem('matrix_current_creator') || '';
                    if (cr) followGoWhenAllowed('https://x.com/' + cr + '/followers');
                    else stopBot();
                }, 2000);
            }
        })();
    }
async function runEngine() {
        if (_engineLoopRunning) {
            console.log('[Follow] 引擎循环已在运行，忽略重复启动');
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                detail: { text: '⚠️ 忽略重复 runEngine（防止双击取关）' }
            }));
            return;
        }
        try { sessionStorage.removeItem('sg_follow_recover_count'); } catch (eRc) {}
        _engineLoopRunning = true;
        var myToken = ++_engineToken;
        let stepStartTime = Date.now();
        const STEP_TIMEOUT = 45000; // 45秒超时
        
        try {
        while (isRunning && myToken === _engineToken) {
            try {
                // 纯养号模式：仅定时养号，不关注
                const isPureNurture = localStorage.getItem('matrix_pure_nurture_mode') === 'true';
                if (isPureNurture) {
                    if (checkScheduledNurture()) {
                        const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
                        const dur = __nr_rand(15, 17);
                        incrementNurtureSessionsToday();
                        const sessionsData = getNurtureSessionsToday();
                        updateStats(`📅 纯养号模式 (今日第${sessionsData.sessions}次)`);
                        navigateToHomeForWarmup('pure_nurture_scheduled', dur);
                        return;
                    }
                    const _nsData = getNurtureSessionsToday();
                    const _nsSettings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
                    const _nsTarget = _nsSettings.nurtureSessionsPerDay ?? 3;
                    if (_nsData.sessions >= _nsTarget) {
                        updateStats("纯养号完成，今日任务全部达成");
                        localStorage.removeItem('matrix_pure_nurture_mode');
                        stopBot();
                        return;
                    }
                    for (let __idle = 0; __idle < 12 && isRunning && myToken === _engineToken; __idle++) {
                        await sleep(10000);
                    }
                    if (!isRunning || myToken !== _engineToken) return;
                    continue;
                }

                // 页面漂移自检：当前页面与步骤期望不符时纠错（防跨页误跑/页面被抢）
                var _ddCr = localStorage.getItem('matrix_current_creator') || '';
                if (_ddCr && !isPureNurture) {
                    var _ddPage = classifyPage();
                    var _ddStep = localStorage.getItem('matrix_step') || 'SCAN';
                    var _ddExp = expectedPageFor(_ddCr, _ddStep);
                    var _ddMatch = _ddExp && _ddExp.kind === _ddPage.kind && _ddExp.handle === _ddPage.handle;
                    if (!_ddMatch) {
                        // 页面与任务不符：先纠错
                        var _ddAct = handlePageDrift({ allowWait: true });
                        if (_ddAct === 'soft') {
                            // history.back 不重载：等回列表后续跑，禁止杀引擎
                            await sleep(1500);
                            continue;
                        }
                        if (_ddAct === 'hard' || _ddAct === true) {
                            // followGo 整页跳转：结束本循环，等新页注入后重启
                            isRunning = false;
                            _engineLoopRunning = false;
                            return;
                        }
                        // 其他模块持页或加载中：短暂等候
                        await sleep(2000);
                        continue;
                    }
                }

                // 步骤超时保护：如果同一步骤超过45秒，强制推进
                let currentStep = localStorage.getItem('matrix_step') || 'SCAN';
                if (Date.now() - stepStartTime > STEP_TIMEOUT) {
                    console.log(`[Follow] 步骤 ${currentStep} 超时 (${Math.round((Date.now() - stepStartTime)/1000)}s)，强制推进`);
                    
                    if (currentStep === 'PROFILE') {
                        // PROFILE 超时：直接跳到粉丝列表
                        const cr = localStorage.getItem('matrix_current_creator') || '';
                        if (cr) {
                            updateStats(`⏱️ 主页浏览超时，直接进入 @${cr} 粉丝列表...`);
                            // 超时前检查是否是敏感/隐私/不存在
                            const _tBody = document.body ? document.body.textContent : '';
                            if (_tBody.includes('このアカウントは存在しません') || _tBody.includes('Account suspended')
                                || /账号不存在|帳戶不存在|This account doesn'?t exist/i.test(_tBody)) {
                                markHandleCompleted(cr); await markPoolTaskDead(); await jumpToNextBloggerAfterDeadSkip(); return;
                            }
                            if (isProtectedProfileText(_tBody) || pageLooksProtected()) {
                                markHandleCompleted(cr); await markPoolTaskDead(); await jumpToNextBloggerAfterDeadSkip(); return;
                            }
                            // 超时仍无本博粉丝链接：慢网常见 → 释放不 dead
                            var _toWait = await waitForBloggerFollowersLink(cr, 10000);
                            if (_toWait.protected) {
                                markHandleCompleted(cr); await markPoolTaskDead(); await jumpToNextBloggerAfterDeadSkip(); return;
                            }
                            if (!_toWait.link) {
                                updateStats('⏱️ @' + cr + ' 超时且无粉丝入口，释放换号（不标死号）');
                                await skipBloggerSoftFail('profile_timeout_no_link');
                                return;
                            }
                            localStorage.setItem('matrix_step', 'SCAN');
                            localStorage.setItem('matrix_follow_running', 'true');
                            markStepChange();
                            followGo(`https://x.com/${cr}/followers`);
                            return;
                        }
                    }
                    
                    // 其他步骤超时：重置 step
                    stepStartTime = Date.now();
                }
                
                // 配额检查
                const stats = getAccountStats();
                const limit = getDailyLimit(stats.day_count);
                if (stats.follows_today >= limit) {
                    // 自动模式：交回调度开养号（勿占 follow_running 进纯养号旁路）
                    if (isSchedulerAutoMode()) {
                        await finishFollowQuotaForScheduler('quota_full');
                        return;
                    }
                    const _qNsData = getNurtureSessionsToday();
                    const _qNsSettings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
                    const _qNsTarget = _qNsSettings.nurtureSessionsPerDay ?? 3;
                    if (_qNsTarget > 0 && _qNsData.sessions < _qNsTarget) {
                        await releasePoolTask('quota_full_pure_nurture');
                        localStorage.setItem('matrix_pure_nurture_mode', 'true');
                        updateStats("配额达成，转入纯养号模式");
                        setTimeout(function() { if (isRunning) followGoWhenAllowed('https://x.com/home'); }, 1000);
                        return;
                    }
                    updateStats("今日总目标达成！下班");
                    try {
                        var sgSq = JSON.parse(localStorage.getItem('sg_state') || '{}');
                        sgSq.followNextDelayUntil = Date.now() + 8 * 60 * 60 * 1000;
                        localStorage.setItem('sg_state', JSON.stringify(sgSq));
                        var msQ = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
                        msQ.running = false;
                        msQ.phase = 'quota_exhausted';
                        msQ.lastActive = Date.now();
                        sessionStorage.setItem('sg_module_follow', JSON.stringify(msQ));
                    } catch (e) {}
                    stopBot();
                    return;
                }

                // 矩阵级冷却检查（只在非 PROFILE 步骤时生效）
                let globalCooldown = getMatrixCooldownUntil();
                if (Date.now() < globalCooldown && currentStep !== 'PROFILE') {
                    let remaining = Math.round((globalCooldown - Date.now()) / 1000);
                    updateStats(`矩阵级冷却中，剩余 ${remaining}s`);
                    await sleep(Math.min(20000, remaining * 1000));
                    continue;
                }
                
                // 如果是 PROFILE 步骤但有冷却，清除冷却继续执行
                if (currentStep === 'PROFILE' && Date.now() < globalCooldown) {
                    console.log('[Follow] PROFILE 步骤，清除旧冷却数据');
                    localStorage.removeItem('matrix_global_cooldown_until');
                }

                // 风控检测（休眠恢复后首次跳过，避免误判残留弹窗）
                let startLimit = (localStorage.getItem('matrix_skip_limit_check') === 'true') ? null : checkLimits();
                localStorage.removeItem('matrix_skip_limit_check');
                if (startLimit === 'FROZEN') {
                    handleAccountFrozen('follow_loop_start');
                    return;
                }
                if (startLimit === 'HARD') {
                    setMatrixCooldown(randomInt(3 * 3600000, 4 * 3600000));
                    updateStats("触发最高风控！脚本已紧急熔断！");
                    (window.__matrix_notify__ || ((m,t,d) => {}))('🚨 检测到推特最高风控，脚本已自动挂起保护账号！', 'error', 5000);
                    try {
                        var sgSh = JSON.parse(localStorage.getItem('sg_state') || '{}');
                        sgSh.followNextDelayUntil = Date.now() + 30 * 60 * 1000;
                        localStorage.setItem('sg_state', JSON.stringify(sgSh));
                        var msW = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
                        msW.running = false;
                        msW.lastActive = Date.now();
                        sessionStorage.setItem('sg_module_follow', JSON.stringify(msW));
                    } catch (e) {}
                    stopBot();
                    return;
                } else if (startLimit === 'SOFT') {
                    if (isSchedulerAutoMode()) {
                        notifyFollowRoundEndAndFill('soft_start_limit');
                    } else {
                        const dur = __nr_rand(15, 17);
                        navigateToHomeForWarmup('soft_start_limit', dur);
                    }
                    return;
                }

                // 定时养号检查：每日定期养号（非风控触发）；自动模式由协调器填窗分流养号
                if (!isSchedulerAutoMode() && checkScheduledNurture()) {
                    const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
                    const dur = __nr_rand(15, 17);
                    incrementNurtureSessionsToday();
                    const sessionsData = getNurtureSessionsToday();
                    updateStats(`📅 定时养号 (今日第${sessionsData.sessions}次)`);
                    navigateToHomeForWarmup('scheduled_nurture', dur);
                    return;
                }

                let step = localStorage.getItem('matrix_step') || 'SCAN';

                // PROFILE 步骤：伪装浏览博主主页
                if (step === 'PROFILE') {
                    const cr = localStorage.getItem('matrix_current_creator') || '';

                    // 前置拦截：本地死号名单只跳过/释放，禁止二次 pool_dead（服务端已复活时误杀）
                    if (cr && isHandleInDeadList(cr)) {
                        updateStats(`💀 @${cr} 已在本地死号名单，跳过（不二次上报）`);
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '💀 死号名单命中 @' + cr + '，释放换号不二次 dead' } }));
                        try { await releasePoolTask('local_dead_skip'); } catch (eLoc) {}
                        localStorage.removeItem('matrix_current_task_id');
                        localStorage.removeItem('matrix_current_task_assigned_at');
                        try { clearBloggerFollowCount(cr); } catch (eClr) {}
                        await sleep(1000);
                        await jumpToNextBloggerAfterDeadSkip();
                        return;
                    }

                    updateStats(`📖 阅读 @${cr} 主页中...`);

                    // 进主页先多等一拍（比特/慢网），避免保护号空态未挂上就误判
                    await sleep(4000);
                    if (await skipProtectedBloggerIfNeeded('profile_early')) return;

                    // ====== 敏感资料/隐私账号/不存在账号检测 ======
                    const _pageBody = document.body ? document.body.textContent : '';
                    // 检测敏感资料：cwcSheetDialog弹窗 + empty_state_button_text确认按钮
                    const _hasCwcSheet = !!document.querySelector('[data-testid="cwcSheetDialog"]');
                    const _emptyStateBtn = document.querySelector('[data-testid="empty_state_button_text"]');
                    const _emptyBtnText = _emptyStateBtn ? _emptyStateBtn.textContent.trim() : '';
                    const _mainText = document.querySelector('main') ? document.querySelector('main').textContent : '';
                    const _hasSensitive = _hasCwcSheet || (_emptyBtnText.indexOf('查看') >= 0 && _mainText.indexOf('敏感') >= 0);
                    const _hasProtected = isProtectedProfileText(_mainText) || isProtectedProfileText(_pageBody) || pageLooksProtected();

                    // 检测封禁：检查main区域
                    const _hasSuspended = (_mainText.includes('このアカウントは凍結') || _mainText.includes('このアカウントは違反')
                        || _mainText.includes('Account has been suspended') || /账号已被冻结|帳戶已被凍結|已被停用/.test(_mainText));

                    // 检测不存在：检查main区域
                    const _hasNotFound = (_mainText.includes('このアカウントは存在しません') || _mainText.includes("This account doesn't exist")
                        || _mainText.includes('account has been withheld') || /账号不存在|帳戶不存在/.test(_mainText));

                    if (_hasNotFound || _hasSuspended) {
                        const _reason = _hasNotFound ? '账号不存在' : '账号已封禁';
                        updateStats(`⛔ @${cr} ${_reason}，标记为死号`);
                        markHandleCompleted(cr);
                        await markPoolTaskDead();
                        await sleep(2000);
                        await jumpToNextBloggerAfterDeadSkip();
                        return;
                    }

                    if (_hasSensitive) {
                        updateStats(`⚠️ @${cr} 敏感资料，点击确认...`);
                        const _viewBtns = Array.from(document.querySelectorAll('button'));
                        const _viewBtn = _viewBtns.find(b => {
                            const t = b.textContent.trim();
                            return t.includes('プロフィールを表示') || t.includes('View profile') ||
                                   t.includes('显示个人资料') || t.includes('顯示個人資料') ||
                                   t.includes('表示する') || t.includes('このプロフィールを表示');
                        });
                        if (_viewBtn) {
                            _viewBtn.click();
                            await sleep(3000);
                        }
                        updateStats(`✅ @${cr} 敏感资料已确认`);
                    }

                    if (_hasProtected) {
                        updateStats(`🔒 @${cr} 是隐私账号，标记为死号`);
                        markHandleCompleted(cr);
                        await markPoolTaskDead();
                        await sleep(2000);
                        await jumpToNextBloggerAfterDeadSkip();
                        return;
                    }

                    const _fWait = await waitForBloggerFollowersLink(cr, 14000);
                    if (_fWait.protected) {
                        updateStats(`🔒 @${cr} 是隐私账号，标记为死号`);
                        markHandleCompleted(cr);
                        await markPoolTaskDead();
                        await sleep(2000);
                        await jumpToNextBloggerAfterDeadSkip();
                        return;
                    }
                    if (!_fWait.link) {
                        await skipBloggerSoftFail('profile_no_followers_link');
                        return;
                    }

                    
                    window.scrollBy({ top: randomInt(400, 800), behavior: 'smooth' });
                    await sleep(randomInt(3000, 5000));
                    
                    window.scrollBy({ top: randomInt(200, 400), behavior: 'smooth' });
                    await sleep(randomInt(2000, 3000));
                    
                    updateStats("↩️ 滑动至顶部...");
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    await sleep(randomInt(2000, 3000));
                    
                    updateStats(`🔄 进入 @${cr} 粉丝列表...`);
                    localStorage.setItem('matrix_step', 'SCAN');
                    localStorage.setItem('matrix_follow_running', 'true');
                    markStepChange();
                    // 优先点粉丝 Tab，减少硬跳握手
                    var _enterLink = findBloggerFollowersLink(cr);
                    if (_enterLink) {
                        try { _enterLink.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (eSv) {}
                        try { _enterLink.click(); } catch (eClkF) {}
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                            detail: { text: '👆 PROFILE→粉丝 Tab click @' + cr }
                        }));
                        await sleep(4500);
                        if (isOthersFollowersPage()) return;
                    }
                    followGo(`https://x.com/${cr}/followers`);
                    return;
                }
                
                // 步骤变化时重置计时器
                if (step !== currentStep) {
                    stepStartTime = Date.now();
                }
                
                if (step === 'SCAN') {
                    if (!isOthersFollowersPage()) {
                        // 不在粉丝页：检查是否在博主主页，如果是则切到 PROFILE 步骤
                        const cr = localStorage.getItem('matrix_current_creator') || '';
                        const curPath = window.location.pathname.toLowerCase().replace(/\/+$/, '');
                        if (cr && !RESERVED_PAGE_HANDLES[cr] && curPath === '/' + cr.toLowerCase()) {
                            // 隐私号硬跳 /followers 常被打回主页 → 来回跳；此处直接死号跳过
                            if (pageLooksProtected()) {
                                updateStats('🔒 @' + cr + ' 粉丝页不可进（保护号），跳过');
                                markHandleCompleted(cr);
                                await markPoolTaskDead();
                                await sleep(1500);
                                await jumpToNextBloggerAfterDeadSkip();
                                return;
                            }
                            // 链接偶发未挂上：慢网多等再判定，仅真保护号 dead
                            if (!findBloggerFollowersLink(cr)) {
                                var _kickWait = await waitForBloggerFollowersLink(cr, 12000);
                                if (_kickWait.protected) {
                                    updateStats('🔒 @' + cr + ' 粉丝页不可进（保护号），跳过');
                                    markHandleCompleted(cr);
                                    await markPoolTaskDead();
                                    await sleep(1500);
                                    await jumpToNextBloggerAfterDeadSkip();
                                    return;
                                }
                                if (!_kickWait.link) {
                                    await skipBloggerSoftFail('scan_kicked_no_link');
                                    return;
                                }
                            }
                            updateStats(`📖 检测到在 @${cr} 主页，切换到浏览模式...`);
                            localStorage.setItem('matrix_step', 'PROFILE');
                            continue;
                        }
                        // 未到目标页面时等待重试，不立即停止（X/Twitter 可能有中间加载页）
                        updateStats("等待跳转...");
                        await sleep(5000);
                        if (!isOthersFollowersPage()) {
                            const cr2 = localStorage.getItem('matrix_current_creator') || '';
                            const curPath2 = window.location.pathname.toLowerCase().replace(/\/+$/, '');
                            if (cr2 && !RESERVED_PAGE_HANDLES[cr2] && curPath2 === '/' + cr2.toLowerCase()) {
                                if (pageLooksProtected()) {
                                    updateStats('🔒 @' + cr2 + ' 粉丝页不可进，跳过');
                                    markHandleCompleted(cr2);
                                    await markPoolTaskDead();
                                    await sleep(1500);
                                    await jumpToNextBloggerAfterDeadSkip();
                                    return;
                                }
                                if (!findBloggerFollowersLink(cr2)) {
                                    var _kickWait2 = await waitForBloggerFollowersLink(cr2, 12000);
                                    if (_kickWait2.protected) {
                                        updateStats('🔒 @' + cr2 + ' 粉丝页不可进，跳过');
                                        markHandleCompleted(cr2);
                                        await markPoolTaskDead();
                                        await sleep(1500);
                                        await jumpToNextBloggerAfterDeadSkip();
                                        return;
                                    }
                                    if (!_kickWait2.link) {
                                        await skipBloggerSoftFail('scan_kicked2_no_link');
                                        return;
                                    }
                                }
                                localStorage.setItem('matrix_step', 'PROFILE');
                                continue;
                            }
                        }
                        continue;
                    }
                    // 粉丝列表页加载失败（出错了/重试）：慢网限流常见 → 软愈重试，满次 fail，禁止立刻 dead
                    if (pageLooksFollowersBroken()) {
                        var _brStall = await handleFollowersBrokenStall('scan_broken');
                        if (_brStall && _brStall.released) return;
                        continue;
                    }
                    try { sessionStorage.removeItem('sg_follow_broken_wait_n'); } catch (eBrOk) {}
                    // 保护号硬跳 /followers 后常停在「帖子受到保护」空页：必须 dead，禁止空刷来回跳
                    if (await skipProtectedBloggerIfNeeded('followers_scan')) return;
                    await scanPage();
                } else if (step === 'WAIT') {
                    await sleep(2000);
                }
            } catch (e) {
                console.error('[引擎错误]', e);
                updateStats(`❌ 错误: ${e.message}`);
                await sleep(3000);
            }
        }
        } finally {
            if (myToken === _engineToken) _engineLoopRunning = false;
        }
    }

    function stopBot(opts) {
        opts = opts || {};
        // 使进行中的 runEngine while 失效
        _engineToken++;
        _engineLoopRunning = false;
        // 释放当前 assigned 任务，避免任务卡死（配额满/硬风控/手动停均经此路径）
        // 软风控填窗（keepTask）保留任务锁：窗口结束后回当前博主续点，不换号
        if (!opts.keepTask) {
            var _tid = localStorage.getItem('matrix_current_task_id');
            var _cr = localStorage.getItem('matrix_current_creator') || '';
            if (_tid) {
                poolFail(_tid).catch(function(){});
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '🔓 stopBot 释放号池任务 #' + _tid }
                }));
            }
            localStorage.removeItem('matrix_current_task_id');
            localStorage.removeItem('matrix_current_task_assigned_at');
            if (_cr) clearBloggerFollowCount(_cr);
        }
        stopDiagnostic();
        isRunning = false;
        __nurtureState.running = false;  // 终止正在运行的养号循环
        try {
            var ms = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}');
            ms.running = false;
            ms.lastActive = Date.now();
            sessionStorage.setItem('sg_module_follow', JSON.stringify(ms));
        } catch (e) {}
        cancelAllFollowSleep();
        // keepTask=软窗填窗：必须保留 soft_fill，否则关注自恢复会在软窗内抢跑，养号永远启不起来
        if (opts.keepTask) {
            sessionStorage.setItem('matrix_tab_running', 'soft_fill');
        } else {
            sessionStorage.setItem('matrix_tab_running', 'false');
        }
        localStorage.removeItem('matrix_follow_running');
        if (!opts.keepTask) {
            localStorage.removeItem('matrix_step');
            localStorage.removeItem('matrix_auto_step');
            localStorage.removeItem('matrix_current_creator');
            localStorage.removeItem('matrix_global_cooldown_until');
            localStorage.removeItem('matrix_global_next_follow_time');
        }
        localStorage.removeItem('matrix_pure_nurture_mode');
        localStorage.removeItem('matrix_warmup_needed');
        localStorage.removeItem('matrix_warmup_end_time');
        localStorage.removeItem('matrix_warmup_reason');
        localStorage.removeItem('matrix_warmup_duration');
        localStorage.removeItem('matrix_warmup_saved_creator');
        localStorage.removeItem('matrix_warmup_saved_step');
        batchManager.clearBatch();
        releaseLock();
        updateStats("引擎已手动或风控停止");
        
        // 通知中控台：引擎已停止
        document.dispatchEvent(new CustomEvent('matrix-follow-status', {
            detail: { running: false, status: 'stopped', message: '引擎已停止' }
        }));
    }

    // stopBot / isRunning 就绪后再绑一次，确保 B4 宿主依赖完整
    try {
        if (window.SgPoolApi && window.SgPoolApi.bind) {
            window.SgPoolApi.bind({ getWorkerId: typeof getWorkerId === 'function' ? getWorkerId : null });
        }
    } catch (ePoolBind) {}
    try { bindSgSoftRiskHooks(); } catch (eBindSr2) {}

    // ================= 【自动启动】 =================
    function tryAutoStart() {
    // Resume warmup if needed
    if (localStorage.getItem('matrix_warmup_needed') === 'true' && window.location.pathname === '/home') {
        const endTime = parseInt(localStorage.getItem('matrix_warmup_end_time') || '0', 10) || 0;
        const defaultDur = parseInt(localStorage.getItem('matrix_warmup_duration') || '5', 10) || 5;
        const remainingMs = endTime > 0 ? Math.max(60000, endTime - Date.now()) : defaultDur * 60000;
        isRunning = true;
        sessionStorage.setItem('matrix_tab_running', 'true');
        localStorage.setItem('matrix_follow_running', 'true');
        updateFollowButtonState();
        startDiagnostic();
        setTimeout(() => runHomeWarmup(remainingMs), 2000);
        return true;
    }
    if (localStorage.getItem('matrix_warmup_needed') === 'true') { return false; }

    // S0: 自动模式下禁止脱离调度自启；仅当调度已授权 follow（或中途 warmup）才恢复
    if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode()) {
        var _warm = localStorage.getItem('matrix_warmup_needed') === 'true';
        if (!SchedulerGate.isModuleOn('follow') && !_warm) {
            return false;
        }
    } else {
      // 兼容无 Gate 时旧逻辑
      var _sgAuto = false;
      try { _sgAuto = !!(JSON.parse(localStorage.getItem('sg_state') || '{}').running); } catch (e) {}
      if (_sgAuto) {
        var _modF = {};
        try { _modF = JSON.parse(sessionStorage.getItem('sg_module_follow') || '{}'); } catch (e2) {}
        if (_modF.running !== true || localStorage.getItem('matrix_follow_running') !== 'true') {
            return false;
        }
      }
    }

    // 纯养号模式：在 /home 页面恢复养号循环
    const isPureNurture = localStorage.getItem('matrix_pure_nurture_mode') === 'true';
    if (isPureNurture && window.location.pathname === '/home' && localStorage.getItem('matrix_follow_running') === 'true') {
        if (_engineLoopRunning || isRunning) return true;
        isRunning = true;
        sessionStorage.setItem('matrix_tab_running', 'true');
        updateFollowButtonState();
        startDiagnostic(); runEngine();
        return true;
    }
    if (isPureNurture) { return false; }

    if (sessionStorage.getItem('matrix_tab_running') === 'stopped_by_user') return false;
    if (sessionStorage.getItem('matrix_tab_running') === 'soft_fill') return false;

    // 恢复兜底：关注已授权 + 有锁博主，但页面与步骤不匹配（卡在个人主页/首页等）→ 统一走漂移纠错
    const _rcCr = localStorage.getItem('matrix_current_creator') || '';
    if (_rcCr && !isRunning && !_engineLoopRunning) {
        if (handlePageDrift({ allowWait: true })) return true;
    }

    const savedCreator = localStorage.getItem('matrix_warmup_saved_creator');
    if (savedCreator && !RESERVED_PAGE_HANDLES[savedCreator] && window.location.pathname.includes('/followers') && !localStorage.getItem('matrix_warmup_needed')) {
        if (_engineLoopRunning || isRunning) return true;
        localStorage.removeItem('matrix_warmup_saved_creator');
        localStorage.removeItem('matrix_warmup_saved_step');
        localStorage.setItem('matrix_step', 'SCAN');
        isRunning = true;
        sessionStorage.setItem('matrix_tab_running', 'true');
        updateFollowButtonState();
        startDiagnostic();
        runEngine();
        return true;
    }

    // 养号完成但卡在 /home（页面刷新吞掉了跳转setTimeout）：主动跳转到粉丝列表
    if (savedCreator && !RESERVED_PAGE_HANDLES[savedCreator] && !localStorage.getItem('matrix_warmup_needed') && window.location.pathname === '/home' && localStorage.getItem('matrix_follow_running') === 'true') {
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '🔄 养号后卡在/home，主动恢复跳转 @' + savedCreator }
        }));
        updateFollowButtonState();
        setTimeout(function () {
            try {
                if (typeof SchedulerGate !== 'undefined' && SchedulerGate.canNavigate
                    && !SchedulerGate.canNavigate('follow')) {
                    return;
                }
            } catch (eNav3) {}
            followGoWhenAllowed('https://x.com/' + savedCreator + '/followers');
        }, 1000);
        return true;
    }

        const step = localStorage.getItem('matrix_step') || '';
        const cr = localStorage.getItem('matrix_current_creator') || '';
        const path = window.location.pathname.toLowerCase();
        const isRunningFromJump = localStorage.getItem('matrix_follow_running') === 'true';

        // 场景1: 在粉丝列表 + SCAN 步骤 → 直接启动
        if (isOthersFollowersPage() && (step === 'SCAN' || step === '' || isRunningFromJump)) {
            if (_engineLoopRunning || isRunning) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '🔁 tryAutoStart: 引擎已在跑，跳过' }
                }));
                return true;
            }
            const pathHandle = window.location.pathname.split('/')[1];
            const lockedCr = normalizeCr(cr || '');
            const pathCr = normalizeCr(pathHandle || '');
            // 已有任务锁且与当前页不一致：禁止用 path 覆盖锁，强制跳到锁定博主
            if (lockedCr && pathCr && lockedCr !== pathCr && !RESERVED_PAGE_HANDLES[lockedCr]) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '🔄 tryAutoStart: 页=@' + pathCr + ' 锁=@' + lockedCr + '，对齐后启动' }
                }));
                localStorage.setItem('matrix_step', 'SCAN');
                isRunning = true;
                sessionStorage.setItem('matrix_tab_running', 'true');
                localStorage.setItem('matrix_follow_running', 'true');
                updateFollowButtonState();
                startDiagnostic();
                navigateToLockedCreator('tryAutoStart_mismatch');
                return true;
            }
            if (pathHandle && !RESERVED_PAGE_HANDLES[pathHandle] && !lockedCr) {
                localStorage.setItem('matrix_current_creator', pathHandle);
            }
            // 不删除 matrix_follow_running，保持持久运行标记，防止页面刷新后引擎丢失
            localStorage.setItem('matrix_step', 'SCAN');
            isRunning = true;
            sessionStorage.setItem('matrix_tab_running', 'true');
            updateFollowButtonState();
            startDiagnostic(); runEngine();
            return true;
        }

        // 场景2: 在博主主页 + PROFILE 步骤 → 启动浏览
        const cleanPath = path.replace(/\/+$/, ''); // 去掉尾部斜杠
        if (step === 'PROFILE' && cr && cleanPath === '/' + cr.toLowerCase()) {
            if (_engineLoopRunning || isRunning) return true;
            isRunning = true;
            sessionStorage.setItem('matrix_tab_running', 'true');
            updateFollowButtonState();
            startDiagnostic(); runEngine();
            return true;
        }

        return false;
    }

    // V3: 只尝试一次恢复，不再持续轮询。调度器通过 sg-follow-command 控制启停
    setTimeout(function () { tryAutoStart(); }, 2000);

    // 页面漂移巡检：页≠锁时即使引擎「在跑」也纠偏（防节流后假活空扫错列表）
    setInterval(function () {
        try {
            var crLock = localStorage.getItem('matrix_current_creator');
            if (!crLock) return;
            if (typeof SchedulerGate !== 'undefined' && SchedulerGate.isAutoMode && SchedulerGate.isAutoMode()) {
                if (!SchedulerGate.isModuleOn('follow')) return;
            } else {
                if (localStorage.getItem('matrix_follow_running') !== 'true') return;
            }
            var pageNow = classifyPage();
            var stepNow = localStorage.getItem('matrix_step') || 'SCAN';
            var expNow = expectedPageFor(crLock, stepNow);
            var mismatch = !!(expNow && (expNow.kind !== pageNow.kind || expNow.handle !== pageNow.handle));
            if (!mismatch) {
                if (isRunning || _engineLoopRunning) return;
                return;
            }
            handlePageDrift({ allowWait: true });
        } catch (e) {}
    }, 8000);

    // ========== 【批量同步本地累计关注数到 NAS】 ==========
    setTimeout(() => {
        let stats = getAccountStats();
        let workerId = getWorkerId();
        if (stats.follows_today > 0) {
            console.log(`[批量同步] 本地关注累计: ${stats.follows_today}，正在上传到 NAS...`);
            try {
                chrome.runtime.sendMessage({
                    action: "send_report",
                    payload: {
                        worker_id: workerId,
                        engine: "follow",
                        status: "批量同步本地统计",
                        detail: `关注${stats.follows_today}/Day${stats.day_count}`,
                        stats: {
                            added: stats.follows_today
                        }
                    }
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('[批量同步] Service Worker 未就绪');
                    } else if (response && response.status === 'success') {
                        console.log('[批量同步] ✅ 关注数上传成功！');
                    } else {
                        console.warn('[批量同步] 上传失败:', response);
                    }
                });
            } catch(e) {
                console.error('[批量同步] 异常:', e);
            }
        }
    }, 4000);

    function humanPauseMaybe(chancePercent) {
        const chance = Math.max(0, Math.min(100, chancePercent || 8));
        if (Math.random() * 100 < chance) {
            const wait = typeof MatrixRisk !== "undefined" ? MatrixRisk.jitterSleepMs(6000, 18000, "follow") : randomInt(6000, 18000);
            return sleep(wait);
        }
        return Promise.resolve();
    }

    const FOLLOW_BACKUP_KEY = 'matrix_follow_backup';
    const FOLLOW_BACKUP_MAX = 50;

    async function replayFollowBackup() {
        try {
            const raw = localStorage.getItem(FOLLOW_BACKUP_KEY);
            if (!raw) return;
            const backup = JSON.parse(raw);
            if (!Array.isArray(backup) || backup.length === 0) return;
            backup.forEach(item => {
                if (!item || !item.payload) return;
                try {
                    chrome.runtime.sendMessage({ action: "log_action", payload: item.payload });
                } catch (_) {}
            });
            localStorage.removeItem(FOLLOW_BACKUP_KEY);
        } catch (e) {
            console.warn('[Backup] replay failed:', e.message);
        }
    }

    const __oldGetMyHandle = getMyHandle;
    getMyHandle = function() {
        let handle = normalizeHandleValue(localStorage.getItem('matrix_my_handle'));
        if (handle) return handle;
        handle = __oldGetMyHandle();
        if (handle && handle !== 'unknown' && handle !== '未知账号') {
            localStorage.setItem('matrix_my_handle', `@${handle}#guard`);
            return handle;
        }
        const extracted = normalizeHandleValue(localStorage.getItem('matrix_extracted_handle'));
        if (extracted) {
            localStorage.setItem('matrix_my_handle', `@${extracted}#guard`);
            return extracted;
        }
        return handle;
    };

    const __oldGetDailyLimit = getDailyLimit;
    getDailyLimit = function(dayCount) {
        const customLimit = localStorage.getItem('matrix_custom_limit');
        if (customLimit && !isNaN(parseInt(customLimit, 10)) && !isAntiBanEnabled()) {
            return parseInt(customLimit, 10);
        }
        return __oldGetDailyLimit(dayCount);
    };

    const __oldGetWorkerId = getWorkerId;
    getWorkerId = function() {
        const profileId = getProfileId();
        if (profileId) return profileId;
        return __oldGetWorkerId();
    };

    const __oldWaitForGlobalFollowSlot = waitForGlobalFollowSlot;
    waitForGlobalFollowSlot = async function() {
        const nextTime = getNextGlobalFollowTime();
        const now = Date.now();
        if (now < nextTime) {
            const waitMs = nextTime - now + randomInt(800, 1800);
            updateStats(`矩阵节奏控制，等待 ${Math.round(waitMs / 1000)}s`);
            await sleep(waitMs);
            return;
        }
        return __oldWaitForGlobalFollowSlot();
    };

    var reportToNAS = function(targetFan, currentCount, dayCount) {
        const payload = {
            bot_id: getWorkerId(),
            target: targetFan,
            count: currentCount,
            day_count: dayCount,
            type: "AUTO",
            action_type: "FOLLOW"
        };

        try {
            let backup = JSON.parse(localStorage.getItem(FOLLOW_BACKUP_KEY) || '[]');
            backup.push({ payload: payload, time: Date.now() });
            if (backup.length > FOLLOW_BACKUP_MAX) backup = backup.slice(-FOLLOW_BACKUP_MAX);
            localStorage.setItem(FOLLOW_BACKUP_KEY, JSON.stringify(backup));
        } catch (e) {
            console.warn('[Backup] write failed:', e.message);
        }

        try {
            chrome.runtime.sendMessage({
                action: "log_action",
                payload: payload
            }, () => {
                if (chrome.runtime.lastError) {
                    console.log('[Report] Service Worker unavailable, kept in backup');
                }
            });
        } catch (_) {}
    };

    // ==================== Coordinator 命令监听 ====================
    window.addEventListener('sg-follow-round-end', function (e) {
        var d = (e && e.detail) || {};
        var reason = d.reason || '';
        if (reason === 'scheduler_stop' || reason === 'hard_risk' || reason === 'frozen') return;
        // co_timeout / 换号等：绝不进软风控；软风控只认平台下方风控条 soft_*
        if (reason === 'co_timeout') {
            try {
                if (typeof Logger !== 'undefined' && Logger.info) {
                    Logger.info('关注', '调度超时轮转，不进软风控');
                }
            } catch (eL) {}
        }
    });

    window.addEventListener('sg-follow-command', function (e) {
        var d = e.detail || {};
        if (d.command === 'start') {
            try {
                var sgCmd = JSON.parse(localStorage.getItem('sg_state') || '{}');
                if (sgCmd.softRiskUntil && Date.now() < sgCmd.softRiskUntil) {
                    console.warn('[Follow] start 忽略：软风控填窗中');
                    localStorage.removeItem('matrix_follow_running');
                    return;
                }
            } catch (eSoftCmd) {}
            localStorage.setItem('matrix_follow_running', 'true');
            sessionStorage.setItem('matrix_tab_running', 'true');
            var fDest = (d.targetUrl || '').split('?')[0];
            // 无 target 但有任务锁：补齐粉丝页，避免空 start 在错误页空转
            if (!fDest) {
                try {
                    var lockH = normalizeCr(localStorage.getItem('matrix_current_creator') || '');
                    if (lockH && !RESERVED_PAGE_HANDLES[lockH]) {
                        fDest = 'https://x.com/' + lockH + '/followers';
                    }
                } catch (eLock) {}
            }
            sessionStorage.setItem('sg_module_follow', JSON.stringify({ running: true, phase: 'active', targetUrl: fDest || '', startedAt: Date.now(), lastActive: Date.now() }));
            // 空 targetUrl = 仅补活不跳转（仅当已在正确页）
            if (fDest && !isAtFollowTarget(fDest)) {
                try { localStorage.setItem('matrix_step', isFollowersUrl(fDest) ? 'SCAN' : 'PROFILE'); } catch (eStep) {}
                markStepChange();
                if (followGoForce(fDest)) return;
                // 跳转失败多为短暂异常：强制重试，禁止写成 stopped_by_user
                try {
                    if (typeof Logger !== 'undefined' && Logger.warn) {
                        Logger.warn('关注', 'start 强制跳转未立刻生效，重试 → ' + fDest);
                    }
                } catch (eLg) {}
                setTimeout(function () {
                    if (localStorage.getItem('matrix_follow_running') !== 'true') return;
                    try { sessionStorage.setItem('matrix_tab_running', 'true'); } catch (eTab) {}
                    if (isAtFollowTarget(fDest)) {
                        if (!isRunning && !_engineLoopRunning) {
                            isRunning = true;
                            updateFollowButtonState();
                            startDiagnostic();
                            runEngine();
                        }
                        return;
                    }
                    if (followGoForce(fDest)) return;
                    navigateToLockedCreator('sg_start_retry');
                }, 2500);
                return;
            }
            // 有锁但当前页已对：若页锁仍不一致（SPA 残留）再对齐一次
            try {
                var lock2 = normalizeCr(localStorage.getItem('matrix_current_creator') || '');
                var pg2 = classifyPage();
                if (lock2 && pg2.kind === 'followers' && pg2.handle && pg2.handle !== lock2) {
                    navigateToLockedCreator('sg_start_align');
                    return;
                }
            } catch (eAl) {}
            if (!isRunning && !_engineLoopRunning) {
                isRunning = true;
                updateFollowButtonState();
                startDiagnostic();
                runEngine();
            } else if (_engineLoopRunning && !isRunning) {
                // 单飞锁残留：循环旗在、业务已死 → 强制清锁再拉起
                _engineLoopRunning = false;
                isRunning = true;
                updateFollowButtonState();
                startDiagnostic();
                runEngine();
            } else {
                console.log('[Follow] start 命令忽略：引擎已在运行');
            }
        } else if (d.command === 'stop') {
            var inSoftFill = false;
            try {
                var sgStop = JSON.parse(localStorage.getItem('sg_state') || '{}');
                inSoftFill = !!(sgStop.softRiskUntil && Date.now() < sgStop.softRiskUntil);
            } catch (eSoft) {}
            if (!inSoftFill) {
                try { releasePoolTask('scheduler_stop'); } catch (eRel) {}
            }
            if (isRunning || localStorage.getItem('matrix_follow_running') === 'true') {
                // 调度 stop：停循环；使 token 失效，杜绝旧 while 继续跑
                _engineToken++;
                _engineLoopRunning = false;
                isRunning = false;
                __nurtureState.running = false;
                try { cancelAllFollowSleep(); } catch (err) {}
                stopDiagnostic();
                localStorage.removeItem('matrix_follow_running');
                sessionStorage.setItem('matrix_tab_running', 'stopped_by_user');
                try {
                    sessionStorage.setItem('sg_module_follow', JSON.stringify({ running: false, phase: 'idle', targetUrl: '', startedAt: 0, lastActive: Date.now() }));
                } catch (err2) {}
                updateFollowButtonState();
                document.dispatchEvent(new CustomEvent('matrix-follow-status', {
                    detail: { running: false, paused: false, count: 0 }
                }));
            } else {
                localStorage.removeItem('matrix_follow_running');
                sessionStorage.removeItem('sg_module_follow');
            }
        }
    });

    setTimeout(() => {
        replayFollowBackup();
    }, 1500);
})();
