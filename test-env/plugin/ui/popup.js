// =============================================================================
// 智能调度中心 v3 — 弹窗面板逻辑
// =============================================================================

const $ = (id) => document.getElementById(id);

let refreshTimer = null;

function nowShanghai() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
  const m = s.match(/(\d+):(\d+):(\d+)/);
  if (m) return { hour: parseInt(m[1]), minute: parseInt(m[2]), second: parseInt(m[3]), str: m[1] + ':' + m[2] };
  const d = new Date();
  return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), str: '' };
}

function setStatus(cls, text) {
  const row = $('statusRow');
  row.className = 'status-row ' + cls;
  $('statusText').textContent = text;
}

async function refresh() {
  const t = nowShanghai();
  $('timeStat').textContent = t.str;

  let scheduleStatus = null;
  let links = [];

  try {
    scheduleStatus = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get_schedule_status' }, (r) => resolve(r || {}));
    });
  } catch (e) { scheduleStatus = {}; }

  try {
    const r = await chrome.storage.local.get(['sg_links', 'sg_daily_log']);
    links = (r.sg_links && Array.isArray(r.sg_links)) ? r.sg_links : [];
    const log = r.sg_daily_log || {};
    $('followStat').textContent = (log.follow ? log.follow.total : 0) + ' / 200';
    $('chatStat').textContent = (log.chat ? log.chat.icebreaker : 0) + ' / ' + (log.chat ? log.chat.ad : 0) + ' / ' + (log.chat ? log.chat.kick : 0);
    $('nurtureStat').textContent = (log.nurture ? log.nurture.likes : 0) + ' / ' + (log.nurture ? log.nurture.comments : 0) + ' / ' + (log.nurture ? log.nurture.reposts : 0);

    const followPct = Math.min(100, ((log.follow ? log.follow.total : 0) / 200) * 100);
    $('followBar').style.width = followPct + '%';
  } catch (e) {}

  if (scheduleStatus.running) {
    setStatus('running', '运行中');
    $('btnStart').textContent = '运行中';
    $('btnStart').disabled = true;
    $('btnPause').textContent = '暂停';
    $('footerMsg').textContent = '调度运行中';
  } else {
    if (!scheduleStatus.linksOk && links.length === 0) {
      setStatus('links-fail', '链接未设置');
      $('footerMsg').textContent = '未设置推广链接';
    } else {
      setStatus('idle', '待机中');
      $('footerMsg').textContent = '就绪';
    }
    $('btnStart').textContent = '启动';
    $('btnStart').disabled = false;
    $('btnPause').textContent = '暂停';
  }

  const eng = scheduleStatus.currentEngine || 'idle';
  const badge = $('engineBadge');
  badge.className = 'engine-indicator ' + eng;
  badge.textContent = eng === 'follow' ? '关注' : eng === 'nurture' ? '养号' : eng === 'chat' ? '私信' : '空闲';

  $('linksStat').textContent = links.length > 0 ? '已就绪 (' + links.length + '条)' : '未设置';
  $('linksStat').className = links.length > 0 ? 'stat-value green' : 'stat-value yellow';
}

$('btnStart').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'scheduler_start' }, () => {
    setTimeout(refresh, 500);
  });
});

$('btnPause').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'scheduler_pause' }, () => {
    setStatus('idle', '已暂停');
    $('btnStart').disabled = false;
    $('footerMsg').textContent = '已手动暂停';
  });
});

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('btnRefresh').addEventListener('click', refresh);

refresh();
refreshTimer = setInterval(refresh, 5000);

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
