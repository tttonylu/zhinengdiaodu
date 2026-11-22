'use strict';

const { CONVERSATION_PATH_RE, ROW } = require('../extension/src/selectors');

function classifySurface(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  if (path === '/i/chat') return 'list';
  if (CONVERSATION_PATH_RE.test(path)) return 'conversation';
  return 'other';
}

async function sampleVisibleInbox(tab) {
  const url = await tab.url();
  const pathname = new URL(url).pathname;
  const surface = classifySurface(pathname);
  if (surface !== 'list') {
    return { surface, listReady: false, loading: false, emptyState: false, rows: [] };
  }

  const listbox = tab.playwright.getByRole('listbox');
  const listReady = await listbox.count() === 1;
  const loadingMore = await tab.playwright.getByRole('status').count() > 0;
  if (!listReady) {
    return { surface, listReady, loading: true, loadingMore, emptyState: false, rows: [] };
  }
  const snapshot = await listbox.evaluate(list => {
    const options = [...list.querySelectorAll('a[role="option"][id^="dm-conversation-option-"]')];
    const candidateRows = [...list.querySelectorAll('[data-inbox-row]')];
    const optionRows = [...list.querySelectorAll('[role="option"]')];
    return {
      rows: options.map(element => ({
        id: element.id,
        href: element.getAttribute('href') || '',
        inboxRow: !!element.querySelector('[data-inbox-row]'),
        icons: [...element.querySelectorAll('[data-icon]')].map(icon => icon.getAttribute('data-icon')),
        selfPreview: /^(你|You)[:：]/.test((element.textContent || '').trim())
      })),
      candidateCount: candidateRows.length,
      optionCount: optionRows.length,
      knownEmptyText: /^(暂无对话|没有对话|No conversations|No messages|メッセージはありません|会話はありません)$/i.test((list.textContent || '').trim())
    };
  });
  const emptyState = snapshot.rows.length === 0 && snapshot.knownEmptyText;
  const loading = loadingMore && snapshot.rows.length === 0 && !emptyState;
  return {
    surface,
    listReady,
    loading,
    loadingMore,
    emptyState,
    selectorMismatch: snapshot.candidateCount > 0 && snapshot.rows.length === 0,
    rows: snapshot.rows,
    candidateCount: snapshot.candidateCount,
    optionCount: snapshot.optionCount
  };
}

module.exports = { classifySurface, sampleVisibleInbox };
