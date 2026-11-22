(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DmPulseReport = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function buildPublicReport(result) {
  return {
    schema: result.schema,
    mode: result.mode || 'snapshot',
    probeRev: result.probeRev || 'unknown',
    pageState: result.pageState || null,
    pulseId: result.pulseId,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    verdict: result.verdict,
    visibleRows: result.visibleRows,
    unreadRows: result.unreadRows,
    uniqueRowsSeen: result.uniqueRowsSeen || 0,
    uniqueUnreadRows: result.uniqueUnreadRows || 0,
    scrollSteps: result.scrollSteps || 0,
    bottomReached: result.bottomReached === true,
    restoredScroll: result.restoredScroll === true,
    scrollAvailable: result.scrollAvailable !== false,
    scanComplete: result.scanComplete === true,
    samples: result.samples.map(sample => ({
      atMs: sample.atMs,
      rows: sample.rows,
      unreadRows: sample.unreadRows,
      uniqueRowsSeen: sample.uniqueRowsSeen || 0,
      loading: sample.loading,
      loadingMore: sample.loadingMore,
      emptyState: sample.emptyState,
      listReady: sample.listReady,
      structureValid: sample.structureValid,
      scrollStep: sample.scrollStep || 0,
      scrollTop: sample.scrollTop == null ? null : sample.scrollTop,
      bottomReached: sample.bottomReached === true,
      scrollerTag: sample.scrollerTag || null,
      scrollerRole: sample.scrollerRole || null,
      scrollerMatchesListbox: sample.scrollerMatchesListbox === true,
      scrollerInShadow: sample.scrollerInShadow === true
    })),
    selectorHealth: {
      valid: result.selectorHealth.valid,
      listReady: result.selectorHealth.listReady,
      loading: result.selectorHealth.loading,
      loadingMore: result.selectorHealth.loadingMore,
      emptyState: result.selectorHealth.emptyState
    },
    errors: result.errors.map(error => ({ atMs: error.atMs, reason: error.reason }))
  };
}

  return { buildPublicReport };
}));
