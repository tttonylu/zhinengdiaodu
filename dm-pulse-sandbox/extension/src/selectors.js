(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DmPulseSelectors = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    SCHEMA: 'xchat-v2',
    ROW: 'a[role="option"][id^="dm-conversation-option-"]',
    ROW_ID_RE: /^dm-conversation-option-\d+:\d+$/,
    ROW_CONTENT: '[data-inbox-row]',
    UNREAD_ICON: '[data-icon="icon-circle-fill"]',
    CONVERSATION_PATH_RE: /^\/i\/chat\/\d+(?:-\d+)?\/?$/
  };
}));
