(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./selectors'));
  else root.DmPulseInboxParser = factory(root.DmPulseSelectors);
}(typeof self !== 'undefined' ? self : this, function (selectors) {
  'use strict';
  const SCHEMA = selectors.SCHEMA;
  const ROW_ID_RE = selectors.ROW_ID_RE;

  function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

function emptyResult(schema, verdict, health) {
  return {
    schema,
    verdict,
    rows: [],
    unreadRows: 0,
    selectorHealth: health || { valid: false }
  };
}

function parseInboxSample(sample) {
  if (!sample || sample.surface !== 'list') {
    return emptyResult('unknown', 'wrong_surface');
  }
  const sourceRows = Array.isArray(sample.rows) ? sample.rows : [];
  if (sourceRows.some(row => row.kind === 'legacy')) {
    return emptyResult('unsupported', 'unsupported_schema');
  }
  sourceRows.forEach(row => {
    if (!ROW_ID_RE.test(String(row.id || ''))) {
      throw new Error('idShapeValid: invalid conversation id');
    }
    const hrefIds = String(row.href || '').match(/^\/i\/chat\/(\d+)-(\d+)\/?$/);
    const idPair = String(row.id).replace('dm-conversation-option-', '').split(':');
    if (!hrefIds || hrefIds[1] !== idPair[0] || hrefIds[2] !== idPair[1]) {
      throw new Error('hrefMatchesId: invalid conversation href');
    }
  });
  const rows = sourceRows.map((row, index) => ({
    rowKey: 'row-' + (index + 1),
    conversationKey: 'conversation-' + fnv1a(row.id),
    unread: Array.isArray(row.icons) && row.icons.includes('icon-circle-fill'),
    selfPreview: row.selfPreview === true,
    idShapeValid: true,
    structureValid: row.inboxRow === true
  }));
  return {
    schema: SCHEMA,
    verdict: null,
    rows,
    unreadRows: rows.filter(row => row.unread).length,
    selectorHealth: {
      valid: rows.every(row => row.structureValid),
      listReady: sample.listReady === true,
      loading: sample.loading === true,
      loadingMore: sample.loadingMore === true,
      emptyState: sample.emptyState === true
    }
  };
}

  return { parseInboxSample };
}));
