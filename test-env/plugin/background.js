// =============================================================================
// 智能调度中心 v3 — 后台常驻大脑（Service Worker）
// 职责：加载各模块 + 启动调度器 + 保活 + 消息中转
// 注意：Service Worker 没有 localStorage，只加载 SW 兼容的模块
// =============================================================================

try { importScripts('config.js'); } catch (e) { console.error('[SW] config 加载失败:', e); }
try { importScripts('core/clock.js'); } catch (e) { console.error('[SW] clock 加载失败:', e); }
try { importScripts('core/error-reporter.js'); } catch (e) { console.error('[SW] error-reporter 加载失败:', e); }
try { importScripts('core/scheduler.js'); } catch (e) { console.error('[SW] scheduler 加载失败:', e); }
