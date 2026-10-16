// =============================================================================
// X-Matrix 博主推送 (V18.3.0 号池模式适配版)
// 基于 1-Extension V12.5.1 改造：
//   - 上报终点：Controller API → NAS号池 (192.168.0.100:5678/pool/push)
//   - 批量队列 flushQueue 终点：sync_batch → pool_push_batch
//   - 机器码来源：Controller get_machine_code → 本地 matrix_my_handle
// =============================================================================

(function() {
    'use strict';

    if (window.__matrix_push_blogger_injected__) return;
    window.__matrix_push_blogger_injected__ = true;

    // ==================== 配置 ====================
    const CONFIG = {
        localStorageKey: 'matrix_target_handles',
        buttonClass: 'matrix-push-blogger-btn',
        processedAttr: 'data-matrix-push-processed'
    };

    // ==================== 获取当前账号 handle ====================
    function getMyHandle() {
        // 1. 从 matrix_my_handle 读取（id_extractor.js 写入）
        const stored = localStorage.getItem('matrix_my_handle');
        if (stored) {
            // 格式：@username#guard → 取出 username
            const m = stored.match(/@?([^#]+)/);
            if (m) return m[1].toLowerCase();
        }
        // 2. 降级到 matrix_extracted_handle
        return localStorage.getItem('matrix_extracted_handle') || 'unknown';
    }

    // ==================== 批量上报队列（号池模式）====================
    const reportQueue = [];
    let reportTimer = null;
    const FLUSH_THRESHOLD_BASE = 12;
    const FLUSH_THRESHOLD_MAX = 18;
    let FLUSH_THRESHOLD = Math.floor(Math.random() * (FLUSH_THRESHOLD_MAX - FLUSH_THRESHOLD_BASE + 1)) + FLUSH_THRESHOLD_BASE;
    const FLUSH_INTERVAL_MS_BASE = 22000;
    const FLUSH_INTERVAL_MS_MAX = 38000;
    let FLUSH_INTERVAL_MS = Math.floor(Math.random() * (FLUSH_INTERVAL_MS_MAX - FLUSH_INTERVAL_MS_BASE + 1)) + FLUSH_INTERVAL_MS_BASE;

    async function queueReport(type, data) {
        reportQueue.push({
            type: type,
            data: data,
            timestamp: Date.now()
        });

        if (!reportTimer) {
            const jitter = Math.floor(Math.random() * 1500);
            reportTimer = setTimeout(throttleFlush, FLUSH_INTERVAL_MS + jitter);
        }

        if (reportQueue.length >= FLUSH_THRESHOLD) {
            setTimeout(() => {
              FLUSH_THRESHOLD = Math.floor(Math.random() * (FLUSH_THRESHOLD_MAX - FLUSH_THRESHOLD_BASE + 1)) + FLUSH_THRESHOLD_BASE;
              flushQueue();
            }, Math.floor(Math.random() * 1200));
        }
    }

    function throttleFlush() {
      const risk = typeof MatrixRisk !== "undefined" ? MatrixRisk.tryAcquire("push", 1) : { ok: true };
      if (!risk.ok) {
        const wait = Math.min(60000, Math.max(2000, risk.waitMs || 5000));
        setTimeout(flushQueue, wait);
        return;
      }
      flushQueue();
    }

    function flushQueue() {
        if (reportQueue.length === 0) return;

        const batch = reportQueue.splice(0, reportQueue.length);
        clearTimeout(reportTimer);
        reportTimer = null;

        // 提取所有 handle
        const handles = batch.map(item => item.data.handle).filter(h => h);

        if (handles.length === 0) return;

        // 调用 background.js 的 pool_push_batch action
        chrome.runtime.sendMessage({
            action: 'pool_push_batch',
            handles: handles,
            source: '📌'
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[博主推送] Service Worker 未就绪');
            } else if (response && response.ok) {
                console.log(`[博主推送] 已批量推送 ${response.count} 个博主 (mode=${response.mode})`);
            } else {
                console.warn('[博主推送] 批量推送失败:', response?.msg);
            }
        });
    }

    // ==================== 样式注入 ====================
    const style = document.createElement('style');
    style.textContent = `
        .${CONFIG.buttonClass} {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 10px 3px 6px;
            border-radius: 12px;
            border: 1px solid rgba(29, 155, 240, 0.3);
            background: rgba(29, 155, 240, 0.06);
            color: #1d9bf0;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            vertical-align: middle;
            margin-left: 6px;
            line-height: 1;
            white-space: nowrap;
        }
        .${CONFIG.buttonClass} svg {
            flex-shrink: 0;
        }
        .${CONFIG.buttonClass}:hover {
            background: rgba(29, 155, 240, 0.15);
            border-color: #1d9bf0;
            transform: scale(1.05);
        }
        .${CONFIG.buttonClass}.pushed {
            color: #00ba7c;
            border-color: rgba(0, 186, 124, 0.3);
            background: rgba(0, 186, 124, 0.06);
        }
        .${CONFIG.buttonClass}.pushed:hover {
            background: rgba(0, 186, 124, 0.12);
            border-color: #00ba7c;
        }
        .matrix-push-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #1d9bf0;
            color: white;
            padding: 10px 18px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: bold;
            z-index: 999999;
            display: none;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            transition: opacity 0.3s;
        }
        .matrix-push-toast.success { background: #00ba7c; }
        .matrix-push-toast.error { background: #f91880; }
    `;
    document.head.appendChild(style);

    // ==================== Toast 提示 ====================
    const toast = document.createElement('div');
    toast.className = 'matrix-push-toast';
    document.body.appendChild(toast);

    function showToast(msg, type = 'info', time = 2000) {
        toast.textContent = msg;
        toast.className = `matrix-push-toast ${type}`;
        toast.style.display = 'block';
        toast.style.opacity = '1';
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => { toast.style.display = 'none'; }, 300);
        }, time);
    }

    // ==================== 本地存储 ====================
    function getLocalHandles() {
        try {
            const data = localStorage.getItem(CONFIG.localStorageKey);
            if (data) {
                const handles = JSON.parse(data);
                if (Array.isArray(handles)) return handles;
            }
        } catch (e) {
            console.error('读取本地缓存失败:', e);
        }
        return [];
    }

    function addHandleToLocal(handle) {
        try {
            let handles = getLocalHandles();
            if (!handles.includes(handle)) {
                handles.push(handle);
                localStorage.setItem(CONFIG.localStorageKey, JSON.stringify(handles));
                return true;
            }
            return false;
        } catch (e) {
            console.error('写入本地缓存失败:', e);
            return false;
        }
    }

    function isHandleInLocal(handle) {
        return getLocalHandles().includes(handle);
    }

    // ==================== 推送到号池 ====================
    async function pushToPool(handle) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'pool_push',
                handle: handle,
                source: '📌'
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('[博主推送] BG 不可达:', chrome.runtime.lastError.message);
                    resolve({ ok: false, msg: 'BG 不可达' });
                    return;
                }
                resolve(response || { ok: false, msg: 'no response' });
            });
        });
    }

    // ==================== 创建推送按钮 ====================
    function createPushButton(handle) {
        const btn = document.createElement('button');
        btn.className = CONFIG.buttonClass;
        btn.title = `推送 ${handle} 到号池`;
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1L14 7H10V15H6V7H2L8 1Z" fill="currentColor"/></svg> <span style="font-size:10px;">push</span>';

        if (isHandleInLocal(handle)) {
            btn.classList.add('pushed');
            btn.title = `${handle} 已在号池中`;
        }

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (isHandleInLocal(handle)) {
                showToast(`${handle} 已在号池`, 'info');
                return;
            }

            // 1. 推送到号池（实时）
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="4 2"><animateTransform attributeName="transform" type="rotate" values="0 8 8;360 8 8" dur="1s" repeatCount="indefinite"/></circle></svg>';
            const result = await pushToPool(handle);

            if (result && result.ok) {
                if (result.skipped > 0) {
                    showToast(`🔄 @${handle} 已存在（重复）`, 'info');
                } else {
                    showToast(`✅ 已推送: @${handle}`, 'success');
                }
                addHandleToLocal(handle);
                btn.classList.add('pushed');
                btn.title = `${handle} 已在号池中`;
                btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 4.5L6.5 11.5L2.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> <span style="font-size:10px;">done</span>';

                // 2. 同时入批量队列（用于统一 backup 上报）
                queueReport('PUSH_BLOGGER', {
                    handle: handle,
                    followed_by: getMyHandle(),
                    action_type: 'PUSH_BLOGGER'
                });
            } else {
                showToast(`❌ 推送失败: ${result?.msg || '未知错误'}`, 'error');
            }

            setTimeout(() => {
                btn.innerHTML = isHandleInLocal(handle) ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 4.5L6.5 11.5L2.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> <span style="font-size:10px;">done</span>' : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1L14 7H10V15H6V7H2L8 1Z" fill="currentColor"/></svg> <span style="font-size:10px;">push</span>';
            }, 1500);
        });

        return btn;
    }

    // ==================== 从URL提取handle ====================
    function extractHandleFromUrl(url) {
        if (!url) return null;
        const match = url.match(/^\/?([a-zA-Z0-9_]+)(?:\/|$)/);
        if (match && match[1]) {
            const handle = match[1];
            const excludes = ['home', 'explore', 'notifications', 'messages', 'settings',
                            'compose', 'search', 'i', 'hashtag', 'lists', 'bookmarks',
                            'followers', 'following', 'likes', 'with_replies', 'media',
                            'verified_followers', 'status'];
            if (!excludes.includes(handle.toLowerCase())) {
                return handle;
            }
        }
        return null;
    }

    // ==================== 注入按钮 ====================
    // 4.6.119：抽出单条处理，供 MutationObserver 增量调用（避免每次全文档 querySelectorAll）
    function injectArticle(article) {
        if (!article || article.getAttribute(CONFIG.processedAttr)) return;
        article.setAttribute(CONFIG.processedAttr, 'true');

        let handle = null;
        let targetElement = null;

        const avatarLink = article.querySelector('a[href^="/"][role="link"][data-testid="Tweet-User-Avatar"]');
        if (avatarLink) {
            handle = extractHandleFromUrl(avatarLink.getAttribute('href'));
            targetElement = avatarLink;
        }

        if (!handle) {
            const userNameArea = article.querySelector('[data-testid="User-Name"]');
            if (userNameArea) {
                const nameLink = userNameArea.querySelector('a[href^="/"]');
                if (nameLink) {
                    handle = extractHandleFromUrl(nameLink.getAttribute('href'));
                    targetElement = nameLink;
                }
            }
        }

        if (!handle) {
            const allLinks = article.querySelectorAll('a[href^="/"]');
            for (let link of allLinks) {
                const href = link.getAttribute('href');
                if (href && /^\/[a-zA-Z0-9_]+$/.test(href)) {
                    const possibleHandle = extractHandleFromUrl(href);
                    if (possibleHandle) {
                        handle = possibleHandle;
                        targetElement = link;
                        break;
                    }
                }
            }
        }

        if (handle && targetElement) {
            const parent = targetElement.closest('[data-testid="User-Name"]') || targetElement.parentElement;
            if (parent && !parent.querySelector(`.${CONFIG.buttonClass}`)) {
                const btn = createPushButton(handle);
                targetElement.insertAdjacentElement('afterend', btn);
            }
        }
    }

    function injectUserCell(cell) {
        if (!cell || cell.getAttribute('data-matrix-push-processed')) return;
        cell.setAttribute('data-matrix-push-processed', 'true');

        const profileLink = cell.querySelector('a[href^="/"][role="link"]');
        if (profileLink) {
            const handle = extractHandleFromUrl(profileLink.getAttribute('href'));
            if (handle) {
                const userNameArea = cell.querySelector('[data-testid="User-Name"]');
                if (userNameArea && !userNameArea.querySelector(`.${CONFIG.buttonClass}`)) {
                    const btn = createPushButton(handle);
                    userNameArea.appendChild(btn);
                } else if (!cell.querySelector(`.${CONFIG.buttonClass}`)) {
                    const btn = createPushButton(handle);
                    cell.appendChild(btn);
                }
            }
        }
    }

    function injectButtonsToTweets() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]:not([data-matrix-push-processed])');
        articles.forEach(injectArticle);
    }

    function injectButtonToProfile() {
        const profileHeader = document.querySelector('[data-testid="UserName"]');
        if (!profileHeader || profileHeader.getAttribute(CONFIG.processedAttr)) return;

        const handle = window.location.pathname.split('/')[1];
        if (!handle || handle === 'i' || handle === 'search' || handle === 'explore') return;

        profileHeader.setAttribute(CONFIG.processedAttr, 'true');

        const displayName = profileHeader.querySelector('div[dir="ltr"] span');
        if (displayName) {
            const btn = createPushButton(handle);
            displayName.insertAdjacentElement('afterend', btn);
        }
    }

    function injectButtonsToFollowers() {
        const userCells = document.querySelectorAll('[data-testid="UserCell"]:not([data-matrix-push-processed])');
        userCells.forEach(cell => {
            cell.setAttribute('data-matrix-push-processed', 'true');

            const profileLink = cell.querySelector('a[href^="/"][role="link"]');
            if (profileLink) {
                const handle = extractHandleFromUrl(profileLink.getAttribute('href'));
                if (handle) {
                    const userNameArea = cell.querySelector('[data-testid="User-Name"]');
                    if (userNameArea && !userNameArea.querySelector(`.${CONFIG.buttonClass}`)) {
                        const btn = createPushButton(handle);
                        userNameArea.appendChild(btn);
                    } else if (!cell.querySelector(`.${CONFIG.buttonClass}`)) {
                        const btn = createPushButton(handle);
                        cell.appendChild(btn);
                    }
                }
            }
        });
    }

    // ==================== MutationObserver 驱动扫描 ====================
    function isRelevantNode(node) {
        if (!(node instanceof Element)) return false;
        if (node.matches('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="UserName"]')) return true;
        return !!(node.querySelector('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="UserName"]'));
    }

    // 4.6.119 CPU 优化：observer 只收集新增节点，节流后做范围注入，
    // 不再对整个 document 跑 querySelectorAll（X 时间线高频 DOM 变更时差异显著）
    let _pushBloggerThrottleTimer = null;
    let _pendingNodes = [];
    function scheduleProcess(node) {
        if (_pendingNodes.length < 200) _pendingNodes.push(node);
        if (_pushBloggerThrottleTimer) return;
        _pushBloggerThrottleTimer = setTimeout(() => {
            _pushBloggerThrottleTimer = null;
            const nodes = _pendingNodes;
            _pendingNodes = [];
            for (const node of nodes) {
                try {
                    if (!node || !node.isConnected) continue;
                    if (node.matches && node.matches('article[data-testid="tweet"]')) injectArticle(node);
                    if (node.matches && node.matches('[data-testid="UserCell"]')) injectUserCell(node);
                    if (node.matches && node.matches('[data-testid="UserName"]')) injectButtonToProfile();
                    const innerArticles = node.querySelectorAll ? node.querySelectorAll('article[data-testid="tweet"]:not([data-matrix-push-processed])') : [];
                    innerArticles.forEach(injectArticle);
                    const innerCells = node.querySelectorAll ? node.querySelectorAll('[data-testid="UserCell"]:not([data-matrix-push-processed])') : [];
                    innerCells.forEach(injectUserCell);
                } catch (e) {}
            }
            // 新增的 UserName 可能是资料页头部（全文档仅一个，函数自带 processed 早退，成本极低）
            try { injectButtonToProfile(); } catch (e) {}
        }, 800);
    }

    function onMutation(mutations) {
        if (document.hidden) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (isRelevantNode(node)) {
                    scheduleProcess(node);
                    return;
                }
            }
        }
    }

    let _pushObserver = null;
    function startPushObserver() {
        if (_pushObserver) return;
        const target = document.body || document.documentElement;
        if (!target) return;
        _pushObserver = new MutationObserver(onMutation);
        _pushObserver.observe(target, { childList: true, subtree: true });
    }

    // ==================== 主循环 ====================
    function main() {
        if (document.hidden) return;
        injectButtonsToTweets();
        if (window.location.pathname.match(/^\/[a-zA-Z0-9_]+$/)) {
            injectButtonToProfile();
        }
        if (window.location.pathname.includes('/followers') || window.location.pathname.includes('/following')) {
            injectButtonsToFollowers();
        }
    }

    // 首次初始化 + DOM 增量监听；fallback 每 10s 兜底，后台标签暂停
    setTimeout(() => { startPushObserver(); main(); }, 1000);
    setInterval(() => { if (!document.hidden) main(); }, 10000);

    // 页面卸载时 flush 一次（防止数据丢失）
    window.addEventListener('beforeunload', () => {
        if (reportQueue.length > 0) flushQueue();
    });

    console.log('[博主推送] push_blogger.js 已加载 (V18.3.0 号池模式)');

})();
