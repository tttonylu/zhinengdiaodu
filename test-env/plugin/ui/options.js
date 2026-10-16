// =============================================================================
// 智能调度中心 v3 — 设置页逻辑
// =============================================================================

const DEFAULTS = {
  poolServer: 'http://192.168.0.100:15678',
  opsServer: 'http://192.168.0.100:15680',
  followCap: 200, followBatch: 15, followMin: 12, followMax: 19,
  restMin: 30, restMax: 50,
  nLikeMin: 5, nLikeMax: 15, nCommentMin: 0, nCommentMax: 3,
  nRepostMin: 0, nRepostMax: 2,
  cBatchMin: 1, cBatchMax: 3, cIceMin: 15, cIceMax: 25,
  cAdMin: 25, cAdMax: 45,
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  chrome.storage.local.get('sg_settings', (r) => {
    const s = r.sg_settings || {};
    $('poolServer').value = s.poolServer || DEFAULTS.poolServer;
    $('opsServer').value = s.opsServer || DEFAULTS.opsServer;
    $('followCap').value = s.followCap || DEFAULTS.followCap;
    $('followBatch').value = s.followBatch || DEFAULTS.followBatch;
    $('followMin').value = s.followMin || DEFAULTS.followMin;
    $('followMax').value = s.followMax || DEFAULTS.followMax;
    $('restMin').value = s.restMin || DEFAULTS.restMin;
    $('restMax').value = s.restMax || DEFAULTS.restMax;
    $('nLikeMin').value = s.nLikeMin || DEFAULTS.nLikeMin;
    $('nLikeMax').value = s.nLikeMax || DEFAULTS.nLikeMax;
    $('nCommentMin').value = s.nCommentMin || DEFAULTS.nCommentMin;
    $('nCommentMax').value = s.nCommentMax || DEFAULTS.nCommentMax;
    $('nRepostMin').value = s.nRepostMin || DEFAULTS.nRepostMin;
    $('nRepostMax').value = s.nRepostMax || DEFAULTS.nRepostMax;
    $('cBatchMin').value = s.cBatchMin || DEFAULTS.cBatchMin;
    $('cBatchMax').value = s.cBatchMax || DEFAULTS.cBatchMax;
    $('cIceMin').value = s.cIceMin || DEFAULTS.cIceMin;
    $('cIceMax').value = s.cIceMax || DEFAULTS.cIceMax;
    $('cAdMin').value = s.cAdMin || DEFAULTS.cAdMin;
    $('cAdMax').value = s.cAdMax || DEFAULTS.cAdMax;
  });
}

function getSettings() {
  return {
    poolServer: $('poolServer').value.trim(),
    opsServer: $('opsServer').value.trim(),
    followCap: parseInt($('followCap').value) || 200,
    followBatch: parseInt($('followBatch').value) || 15,
    followMin: parseInt($('followMin').value) || 12,
    followMax: parseInt($('followMax').value) || 19,
    restMin: parseInt($('restMin').value) || 30,
    restMax: parseInt($('restMax').value) || 50,
    nLikeMin: parseInt($('nLikeMin').value) || 5,
    nLikeMax: parseInt($('nLikeMax').value) || 15,
    nCommentMin: parseInt($('nCommentMin').value) || 0,
    nCommentMax: parseInt($('nCommentMax').value) || 3,
    nRepostMin: parseInt($('nRepostMin').value) || 0,
    nRepostMax: parseInt($('nRepostMax').value) || 2,
    cBatchMin: parseInt($('cBatchMin').value) || 1,
    cBatchMax: parseInt($('cBatchMax').value) || 3,
    cIceMin: parseInt($('cIceMin').value) || 15,
    cIceMax: parseInt($('cIceMax').value) || 25,
    cAdMin: parseInt($('cAdMin').value) || 25,
    cAdMax: parseInt($('cAdMax').value) || 45,
  };
}

function showToast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  setTimeout(() => { el.className = 'toast'; }, 2000);
}

$('btnSave').addEventListener('click', () => {
  chrome.storage.local.set({ sg_settings: getSettings() }, () => {
    showToast('设置已保存', 'success');
  });
});

$('btnReset').addEventListener('click', () => {
  chrome.storage.local.remove('sg_settings', () => {
    Object.keys(DEFAULTS).forEach(k => {
      const el = $(k);
      if (el) el.value = DEFAULTS[k];
    });
    showToast('已恢复默认', 'success');
  });
});

loadSettings();
