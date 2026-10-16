const test = require('node:test');
const assert = require('node:assert/strict');
const { STAGES } = require('../src/domain/stages');
const { getNextStage } = require('../src/services/funnel-service');
const { isActionAllowed } = require('../src/services/rules-service');

test('follow success advances discovered to followed', () => {
  assert.equal(getNextStage(STAGES.DISCOVERED, 'follow', 'success'), STAGES.FOLLOWED);
});

test('old events never roll a lead backwards', () => {
  assert.equal(getNextStage(STAGES.DM_SENT, 'follow', 'success'), STAGES.DM_SENT);
});

test('dm check blocks leads already completed/skipped/rejected', () => {
  const decision = isActionAllowed({
    actionType: 'dm',
    targetHandle: '@lead-1',
    lead: { current_stage: STAGES.COMPLETED },
    rules: {
      requireFollowBackBeforeDm: true,
      allowDuplicateFollow: false,
      blockedHandles: [],
    },
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /closed|rejected/i);
});
