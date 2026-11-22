(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DmPulseConversation = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function classifyConversationSurface(pathname) {
    const path = String(pathname || '').replace(/\/+$/, '') || '/';
    if (path === '/i/chat') return 'list';
    if (/^\/i\/chat\/\d+(?:-\d+)?$/.test(path)) return 'conversation';
    return 'other';
  }

  function directionOf(centerX, containerLeft, containerRight) {
    const width = Number(containerRight) - Number(containerLeft);
    if (!Number.isFinite(width) || width <= 0) return 'unknown';
    const deadZone = Math.max(15, width * 0.03);
    const middle = (Number(containerLeft) + Number(containerRight)) / 2;
    if (centerX > middle + deadZone) return 'own';
    if (centerX < middle - deadZone) return 'peer';
    return 'unknown';
  }

  function summarizeBubbles(bubbles, extras) {
    const input = Array.isArray(bubbles) ? bubbles : [];
    const summary = {
      bubbleCount: input.length,
      peerBubbles: 0,
      ownBubbles: 0,
      unknownBubbles: 0,
      textBubbles: 0,
      linkBubbles: 0,
      attachmentGroups: 0,
      lastDirection: 'none',
      maxTextLength: 0
    };
    input.forEach((bubble) => {
      if (bubble.direction === 'peer') summary.peerBubbles++;
      else if (bubble.direction === 'own') summary.ownBubbles++;
      else summary.unknownBubbles++;
      if (Number(bubble.textLength) > 0) summary.textBubbles++;
      if (Number(bubble.linkCount) > 0) summary.linkBubbles++;
      if (bubble.hasAttachment === true) summary.attachmentGroups++;
      summary.maxTextLength = Math.max(summary.maxTextLength, Number(bubble.textLength) || 0);
      if (input.length > 0) summary.lastDirection = bubble.direction || 'unknown';
    });
    if (extras && Number.isFinite(Number(extras.attachmentGroups))) {
      summary.attachmentGroups = Number(extras.attachmentGroups);
    }
    return summary;
  }

  function buildConversationReport(input) {
    const source = input || {};
    return {
      schema: 'xchat-v2-conversation',
      verdict: source.verdict || 'conversation_probed',
      surface: source.surface || 'conversation',
      opened: source.opened === true,
      markedRead: source.opened === true,
      durationMs: Number(source.durationMs) || 0,
      bubbleCount: Number(source.bubbleCount) || 0,
      peerBubbles: Number(source.peerBubbles) || 0,
      ownBubbles: Number(source.ownBubbles) || 0,
      unknownBubbles: Number(source.unknownBubbles) || 0,
      textBubbles: Number(source.textBubbles) || 0,
      linkBubbles: Number(source.linkBubbles) || 0,
      attachmentGroups: Number(source.attachmentGroups) || 0,
      lastDirection: source.lastDirection || 'none',
      maxTextLength: Number(source.maxTextLength) || 0,
      hasComposer: source.hasComposer === true,
      composerHasText: source.composerHasText === true,
      returned: false,
      errors: Array.isArray(source.errors)
        ? source.errors.map((error) => ({ atMs: Number(error.atMs) || 0, reason: String(error.reason || 'unknown') }))
        : []
    };
  }

  return { classifyConversationSurface, directionOf, summarizeBubbles, buildConversationReport };
}));
