const fs = require('node:fs');
const path = require('node:path');

function defaultRules() {
  return {
    requireFollowBackBeforeDm: true,
    allowDuplicateFollow: false,
    defaultDailyFollowLimit: 260,
    defaultDailyDmLimit: 50,
    stalledHoursThreshold: 24,
    blockedHandles: [],
  };
}

function loadRules(rulesPath) {
  if (!rulesPath || !fs.existsSync(rulesPath)) {
    return defaultRules();
  }
  return { ...defaultRules(), ...JSON.parse(fs.readFileSync(rulesPath, 'utf8')) };
}

function saveRules(rulesPath, rules) {
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, JSON.stringify({ ...defaultRules(), ...rules }, null, 2));
}

function isActionAllowed({ actionType, targetHandle, lead, rules }) {
  if ((rules.blockedHandles || []).includes(targetHandle)) {
    return { allowed: false, reason: 'handle blocked by rules' };
  }

  if (!lead) {
    return { allowed: true, reason: 'new target, allow dm/bind to decide' };
  }

  // follow 规则：不允许重复关注（除非是 discovered 阶段）
  if (
    actionType === 'follow' &&
    !rules.allowDuplicateFollow &&
    lead.current_stage !== 'discovered'
  ) {
    return { allowed: false, reason: 'lead already progressed past follow' };
  }

  // dm 规则：只检查是否已完成/跳过/拉黑
  // 不再强制要求 dm_ready 阶段，因为聊天流程由 dm/decide 统一管理
  if (actionType === 'dm') {
    if (['completed', 'skipped', 'rejected'].includes(lead.current_stage)) {
      return { allowed: false, reason: 'lead is closed/rejected' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

module.exports = { defaultRules, loadRules, saveRules, isActionAllowed };
