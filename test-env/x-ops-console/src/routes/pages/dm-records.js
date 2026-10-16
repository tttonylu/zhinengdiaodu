const { createDmRecordsRepo } = require('../../repositories/dm-records-repo');
const { maybeAlertDmCapacity } = require('../../services/dm-capacity-alert');

async function dmRecordsPageRoutes(app) {
  const dmRepo = createDmRecordsRepo(app.db);

  app.get('/dm-records', async (request, reply) => {
    var offset = parseInt(request.query.offset || '0') || 0;
    var limit = 50;
    var records = dmRepo.listAll(null, offset, limit);
    var total = dmRepo.countAll();
    const health = dmRepo.todayHourlyHealth();
    const progress = dmRepo.todayTargetProgress();

    let capacity = { alert: false };
    try {
      capacity = await maybeAlertDmCapacity(app, dmRepo, health);
    } catch (eCap) {
      capacity = { alert: false, error: eCap.message };
    }

    return reply.view('dm-records.njk', {
      title: 'DM 记录',
      records,
      offset,
      limit,
      total: (total && total.c) || 0,
      healthHours: health.hours || [],
      healthTotals: health.totals || {},
      progressSummary: (progress && progress.summary) || { total: 0, done: 0, adOnly: 0, iceOnly: 0, failedOnly: 0 },
      progressStalled: (progress && progress.stalled) || [],
      progressStalledTotal: (progress && progress.stalledTotal) || 0,
      capacityAlert: !!capacity.alert,
      capacityPrev: (capacity.snapshot && capacity.snapshot.prevHour) || null,
      capacityNote: '口径：按话术池轮次统计 — 第1轮=破冰、第2轮=广告、第3轮=催加；括号内「含链接」是第2轮广告中带推广链接（http/line.me）的子集，不是另一类。「婉拒」是对方拒绝后发出的婉拒话术（占用第2轮槽位），不计入广告；[peer_first_placeholder]/[*_reject_done] 等系统标记行非真实发送，不计数。失败/未确认不分轮次。告警只盯含链接广告是否断崖，不硬判进线。',
    });
  });
}

module.exports = { dmRecordsPageRoutes };
