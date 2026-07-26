// =============================================================================
// X-Matrix-Bot 统一配置中心 (V18.2.1 号池模式)
// 基础：1-Extension V12.5.1 生产版（deepMerge / 路径访问 / storage 覆盖）
// 新增：任务锁机制防止异常中断后重复领号
// 兼容：Service Worker（background.js）和 Content Script（content_*.js）
// =============================================================================
//
// 使用方式：
//   - 同步获取完整配置：       MatrixConfig.getConfig()
//   - 同步获取单个值：         MatrixConfig.getConfigValue('pool.server')
//   - 异步加载存储配置：       await MatrixConfig.loadFromStorage()
//   - 更新配置并持久化：       await MatrixConfig.setConfigValue('pool.server', url)
//   - 重置为默认：            await MatrixConfig.resetConfig()
//
// 版本：V18.2.1
// =============================================================================

(function() {
    'use strict';

    // ==================== 默认配置（号池模式）====================
    const DEFAULT_CONFIG = {
        // 号池服务器（DeepSeek 核心）
        pool: {
            server: 'http://192.168.0.100:15678',
            timeout: 5000,
            endpoints: {
                push:   '/pool/push',
                push_batch: '/pool/push_batch',
                pop:    '/pool/pop',
                done:   '/pool/done',
                fail:   '/pool/fail',
                status: '/pool/status',
                links:  '/pool/links',
                health: '/health'
            }
        },

        // X ops console backend. Override this with the NAS URL in the extension UI/storage.
        opsConsole: {
            server: 'http://192.168.0.100:15680',
            timeout: 5000,
            endpoints: {
                activityCheck: '/api/plugin/activity/check',
                dmCheck: '/api/plugin/dm/check',
                activityReport: '/api/plugin/activity/report',
                health: '/health',
                scriptsPool: '/api/scripts/pool',
                dmDecide: '/api/plugin/dm/decide',
                dmResult: '/api/plugin/dm/result',
                dmSnapshot: '/api/plugin/dm/snapshot',
                dmProgress: '/api/plugin/dm/progress',
                dmBind: '/api/plugin/dm/bind'
            }
        },

        // 心跳/保活
        heartbeat: {
            interval: 5 * 60 * 1000,        // 5 分钟
            statusCheckInterval: 30000      // 状态检查 30 秒
        },

        // 数据同步队列（push_blogger 用）
        sync: {
            batchSize: 20,                  // 批量上报阈值
            flushInterval: 30 * 1000,       // 队列刷新间隔（30秒）
            maxQueueSize: 100               // 最大队列长度
        },

        // UI 配置
        ui: {
            consoleUpdateInterval: 10000,   // 中控台更新间隔（10秒）
            announcementDuration: 10000     // 公告显示时长（10秒）
        },

        // 关注配置（ui-console 设置面板写入）
        // follow daily limit (ramp + jitter)
        followLimit: {
            targetLimit: 200,
            firstDayLimit: 80,
            dailyStep: 40,
            jitterMax: 0
        },
        follow: {
            intervalMin: 12,                // 关注最小间隔（秒）
            intervalMax: 19,                // 关注最大间隔（秒）
            onlyJapanese: true,             // 只点日本词条
            backupQueueMax: 50              // backup 队列最大长度
        },

        // 防封模式配置
        antiBan: {
            enabled: false,                                  // 默认关闭
            limits: [0, 50, 100, 150, 200],                 // 阶梯日限额：第1天0, 第2天50, ...
            warmupLikeMin: 2,                                // 养号每轮最少点赞
            warmupLikeMax: 3                                 // 养号每轮最多点赞
        },

        // 养号配置
        nurture: {
            dailyBudget: {
                likes:     { min: 40, max: 80 },
                comments:  { min:  3, max:  8 },
                reposts:   { min:  1, max:  5 },
                trends:    { min:  5, max: 10 },
                profiles:  { min:  2, max:  5 },
            },
            hourlyBudget: {
                likes:     { min:  5, max: 15 },
                comments:  { min:  0, max:  3 },
                reposts:   { min:  0, max:  2 },
                trends:    { min:  1, max:  2 },
                profiles:  { min:  0, max:  1 },
            },
            actionGapSec:   { min: 10, max: 20 },
            actionWeights:  { like: 0.60, comment: 0.04, repost: 0.03, trend: 0.04, profile: 0.02 },
            activeHours:    { start: { hour: 8, minute: 0 }, end: { hour: 23, minute: 0 } },
            likeCooldownMin: 3,
            segmentMinutes: 15,
        },

        // 聊天配置
        chat: {
            maxRetry: 3,                    // 发送失败重试次数
            cooldownAfterFail: 60,          // 失败后冷却（秒）
            scriptsFile: "chat_scripts.json", // 默认话术文件
            shuffleMode: "random",          // random=随机抽取 | round_robin=轮换发放
            enabledScripts: ["direct_v1","curious_v1","blunt_v1"] // 默认启用的方案
        },

        // 调试配置
        debug: {
            enabled: false,
            logLevel: 'info'                // debug / info / warn / error
        }
    };

    // Chrome Storage 中的配置键名
    const STORAGE_KEY = 'matrix_config_overrides';

    // ==================== 内部状态 ====================
    let _config = deepClone(DEFAULT_CONFIG);
    let _loaded = false;

    // ==================== 工具函数 ====================

    function deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        try {
            return JSON.parse(JSON.stringify(obj));
        } catch (e) {
            return obj;
        }
    }

    function deepMerge(target, source) {
        const result = deepClone(target);
        for (const key in source) {
            if (source.hasOwnProperty(key)) {
                if (
                    result[key] &&
                    typeof result[key] === 'object' &&
                    !Array.isArray(result[key]) &&
                    typeof source[key] === 'object' &&
                    !Array.isArray(source[key])
                ) {
                    result[key] = deepMerge(result[key], source[key]);
                } else {
                    result[key] = deepClone(source[key]);
                }
            }
        }
        return result;
    }

    function getNestedValue(obj, path) {
        if (!path || !obj) return obj;
        const keys = path.split('.');
        let current = obj;
        for (const key of keys) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = current[key];
        }
        return current;
    }

    function setNestedValue(obj, path, value) {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        current[keys[keys.length - 1]] = value;
    }

    function isServiceWorker() {
        return typeof window === 'undefined' && typeof self !== 'undefined';
    }

    function getStorage() {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return chrome.storage.local;
        }
        return null;
    }

    // ==================== 核心 API ====================

    async function loadFromStorage() {
        const storage = getStorage();
        if (!storage) {
            console.log('[配置] chrome.storage.local 不可用，使用默认配置');
            _loaded = true;
            return false;
        }

        try {
            const result = await new Promise((resolve, reject) => {
                storage.get(STORAGE_KEY, (result) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(result);
                    }
                });
            });

            const overrides = result[STORAGE_KEY];
            if (overrides && typeof overrides === 'object') {
                _config = deepMerge(DEFAULT_CONFIG, overrides);
                console.log('[配置] 已从 storage 加载覆盖配置');
            } else {
                _config = deepClone(DEFAULT_CONFIG);
                console.log('[配置] storage 中无覆盖配置，使用默认值');
            }

            _loaded = true;
            return true;
        } catch (e) {
            console.error('[配置] 从 storage 加载配置失败:', e);
            _config = deepClone(DEFAULT_CONFIG);
            _loaded = true;
            return false;
        }
    }

    function getConfig() {
        return deepClone(_config);
    }

    function getConfigValue(path, defaultValue) {
        const value = getNestedValue(_config, path);
        return value !== undefined ? value : defaultValue;
    }

    async function setConfigValue(path, value) {
        setNestedValue(_config, path, value);

        const storage = getStorage();
        if (!storage) {
            console.warn('[配置] storage 不可用，配置仅在内存中生效');
            return false;
        }

        try {
            const result = await new Promise((resolve, reject) => {
                storage.get(STORAGE_KEY, (result) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(result);
                    }
                });
            });

            const overrides = result[STORAGE_KEY] || {};
            setNestedValue(overrides, path, value);

            await new Promise((resolve, reject) => {
                storage.set({ [STORAGE_KEY]: overrides }, () => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve();
                    }
                });
            });

            console.log('[配置] 已保存配置到 storage:', path);
            return true;
        } catch (e) {
            console.error('[配置] 保存配置到 storage 失败:', e);
            return false;
        }
    }

    async function resetConfig() {
        _config = deepClone(DEFAULT_CONFIG);

        const storage = getStorage();
        if (!storage) return false;

        try {
            await new Promise((resolve, reject) => {
                storage.remove(STORAGE_KEY, () => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve();
                    }
                });
            });

            console.log('[配置] 已重置为默认配置');
            return true;
        } catch (e) {
            console.error('[配置] 重置配置失败:', e);
            return false;
        }
    }

    function isLoaded() {
        return _loaded;
    }

    async function ensureLoaded() {
        if (!_loaded) {
            await loadFromStorage();
        }
    }

    // ==================== 便捷方法 ====================

    function getPoolServer() {
        return getConfigValue('pool.server', DEFAULT_CONFIG.pool.server);
    }

    function getPoolEndpoint(name) {
        const ep = getConfigValue(`pool.endpoints.${name}`);
        return ep || (DEFAULT_CONFIG.pool.endpoints[name] || '');
    }

    function getPoolUrl(endpointName) {
        return getPoolServer() + getPoolEndpoint(endpointName);
    }

    function getOpsConsoleServer() {
        return getConfigValue('opsConsole.server', DEFAULT_CONFIG.opsConsole.server);
    }

    function getOpsConsoleEndpoint(name) {
        const ep = getConfigValue(`opsConsole.endpoints.${name}`);
        return ep || (DEFAULT_CONFIG.opsConsole.endpoints[name] || '');
    }

    function getOpsConsoleUrl(endpointName) {
        return getOpsConsoleServer() + getOpsConsoleEndpoint(endpointName);
    }

    // ==================== 导出 API ====================

function getDailyLimit(dayIndex) {
  const cfg = getConfigValue('followLimit', {});
  const target = (cfg.targetLimit ?? 200);
  const first = (cfg.firstDayLimit ?? 100);
  const step = (cfg.dailyStep ?? 10);
  const jitterMax = (cfg.jitterMax ?? 9);
  const idx = Math.max(0, Number(dayIndex) || 0);
  const base = Math.min(target, first + step * idx);
  const jitter = Math.floor(Math.random() * (jitterMax + 1));
  return base + jitter;
}

function isAntiBanEnabled() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('matrix_antiban_enabled') === 'true';
    }
  } catch (_) {}
  return getConfigValue('antiBan.enabled', false);
}

function getAntiBanLimit(dayIndex) {
  const cfg = getConfigValue('antiBan', {});
  const limits = cfg.limits || [0, 50, 100, 150, 200];
  const idx = Math.max(0, Math.min(Number(dayIndex) || 0, limits.length - 1));
  return limits[idx];
}

    const api = {
        getConfig,
        getConfigValue,
        setConfigValue,
        resetConfig,
        loadFromStorage,
        isLoaded,
        ensureLoaded,

        // 便捷方法
        getPoolServer,
        getPoolEndpoint,
        getPoolUrl,
        getOpsConsoleServer,
        getOpsConsoleEndpoint,
        getOpsConsoleUrl,
        getDailyLimit,
        isAntiBanEnabled,
        getAntiBanLimit,

        // 便捷访问器（只读）
        get pool() { return _config.pool; },
        get opsConsole() { return _config.opsConsole; },
        get heartbeat() { return _config.heartbeat; },
        get sync() { return _config.sync; },
        get ui() { return _config.ui; },
        get follow() { return _config.follow; },
        get antiBan() { return _config.antiBan; },
        get nurture() { return _config.nurture; },
        get chat() { return _config.chat; },
        get debug() { return _config.debug; },

        // 版本信息
        version: 'V18.2.1',

        // 默认配置引用（只读）
        defaults: deepClone(DEFAULT_CONFIG)
    };

    // 环境检测与导出
    if (isServiceWorker()) {
        self.__MATRIX_CONFIG__ = api;
        self.MatrixConfig = api;
    } else {
        window.__MATRIX_CONFIG__ = api;
        window.MatrixConfig = api;
    }

    // ==================== 自动初始化 ====================
    loadFromStorage().catch(e => {
        console.error('[配置] 自动加载失败:', e);
    });

    console.log(`[配置] 统一配置模块已加载 (V18.2.1 号池模式)，环境: ${isServiceWorker() ? 'ServiceWorker' : 'ContentScript'}`);

})();

