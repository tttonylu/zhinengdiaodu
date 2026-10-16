const STAGES = {
  DISCOVERED: 'discovered',
  FOLLOWED: 'followed',
  FOLLOWED_BACK: 'followed_back',
  DM_READY: 'dm_ready',
  ICE_SENT: 'ice_sent',
  AD_SENT: 'ad_sent',
  KICK_SENT: 'kick_sent',
  REJECTED: 'rejected',
  DM_SENT: 'dm_sent',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
};

const STAGE_ORDER = [
  STAGES.DISCOVERED,
  STAGES.FOLLOWED,
  STAGES.FOLLOWED_BACK,
  STAGES.DM_READY,
  STAGES.ICE_SENT,
  STAGES.AD_SENT,
  STAGES.KICK_SENT,
  STAGES.REJECTED,
  STAGES.DM_SENT,
  STAGES.COMPLETED,
  STAGES.SKIPPED,
];

module.exports = { STAGES, STAGE_ORDER };
