const { STAGE_ORDER } = require('../domain/stages');

const SUCCESS_STAGE_BY_ACTION = {
  discover: 'discovered',
  follow: 'followed',
  follow_back: 'followed_back',
  mark_dm_ready: 'dm_ready',
  ice_sent: 'ice_sent',
  ad_sent: 'ad_sent',
  kick_sent: 'kick_sent',
  reject_sent: 'rejected',
  foreigner_reject_sent: 'rejected',
  dm: 'dm_sent',
  complete: 'completed',
  skip: 'skipped',
};

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(stage);
}

function getNextStage(currentStage, actionType, result) {
  if (result !== 'success') return currentStage;

  const candidate = SUCCESS_STAGE_BY_ACTION[actionType];
  if (!candidate) return currentStage;
  if (!currentStage) return candidate;

  return stageIndex(candidate) > stageIndex(currentStage) ? candidate : currentStage;
}

module.exports = { getNextStage, SUCCESS_STAGE_BY_ACTION };
