// X-Matrix 自动关注引擎 (V18.2.1 | 任务锁 + 防封阶梯 + 养号 + 配额满转纯养号 + 天数覆盖)
(function() {
    'use strict';

    // ================= 【配置区】 =================
    const CONFIG = {
        localStorageKey: 'matrix_target_handles',
        completedKey: 'matrix_completed_handles',
        autoJumpEnabled: true,
        jumpDelayMin: 2000,
        jumpDelayMax: 4000,
    };

    function isAntiBanEnabled() {
        if (localStorage.getItem('matrix_antiban_enabled') === 'true') return true;
        try {
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            if (settings.antiBanMode !== undefined) return settings.antiBanMode === true;
            return true;
        } catch (e) { return false; }
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

    try {
        setInterval(function() {
            chrome.storage.local.get(['matrix_console_settings'], function(r) {
                if (!r.matrix_console_settings) return;
                var cur = localStorage.getItem('matrix_console_settings');
                var nxt = JSON.stringify(r.matrix_console_settings);
                if (cur !== nxt) syncSettingsFromStorage(r.matrix_console_settings);
            });
        }, 10000);
    } catch(e) {}

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

    // 获取关注间隔设置（从中控台 localStorage 读取）
    function getFollowInterval() {
        try {
            const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
            const min = Math.max(9, settings.followIntervalMin || 12);
            const max = Math.max(min, settings.followIntervalMax || 19);
            return { min: min * 1000, max: max * 1000 }; // 转换为毫秒
        } catch (e) {
            return { min: 12000, max: 19000 }; // 默认值
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
        const now = new Date();
        const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        return `${bj.getUTCFullYear()}/${bj.getUTCMonth()+1}/${bj.getUTCDate()}`;
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
        if (stats.date !== today) {
            stats.date = today; stats.follows_today = 0;
            if (!hasManualDayOverride()) {
                stats.day_count = (typeof stats.day_count === 'number' ? stats.day_count : 0) + 1;
            }
            localStorage.setItem(key, JSON.stringify(stats));
            if (isAntiBanEnabled()) {
                var c = parseInt(localStorage.getItem('matrix_day_offset') || '0', 10) || 0;
                localStorage.setItem('matrix_day_offset', (c + 1).toString());
            }
            const nurtureKey = `matrix_nurture_sessions_${handle}`;
            localStorage.setItem(nurtureKey, JSON.stringify({ date: today, sessions: 0, lastTime: 0 }));
        }
        var dov = getManualDayOverride();
        if (dov > 0) {
            return { date: stats.date, follows_today: stats.follows_today, day_count: dov };
        }
        return stats;
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
        var antiBan = isAntiBanEnabled();
        if (antiBan) {
            var idx = Math.max(0, (dayCount || 1) - 1);
            return idx === 0 ? __nr_rand(10, 20) : Math.min(50 * idx, 200);
        }
        // ???????????
        let customLimit = localStorage.getItem('matrix_custom_limit');
        if (customLimit && !isNaN(parseInt(customLimit))) {
            return parseInt(customLimit);
        }
        // ????????
        const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
        if (settings.followLimit) return settings.followLimit;
        if (settings.dailyLimit) return settings.dailyLimit;
        // ???? 200
        return 200;
    }

    function checkLimits() {
        // 扩大检测范围：toast、alertdialog、dialog、sheetDialog、banner
        const selectors = '[data-testid="toast"], [role="alertdialog"], [role="dialog"], [data-testid="sheetDialog"], [data-testid="confirmationSheetDialog"]';
        const allAlerts = document.querySelectorAll(selectors);

        for (let t of allAlerts) {
            let txt = (t.innerText || "").toLowerCase();
            
            // HARD 级：每日关注上限
            if (txt.includes("你暂时不能关注更多用户") || txt.includes("无法再关注") || 
                txt.includes("unable to follow more") || txt.includes("达到每天的关注上限") || 
                txt.includes("不能再关注") || txt.includes("can't follow more") ||
                txt.includes("follow limit reached")) {
                return 'HARD';
            }
            
            // SOFT 级：速度限制（包含更多中文/日文/英文关键词）
            if (txt.includes("速度限制") || txt.includes("rate limit") || 
                txt.includes("稍后再试") || txt.includes("try again") || 
                txt.includes("请稍等") || txt.includes("抱歉") ||
                txt.includes("too many") || txt.includes("slow down") ||
                txt.includes("暂时") || txt.includes("しばらく") ||
                txt.includes("please wait") || txt.includes("retry later")) {
                return 'SOFT';
            }
        }
        
        // 兜底：检查页面 body 文本中的速度限制提示（有些 X/Twitter 弹窗不走标准组件）
        const bodyText = (document.body.innerText || "").toLowerCase();
        if (bodyText.includes("你受到速度限制") || bodyText.includes("rate limit exceeded") ||
            bodyText.includes("you are being rate limited")) {
            return 'SOFT';
        }
        
        return 'NONE';
    }

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
        if (handle === "未知账号") {
            handle = String(Math.floor(Math.random() * 90000 + 10000));
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

    // 心跳上报（每5秒，不受引擎状态限制）
    setInterval(() => {
        let workerId = getWorkerId();
        let stats = getAccountStats();
        let currentStatus = isRunning ? '推土扫荡中...' : '待机就绪';

        // 发送状态到中控台
        document.dispatchEvent(new CustomEvent('matrix-follow-status', {
            detail: {
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
                    status: currentStatus,
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
        const workerId = getWorkerId ? getWorkerId() : 'unknown';
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'pool_pop', worker_id: workerId }, (resp) => {
                if (chrome.runtime.lastError) { resolve({ ok: false, reason: chrome.runtime.lastError.message }); return; }
                resolve(resp || { ok: false, reason: 'no response' });
            });
        });
    }

    function isHandleInDeadList(handle) {
        if (!handle) return false;
        try {
            const deadSet = JSON.parse(localStorage.getItem('matrix_dead_handles') || '[]');
            return deadSet.indexOf(handle.toLowerCase()) >= 0;
        } catch (e) { return false; }
    }

    async function jumpToNextBlogger() {
        // P3: 领新号前释放旧 assigned 任务，防止中断后遗留任务卡死号池
        const oldTaskId = localStorage.getItem('matrix_current_task_id');
        if (oldTaskId) {
            try {
                await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ action: 'pool_fail', id: oldTaskId }, (resp) => { resolve(resp); });
                });
            } catch (e) {}
            localStorage.removeItem('matrix_current_task_id');
            localStorage.removeItem('matrix_current_task_assigned_at');
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '🔙 释放旧 assigned 任务 #' + oldTaskId } }));
        }
        updateStats('领取中...');

        // 带死号过滤的领号循环（最多10次跳过死号）
        let result;
        for (let __deadRetry = 0; __deadRetry < 10; __deadRetry++) {
            result = await popFromPool();
            if (!result.ok || !result.handle) {
                // 池空
                break;
            }
            const handle = result.handle.replace(/^@/, '').toLowerCase();
            if (isHandleInDeadList(handle)) {
                document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
                    detail: { text: '💀 跳过死号 @' + handle + ' (id:' + result.id + ')' }
                }));
                try {
                    await new Promise((resolve) => {
                        chrome.runtime.sendMessage({ action: 'pool_fail', id: result.id }, (r) => { resolve(r); });
                    });
                } catch (e) {}
                continue;
            }
            break;
        }

        if (!result || !result.ok || !result.handle) {
            localStorage.removeItem('matrix_follow_running');
            localStorage.removeItem('matrix_current_task_id');
            localStorage.removeItem('matrix_current_task_assigned_at');
            localStorage.removeItem('matrix_current_creator');
            isRunning = false;
            __nurtureState.running = false;
            stopDiagnostic();
            updateStats('✅ 号池已空，所有博主已处理完毕');
            document.dispatchEvent(new CustomEvent('matrix-follow-status', {
                detail: { running: false, status: 'completed', message: '✅ 号池已空，自动结束' }
            }));
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '✅ 号池已空，自动流程已自然结束' } }));
            return;
        }
        const handle = result.handle.replace(/^@/, '');
        localStorage.setItem('matrix_current_creator', handle);
        localStorage.setItem('matrix_current_task_id', String(result.id));
        localStorage.setItem('matrix_current_task_assigned_at', String(Date.now()));
        localStorage.setItem('matrix_step', 'PROFILE');
        localStorage.setItem('matrix_follow_running', 'true');
        updateStats('领取到 @' + handle + ' ，进入主页...');
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '领取到 @' + handle + ' (id:' + result.id + ')' } }));
        window.location.href = 'https://x.com/' + handle;
    }

    // ================= 【UI 创建】 =================
    // ================= 【新UI系统】 =================
    let followBtn, followSettingsBtn, followPanel, followStatusDot;

    function createFollowUI() {
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
                setTimeout(function() { if (isRunning) window.location.href = 'https://x.com/home'; }, 1000);
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
                if (isOthersFollowersPage() && window.location.pathname.split('/')[1] === _lockedCreator.toLowerCase()) {
                    runEngine();
                } else {
                    window.location.href = 'https://x.com/' + _lockedCreator + '/followers';
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

        if (document.querySelector('[data-testid="UserCell"]') || currentPath === '/' + cr || currentPath === '/home') {
            sessionStorage.setItem('matrix_watchdog_time', Date.now());
        } else if (Date.now() - lastHealth > 35000) {
            updateStats("【防卡死】触发，强力刷新！");
            location.href = window.location.href + (window.location.href.includes('?') ? '&' : '?') + '_t=' + Date.now();
        }
    }, 5000);

    // ================= 【号池任务标记】 =================
    async function poolFail(taskId) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'pool_fail', id: taskId }, (resp) => {
                if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
                resolve(resp || { ok: false });
            });
        });
    }

    async function poolFailByHandle(handle) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'pool_fail', id: handle }, (resp) => {
                if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
                resolve(resp || { ok: false });
            });
        });
    }

    async function markPoolTaskDone() {
        let taskId = localStorage.getItem('matrix_current_task_id');
        if (!taskId) return;
        try {
            await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: "pool_done", id: taskId }, (resp) => { resolve(resp); });
            });
        } catch (e) {}
        localStorage.removeItem('matrix_current_task_id');
        localStorage.removeItem('matrix_current_task_assigned_at');
    }

    async function markPoolTaskFail() {
        let taskId = localStorage.getItem('matrix_current_task_id');
        if (!taskId) return;
        try { await poolFail(taskId); } catch (e) {}
        localStorage.removeItem('matrix_current_task_id');
        localStorage.removeItem('matrix_current_task_assigned_at');
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

    function __followDetectReason(btnText, testId, ariaLabel, btnClass) {
        const parts = [];
        if (testId.includes('unfollow')) parts.push('testId=unfollow');
        else if (testId.includes('following')) parts.push('testId=following');
        if (btnText) {
            const kw = ['正在', '已关', 'following', 'pending', 'requested', '关注中', '已关注',
                'フォロー中', 'フォロー解除', 'リクエスト済み', '承認待ち', 'キャンセル'];
            const hit = kw.find(k => btnText.includes(k));
            if (hit) parts.push('btnText=' + hit);
        }
        if (ariaLabel) {
            const kw = ['正在', '已关注', 'following', 'unfollow', 'フォロー中', 'フォロー解除'];
            const hit = kw.find(k => ariaLabel.includes(k));
            if (hit) parts.push('aria=' + hit);
        }
        if (btnClass.includes('following')) parts.push('class=following');
        if (btnClass.includes('unfollow')) parts.push('class=unfollow');
        return parts.join('|') || 'unknown';
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

    function __nr_getVisibleRealTweets() {
        const articles = __nr_getAllTweets();
        const vh = window.innerHeight;
        const result = [];
        for (const article of articles) {
            if (__nr_isPromotedTweet(article)) continue;
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

    async function __nr_actionComment() {
        try {
            const tweets = await __nr_findTweetsWithRetry(5);
            if (!tweets.length) { await __nr_scrollAndRead(); return false; }
            const target = __nr_pickRandom(tweets);
            const replyBtn = target.el.querySelector('button[data-testid="reply"]');
            if (!replyBtn) return false;
            const origUrl = window.location.href;
            await __nr_humanClick(replyBtn);
            for (let i = 0; i < 15; i++) {
                await __nr_sleep(1000);
                if (window.location.href !== origUrl) break;
                if (document.querySelector('[data-testid="sheetDialog"], [role="dialog"]')) break;
            }
            let textarea = null;
            for (let i = 0; i < 15; i++) {
                textarea = Array.from(document.querySelectorAll('[contenteditable="true"]'))
                    .reverse().find(e => e.offsetParent !== null);
                if (textarea) break;
                await __nr_sleep(1000);
            }
            if (!textarea) return false;
            const text = __nr_pickUnusedComment(__NURTURE_COMMENTS);
            await __nr_humanClick(textarea);
            await __nr_sleep(300);
            textarea.focus();
            textarea.textContent = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await __nr_sleep(200);
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await __nr_sleep(1500);
            const panel = textarea.closest('[role="dialog"], [data-testid="sheetDialog"]');
            const sendBtn = panel
                ? panel.querySelector('button:not([disabled])')
                : document.querySelector('button[data-testid="tweetButtonInline"], button[data-testid="tweetButton"]');
            if (!sendBtn || sendBtn.disabled) return false;
            await __nr_humanClick(sendBtn);
            for (let i = 0; i < 12; i++) {
                await __nr_sleep(1000);
                if (window.location.href === origUrl || window.location.href.includes('/home')) {
                    __nurtureState.interactedTweets.add(target.id);
                    __nurtureState.commentsDone++;
                    return true;
                }
                if (!document.querySelector('[data-testid="sheetDialog"], [role="dialog"]')) {
                    __nurtureState.interactedTweets.add(target.id);
                    __nurtureState.commentsDone++;
                    return true;
                }
            }
            return false;
        } catch (e) {
            __nurtureState.failCount++;
            console.warn('[Nurture] comment失败:', e.message || String(e));
            window.history.back();
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
        
        // 配额检查
        const stats = getAccountStats();
        const limit = getDailyLimit(stats.day_count);
        if (stats.follows_today >= limit) {
            updateStats("今日配额已满，停止关注");
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
        
        let followBtn = cell.querySelector('[role="button"][data-testid*="ollow"]')
            || cell.querySelector('[data-testid*="ollow"]')
            || cell.querySelector('button[data-testid*="ollow"]');
        if (!followBtn) {
            // 尝试通过按钮文字查找
            const allBtns = cell.querySelectorAll('[role="button"], button');
            for (const btn of allBtns) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (txt === 'follow' || txt === '关注' || txt === 'フォロー') {
                    followBtn = btn;
                    break;
                }
            }
        }
        if (!followBtn) {
            console.warn('[关注] 找不到关注按钮，cell data-testid:', cell.getAttribute('data-testid'), 'cell buttons:', cell.querySelectorAll('[role="button"]').length);
            return 'no_follow_btn';
        }
        
        // 六重检测：防止对"正在关注"状态的用户重复点击
        let btnText = (followBtn.textContent || followBtn.innerText || "").replace(/\s+/g, "");
        let testId = (followBtn.getAttribute('data-testid') || "").toLowerCase();
        let ariaLabel = (followBtn.getAttribute('aria-label') || "").toLowerCase();
        let btnClass = (followBtn.className || "").toLowerCase();
        let btnStyle = (followBtn.getAttribute('style') || "").toLowerCase();

        let isAlreadyFollowed = 
            // data-testid 检测
            testId.includes('unfollow') ||
            testId.includes('following') ||
            // 按钮文字检测
            btnText.includes('正在') ||
            btnText.includes('已关') ||
            btnText.includes('following') ||
            btnText.includes('pending') ||
            btnText.includes('requested') ||
            btnText.includes('关注中') ||
            btnText.includes('已关注') ||
            btnText === 'following' ||
            btnText === 'followingyou' ||
            // 日文按钮文字检测 (フォロー中=Following, フォロー解除=Unfollow)
            btnText.includes('フォロー中') ||
            btnText.includes('フォロー解除') ||
            btnText.includes('リクエスト済み') ||
            btnText.includes('承認待ち') ||
            btnText.includes('キャンセル') ||
            // aria-label 检测
            ariaLabel.includes('正在') ||
            ariaLabel.includes('已关注') ||
            ariaLabel.includes('following') ||
            ariaLabel.includes('unfollow') ||
            ariaLabel.includes('フォロー中') ||
            ariaLabel.includes('フォロー解除') ||
            // class 检测（某些情况下 X/Twitter 使用 class 标识状态）
            btnClass.includes('following') ||
            btnClass.includes('unfollow');

        if (isAlreadyFollowed) {
            document.dispatchEvent(new CustomEvent('matrix-follow-detect', {
                detail: { handle: handle, btnText: btnText, testId: testId, ariaLabel: ariaLabel,
                    decision: 'already_followed', reason: __followDetectReason(btnText, testId, ariaLabel, btnClass) }
            }));
            return 'already_followed';
        }
        document.dispatchEvent(new CustomEvent('matrix-follow-detect', {
            detail: { handle: handle, btnText: btnText, testId: testId, ariaLabel: ariaLabel,
                decision: 'proceed_to_follow' }
        }));

        // 防老外：获取用户简介内容，检测是否是日语用户
        let rawText = cell.innerText || "";
        let lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let rawBtnText = followBtn.innerText ? followBtn.innerText.trim() : '';
        let content = lines.filter(l => l !== rawBtnText).join(' | ');

        const isJp = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(content);
        const isPureEng = /[a-zA-Z]/.test(content) && !isJp;
        const isSubstantial = content.length > 8;

        // 读取"只点击日本人"设置
        const consoleSettings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
        const onlyJapanese = consoleSettings.onlyJapanese !== false; // 默认开启

        if (onlyJapanese) {
            // 只点击日本人模式
            if (isPureEng || !isJp || !isSubstantial) {
                cell.style.cssText += 'opacity: 0.15; filter: grayscale(100%); border: 1px solid red;';
                updateStats("【防线】非目标号，剔除...");
                cell.setAttribute('data-matrix-processed', 'true');
                { const _r = cell.getBoundingClientRect(); if (_r.bottom > window.innerHeight) window.scrollBy({ top: _r.bottom - window.innerHeight + 50, behavior: 'smooth' }); }
                await sleep(randomInt(700, 1200));
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

            followBtn.click();
            document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '✅ 已点击关注: @' + handle } }));
            
            // 点击后风控检测
            await sleep(2000);
            let postClickLimit = checkLimits();
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
            const dur = __nr_rand(15, 17);
            navigateToHomeForWarmup('soft_cooldown', dur);
            return 'soft_cooldown';
            }
            
            let count = incrementFollowCount();
            
            // 通过 reportToNAS 上报战报
            reportToNAS(handle, count, stats.day_count);
            
            // 设置下一次全局关注时间
            setNextGlobalFollowTime(totalInterval);

            updateStats(`✅ 已关注 @${handle} (${count}/${limit}) | 间隔 ${Math.round(totalInterval/1000)}s`);
            return 'followed';
            
        } catch (e) {
            updateStats(`❌ 关注 @${handle} 失败`);
            return 'click_error';
        }
    }

    // ================= 【扫描页面（DeepSeek 简单逻辑）】 =================
    async function scanPage() {
        if (!isRunning) return;

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

                // 跳过已处理的（可能被其他逻辑标记了）
                if (cell.getAttribute('data-matrix-processed') === 'true') continue;

                // 配额检查
                const stats = getAccountStats();
                const limit = getDailyLimit(stats.day_count);
                if (stats.follows_today >= limit) {
                    updateStats("今日配额已满，停止关注");
                    return;
                }

                let result = await handleFollowButton(cell);

                if (result === 'already_followed') {
                    __scanStats.already++;
                    cell.style.cssText += 'opacity: 0.3 !important; filter: grayscale(100%) !important; border: 1px dashed #00ba7c;';
                    cell.setAttribute('data-matrix-processed', 'true');
                    window.scrollBy({ top: randomInt(35, 75), behavior: 'smooth' });
                    await sleep(randomInt(700, 1200));
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
                    await reportOpsFollowResult(getWorkerId(), normalizeOpsTargetHandle(rowHandle), 'success', { sourceUrl: location.href });
                    cell.setAttribute('data-matrix-processed', 'true');
                    // 操作完后小幅滚动
                    window.scrollBy({ top: randomInt(50, 80), behavior: 'smooth' });
                    await sleep(randomInt(1000, 1500));
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

                if (result === 'hard_risk' || result === 'engine_stopped' || result === 'quota_full') {
                    __scanStats.skipped++;
                    cell.setAttribute('data-matrix-processed', 'true');
                    continue;
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
        } else {
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
                // 三次滚动都无变化 = 真正触底
                updateStats("📄 确认到底，本页收割完毕！切换下一个博主");
                await sleep(2000);

                const currentBlogger = localStorage.getItem('matrix_current_creator');
                if (currentBlogger) markHandleCompleted(currentBlogger);
                await markPoolTaskDone();

                updateStats("📄 当前博主粉丝已全部处理，切换下一个博主");
                await sleep(2000);

                await jumpToNextBlogger();
                return;
            }
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

    // ==================== [Nurture - Navigate to Home for Warmup] ====================
    function navigateToHomeForWarmup(reason, durationMinutes) {
        if (localStorage.getItem('matrix_warmup_needed') === 'true') return;
        const dur = durationMinutes || 5;
        const handle = getMyHandle();
        const nurtureKey = `matrix_nurture_sessions_${handle}`;
        try {
            const data = JSON.parse(localStorage.getItem(nurtureKey) || '{"date":"","sessions":0,"lastTime":0}');
            data.lastTime = Date.now();
            // 软风控/纯养号基座触发的养号计入每日次数，自然抑制后续定时养号
            if (reason && (reason.indexOf('soft') === 0 || reason === 'pure_nurture_day0')) {
                data.sessions++;
            }
            localStorage.setItem(nurtureKey, JSON.stringify(data));
        } catch(e) {}
        localStorage.setItem('matrix_warmup_needed', 'true');
        localStorage.setItem('matrix_warmup_reason', reason);
        localStorage.setItem('matrix_warmup_duration', dur.toString());
        localStorage.setItem('matrix_warmup_end_time', String(Date.now() + dur * 60000));
        localStorage.setItem('matrix_warmup_saved_creator', reason && reason.indexOf('pure_nurture') === 0 ? '' : (localStorage.getItem('matrix_current_creator') || ''));
        localStorage.setItem('matrix_warmup_saved_step', localStorage.getItem('matrix_step') || '');
        localStorage.setItem('matrix_follow_running', 'true');
        updateStats('\u517b\u53f7\u6a21\u5f0f\uff1a\u8df3\u8f6c\u5230\u4e3b\u9875...');
        setTimeout(() => { if (isRunning) window.location.href = 'https://x.com/home'; }, 1500);
    }

    // ==================== [Nurture - Run Warmup on /home] ====================
    function runHomeWarmup(durationMs) {
        if (__nurtureState.running || !isRunning) return;
        __nurtureState.running = true;
        // warmup_needed 保留到养号完成后才删除，防止期间页面刷新导致引擎丢失
        const endTime = Date.now() + durationMs;
        const settings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
        const likeTarget = __nr_rand(settings.nurtureLikeMin || 1, settings.nurtureLikeMax || 3);
        const commentTarget = __nr_rand(settings.nurtureCommentMin || 1, settings.nurtureCommentMax || 1);
        const enterTarget = __nr_rand(settings.nurtureEnterMin || 1, settings.nurtureEnterMax || 3);
        const actionInterval = (settings.nurtureInterval || settings.nurtureActionInterval || 30) * 1000;

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
                } else if (__nurtureState.commentsDone < commentTarget && roll < 0.40) {
                    await __nr_actionComment();
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
            updateStats('\u517b\u53f7\u5b8c\u6210\uff0c\u8fd4\u56de\u7c89\u4e1d\u5217\u8868...');
            const savedCreator = localStorage.getItem('matrix_warmup_saved_creator');
            localStorage.removeItem('matrix_warmup_needed');
            localStorage.removeItem('matrix_warmup_end_time');
            localStorage.removeItem('matrix_warmup_reason');
            localStorage.removeItem('matrix_warmup_duration');
            localStorage.setItem('matrix_follow_running', 'true');
            localStorage.setItem('matrix_step', 'SCAN');
            if (savedCreator) {
                setTimeout(() => { if (isRunning) window.location.href = 'https://x.com/' + savedCreator + '/followers'; }, 2000);
            } else if (localStorage.getItem('matrix_pure_nurture_mode') === 'true') {
                updateStats('\u517b\u53f7\u5b8c\u6210\uff0c\u56de\u4e3b\u9875\u4f11\u606f...');
                setTimeout(() => { if (isRunning) window.location.href = 'https://x.com/home'; }, 2000);
            } else {
                setTimeout(() => {
                    if (!isRunning) return;
                    const cr = localStorage.getItem('matrix_current_creator') || '';
                    if (cr) window.location.href = 'https://x.com/' + cr + '/followers';
                    else stopBot();
                }, 2000);
            }
        })();
    }
async function runEngine() {
        let stepStartTime = Date.now();
        const STEP_TIMEOUT = 45000; // 45秒超时
        
        while (isRunning) {
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
                    for (let __idle = 0; __idle < 12 && isRunning; __idle++) {
                        await sleep(10000);
                    }
                    if (!isRunning) return;
                    continue;
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
                            if (_tBody.includes('このアカウントは存在しません') || _tBody.includes('Account suspended')) {
                                markHandleCompleted(cr); await markPoolTaskDead(); await jumpToNextBlogger(); return;
                            }
                            if (_tBody.includes('このアカウントは非公開') || _tBody.includes('protected')) {
                                markHandleCompleted(cr); await markPoolTaskDead(); await jumpToNextBlogger(); return;
                            }
                            localStorage.setItem('matrix_step', 'SCAN');
                            localStorage.setItem('matrix_follow_running', 'true');
                            window.location.href = `https://x.com/${cr}/followers`;
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
                    const _qNsData = getNurtureSessionsToday();
                    const _qNsSettings = JSON.parse(localStorage.getItem('matrix_console_settings') || '{}');
                    const _qNsTarget = _qNsSettings.nurtureSessionsPerDay ?? 3;
                    if (_qNsTarget > 0 && _qNsData.sessions < _qNsTarget) {
                        localStorage.setItem('matrix_pure_nurture_mode', 'true');
                        updateStats("配额达成，转入纯养号模式");
                        setTimeout(function() { if (isRunning) window.location.href = 'https://x.com/home'; }, 1000);
                        return;
                    }
                    updateStats("今日总目标达成！下班");
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
                if (startLimit === 'HARD') {
                    setMatrixCooldown(randomInt(3 * 3600000, 4 * 3600000));
                    updateStats("触发最高风控！脚本已紧急熔断！");
                    (window.__matrix_notify__ || ((m,t,d) => {}))('🚨 检测到推特最高风控，脚本已自动挂起保护账号！', 'error', 5000);
                    stopBot();
                    return;
                } else if (startLimit === 'SOFT') {
                    const dur = __nr_rand(15, 17);
                    navigateToHomeForWarmup('soft_start_limit', dur);
                    return;
                }

                // 定时养号检查：每日定期养号（非风控触发）
                if (checkScheduledNurture()) {
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

                    // 前置拦截：如果在本地死号名单中，直接跳过
                    if (cr && isHandleInDeadList(cr)) {
                        updateStats(`💀 @${cr} 已在死号名单，跳过`);
                        markHandleCompleted(cr);
                        localStorage.removeItem('matrix_current_creator');
                        localStorage.removeItem('matrix_current_task_id');
                        localStorage.removeItem('matrix_current_task_assigned_at');
                        document.dispatchEvent(new CustomEvent('matrix-diagnostic', { detail: { text: '💀 死号名单命中 @' + cr + '，直接跳过' } }));
                        await sleep(1000);
                        await jumpToNextBlogger();
                        return;
                    }

                    updateStats(`📖 阅读 @${cr} 主页中...`);

                    // ====== 敏感资料/隐私账号/不存在账号检测 ======
                    const _pageBody = document.body ? document.body.textContent : '';
                    // 检测敏感资料：cwcSheetDialog弹窗 + empty_state_button_text确认按钮
                    const _hasCwcSheet = !!document.querySelector('[data-testid="cwcSheetDialog"]');
                    const _emptyStateBtn = document.querySelector('[data-testid="empty_state_button_text"]');
                    const _emptyBtnText = _emptyStateBtn ? _emptyStateBtn.textContent.trim() : '';
                    const _mainText = document.querySelector('main') ? document.querySelector('main').textContent : '';
                    const _hasSensitive = _hasCwcSheet || (_emptyBtnText.indexOf('查看') >= 0 && _mainText.indexOf('敏感') >= 0);
                    const _hasProtected = (_mainText.includes('このアカウントは非公開') || _mainText.includes('These posts are protected'));

                    // 检测封禁：检查main区域
                    const _hasSuspended = (_mainText.includes('このアカウントは凍結') || _mainText.includes('このアカウントは違反') || _mainText.includes('Account has been suspended'));

                    // 检测不存在：检查main区域
                    const _hasNotFound = (_mainText.includes('このアカウントは存在しません') || _mainText.includes("This account doesn't exist") || _mainText.includes('account has been withheld'));

                    if (_hasNotFound || _hasSuspended) {
                        const _reason = _hasNotFound ? '账号不存在' : '账号已封禁';
                        updateStats(`⛔ @${cr} ${_reason}，标记为死号`);
                        markHandleCompleted(cr);
                        await markPoolTaskDead();
                        await sleep(2000);
                        await jumpToNextBlogger();
                        return;
                    }

                    if (_hasSensitive) {
                        updateStats(`⚠️ @${cr} 敏感资料，点击确认...`);
                        const _viewBtns = Array.from(document.querySelectorAll('button'));
                        const _viewBtn = _viewBtns.find(b => {
                            const t = b.textContent.trim();
                            return t.includes('プロフィールを表示') || t.includes('View profile') ||
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
                        await markPoolTaskDead();
                        await sleep(2000);
                        await jumpToNextBlogger();
                        return;
                    }

                    const _fLink = document.querySelector('a[href*="/followers"]') || document.querySelector('a[href*="/verified_followers"]') || document.querySelector('a[href*="/followers_you_follow"]');
                    if (!_fLink) {
                        await sleep(3000);
                        const _retryLink = document.querySelector('a[href*="/followers"]') || document.querySelector('a[href*="/verified_followers"]') || document.querySelector('a[href*="/followers_you_follow"]');
                        if (!_retryLink) {
                            updateStats(`⚠️ @${cr} 无粉丝列表，标记为死号`);
                            markHandleCompleted(cr);
                            await markPoolTaskDead();
                            await sleep(2000);
                            await jumpToNextBlogger();
                            return;
                        }
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
                    window.location.href = `https://x.com/${cr}/followers`;
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
                        if (cr && curPath === '/' + cr.toLowerCase()) {
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
                            if (cr2 && curPath2 === '/' + cr2.toLowerCase()) {
                                localStorage.setItem('matrix_step', 'PROFILE');
                                continue;
                            }
                        }
                        continue;
                    }
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
    }

    function stopBot() {
        // 释放当前 assigned 任务，避免任务卡死
        var _tid = localStorage.getItem('matrix_current_task_id');
        if (_tid) { poolFail(_tid).catch(function(){}); }
        localStorage.removeItem('matrix_current_task_id');
        localStorage.removeItem('matrix_current_task_assigned_at');
        stopDiagnostic();
        isRunning = false;
        __nurtureState.running = false;  // 终止正在运行的养号循环
        cancelAllFollowSleep();
        sessionStorage.setItem('matrix_tab_running', 'false');
        localStorage.removeItem('matrix_follow_running');
        localStorage.removeItem('matrix_step');
        localStorage.removeItem('matrix_auto_step');
        localStorage.removeItem('matrix_current_creator');
        localStorage.removeItem('matrix_global_cooldown_until');
        localStorage.removeItem('matrix_global_next_follow_time');
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

    // 纯养号模式：在 /home 页面恢复养号循环
    const isPureNurture = localStorage.getItem('matrix_pure_nurture_mode') === 'true';
    if (isPureNurture && window.location.pathname === '/home' && localStorage.getItem('matrix_follow_running') === 'true') {
        isRunning = true;
        sessionStorage.setItem('matrix_tab_running', 'true');
        updateFollowButtonState();
        startDiagnostic(); runEngine();
        return true;
    }
    if (isPureNurture) { return false; }

    if (sessionStorage.getItem('matrix_tab_running') === 'stopped_by_user') return false;

    const savedCreator = localStorage.getItem('matrix_warmup_saved_creator');
    if (savedCreator && window.location.pathname.includes('/followers') && !localStorage.getItem('matrix_warmup_needed')) {
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
    if (savedCreator && !localStorage.getItem('matrix_warmup_needed') && window.location.pathname === '/home' && localStorage.getItem('matrix_follow_running') === 'true') {
        document.dispatchEvent(new CustomEvent('matrix-diagnostic', {
            detail: { text: '🔄 养号后卡在/home，主动恢复跳转 @' + savedCreator }
        }));
        updateFollowButtonState();
        setTimeout(() => { window.location.href = 'https://x.com/' + savedCreator + '/followers'; }, 1000);
        return true;
    }

        const step = localStorage.getItem('matrix_step') || '';
        const cr = localStorage.getItem('matrix_current_creator') || '';
        const path = window.location.pathname.toLowerCase();
        const isRunningFromJump = localStorage.getItem('matrix_follow_running') === 'true';

        // 场景1: 在粉丝列表 + SCAN 步骤 → 直接启动
        if (isOthersFollowersPage() && (step === 'SCAN' || step === '' || isRunningFromJump)) {
            const pathHandle = window.location.pathname.split('/')[1];
            if (pathHandle) localStorage.setItem('matrix_current_creator', pathHandle);
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
            isRunning = true;
            sessionStorage.setItem('matrix_tab_running', 'true');
            updateFollowButtonState();
            startDiagnostic(); runEngine();
            return true;
        }

        return false;
    }

    // 页面加载后检测是否有待恢复的跳转任务（持续守候，不因超时放弃）
    (function resumeJumpIfNeeded() {
        let retries = 200; // ~10分钟，足够遍历各种加载状态
        (function poll() {
            setTimeout(() => {
                var shouldRun = localStorage.getItem('matrix_follow_running') === 'true'
                    || localStorage.getItem('matrix_warmup_needed') === 'true'
                    || localStorage.getItem('matrix_pure_nurture_mode') === 'true';
                if (!shouldRun) return;
                if (tryAutoStart()) return;
                if (retries > 0) {
                    retries--;
                    poll();
                } else {
                    // P3: 轮询超时，释放 stuck 号池任务并全面清理状态
                    var stuckId = localStorage.getItem('matrix_current_task_id');
                    if (stuckId) {
                        chrome.runtime.sendMessage({ action: 'pool_fail', id: stuckId });
                        localStorage.removeItem('matrix_current_task_id');
                        localStorage.removeItem('matrix_current_task_assigned_at');
                        console.log('[Follow] 轮询超时，已释放 stuck 任务 #' + stuckId);
                    }
                    __nurtureState.running = false;
                    cancelAllFollowSleep();
                    localStorage.removeItem('matrix_follow_running');
                    localStorage.removeItem('matrix_step');
                    localStorage.removeItem('matrix_current_creator');
                    localStorage.removeItem('matrix_global_cooldown_until');
                    localStorage.removeItem('matrix_global_next_follow_time');
                    localStorage.removeItem('matrix_warmup_needed');
                    localStorage.removeItem('matrix_warmup_end_time');
                    localStorage.removeItem('matrix_warmup_reason');
                    localStorage.removeItem('matrix_warmup_duration');
                    localStorage.removeItem('matrix_warmup_saved_creator');
                    localStorage.removeItem('matrix_warmup_saved_step');
                    localStorage.removeItem('matrix_pure_nurture_mode');
                }
            }, 3000);
        })();
    })();

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

    setTimeout(() => {
        replayFollowBackup();
    }, 1500);
})();
