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
    /** 兼职粉话术池（localStorage dan_scripts_job；与交友 dan_scripts 隔离） */
    LK_CHAT_SCRIPTS_JOB: 'dan_scripts_job',
    LK_PROMO_LINKS: 'sg_links',
    // 回复检测状态（dan_reply_state）的持久镜像：localStorage 副本，标签页/扩展重载后可回填 sessionStorage
    LK_CHAT_REPLY_STATE: 'dan_reply_state',
    // 实机校准的收件箱未读 DOM selector（testid / aria-label 白名单）
    LK_DM_UNREAD_SELECTORS: 'sg_dm_unread_selectors',

    SK_CHAT_AUTO_RUN: 'dan_auto_run',
    SK_CHAT_STEP: 'dan_auto_step',
    SK_CHAT_TARGET: 'dan_target_username',
    SK_ICE_TASK_QUEUE: 'dan_ice_task_queue',
    SK_INBOX_TASK_QUEUE: 'dan_inbox_task_queue',
    SK_CURRENT_TARGET: 'current_target',
    SK_PAUSED_TILL: 'sg_paused_till',

    // --- 养号引擎（sg_ 前缀）---
    LK_NURTURE_RUNNING: 'sg_nurture_running',
    LK_NURTURE_ONLY: 'sg_nurture_only',
    LK_NURTURE_SETTINGS: 'sg_nurture_settings',
    LK_NURTURE_DAILY: 'sg_nurture_daily',
    SK_NURTURE_RUNNING: 'sg_nurture_running',
    SK_NURTURE_PAUSED: 'sg_nurture_paused',

    // --- 转帖引擎 ---
    LK_REPOST_TARGETS: 'sg_repost_targets',
    LK_REPOST_CONFIG: 'sg_repost_config',
    LK_REPOST_POSTED: 'sg_repost_posted_ids',
    LK_REPOST_AUTO_DATE: 'sg_repost_auto_date',
    LK_REPOST_AUTO_STATUS: 'sg_repost_auto_status',
    SK_REPOST_RUNNING: 'sg_repost_running',
    SK_REPOST_AUTO_SLOT: 'sg_repost_auto_slot',

    // --- 资料克隆（与转帖来源共用；按 handle 后缀隔离）---
    LK_PROFILE_CLONE_STATE_PREFIX: 'sg_profile_clone_state_',
    SK_PROFILE_CLONE_JOB: 'sg_profile_clone_job',
    SK_PROFILE_CLONE_RUNNING: 'sg_profile_clone_running',

    // --- 用户点「停止」：禁止引擎 recover / 克隆续跑拉养号 ---
    LK_USER_PAUSED: 'sg_user_paused',
  };
})();
