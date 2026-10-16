/**
 * SCRM Cookie Sync v1.1
 * 改进的 cookie 获取逻辑：多域名扫描 + 当前页优先 + 可视化展示
 */

const DEFAULT_NAS = 'http://192.168.0.100:3211';
const DEFAULT_TOKEN = '';
const SCRM_DOMAINS = [
  'admin.scrmceo.com',
  '.scrmceo.com',
  'scrmceo.com',
  'www.scrmceo.com',
  'app.scrmceo.com',
  'api.scrmceo.com',
];

// ========== DOM 元素 ==========
const nasEl = document.getElementById('nas');
const tokenEl = document.getElementById('token');
const msgEl = document.getElementById('msg');
const syncBtn = document.getElementById('sync');
const scanBtn = document.getElementById('scan-local');
const grabBtn = document.getElementById('grab-current');
const requestPermBtn = document.getElementById('request-perm');
const openScrmBtn = document.getElementById('open-scrm');
const checkNasBtn = document.getElementById('check-nas');
const savePrefsBtn = document.getElementById('save-prefs');
const localCookieStatusEl = document.getElementById('local-cookie-status');
const localCookieListEl = document.getElementById('local-cookie-list');
const nasStatusTextEl = document.getElementById('nas-status-text');
const currentTabInfoEl = document.getElementById('current-tab-info');
const allDomainsListEl = document.getElementById('all-domains-list');
const domainsContentEl = document.getElementById('domains-content');
const permHintEl = document.getElementById('perm-hint');

let lastCookies = [];
let currentTabUrl = '';
let currentTabHostname = '';

// ========== Tab 切换 ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });
});

// ========== 工具函数 ==========
function setMsg(text, ok) {
  msgEl.textContent = text;
  msgEl.className = '';
  if (ok === true) msgEl.classList.add('ok');
  else if (ok === false) msgEl.classList.add('err');
}

function setNas(url) {
  nasEl.value = url;
  savePrefs();
}

// ========== 存储 ==========
function loadPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['nasUrl', 'token'], (st) => {
      resolve({
        nasUrl: st.nasUrl || DEFAULT_NAS,
        token: st.token || DEFAULT_TOKEN,
      });
    });
  });
}

function savePrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      nasUrl: (nasEl.value || '').trim() || DEFAULT_NAS,
      token: (tokenEl.value || '').trim()
    }, resolve);
  });
}

// ========== 当前标签页 ==========
async function getCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (e) {
    return null;
  }
}

async function updateCurrentTabInfo() {
  const tab = await getCurrentTab();
  if (!tab || !tab.url) {
    currentTabInfoEl.textContent = '无法获取当前页面信息';
    currentTabInfoEl.style.color = '#f56c6c';
    return;
  }
  
  currentTabUrl = tab.url;
  try {
    const u = new URL(tab.url);
    currentTabHostname = u.hostname;
  } catch (_) {
    currentTabHostname = '';
  }
  
  const isScrm = currentTabHostname.includes('scrmceo.com');
  currentTabInfoEl.innerHTML = `
    <div style="margin-bottom:2px;">
      <span style="color:#606266;">域名:</span> 
      <span style="color:${isScrm ? '#67c23a' : '#e6a23c'};font-weight:500;">${currentTabHostname || '未知'}</span>
      ${isScrm ? '✅' : '⚠️ 不是 scrmceo.com'}
    </div>
    <div style="font-size:10px;opacity:0.8;">${tab.url.substring(0, 80)}${tab.url.length > 80 ? '...' : ''}</div>
  `;
  
  // 动态添加当前域名到扫描列表
  if (currentTabHostname && !SCRM_DOMAINS.includes(currentTabHostname)) {
    SCRM_DOMAINS.unshift(currentTabHostname);
  }
}

// ========== Cookie 获取 ==========
/**
 * 获取所有相关的 cookie
 * 策略：多管齐下，确保不遗漏
 */
async function fetchCookies() {
  const allCookies = [];
  const seen = new Set();
  const allDomains = new Set();

  // 方法1：获取所有 cookie，然后过滤（最全面，用于诊断）
  try {
    const all = await chrome.cookies.getAll({});
    for (const c of all) {
      const d = String(c.domain || '').toLowerCase();
      if (d) allDomains.add(d);
      // 匹配 scrmceo.com 或当前页面域名
      const isMatch = d.includes('scrmceo.com') || 
                     (currentTabHostname && (d === currentTabHostname || d.endsWith('.' + currentTabHostname)));
      if (isMatch) {
        const key = `${c.name}||${c.domain}||${c.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          allCookies.push(c);
        }
      }
    }
    // 显示所有域名（调试用）
    if (allDomains.size > 0) {
      const sorted = [...allDomains].sort();
      domainsContentEl.textContent = sorted.join(', ');
      allDomainsListEl.style.display = 'block';
    }
  } catch (e) {
    console.warn('getAll failed:', e);
  }

  // 方法2：按域名逐个查询（更可靠）
  const domainsToTry = [...SCRM_DOMAINS];
  if (currentTabHostname && !domainsToTry.includes(currentTabHostname)) {
    domainsToTry.unshift(currentTabHostname);
    // 也加上带点前缀的
    const dotDomain = '.' + currentTabHostname;
    if (!domainsToTry.includes(dotDomain)) {
      domainsToTry.unshift(dotDomain);
    }
  }
  
  for (const domain of domainsToTry) {
    try {
      const cookies = await chrome.cookies.getAll({ domain: domain });
      for (const c of cookies) {
        const key = `${c.name}||${c.domain}||${c.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          allCookies.push(c);
        }
      }
    } catch (e) {
      console.warn('getAll by domain failed:', domain, e);
    }
  }

  // 方法3：当前标签页 URL 查询
  if (currentTabUrl) {
    try {
      const urlCookies = await chrome.cookies.getAll({ url: currentTabUrl });
      for (const c of urlCookies) {
        const key = `${c.name}||${c.domain}||${c.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          allCookies.push(c);
        }
      }
    } catch (e) {
      console.warn('getAll by url failed:', e);
    }
  }

  return allCookies;
}

/**
 * 检查 cookie 质量
 */
function analyzeCookies(cookies) {
  const names = cookies.map(c => c.name);
  const hasCf = names.includes('cf_clearance');
  const hasSession = names.some(n => 
    n.toLowerCase().includes('session') ||
    n.toLowerCase().includes('token') ||
    n.toLowerCase().includes('auth') ||
    n.toLowerCase().includes('login')
  );
  const domains = [...new Set(cookies.map(c => c.domain))];
  
  return {
    count: cookies.length,
    hasCfClearance: hasCf,
    hasSessionCookie: hasSession,
    domains,
    names,
  };
}

/**
 * 渲染本地 cookie 状态
 */
function renderLocalCookies(cookies) {
  const analysis = analyzeCookies(cookies);
  lastCookies = cookies;

  // 状态徽章
  let statusHtml = '';
  if (analysis.count === 0) {
    statusHtml = '<span class="status-badge badge-red">❌ 未找到 Cookie</span>';
  } else if (!analysis.hasCfClearance) {
    statusHtml = '<span class="status-badge badge-orange">⚠️ 缺少 cf_clearance</span>';
  } else {
    statusHtml = '<span class="status-badge badge-green">✅ Cookie 正常</span>';
  }
  statusHtml += ` <span style="font-size:11px;color:#909399;">共 ${analysis.count} 条</span>`;
  localCookieStatusEl.innerHTML = statusHtml;

  // 列表
  if (cookies.length === 0) {
    const hint = currentTabHostname && !currentTabHostname.includes('scrmceo.com')
      ? `<br>当前域名是 ${currentTabHostname}，可能不是 SCRM 站点`
      : '<br>请确认已打开 SCRM 页面并通过 Cloudflare 验证';
    localCookieListEl.innerHTML = `<div style="color:#909399;font-size:11px;padding:4px;">未找到相关 Cookie${hint}</div>`;
  } else {
    const sorted = [...cookies].sort((a, b) => {
      // cf_clearance 排最前
      if (a.name === 'cf_clearance') return -1;
      if (b.name === 'cf_clearance') return 1;
      return a.name.localeCompare(b.name);
    });
    localCookieListEl.innerHTML = sorted.slice(0, 10).map(c => `
      <div class="cookie-item">
        <span class="cookie-name">${c.name}</span>
        <span class="cookie-domain">${c.domain}</span>
      </div>
    `).join('');
    if (sorted.length > 10) {
      localCookieListEl.innerHTML += `<div style="text-align:center;color:#909399;font-size:10px;padding:2px;">... 还有 ${sorted.length - 10} 条</div>`;
    }
  }

  // 同步按钮状态
  syncBtn.disabled = cookies.length === 0;
  
  // 如果 cookie 为 0 且当前页是 scrmceo.com，提示可能缺权限
  if (cookies.length === 0 && currentTabHostname && currentTabHostname.includes('scrmceo.com')) {
    permHintEl.style.display = 'block';
  } else {
    permHintEl.style.display = 'none';
  }
}

// ========== 权限管理 ==========
/**
 * 检查是否有指定域名的权限
 */
async function checkPermission(url) {
  try {
    const hasPerm = await chrome.permissions.contains({
      origins: [url]
    });
    return hasPerm;
  } catch (e) {
    return false;
  }
}

/**
 * 请求当前页面域名的权限
 */
async function requestCurrentPermission() {
  if (!currentTabUrl) {
    await updateCurrentTabInfo();
  }
  
  if (!currentTabUrl) {
    setMsg('❌ 无法获取当前页面 URL', false);
    return;
  }
  
  // 构造权限请求模式
  const originPattern = currentTabHostname 
    ? `*://*.${currentTabHostname.replace(/^\./, '')}/*`
    : currentTabUrl + '*';
  
  try {
    const granted = await chrome.permissions.request({
      origins: [originPattern, '*://*.scrmceo.com/*']
    });
    
    if (granted) {
      setMsg('✅ 权限已授予！正在重新扫描...', true);
      permHintEl.style.display = 'none';
      setTimeout(() => scanLocalCookies(), 500);
    } else {
      setMsg('❌ 权限被拒绝。请右键扩展图标手动授权。', false);
    }
  } catch (e) {
    setMsg('❌ 请求权限失败: ' + (e.message || e), false);
  }
}

/**
 * 扫描本地 cookie
 */
async function scanLocalCookies() {
  localCookieStatusEl.innerHTML = '<span class="status-badge badge-gray">扫描中...</span>';
  pastedMode = false;
  try {
    await updateCurrentTabInfo();
    const cookies = await fetchCookies();
    renderLocalCookies(cookies);
  } catch (e) {
    localCookieStatusEl.innerHTML = '<span class="status-badge badge-red">扫描失败</span>';
    console.error(e);
  }
}

/**
 * 从当前页面抓取 cookie（强制按 URL 获取）
 */
async function grabCurrentPageCookies() {
  localCookieStatusEl.innerHTML = '<span class="status-badge badge-gray">抓取中...</span>';
  pastedMode = false;
  try {
    await updateCurrentTabInfo();
    if (!currentTabUrl) {
      localCookieStatusEl.innerHTML = '<span class="status-badge badge-red">无法获取当前页</span>';
      return;
    }
    
    // 强制按 URL 获取
    const urlCookies = await chrome.cookies.getAll({ url: currentTabUrl });
    const cookies = urlCookies || [];
    
    // 也按 hostname 查一遍
    if (currentTabHostname) {
      try {
        const domainCookies = await chrome.cookies.getAll({ domain: currentTabHostname });
        const seen = new Set(cookies.map(c => `${c.name}||${c.domain}||${c.path}`));
        for (const c of domainCookies) {
          const key = `${c.name}||${c.domain}||${c.path}`;
          if (!seen.has(key)) {
            seen.add(key);
            cookies.push(c);
          }
        }
      } catch (_) {}
    }
    
    renderLocalCookies(cookies);
    lastCookies = cookies;
    
    if (cookies.length === 0) {
      setMsg(`⚠️ 当前页面 ${currentTabHostname} 没有找到任何 Cookie。\n可能原因：\n1. 扩展没有该域名的权限\n2. 页面还在加载中\n3. 该站点使用了特殊的存储方式`, false);
    } else {
      setMsg(`从 ${currentTabHostname} 抓到 ${cookies.length} 条 Cookie`, true);
    }
  } catch (e) {
    localCookieStatusEl.innerHTML = '<span class="status-badge badge-red">抓取失败</span>';
    setMsg('❌ ' + (e.message || e), false);
    console.error(e);
  }
}

/**
 * 解析用户粘贴的 Cookie 字符串
 * 支持格式：
 * - Cookie: name1=val1; name2=val2; ...
 * - name1=val1; name2=val2; ...
 * - JSON 格式
 */
function parsePastedCookies() {
  const textarea = document.getElementById('paste-cookies');
  const raw = textarea.value.trim();
  
  if (!raw) {
    setMsg('请先粘贴 Cookie 内容', false);
    return;
  }
  
  let cookies = [];
  const domain = currentTabHostname || 'admin.scrmceo.com';
  const dotDomain = '.' + domain.replace(/^\./, '');
  
  // 尝试 JSON
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cookies = parsed;
      } else if (parsed.cookies && Array.isArray(parsed.cookies)) {
        cookies = parsed.cookies;
      }
    } catch (_) {}
  }
  
  // 解析 name=value 格式
  if (cookies.length === 0) {
    // 去掉 "Cookie:" 前缀
    let s = raw.replace(/^Cookie:\s*/i, '').trim();
    const parts = s.split(/[;；]/).map(p => p.trim()).filter(Boolean);
    
    cookies = parts.map(part => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      const name = part.substring(0, eq).trim();
      const value = part.substring(eq + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: name === 'cf_clearance' ? dotDomain : domain,
        path: '/'
      };
    }).filter(Boolean);
  }
  
  if (cookies.length === 0) {
    setMsg('❌ 无法解析 Cookie 格式', false);
    return;
  }
  
  lastCookies = cookies;
  renderLocalCookies(cookies);
  pastedMode = true;
  
  const hasCf = cookies.some(c => c.name === 'cf_clearance');
  setMsg(`✅ 解析成功！共 ${cookies.length} 条 Cookie${hasCf ? '（含 cf_clearance）' : ''}\n可以直接点「同步 Cookie 到 NAS」了`, true);
}

// ========== NAS 相关 ==========
async function checkNasStatus() {
  const base = (nasEl.value || DEFAULT_NAS).replace(/\/$/, '');
  nasStatusTextEl.textContent = '检查中...';
  checkNasBtn.disabled = true;
  
  try {
    const r = await fetch(base + '/api/cookies/status', { 
      method: 'GET',
      cache: 'no-cache'
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (_) {}
    
    if (!r.ok) {
      nasStatusTextEl.textContent = `❌ HTTP ${r.status}`;
      nasStatusTextEl.style.color = '#f56c6c';
      return;
    }
    
    if (j && j.ok && j.hasCookies) {
      nasStatusTextEl.textContent = `✅ ${j.count}条 · ${j.imported_at || '已导入'}`;
      nasStatusTextEl.style.color = '#67c23a';
    } else if (j && j.ok) {
      nasStatusTextEl.textContent = '⚠️ 暂无 Cookie';
      nasStatusTextEl.style.color = '#e6a23c';
    } else {
      nasStatusTextEl.textContent = '❌ 状态异常';
      nasStatusTextEl.style.color = '#f56c6c';
    }
  } catch (e) {
    nasStatusTextEl.textContent = '❌ 不可达';
    nasStatusTextEl.style.color = '#f56c6c';
  } finally {
    checkNasBtn.disabled = false;
  }
}

// ========== 同步 ==========
let pastedMode = false;

syncBtn.addEventListener('click', async () => {
  await savePrefs();
  const base = (nasEl.value || DEFAULT_NAS).replace(/\/$/, '');
  const token = (tokenEl.value || '').trim();
  
  syncBtn.disabled = true;
  setMsg('读取 Cookie 中...');
  
  try {
    // 如果用户粘贴过 cookie，优先用粘贴的那份
    let cookies;
    if (pastedMode && lastCookies.length > 0) {
      cookies = lastCookies;
      renderLocalCookies(cookies);
    } else {
      cookies = await fetchCookies();
      renderLocalCookies(cookies);
    }
    
    if (!cookies.length) {
      setMsg('❌ 未找到 scrmceo.com Cookie。\n请先打开并登录 https://admin.scrmceo.com', false);
      return;
    }
    
    const analysis = analyzeCookies(cookies);
    
    if (!analysis.hasCfClearance) {
      setMsg(`⚠️ 警告: 没有 cf_clearance，Cloudflare 可能未放行。\n已有 ${cookies.length} 条: ${analysis.names.join(', ')}\n\n正在上传...`, null);
    } else {
      setMsg(`找到 ${cookies.length} 条 Cookie（含 cf_clearance），上传中...`);
    }
    
    const payload = {
      token: token,
      source: 'chrome-extension-v1.1',
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        expirationDate: c.expirationDate,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite
      }))
    };
    
    const r = await fetch(base + '/api/cookies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (_) {}
    
    if (!r.ok || (j && j.ok === false)) {
      setMsg('❌ 同步失败 HTTP ' + r.status + '\n' + t.slice(0, 400), false);
      return;
    }
    
    setMsg(
      '✅ 同步成功！\n' +
      `导入 ${j.count || 0} 条 Cookie\n` +
      `时间: ${j.imported_at || '-'}\n` +
      `来源: ${j.source || '-'}\n` +
      `域名: ${(j.domains || []).join(', ')}\n\n` +
      '请等 NAS 下一轮爬取（约 10-15 分钟）生效。',
      true
    );
    
    // 更新 NAS 状态显示
    checkNasStatus();
    
  } catch (e) {
    setMsg('❌ 同步异常: ' + (e.message || e), false);
  } finally {
    syncBtn.disabled = false;
  }
});

// ========== 事件绑定 ==========
scanBtn.addEventListener('click', scanLocalCookies);
grabBtn.addEventListener('click', grabCurrentPageCookies);
requestPermBtn.addEventListener('click', requestCurrentPermission);
checkNasBtn.addEventListener('click', checkNasStatus);

document.getElementById('parse-paste').addEventListener('click', parsePastedCookies);

savePrefsBtn.addEventListener('click', async () => {
  await savePrefs();
  savePrefsBtn.textContent = '✅ 已保存';
  setTimeout(() => { savePrefsBtn.textContent = '💾 保存设置'; }, 1500);
});

openScrmBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://admin.scrmceo.com' });
});

// ========== 初始化 ==========
(async function init() {
  const prefs = await loadPrefs();
  nasEl.value = prefs.nasUrl;
  tokenEl.value = prefs.token;
  
  // 先获取当前标签页信息
  await updateCurrentTabInfo();
  
  // 如果当前页是 SCRM 相关，优先用 URL 方式抓（最准）
  if (currentTabUrl && currentTabHostname && currentTabHostname.includes('scrmceo.com')) {
    await grabCurrentPageCookies();
  } else {
    scanLocalCookies();
  }
})();
