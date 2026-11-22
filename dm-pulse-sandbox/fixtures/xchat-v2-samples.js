'use strict';

function makeRow(index, options) {
  const opts = options || {};
  return {
    id: 'dm-conversation-option-1000000000000000000:200000000000000000' + index,
    href: '/i/chat/1000000000000000000-200000000000000000' + index,
    inboxRow: true,
    icons: opts.verified ? ['icon-verified'] : opts.unread ? ['icon-circle-fill'] : [],
    selfPreview: !!opts.selfPreview,
    privateDisplayName: '虚构用户' + index,
    privatePreviewText: '虚构消息' + index
  };
}

const unreadFixture = {
  surface: 'list',
  listReady: true,
  loading: false,
  emptyState: false,
  rows: [
    makeRow(1, { unread: true }),
    makeRow(2),
    makeRow(3),
    makeRow(4),
    makeRow(5, { verified: true }),
    makeRow(6, { verified: true }),
    makeRow(7),
    makeRow(8),
    makeRow(9, { verified: true, selfPreview: true })
  ]
};

const readFixture = {
  surface: 'list',
  listReady: true,
  loading: false,
  emptyState: false,
  rows: [makeRow(1), makeRow(2, { verified: true })]
};

function scrollWindow(indexes, unreadIndex) {
  return {
    surface: 'list',
    listReady: true,
    loading: false,
    emptyState: false,
    rows: indexes.map((index) => makeRow(index, { unread: index === unreadIndex }))
  };
}

const scrollWindowA = scrollWindow([1, 2]);
const scrollWindowB = scrollWindow([2, 3, 4], 3);
const scrollWindowC = scrollWindow([4, 5, 6], 6);

module.exports = {
  makeRow,
  unreadFixture,
  readFixture,
  scrollWindow,
  scrollWindowA,
  scrollWindowB,
  scrollWindowC
};
