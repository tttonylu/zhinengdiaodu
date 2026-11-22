'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifySurface, sampleVisibleInbox } = require('../browser/readonly-probe');
const { makeRow } = require('../fixtures/xchat-v2-samples');

describe('readonly browser surface guard', () => {
  it('只允许会话列表根进入采样', () => {
    assert.equal(classifySurface('/i/chat'), 'list');
    assert.equal(classifySurface('/i/chat/'), 'list');
    assert.equal(classifySurface('/i/chat/12345-67890'), 'conversation');
    assert.equal(classifySurface('/i/chat/12345'), 'conversation');
    assert.equal(classifySurface('/login'), 'other');
  });

  it('从唯一列表容器读取新版行并区分初始加载与加载更多', async () => {
    const row = makeRow(1, { unread: true });
    const listbox = {
      count: async () => 1,
      evaluate: async fn => fn({
        querySelectorAll: selector => selector === 'a[role="option"][id^="dm-conversation-option-"]' ? [{
          id: row.id,
          getAttribute: name => name === 'href' ? row.href : null,
          querySelector: selector => selector === '[data-inbox-row]' ? {} : null,
          querySelectorAll: selector => selector === '[data-icon]' ? [{ getAttribute: () => 'icon-circle-fill' }] : [],
          textContent: '你: 虚构内容'
        }] : []
      })
    };
    const tab = {
      url: async () => 'https://x.com/i/chat',
      playwright: { getByRole: role => role === 'listbox' ? listbox : { count: async () => 0 } }
    };
    const sample = await sampleVisibleInbox(tab);
    assert.equal(sample.rows.length, 1);
    assert.equal(sample.rows[0].selfPreview, true);
    assert.equal(sample.loading, false);
    assert.equal(sample.loadingMore, false);
    assert.equal(sample.emptyState, false);
  });

  it('无可信空态或唯一列表容器时不伪造空列表', async () => {
    const tab = {
      url: async () => 'https://x.com/i/chat',
      playwright: { getByRole: () => ({ count: async () => 0 }) }
    };
    const sample = await sampleVisibleInbox(tab);
    assert.equal(sample.listReady, false);
    assert.equal(sample.emptyState, false);
  });

  it('浏览器适配器不包含点击、发送、导航或存储写入', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'browser', 'readonly-probe.js'), 'utf8');
    assert.doesNotMatch(source, /\.click\(|\.fill\(|\.goto\(|localStorage|sessionStorage|fetch\(/);
  });

  it('列表有候选行但主选择器失效时显式退化', async () => {
    const listbox = {
      count: async () => 1,
      evaluate: async fn => fn({
        querySelectorAll: selector => selector === '[data-inbox-row]' ? [{}] : [],
        textContent: '非空列表'
      })
    };
    const tab = {
      url: async () => 'https://x.com/i/chat',
      playwright: { getByRole: () => listbox }
    };
    const sample = await sampleVisibleInbox(tab);
    assert.equal(sample.selectorMismatch, true);
    const { runReadonlyPulse } = require('../extension/src/pulse');
    assert.equal(runReadonlyPulse({ samples: [sample] }).verdict, 'selector_degraded');
  });
});
