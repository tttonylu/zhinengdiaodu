// =============================================================================
// 智能调度 — 统一 storage key 常量（唯一权威来源）
//   LK = localStorage Key
//   SK = sessionStorage Key
//   CK = chrome.storage Key
// =============================================================================

var SKeys = (function () {
  'use strict';

  return {
    // --- 调度器自身（sg_ 前缀）---
    LK_STATE: 'sg_state',
    LK_LOG: 'sg_log',
    LK_SUSPENDED: 'sg_suspended_blogger',

    // --- 关注引擎（matrix_ 前缀，号池原版不改）---
    LK_FOLLOW_RUNNING: 'matrix_follow_running',
    LK_WARMUP_NEEDED: 'matrix_warmup_needed',
    LK_WARMUP_END: 'matrix_warmup_end_time',
    LK_FOLLOW_STEP: 'matrix_step',
    LK_CURRENT_CREATOR: 'matrix_current_creator',
    LK_CURRENT_TASK_ID: 'matrix_current_task_id',
    LK_GLOBAL_COOLDOWN: 'matrix_global_cooldown_until',
    LK_MY_HANDLE: 'matrix_my_handle',
    LK_WARMUP_SAVED_CREATOR: 'matrix_warmup_saved_creator',
    LK_ANTIBAN_ENABLED: 'matrix_antiban_enabled',
    LK_CONSOLE_SETTINGS: 'matrix_console_settings',
    LK_PURE_NURTURE: 'matrix_pure_nurture_mode',

    SK_TAB_RUNNING: 'matrix_tab_running',

    // --- 私信引擎（dan_ 前缀，DAN原版不改）---
    LK_CHAT_STATUS: 'dan_chat_status',
    LK_CHAT_RECOVERY: 'dan_recovery_auto_run',
    LK_CHAT_ROUNDS: 'dan_round_states',
    LK_CHAT_SCRIPTS: 'chat_scripts',
    LK_PROMO_LINKS: 'sg_links',

    SK_CHAT_AUTO_RUN: 'dan_auto_run',
    SK_CHAT_STEP: 'dan_auto_step',
    SK_CHAT_TARGET: 'dan_target_username',
    SK_CURRENT_TARGET: 'current_target',
    SK_PAUSED_TILL: 'sg_paused_till',

    // --- 养号引擎（sg_ 前缀）---
    LK_NURTURE_RUNNING: 'sg_nurture_running',
    LK_NURTURE_ONLY: 'sg_nurture_only',
    LK_NURTURE_SETTINGS: 'sg_nurture_settings',
    LK_NURTURE_DAILY: 'sg_nurture_daily',
    SK_NURTURE_RUNNING: 'sg_nurture_running',
    SK_NURTURE_PAUSED: 'sg_nurture_paused',
  };
})();
