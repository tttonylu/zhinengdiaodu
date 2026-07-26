// =============================================================================
// X-Matrix-Bot 用户ID自动提取器 (V18.2.1 号池模式适配版)
// 基于 1-Extension V12.5.1 改造：
//   - 移除所有远程上报（GuardAgent / NAS / Controller）
//   - 仅本地写入 localStorage.matrix_my_handle = "@handle#guard"
//   - 移除调试浮动面板
//   - 保留多开身份（BitBrowser bit_id 仍写入 sessionStorage）
// =============================================================================
// 触发时机：页面加载完成后 3 秒（与 1-Extension 一致）
// =============================================================================

(function() {
    'use strict';

    // 防止重复注入
    if (window.__matrix_id_extractor_injected__) return;
    window.__matrix_id_extractor_injected__ = true;

    // ================= 诊断日志 =================
    console.log('[ID提取器] id_extractor.js 已加载 (V18.2.1)');

    // 延迟执行，等待页面完全加载
    setTimeout(extractAndStore, 3000);

    function extractAndStore() {
        try {
            // 清除旧的 sessionStorage 缓存
            const oldInstanceId = sessionStorage.getItem('matrix_instance_id');
            if (oldInstanceId) {
                sessionStorage.removeItem('matrix_instance_id');
            }
            const oldTabId = sessionStorage.getItem('matrix_tab_id');
            if (oldTabId) {
                sessionStorage.removeItem('matrix_tab_id');
            }
            const oldWindowShortId = sessionStorage.getItem('matrix_window_short_id');
            if (oldWindowShortId) {
                sessionStorage.removeItem('matrix_window_short_id');
            }

            const handle = extractHandle();

            if (!handle) {
                console.log('[ID提取器] 未能提取到用户ID（未登录？）');
                return;
            }

            // 过滤无效 handle
            const INVALID_HANDLES = ['home', 'explore', 'notifications', 'messages', 'search', 'i', 'settings', 'compose'];
            if (/^\d+$/.test(handle) || INVALID_HANDLES.includes(handle.toLowerCase())) {
                console.log('[ID提取器] 跳过无效 handle:', handle);
                return;
            }

            // 统一使用 @handle#guard 格式
            const profileId = '@' + handle + '#guard';

            // 获取 bit_id（多开区分，BitBrowser 窗口 ID）
            let bitId = sessionStorage.getItem('matrix_bit_id');
            if (!bitId) {
                bitId = new URLSearchParams(window.location.search).get('bit_id') || '';
                if (bitId) {
                    sessionStorage.setItem('matrix_bit_id', bitId);
                }
            }

            // 仅本地写入，不发远程
            localStorage.setItem('matrix_my_handle', profileId);
            localStorage.setItem('matrix_extracted_handle', handle);
            if (bitId) {
                localStorage.setItem('matrix_bit_id', bitId);
            }

            console.log('[ID提取器] 已写入: matrix_my_handle =', profileId, 'bit_id =', bitId || '(none)');

            // Sync to chrome.storage.local via background.js
            try {
                chrome.runtime.sendMessage({
                    action: "set_my_handle",
                    handle: profileId,
                    bit_id: bitId || ''
                });
            } catch(e) {}

            // 通知其他 content script（关注/聊天引擎）
            window.dispatchEvent(new CustomEvent('matrix:handle-ready', {
                detail: { handle, profileId, bitId }
            }));

        } catch (e) {
            console.error('[ID提取器] 错误:', e);
        }
    }

    function extractHandle() {
        // 方法1: 从导航栏个人资料链接提取
        let handle = null;
        const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        if (profileLink && profileLink.href) {
            // Handle both absolute (https://x.com/handle) and relative (/handle) hrefs
            const absMatch = profileLink.href.match(/x\.com\/([^\/\?]+)/);
            const relMatch = (profileLink.getAttribute('href') || '').match(/^\/([^\/\?]+)$/);
            const match = absMatch || relMatch;
            if (match && match[1] && match[1] !== 'i' && match[1] !== 'home') {
                return match[1].toLowerCase();
            }
        }

        // 方法2: 从账号切换按钮提取
        if (!handle) {
            const accountBtn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
            if (accountBtn) {
                const text = accountBtn.innerText || '';
                const match = text.match(/@([\w_]+)/i);
                if (match) {
                    return match[1].toLowerCase();
                }
            }
        }

        // 方法3: 从页面脚本数据提取 screen_name
        if (!handle) {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                const match = text.match(/"screen_name":"([^"]+)"/);
                if (match) {
                    return match[1].toLowerCase();
                }
            }
        }

        // 方法4: 从 URL 路径提取（如果在个人主页）
        if (!handle) {
            const path = window.location.pathname;
            const match = path.match(/^\/([\w_]+)(?:\/|$)/);
            if (match && match[1] && !['home', 'explore', 'notifications', 'messages', 'i', 'search'].includes(match[1])) {
                return match[1].toLowerCase();
            }
        }

        return null;
    }

    // 响应 background 强制刷新请求
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "matrix_force_extract") {
            console.log('[ID提取器] 收到强制重新提取请求');
            extractAndStore();
            sendResponse({ status: "extract_triggered" });
            return true;
        }
    });

})();
