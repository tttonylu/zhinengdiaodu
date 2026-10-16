const { STAGES } = require('../domain/stages');
const { getNextStage } = require('./funnel-service');

function createLeadsService(leadsRepo) {
  return {
    ensureLead(targetHandle, source) {
      let lead = leadsRepo.findByHandle(targetHandle);
      if (lead) return lead;

      leadsRepo.insert({
        platform: 'x',
        target_handle: targetHandle,
        source,
        current_stage: STAGES.DISCOVERED,
      });

      return leadsRepo.findByHandle(targetHandle);
    },

    advanceLead(lead, actionType, result, accountId, eventTime) {
      const nextStage = getNextStage(lead.current_stage, actionType, result);

      leadsRepo.updateStage({
        id: lead.id,
        current_stage: nextStage,
        bound_account_id: accountId || lead.bound_account_id,
        event_time: eventTime,
        action_type: actionType,
      });

      return leadsRepo.findById(lead.id);
    },

    list(filters) {
      return leadsRepo.list(filters);
    },

    getDetail(id) {
      return leadsRepo.findDetail(id);
    },

    markCompleted(id, reason = 'manual_complete') {
      const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      leadsRepo.markClosed(id, STAGES.COMPLETED, reason, ts);
      return leadsRepo.findDetail(id);
    },

    markSkipped(id, reason = 'manual_skip') {
      const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      leadsRepo.markClosed(id, STAGES.SKIPPED, reason, ts);
      return leadsRepo.findDetail(id);
    },
  };
}

module.exports = { createLeadsService };
