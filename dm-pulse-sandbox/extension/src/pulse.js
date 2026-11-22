(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./inbox-parser'));
  else root.DmPulsePulse = factory(root.DmPulseInboxParser);
}(typeof self !== 'undefined' ? self : this, function (parser) {
  'use strict';
  const parseInboxSample = parser.parseInboxSample;

function rowSignature(rows) {
  return JSON.stringify(rows.map(row => [
    row.conversationKey,
    row.unread,
    row.selfPreview,
    row.structureValid
  ]));
}

function runReadonlyPulse(options) {
  const input = options || {};
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const budgetMs = input.budgetMs == null ? 15000 : input.budgetMs;
  const intervalMs = input.intervalMs == null ? 500 : input.intervalMs;
  const emptyGraceMs = input.emptyGraceMs == null ? 5000 : input.emptyGraceMs;
  const mode = input.mode === 'deep' ? 'deep' : 'snapshot';
  const scrollMeta = input.scrollMeta && typeof input.scrollMeta === 'object' ? input.scrollMeta : {};
  const history = [];
  const errors = [];
  const seenRows = new Map();
  let schema = 'unknown';
  let visibleRows = 0;
  let maxVisibleRows = 0;
  let unreadRows = 0;
  let selectorHealth = { valid: false };
  let lastSignature = '';
  let stableCount = 0;
  let emptySince = null;
  let verdict = 'samples_exhausted';
  let durationMs = 0;
  let budgetExceeded = false;

  function uniqueUnreadCount() {
    let count = 0;
    seenRows.forEach((row) => {
      if (row.unread) count++;
    });
    return count;
  }

  function report(atMs) {
    const uniqueUnread = uniqueUnreadCount();
    return {
      schema,
      mode,
      probeRev: input.probeRev || 'unknown',
      pageState: input.pageState || null,
      pulseId: input.pulseId || 'local-pulse',
      startedAt: input.startedAt || null,
      durationMs: atMs,
      verdict,
      visibleRows: mode === 'deep' ? maxVisibleRows : visibleRows,
      unreadRows: mode === 'deep' ? uniqueUnread : unreadRows,
      uniqueRowsSeen: seenRows.size,
      uniqueUnreadRows: uniqueUnread,
      scrollSteps: Number(scrollMeta.scrollSteps) || 0,
      bottomReached: scrollMeta.bottomReached === true,
      restoredScroll: scrollMeta.restoredScroll === true,
      scrollAvailable: scrollMeta.scrollAvailable !== false,
      scanComplete: scrollMeta.scanComplete === true,
      samples: history,
      selectorHealth,
      errors
    };
  }

  function finalizeDeep() {
    const unread = uniqueUnreadCount();
    if (unread > 0) {
      verdict = 'unread_found';
      return;
    }
    const rowSamples = history.filter((entry) =>
      entry.rows > 0 && entry.listReady === true && entry.loading !== true);
    const last = history.length ? history[history.length - 1] : null;
    if (rowSamples.length >= 2 && last && last.listReady === true && last.loading !== true) {
      verdict = 'no_unread_confirmed';
      return;
    }
    if (last && last.rows === 0 && last.listReady === true && last.loading !== true &&
        last.emptyState === true && stableCount >= 2 && durationMs >= emptyGraceMs) {
      verdict = 'empty_confirmed';
      return;
    }
    if (budgetExceeded) {
      verdict = 'loading_timeout';
      return;
    }
    verdict = 'samples_exhausted';
  }

  for (let index = 0; index < samples.length; index++) {
    const atMs = Array.isArray(input.now) ? input.now[index] : index * intervalMs;
    durationMs = atMs;
    if (atMs > budgetMs) {
      budgetExceeded = true;
      if (mode !== 'deep') verdict = 'loading_timeout';
      break;
    }
    const sample = samples[index];
    if (!sample || sample.surface !== 'list') {
      verdict = 'wrong_surface';
      break;
    }
    if (sample.selectorMismatch === true) {
      verdict = 'selector_degraded';
      break;
    }

    let parsed;
    try {
      parsed = parseInboxSample(sample);
    } catch (error) {
      errors.push({ atMs, reason: 'parse_error' });
      verdict = 'selector_degraded';
      break;
    }
    schema = parsed.schema;
    const parsedVisible = parsed.rows.length;
    visibleRows = parsedVisible;
    maxVisibleRows = Math.max(maxVisibleRows, parsedVisible);
    unreadRows = parsed.unreadRows;
    selectorHealth = parsed.selectorHealth;
    if (parsed.verdict === 'unsupported_schema') {
      verdict = 'unsupported_schema';
      break;
    }

    parsed.rows.forEach((row) => {
      const existing = seenRows.get(row.conversationKey);
      if (!existing) {
        seenRows.set(row.conversationKey, row);
      } else if (row.unread) {
        existing.unread = true;
      }
    });

    const signature = rowSignature(parsed.rows);
    stableCount = signature === lastSignature ? stableCount + 1 : 1;
    lastSignature = signature;
    history.push({
      atMs,
      rows: parsedVisible,
      unreadRows: parsed.unreadRows,
      uniqueRowsSeen: seenRows.size,
      loading: sample.loading === true,
      loadingMore: sample.loadingMore === true,
      emptyState: sample.emptyState === true,
      listReady: sample.listReady === true,
      structureValid: selectorHealth.valid,
      scrollStep: Number(sample.scrollStep) || 0,
      scrollTop: Number.isFinite(sample.scrollTop) ? sample.scrollTop : null,
      bottomReached: sample.bottomReached === true,
      scrollerTag: sample.scrollerTag || null,
      scrollerRole: sample.scrollerRole || null,
      scrollerMatchesListbox: sample.scrollerMatchesListbox === true,
      scrollerInShadow: sample.scrollerInShadow === true
    });

    if (!selectorHealth.valid && parsedVisible > 0) {
      verdict = 'selector_degraded';
      break;
    }

    if (mode === 'deep') {
      if (atMs >= budgetMs) {
        budgetExceeded = true;
        break;
      }
      continue;
    }

    if (visibleRows > 0 && stableCount >= 2 && sample.listReady === true && sample.loading !== true) {
      verdict = unreadRows > 0 ? 'unread_found' : 'no_unread_confirmed';
      break;
    }

    const confirmedEmptyState = visibleRows === 0 &&
      sample.listReady === true && sample.loading !== true && sample.emptyState === true;
    if (confirmedEmptyState) {
      if (emptySince === null) emptySince = atMs;
    } else {
      emptySince = null;
    }
    if (emptySince !== null && atMs - emptySince > emptyGraceMs && stableCount >= 2) {
      verdict = 'empty_confirmed';
      break;
    }
    if (atMs === budgetMs) {
      verdict = 'loading_timeout';
      break;
    }
  }

  if (mode === 'deep' && (verdict === 'samples_exhausted' || budgetExceeded)) {
    finalizeDeep();
  }

  return report(durationMs);
}

  return { runReadonlyPulse };
}));
