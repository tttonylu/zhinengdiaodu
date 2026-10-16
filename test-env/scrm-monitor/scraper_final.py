#!/usr/bin/env python3
"""
SCRM CEO Scraper v9.1 - 常驻浏览器 + 搜索栏定位 + 翻页兜底
Playwright 爬取 SCRM + PushPlus / OPS 上报
"""

import json
import os
import time
from datetime import datetime

import requests
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

CONFIG = os.environ.get("CONFIG_FILE", "E:/hanako/scrm-monitor/config.json")
SNAPSHOT = os.path.join(os.path.dirname(CONFIG), "last-snapshot.json")
PUSHPLUS_URL = "https://www.pushplus.plus/send"

TOTAL_JS = r"""() => {
    const m = document.body.textContent.match(/\u5171\s*(\d+)\s*\u6761/);
    return m ? parseInt(m[1]) : 0;
}"""

ROW_COUNT_JS = r"""() => {
    return document.querySelectorAll('.el-table__body-wrapper tbody tr').length;
}"""

CLICK_VERIFY_JS = r"""() => {
    for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '\u9a8c\u8bc1') { b.click(); return true; }
    }
    return false;
}"""

NEXT_PAGE_JS = """() => {
    for (const sel of ['ul.el-pager + button', 'button.el-pagination__next', '.el-pagination .btn-next']) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled && !btn.classList.contains('disabled')) { btn.click(); return sel; }
    }
    const num = document.querySelector('ul.el-pager li.number.active + li.number');
    if (num) { num.click(); return 'pager-num'; }
    return false;
}"""

# 定位页面顶部筛选/搜索框（Element UI）
# 分享页结构：下拉[用户名/昵称/注释/备注] + input[placeholder=请输入] + 按钮[搜索]
FIND_SEARCH_JS = r"""() => {
    document.querySelectorAll('[data-scrm-search]').forEach(n => n.removeAttribute('data-scrm-search'));
    const badCls = (inp) => {
        const c = (inp.className || '').toString();
        return c.indexOf('el-select__input') >= 0
            || c.indexOf('el-range-input') >= 0
            || inp.type === 'password'
            || inp.type === 'number'
            || inp.type === 'hidden';
    };
    const inputs = Array.from(document.querySelectorAll('input.el-input__inner, input[type="text"]'))
        .filter(inp => {
            if (badCls(inp)) return false;
            const r = inp.getBoundingClientRect();
            return r.width > 80 && r.height > 10 && r.top > 0 && r.top < window.innerHeight * 0.55;
        });
    // 1) 精确：请输入
    for (const inp of inputs) {
        const ph = inp.getAttribute('placeholder') || '';
        if (ph.indexOf('请输入') >= 0 || ph.indexOf('請輸入') >= 0) {
            inp.setAttribute('data-scrm-search', '1');
            return { ok: true, placeholder: ph, via: 'qingshuru' };
        }
    }
    // 2) 其它搜索语义
    const hints = ['搜索', '查询', '客服', '账号', '帳號', '关键字', '關鍵字'];
    for (const inp of inputs) {
        const ph = (inp.getAttribute('placeholder') || '') + ' ' + (inp.getAttribute('aria-label') || '');
        if (hints.some(h => ph.indexOf(h) >= 0)) {
            inp.setAttribute('data-scrm-search', '1');
            return { ok: true, placeholder: inp.getAttribute('placeholder') || '', via: 'placeholder' };
        }
    }
    // 3) 「搜索」按钮左侧最近的文本框
    const btns = Array.from(document.querySelectorAll('button, .el-button'));
    const searchBtn = btns.find(b => {
        const t = (b.textContent || '').trim();
        return t === '搜索' || t === '查询' || t === '搜尋' || t === '查詢';
    });
    if (searchBtn) {
        const br = searchBtn.getBoundingClientRect();
        let best = null, bestDx = 1e9;
        for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            if (Math.abs(r.top - br.top) > 40) continue;
            if (r.right > br.left + 4) continue;
            const dx = br.left - r.right;
            if (dx >= 0 && dx < bestDx) { bestDx = dx; best = inp; }
        }
        if (best) {
            best.setAttribute('data-scrm-search', '1');
            return { ok: true, placeholder: best.getAttribute('placeholder') || '', via: 'left-of-search-btn' };
        }
    }
    return { ok: false };
}"""

SELECT_SEARCH_FIELD_JS = r"""(wanted) => {
    // wanted: ['用户名','帳號',...] 优先选用户名（对应 @客服号）
    const texts = Array.isArray(wanted) ? wanted : [wanted];
    const selects = Array.from(document.querySelectorAll('.el-select'));
    let target = null;
    for (const sel of selects) {
        const r = sel.getBoundingClientRect();
        if (r.top < 0 || r.top > window.innerHeight * 0.55) continue;
        const t = (sel.textContent || '').replace(/\s+/g, '');
        if (t.indexOf('用户名') >= 0 || t.indexOf('昵称') >= 0 || t.indexOf('注释') >= 0 || t.indexOf('备注') >= 0
            || t.indexOf('暱稱') >= 0) {
            target = sel; break;
        }
    }
    if (!target && selects.length) target = selects[0];
    if (!target) return { ok: false, reason: 'no-select' };
    const cur = (target.textContent || '').replace(/\s+/g, ' ').trim();
    // 已是用户名则跳过
    if (texts.some(x => cur.indexOf(x) >= 0)) {
        return { ok: true, already: cur, clicked: false };
    }
    const clickable = target.querySelector('.el-input__inner, .el-select__wrapper, input, .el-input') || target;
    clickable.click();
    return { ok: true, already: cur, clicked: true, needPick: true };
}"""

PICK_DROPDOWN_JS = r"""(wanted) => {
    const texts = Array.isArray(wanted) ? wanted : [wanted];
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item, li.el-select-dropdown__item'));
    const visible = items.filter(li => {
        const st = window.getComputedStyle(li);
        return st.display !== 'none' && st.visibility !== 'hidden' && li.offsetParent !== null;
    });
    for (const want of texts) {
        for (const li of visible) {
            const t = (li.textContent || '').trim();
            if (t === want || t.indexOf(want) >= 0) {
                li.click();
                return { ok: true, picked: t };
            }
        }
    }
    // 关掉下拉
    document.body.click();
    return { ok: false, options: visible.map(li => (li.textContent||'').trim()).slice(0, 20) };
}"""

CLICK_SEARCH_BTN_JS = r"""() => {
    const texts = ['搜索', '查询', '搜尋', '查詢', 'Search'];
    const buttons = Array.from(document.querySelectorAll('button, .el-button, [role="button"]'));
    for (const b of buttons) {
        const t = (b.textContent || '').trim().replace(/\s+/g, '');
        if (texts.some(x => t === x)) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.top > 0 && r.top < window.innerHeight * 0.55) { b.click(); return t; }
        }
    }
    const icon = document.querySelector('[data-scrm-search="1"]')?.closest('.el-input')?.querySelector('.el-icon-search');
    if (icon) { icon.click(); return 'icon'; }
    return false;
}"""

EXTRACT_JS = r"""() => {
    const results = [];
    const rows = document.querySelectorAll('.el-table__body-wrapper tbody tr');
    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 13) continue;
        const getText = (i) => cells[i] ? cells[i].textContent.trim() : '';
        const agentId = getText(3);
        if (!agentId || !agentId.startsWith('@')) continue;

        let nickname = '';
        const nameText = getText(1);
        const uuidPattern = /\s*U[0-9a-f]{20,}/;
        if (uuidPattern.test(nameText)) {
            nickname = nameText.split(uuidPattern)[0].trim();
        } else {
            const lines = nameText.split('\n').map(s => s.trim()).filter(s => s);
            for (const line of lines) {
                if (/^[Uu][0-9a-f]{20,}/.test(line)) continue;
                if (line.startsWith('@') || /^\d+$/.test(line)) continue;
                if (line.length > 0 && line.length < 30) { nickname = line; break; }
            }
        }

        let online = false, statusText = '';
        const tagMap = {'\u5728\u7ebf':true,'\u79bb\u7ebf':false,'\u5f02\u5e38\u79bb\u7ebf':false,'\u5e73\u53f0\u5173\u95ed':false,'\u5ba2\u6237\u7aef\u9000\u51fa':false,'\u5f3a\u5236\u4e0b\u7ebf':false,'\u7528\u6237\u4e3b\u52a8\u9000\u51fa':false,'\u7f51\u7edc\u5f02\u5e38':false};
        for (const tag of cells[2].querySelectorAll('.el-tag')) {
            const t = tag.textContent.trim();
            if (t in tagMap) { online = tagMap[t]; statusText = t; break; }
        }

        const remark = getText(10);
        let todayDone = 0, todayTarget = 0;
        const tm = getText(5).match(/(\d+)\/(\d+)/);
        if (tm) { todayDone = parseInt(tm[1]); todayTarget = parseInt(tm[2]); }
        const lineUrl = getText(13).includes('line.me') ? getText(13) : '';
        const dateText = getText(12);
        const dates = dateText.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g) || [];
        const firstLogin = dates[0] || '';
        const lastActive = dates[1] || dates[0] || '';
        const version = getText(11);
        const ipText = getText(8);
        const ipM = ipText.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        const locM = ipText.match(/(Japan\|JP\|[^\s]+)/);

        results.push({
            agentId, nickname, online, statusText, remark,
            todayDone, todayTarget, lineUrl, lastActive, firstLogin,
            version, proxyIP: ipM ? ipM[1] : '', location: locM ? locM[1] : ''
        });
    }

    const pt = document.body.textContent;
    const s = {};
    const sm = (r,k) => { const m = pt.match(r); if(m) s[k]=parseInt(m[1]); };
    sm(/在线APP数量[^0-9]*(\d+)/, 'onlineAppCount');
    sm(/总APP数量[^0-9]*(\d+)/, 'totalAppCount');
    sm(/今日线索[^0-9]*(\d+)/, 'todayLeads');
    sm(/今日有效线索[^0-9]*(\d+)/, 'todayValidLeads');
    sm(/今日重复线索[^0-9]*(\d+)/, 'todayRepeatLeads');
    sm(/总线索[^0-9]*(\d+)/, 'totalLeads');
    sm(/总有效线索[^0-9]*(\d+)/, 'totalValidLeads');
    sm(/总重复线索[^0-9]*(\d+)/, 'totalRepeatLeads');

    return {agents: results, summary: s};
}"""


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_config():
    local = load_json(CONFIG) or {}
    api_url = local.get("configApiUrl") or os.environ.get("CONFIG_API_URL")
    if not api_url:
        return local
    try:
        resp = requests.get(api_url, timeout=10)
        if resp.status_code == 200:
            print(f"  Config from NAS API: {api_url}")
            merged = dict(local)
            remote = resp.json() or {}
            if isinstance(remote, dict):
                merged.update(remote)
            return merged
    except Exception as e:
        print(f"  NAS API failed: {e}, using local config")
    return local


def sanitize_share_url(raw):
    """从粘贴文本中抽出真正的 http(s) URL（去掉「分享链接：」等前缀）。"""
    import re

    s = str(raw or "").strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        return s
    m = re.search(r"https?://[^\s\"'<>]+", s)
    if not m:
        return s
    url = m.group(0).rstrip("，。；;）)』」\"'")
    if url != s:
        print(f"  shareUrl sanitized: {s[:40]}... -> {url[:60]}")
    return url


def normalize_targets(targets):
    """raw_by_lower: lower -> canonical @id"""
    raw_by_lower = {}
    for t in targets or []:
        if not t:
            continue
        s = str(t).strip()
        raw = s if s.startswith("@") else "@" + s.lstrip("@")
        raw_by_lower[raw.lower()] = raw
    return raw_by_lower


def targets_key(targets):
    lows = sorted(normalize_targets(targets).keys())
    return "|".join(lows)


def page_fingerprint(agents):
    if not agents:
        return ""
    return "|".join((a.get("agentId") or "") for a in agents[:3])


def dedupe_agents(agents):
    dedup = {}
    for a in agents or []:
        aid = a.get("agentId")
        if aid:
            dedup[aid] = a
    return list(dedup.values())


def find_targets_in_agents(all_agents, raw_by_lower):
    found = {}
    for low, raw in raw_by_lower.items():
        hit = None
        for a in all_agents:
            aid = str(a.get("agentId") or "")
            if aid.lower() == low:
                hit = a
                break
        if hit:
            found[hit.get("agentId") or raw] = hit
    return found


def locate_lookup(located, agent_id):
    if not located or not agent_id:
        return None
    low = str(agent_id).strip().lower()
    for k, v in located.items():
        if str(k).strip().lower() == low:
            return v
    return None


def assemble_result(raw_by_lower, found_live, located, summary, all_count, mode):
    """
    组装上报结果：
    - 抽到 → 用新数据
    - 未抽到但 located 有历史 → 继承 lastGood，不进 notFound
    - 从未 locate → notFound
    """
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
    agents = {}
    notfound = []
    inherited = []
    new_located = dict(located or {})

    for low, raw in raw_by_lower.items():
        live = None
        for aid, data in (found_live or {}).items():
            if str(aid).strip().lower() == low:
                live = data
                break
        if live:
            key = live.get("agentId") or raw
            agents[key] = dict(live)
            agents[key].pop("inherited", None)
            prev = locate_lookup(new_located, key) or {}
            new_located[key] = {
                "firstSeenAt": prev.get("firstSeenAt") or now,
                "lastSeenAt": now,
                "lastGood": {k: v for k, v in live.items() if k != "inherited"},
            }
            continue

        hist = locate_lookup(new_located, raw)
        if hist and hist.get("lastGood"):
            good = dict(hist["lastGood"])
            key = good.get("agentId") or raw
            good["inherited"] = True
            agents[key] = good
            inherited.append(key)
        else:
            notfound.append(raw)

    return {
        "timestamp": now,
        "agents": agents,
        "notFound": notfound,
        "summary": summary or {},
        "allCount": all_count,
        "mode": mode,
        "inherited": inherited,
        "located": new_located,
    }, new_located


def compute_changes(prev_agents, agents):
    changes = {}
    for aid, d in (agents or {}).items():
        if d.get("inherited"):
            continue
        old = (prev_agents or {}).get(aid, {})
        c = {}
        for k in ("online", "statusText", "todayDone"):
            if old.get(k) != d.get(k):
                c[k] = {"from": old.get(k), "to": d.get(k)}
        if c:
            changes[aid] = c
    return changes


def send_pushplus(token, title, content, template="html"):
    try:
        resp = requests.post(
            PUSHPLUS_URL,
            json={"token": token, "title": title, "content": content, "template": template},
            timeout=10,
        )
        result = resp.json()
        if result.get("code") == 200:
            print("  PushPlus: sent OK")
            return True
        print(f"  PushPlus: {result.get('msg', 'unknown error')}")
        return False
    except Exception as e:
        print(f"  PushPlus error: {e}")
        return False


def report_status_to_ops(result, cfg=None):
    cfg = cfg or {}
    url = (
        cfg.get("opsStatusUrl")
        or os.environ.get("OPS_STATUS_URL")
        or "http://192.168.0.100:15680/api/scrm/status"
    )
    token = cfg.get("opsStatusToken") or os.environ.get("OPS_STATUS_TOKEN") or ""
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["X-Scrm-Token"] = token
    # OPS 不需要完整 located 缓存
    payload = {k: v for k, v in (result or {}).items() if k != "located"}
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
        print(f"  OPS status: HTTP {resp.status_code} {resp.text[:200]}")
        return resp.status_code < 300
    except Exception as e:
        print(f"  OPS status error: {e}")
        return False


def build_report_html(result, cfg):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    agents = result.get("agents", {})
    summary = result.get("summary", {})
    changes = result.get("changes", {})
    notfound = result.get("notFound", [])

    rows_html = ""
    for aid, data in agents.items():
        online_icon = "✅" if data.get("online") else "❌"
        online_text = data.get("statusText", "未知")
        nickname = data.get("nickname", "")
        remark = data.get("remark", "")
        today_done = data.get("todayDone", 0)
        today_target = data.get("todayTarget", 0)
        change_mark = ""
        if aid in changes:
            c = changes[aid]
            marks = []
            if "online" in c:
                marks.append(f"状态{c['online']['from']}→{c['online']['to']}")
            if "todayDone" in c:
                marks.append(f"今日{c['todayDone']['from']}→{c['todayDone']['to']}")
            change_mark = f" <span style='color:#e6a23c'>({' | '.join(marks)})</span>"
        inh = " <span style='color:#909399'>(继承)</span>" if data.get("inherited") else ""
        rows_html += f"""
        <tr>
            <td><b>{aid}{change_mark}{inh}</b></td>
            <td>{nickname}</td>
            <td>{online_icon} {online_text}</td>
            <td>{remark}</td>
            <td>{today_done}/{today_target}</td>
        </tr>"""

    notfound_html = ""
    if notfound:
        notfound_html = f"<p style='color:#f56c6c'>⚠️ 未找到: {', '.join(notfound)}</p>"

    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #409eff; border-bottom: 2px solid #409eff; padding-bottom: 10px;">
            📊 SCRM 工单监控报告
        </h2>
        <p style="color: #909399; font-size: 12px;">⏰ {now} | mode={result.get('mode', '-')}</p>
        <div style="background: #f5f7fa; padding: 12px; border-radius: 6px; margin: 10px 0;">
            <b>📋 总览</b><br>
            在线APP: <b>{summary.get('onlineAppCount', 0)}</b> / 总APP: <b>{summary.get('totalAppCount', 0)}</b><br>
            今日线索: <b>{summary.get('todayLeads', 0)}</b> | 总线索: <b>{summary.get('totalLeads', 0)}</b>
        </div>
        {notfound_html}
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
                <tr style="background: #409eff; color: white;">
                    <th style="padding: 8px; text-align: left;">客服号</th>
                    <th style="padding: 8px; text-align: left;">昵称</th>
                    <th style="padding: 8px; text-align: left;">状态</th>
                    <th style="padding: 8px; text-align: left;">备注</th>
                    <th style="padding: 8px; text-align: left;">今日</th>
                </tr>
            </thead>
            <tbody>{rows_html}</tbody>
        </table>
        <p style="color: #c0c4cc; font-size: 11px; margin-top: 20px;">
            共抓取 {result.get('allCount', 0)} 个APP | 自动监控 by Hana
        </p>
    </div>
    """
    return html


def build_report_txt(result):
    agents = result.get("agents", {})
    summary = result.get("summary", {})
    notfound = result.get("notFound", [])
    lines = [
        "📊 SCRM 工单监控",
        "",
        f"在线: {summary.get('onlineAppCount', 0)}/{summary.get('totalAppCount', 0)}",
        f"今日线索: {summary.get('todayLeads', 0)} | 总线索: {summary.get('totalLeads', 0)}",
        f"mode: {result.get('mode', '-')}",
        "",
    ]
    for aid, data in agents.items():
        icon = "✅" if data.get("online") else "❌"
        inh = " (继承)" if data.get("inherited") else ""
        lines.append(f"{icon} {aid} {data.get('nickname', '')}{inh}")
        lines.append(
            f"  备注: {data.get('remark', '')} | 今日: {data.get('todayDone', 0)}/{data.get('todayTarget', 0)}"
        )
        lines.append("")
    if notfound:
        lines.append(f"⚠️ 未找到: {', '.join(notfound)}")
    lines.append(f"共 {result.get('allCount', 0)} 个APP")
    return "\n".join(lines)


class BrowserSession:
    """进程内常驻 Playwright Chrome。"""

    def __init__(self):
        self._pw_cm = None
        self._playwright = None
        self.ctx = None
        self.browser = None
        self.page = None
        self.is_persistent = False
        self.fail_streak = 0
        self._targets_key = None
        self._located_once = False
        self._cookies_mtime_applied = 0.0
        self._status_cycles = 0
        self._auth_needed = False
        self.stealth = Stealth()

    @property
    def alive(self):
        if not self.page:
            return False
        try:
            self.page.evaluate("() => 1")
            return True
        except Exception:
            return False

    def _user_data_dir(self):
        base = os.path.dirname(CONFIG)
        if not os.path.isabs(base) or not base:
            base = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(base, ".chrome_data")

    def _launch_kwargs(self):
        chrome_path = "/usr/bin/google-chrome" if os.name != "nt" else None
        kwargs = {
            "headless": True,
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
            "user_agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "viewport": {"width": 1920, "height": 1080},
        }
        if chrome_path:
            kwargs["executable_path"] = chrome_path
        return kwargs, chrome_path

    def start(self):
        if self._playwright is None:
            self._pw_cm = sync_playwright()
            self._playwright = self._pw_cm.start()
        self._close_browser_only()
        kwargs, chrome_path = self._launch_kwargs()
        try:
            self.ctx = self._playwright.chromium.launch_persistent_context(
                user_data_dir=self._user_data_dir(), **kwargs
            )
            self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
            self.is_persistent = True
            self.browser = None
            print(f"  Chrome persistent ({chrome_path or 'bundled'})")
        except Exception as e:
            print(f"  Chrome persistent failed: {str(e)[:60]}")
            try:
                launch_kw = {
                    "headless": True,
                    "args": kwargs["args"],
                }
                if chrome_path:
                    launch_kw["executable_path"] = chrome_path
                self.browser = self._playwright.chromium.launch(**launch_kw)
                self.ctx = self.browser.new_context(
                    user_agent=kwargs["user_agent"],
                    viewport=kwargs["viewport"],
                )
                self.page = self.ctx.new_page()
                self.is_persistent = False
                print(f"  Chrome headless ({chrome_path or 'bundled'})")
            except Exception:
                self.browser = self._playwright.firefox.launch(headless=True)
                self.ctx = None
                self.page = self.browser.new_page()
                self.is_persistent = False
                print("  Firefox headless (fallback)")
        self.stealth.apply_stealth_sync(self.page)
        self.apply_imported_cookies(force=True)

    def apply_imported_cookies(self, force=False):
        """从 /data/scrm_cookies.json 热加载本机同步的登录 cookie。"""
        try:
            from cookie_store import (
                load_playwright_cookies,
                cookie_file_mtime,
                consume_reload_flag,
            )
        except Exception as e:
            print(f"  cookie_store import err: {e}")
            return False
        flag = consume_reload_flag()
        mtime = cookie_file_mtime()
        if not force and not flag and mtime <= (self._cookies_mtime_applied or 0):
            return False
        cookies = load_playwright_cookies()
        if not cookies:
            if force or flag:
                print("  No imported cookies file")
            return False
        try:
            from cookie_store import has_cf_clearance
            if not has_cf_clearance(cookies):
                print("  Imported cookies lack cf_clearance — treat as authNeeded")
                self._auth_needed = True
                return False
        except Exception:
            pass
        if not self.ctx:
            print("  No browser context for cookies")
            return False
        try:
            self.ctx.add_cookies(cookies)
            self._cookies_mtime_applied = mtime or time.time()
            self._auth_needed = False
            print(f"  Cookies applied: {len(cookies)} (mtime={int(self._cookies_mtime_applied)})")
            return True
        except Exception as e:
            print(f"  add_cookies failed: {str(e)[:80]}")
            return False

    def needs_admin_login(self):
        """检测是否掉到 SCRM 后台登录页（非分享页密码框）。"""
        if not self.alive:
            return False
        try:
            url = (self.page.url or "").lower()
        except Exception:
            url = ""
        if any(x in url for x in ("/login", "signin", "passport", "sso")):
            if "share" not in url:
                return True
        try:
            info = self.page.evaluate(
                """() => {
                const pw = !!document.querySelector('input[type="password"]');
                const user = !!(
                  document.querySelector('input[name="username"]')
                  || document.querySelector('input[name="account"]')
                  || document.querySelector('input[type="text"][placeholder*="账"]')
                  || document.querySelector('input[type="text"][placeholder*="手机"]')
                  || document.querySelector('input[type="tel"]')
                );
                let rows = 0;
                try {
                  rows = document.querySelectorAll('table tbody tr').length;
                } catch (e) {}
                const title = (document.title || '').toLowerCase();
                return { pw, user, rows, title };
            }"""
            ) or {}
        except Exception:
            return False
        if info.get("pw") and info.get("user") and int(info.get("rows") or 0) == 0:
            if not self.page_readable():
                return True
        title = str(info.get("title") or "")
        if info.get("pw") and ("login" in title or "登录" in title) and not self.page_readable():
            return True
        return False

    def _close_browser_only(self):
        try:
            if self.is_persistent and self.ctx:
                self.ctx.close()
            elif self.browser:
                self.browser.close()
            elif self.ctx:
                self.ctx.close()
        except Exception:
            pass
        self.ctx = None
        self.browser = None
        self.page = None
        self.is_persistent = False

    def close(self):
        self._close_browser_only()
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception:
                pass
        self._playwright = None
        self._pw_cm = None

    def rebuild(self):
        print("  Rebuilding browser session...")
        self._close_browser_only()
        self.start()

    def ensure_ready(self):
        if not self.alive:
            self.start()

    def page_readable(self):
        if not self.alive:
            return False
        try:
            total = self.page.evaluate(TOTAL_JS) or 0
            if total > 0:
                return True
            rows = self.page.evaluate(ROW_COUNT_JS) or 0
            return rows > 0
        except Exception:
            return False

    def wait_readable(self, seconds=15):
        total = 0
        for wait_i in range(seconds):
            time.sleep(1)
            try:
                total = self.page.evaluate(TOTAL_JS) or 0
            except Exception:
                total = 0
            if total > 0:
                print(f"  Data loaded after {wait_i + 1}s, total: {total}")
                return total
        return total

    def _submit_password(self, pw):
        self.page.evaluate(
            """(pwd) => {
            const inp = document.querySelector('input[type="password"]');
            if (inp) { inp.value = pwd; inp.dispatchEvent(new Event('input', {bubbles:true})); }
        }""",
            pw,
        )
        self.page.evaluate(CLICK_VERIFY_JS)

    def cold_open(self, url, pw):
        print("[1] Cold open...")
        page_loaded = False
        for attempt in range(3):
            for wu in ("load", "domcontentloaded", "networkidle"):
                try:
                    self.page.goto(url, wait_until=wu, timeout=45000)
                    page_loaded = True
                    break
                except Exception as e:
                    print(f"  Attempt {attempt + 1}/{wu} failed: {str(e)[:60]}")
                    if self.page_readable():
                        print("  Page readable despite goto timeout")
                        page_loaded = True
                        break
            if page_loaded:
                break
            if attempt < 2:
                wait = 15 * (attempt + 1)
                print(f"  Waiting {wait}s before retry...")
                time.sleep(wait)

        if not page_loaded and not self.page_readable():
            print("  Failed to load SCRM page after 3 attempts")
            return False

        time.sleep(3)
        self._submit_password(pw)
        print("[3] Waiting...")
        total = self.wait_readable(15)
        if total == 0:
            print("  No data after 15s, retrying verification...")
            self.page.evaluate(CLICK_VERIFY_JS)
            time.sleep(8)
            total = self.page.evaluate(TOTAL_JS) or 0
            print(f"  After retry: total={total}")
        if total == 0 and not self.page_readable():
            return False
        return True

    def light_refresh(self, url, pw, force_reload=False):
        """轻量刷新：可读时默认不整页 reload；每隔若干轮或 force 才 reload。"""
        self.apply_imported_cookies()
        if self.needs_admin_login():
            print("  Admin login required — skip refresh storm")
            self._auth_needed = True
            return False

        self._status_cycles = getattr(self, "_status_cycles", 0) + 1
        # 每 4 轮 status 才强制 reload 一次，减轻 45s timeout 风暴
        do_reload = force_reload or (self._status_cycles % 4 == 1)

        if not do_reload and self.page_readable():
            print("[1] Soft refresh (skip reload, page already readable)")
            try:
                self.clear_search()
            except Exception:
                pass
            return True

        print("[1] Light refresh (reload for fresh online/today)...")
        try:
            if self.page_readable():
                self.clear_search()
        except Exception:
            pass
        before_total = 0
        before_fp = ""
        try:
            before_total = self.page.evaluate(TOTAL_JS) or 0
            agents0, _ = self.extract_current()
            before_fp = page_fingerprint(agents0)
        except Exception:
            pass
        try:
            self.page.reload(wait_until="domcontentloaded", timeout=15000)
        except Exception as e:
            print(f"  reload timeout/err: {str(e)[:60]}")
            if self.needs_admin_login():
                self._auth_needed = True
                return False
            if not self.page_readable():
                # 不可读时最多 cold_open 一次，不再连环 rebuild
                return self.cold_open(url, pw)
            print("  Readable after reload timeout — continue settle wait")

        settled = False
        for i in range(12):
            time.sleep(1)
            if self.needs_admin_login():
                self._auth_needed = True
                return False
            if not self.page_readable():
                continue
            try:
                total = self.page.evaluate(TOTAL_JS) or 0
                agents, _ = self.extract_current()
                fp = page_fingerprint(agents)
            except Exception:
                total, fp = 0, ""
            if total > 0 and agents:
                if total != before_total or (fp and fp != before_fp) or i >= 2:
                    print(f"  Refresh settled after {i + 1}s, total={total} (was {before_total})")
                    settled = True
                    break
        if settled:
            return True

        try:
            has_pw = self.page.evaluate(
                "() => !!document.querySelector('input[type=\"password\"]')"
            )
        except Exception:
            has_pw = False
        if has_pw and self.needs_admin_login():
            self._auth_needed = True
            print("  Admin login page — need cookie sync")
            return False
        if has_pw:
            print("  Share password page detected, cold verify...")
            self._submit_password(pw)
            total = self.wait_readable(15)
            return total > 0 or self.page_readable()
        if self.page_readable():
            total = 0
            try:
                total = self.page.evaluate(TOTAL_JS) or 0
            except Exception:
                pass
            print(f"  Refresh fallback readable total={total}")
            return True
        print("  Not readable after reload, falling back to cold_open")
        return self.cold_open(url, pw)

    def extract_current(self):
        data = self.page.evaluate(EXTRACT_JS)
        return data.get("agents") or [], data.get("summary") or {}

    def paginate_collect(self, stop_when_found=None):
        """全表或直到 stop_when_found(all_agents)->True。返回 (all_agents, summary, total)."""
        total = 0
        try:
            total = self.page.evaluate(TOTAL_JS) or 0
        except Exception:
            pass
        print(f"  Total: {total}")
        print("[4] Extract page 1...")
        agents, summary = self.extract_current()
        all_agents = list(agents)
        print(f"  Found {len(all_agents)} agents")
        if stop_when_found and stop_when_found(all_agents):
            return dedupe_agents(all_agents), summary, total

        pages = max(1, (total + 9) // 10) if total else 30
        for pn in range(2, min(pages + 1, 31)):
            print(f"  Page {pn}...")
            try:
                cur = self.page.evaluate(EXTRACT_JS).get("agents") or []
                prev_fp = page_fingerprint(cur) or page_fingerprint(all_agents[-10:])
            except Exception:
                prev_fp = page_fingerprint(all_agents[-10:])
            try:
                ok = self.page.evaluate(NEXT_PAGE_JS)
            except Exception:
                ok = False
            if not ok:
                print("    No more pages")
                break
            new = []
            for _ in range(12):
                time.sleep(1)
                try:
                    d = self.page.evaluate(EXTRACT_JS)
                    new = d.get("agents") or []
                    if d.get("summary"):
                        summary = d["summary"]
                except Exception:
                    new = []
                fp = page_fingerprint(new)
                if new and fp and fp != prev_fp:
                    break
            if not new:
                print("    Empty after flip, stop")
                break
            if page_fingerprint(new) == prev_fp:
                print("    Page did not change (slow network), stop to avoid dup")
                break
            print(f"    Found {len(new)} agents")
            all_agents.extend(new)
            if stop_when_found and stop_when_found(all_agents):
                print("    All targets found, stop paging")
                break
        return dedupe_agents(all_agents), summary, total

    def ensure_search_field_username(self):
        """筛选类型切到「用户名」（对应 @客服号）。"""
        wanted = ["用户名", "用戶名", "账号", "帳號"]
        try:
            st = self.page.evaluate(SELECT_SEARCH_FIELD_JS, wanted) or {}
        except Exception as e:
            print(f"  select field err: {e}")
            return False
        if not st.get("ok"):
            print(f"  select field fail: {st}")
            return False
        if st.get("already") and not st.get("needPick"):
            print(f"  search field already={st.get('already')}")
            return True
        if st.get("needPick") or st.get("clicked"):
            time.sleep(0.6)
            try:
                picked = self.page.evaluate(PICK_DROPDOWN_JS, wanted) or {}
            except Exception as e:
                print(f"  pick dropdown err: {e}")
                return False
            print(f"  search field pick={picked}")
            time.sleep(0.4)
            return bool(picked.get("ok"))
        return True

    def _ensure_search_marked(self):
        try:
            info = self.page.evaluate(FIND_SEARCH_JS) or {}
        except Exception as e:
            print(f"  FIND_SEARCH failed: {e}")
            return None
        if not info.get("ok"):
            print("  No search input found")
            return None
        print(f"  Search input via={info.get('via')} placeholder={info.get('placeholder')!r}")
        return info

    def _fill_search(self, text):
        """写入搜索框并触发 Vue 输入事件。"""
        ok = self.page.evaluate(
            """(val) => {
            const inp = document.querySelector('[data-scrm-search="1"]');
            if (!inp) return false;
            inp.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, val);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }""",
            text,
        )
        return bool(ok)

    def _submit_search(self):
        clicked = False
        try:
            clicked = self.page.evaluate(CLICK_SEARCH_BTN_JS)
        except Exception:
            clicked = False
        if clicked:
            print(f"    search click: {clicked}")
            return
        try:
            self.page.keyboard.press("Enter")
            print("    search Enter")
        except Exception as e:
            print(f"    search submit failed: {e}")

    def _wait_search_result(self, agent_id, timeout_s=10):
        low = str(agent_id).strip().lower()
        bare = low.lstrip("@")
        deadline = time.time() + timeout_s
        last = []
        summary = {}
        while time.time() < deadline:
            time.sleep(0.8)
            try:
                agents, summary = self.extract_current()
            except Exception:
                agents, summary = [], {}
            last = agents
            for a in agents:
                aid = str(a.get("agentId") or "").lower()
                if aid == low or aid.lstrip("@") == bare:
                    return a, agents, summary
            # 过滤生效时行数会变少；继续等到命中或超时
            try:
                total = self.page.evaluate(TOTAL_JS) or 0
                if total and total < 10 and agents:
                    # 已过滤但仍未匹配到目标 id
                    pass
            except Exception:
                pass
        return None, last, summary

    def search_one(self, agent_id):
        """用搜索栏定位单个客服号。成功返回 agent dict，失败返回 None。"""
        raw = str(agent_id).strip()
        if not raw.startswith("@"):
            raw = "@" + raw.lstrip("@")
        print(f"  Search {raw}...")
        self.ensure_search_field_username()
        if not self._ensure_search_marked():
            return None, {}, {}
        # 先清空再搜
        self._fill_search("")
        time.sleep(0.3)
        self._fill_search(raw)
        time.sleep(0.2)
        self._submit_search()
        hit, agents, summary = self._wait_search_result(raw, timeout_s=8)
        if hit:
            print(f"    hit {hit.get('agentId')} status={hit.get('statusText')}")
            return hit, agents, summary
        # 再试裸 ID（不带 @）
        bare = raw.lstrip("@")
        if bare and ("@" + bare) == raw:
            print(f"    retry bare id {bare}")
            self._fill_search(bare)
            time.sleep(0.2)
            self._submit_search()
            hit, agents, summary = self._wait_search_result(raw, timeout_s=8)
            if hit:
                print(f"    hit {hit.get('agentId')} status={hit.get('statusText')}")
                return hit, agents, summary
        print(f"    miss {raw} (rows={len(agents)})")
        return None, agents, summary

    def clear_search(self):
        if not self._ensure_search_marked():
            return
        self._fill_search("")
        time.sleep(0.2)
        self._submit_search()
        time.sleep(1.2)
        print("  Search cleared")

    def search_collect(self, raw_by_lower):
        """按监控号逐个搜索。返回 (found_agents_list, summary, searched_ok)."""
        if not raw_by_lower:
            return [], {}, False
        if not self._ensure_search_marked():
            return [], {}, False
        found = {}
        summary = {}
        for low, raw in raw_by_lower.items():
            hit, _agents, sm = self.search_one(raw)
            if sm:
                summary = sm
            if hit:
                found[hit.get("agentId") or raw] = hit
        try:
            self.clear_search()
        except Exception as e:
            print(f"  clear_search err: {e}")
        return list(found.values()), summary, True

    def collect_targets(self, raw_by_lower, allow_paginate=True):
        """
        优先搜索栏定位监控号；失败再翻页。
        返回 (all_agents, summary, total, method)
        """
        total = 0
        try:
            total = self.page.evaluate(TOTAL_JS) or 0
        except Exception:
            pass

        searched_agents, summary, searched_ok = self.search_collect(raw_by_lower)
        if searched_ok:
            live = find_targets_in_agents(searched_agents, raw_by_lower)
            if len(live) >= len(raw_by_lower):
                print(f"  collect via search: {len(live)}/{len(raw_by_lower)}")
                return searched_agents, summary, total, "search"
            print(f"  search partial {len(live)}/{len(raw_by_lower)}, fallback paginate={allow_paginate}")
            if not allow_paginate:
                return searched_agents, summary, total, "search-partial"

        if not allow_paginate:
            return searched_agents, summary, total, "search-miss"

        def all_found(agents_list):
            live = find_targets_in_agents(agents_list, raw_by_lower)
            return len(live) >= len(raw_by_lower)

        # 翻页前尽量清掉搜索残留
        try:
            self.clear_search()
        except Exception:
            pass
        all_agents, summary2, total2 = self.paginate_collect(
            stop_when_found=all_found if raw_by_lower else None
        )
        if summary2:
            summary = summary2
        # 合并搜索已命中 + 翻页结果
        merged = dedupe_agents(list(searched_agents) + list(all_agents))
        return merged, summary, total2 or total, "paginate"


_SESSION = None


def get_session():
    global _SESSION
    if _SESSION is None:
        _SESSION = BrowserSession()
    return _SESSION


def close_session():
    global _SESSION
    if _SESSION is not None:
        _SESSION.close()
        _SESSION = None


def _load_snapshot_state():
    snap = load_json(SNAPSHOT, {}) or {}
    return snap


def _save_snapshot(result, located):
    out = dict(result)
    out["located"] = located
    # 去掉仅供内存的大字段重复
    save_json(SNAPSHOT, out)


def scrape(mode=None, force_close=None):
    """
    mode: None 自动 | 'locate' | 'status'
    页面不可读且恢复失败时返回 None（不更新 snapshot / 不报 OPS）
    """
    cfg = load_config()
    url = sanitize_share_url(cfg.get("shareUrl") or "")
    pw = cfg.get("password") or ""
    if not url or not url.startswith("http"):
        print(f"  Invalid shareUrl: {cfg.get('shareUrl')!r}")
        return None
    targets = cfg.get("agentIds", [])
    resident = cfg.get("residentBrowser", True)
    if isinstance(resident, str):
        resident = resident.lower() not in ("0", "false", "no")
    if force_close is None:
        force_close = not resident

    raw_by_lower = normalize_targets(targets)
    tkey = targets_key(targets)
    snap = _load_snapshot_state()
    located = snap.get("located") or {}
    prev_agents = snap.get("agents") or {}

    session = get_session()
    print(f"SCRM Scraper v9.2 | {datetime.now().isoformat()}")
    print(f"Targets: {targets} | resident={resident}")
    print("  pipeline: cookie→soft/reload → search(@id) → paginate fallback")

    # 自动选模式
    auto_mode = mode
    if auto_mode is None:
        need_locate = (
            not session._located_once
            or session._targets_key != tkey
            or any(locate_lookup(located, raw) is None for raw in raw_by_lower.values())
        )
        auto_mode = "locate" if need_locate else "status"
    print(f"  mode={auto_mode}")

    try:
        session.ensure_ready()
        session.apply_imported_cookies()
        ok = False
        if auto_mode == "status":
            ok = session.light_refresh(url, pw)
            if not ok and session._auth_needed and not session.page_readable():
                print("  Auth needed — skip rebuild, wait for cookie sync")
                if force_close:
                    close_session()
                return {"authNeeded": True, "ok": False, "mode": auto_mode}
            if not ok:
                session.fail_streak += 1
                print(f"  light_refresh failed, streak={session.fail_streak}")
                if session.fail_streak >= 2 and not session._auth_needed:
                    session.rebuild()
                    session.apply_imported_cookies(force=True)
                    ok = session.cold_open(url, pw)
                    auto_mode = "locate"
            else:
                session.fail_streak = 0
        else:
            ok = session.cold_open(url, pw)
            if not ok and session.needs_admin_login():
                session._auth_needed = True
            if not ok and session._auth_needed and not session.page_readable():
                print("  Auth needed after cold_open — skip rebuild")
                if force_close:
                    close_session()
                return {"authNeeded": True, "ok": False, "mode": auto_mode}
            if not ok:
                session.fail_streak += 1
                if session.fail_streak >= 2:
                    session.rebuild()
                    session.apply_imported_cookies(force=True)
                    ok = session.cold_open(url, pw)

        if not ok or not session.page_readable():
            print("  Page not readable — skip snapshot/OPS update")
            session.fail_streak += 1
            # 页面不可读时，检查是否是登录墙导致的
            if session.needs_admin_login() or session._auth_needed:
                print("  Admin login wall detected")
                if force_close:
                    close_session()
                return {"authNeeded": True, "ok": False, "mode": auto_mode}
            if force_close:
                close_session()
            return None

        # 页面可读就继续；_auth_needed 只是 cookie 警告，不影响实际抓取
        if session._auth_needed:
            print("  Note: cookies lack cf_clearance but page readable — proceeding anyway")
            session._auth_needed = False  # 清除标志，避免重复告警

        session.fail_streak = 0

        def all_found(agents_list):
            live = find_targets_in_agents(agents_list, raw_by_lower)
            return len(live) >= len(raw_by_lower)

        if auto_mode == "status":
            all_agents, summary, _total, method = session.collect_targets(
                raw_by_lower, allow_paginate=True
            )
            print(f"  collect method={method}")
            found_live = find_targets_in_agents(all_agents, raw_by_lower)
            # 有从未 locate 的号 → 升级全量 locate
            missing_never = [
                raw
                for low, raw in raw_by_lower.items()
                if not any(str(a).lower() == low for a in found_live)
                and locate_lookup(located, raw) is None
            ]
            if missing_never:
                print(f"  Escalate to locate for: {missing_never}")
                if not session.cold_open(url, pw) or not session.page_readable():
                    print("  Escalate cold_open failed — skip snapshot/OPS update")
                    if force_close:
                        close_session()
                    return None
                all_agents, summary, _total, method = session.collect_targets(
                    raw_by_lower, allow_paginate=True
                )
                print(f"  escalate collect method={method}")
                found_live = find_targets_in_agents(all_agents, raw_by_lower)
                auto_mode = "locate"
        else:
            all_agents, summary, _total, method = session.collect_targets(
                raw_by_lower, allow_paginate=True
            )
            print(f"  collect method={method}")
            found_live = find_targets_in_agents(all_agents, raw_by_lower)

        if not found_live and targets and all_agents:
            print(f"  Target(s) {targets} not found in {len(all_agents)} agents")
            print(f"  Sample ids: {[a.get('agentId') for a in all_agents[:12]]}")

        result, new_located = assemble_result(
            raw_by_lower, found_live, located, summary, len(all_agents), auto_mode
        )
        result["changes"] = compute_changes(prev_agents, result["agents"])
        _save_snapshot(result, new_located)

        session._targets_key = tkey
        if found_live or (result.get("agents") and not result.get("notFound")):
            session._located_once = True
        if any(not a.get("inherited") for a in result.get("agents", {}).values()):
            session._located_once = True

        print(f"\n[5] Snapshot saved mode={auto_mode} inherited={result.get('inherited')}")

        if force_close:
            close_session()
        return result
    except Exception:
        if force_close:
            close_session()
        raise


def main():
    cfg = load_config()
    pushplus_token = cfg.get("pushplusToken", "")
    now = datetime.now().strftime("%H:%M")

    try:
        result = scrape(mode="locate")
    except Exception as e:
        print(f"Scrape exception: {e}")
        if pushplus_token:
            send_pushplus(
                pushplus_token,
                f"⚠️ SCRM监控 {now} - 爬虫异常",
                f"<p>爬虫执行异常：{str(e)[:200]}</p>",
                template="html",
            )
        return

    if not result:
        print("Scrape failed / unreadble!")
        if pushplus_token:
            send_pushplus(
                pushplus_token,
                f"⚠️ SCRM监控 {now} - 爬虫失败",
                "<p>页面不可读或返回空结果。</p>",
                template="html",
            )
        return

    notfound = result.get("notFound", [])
    has_changes = bool(result.get("changes", {}))
    if notfound:
        title = f"⚠️ SCRM监控 {now} - 客服号未找到"
    elif has_changes:
        title = f"📊 SCRM监控 {now} - 有变化"
    else:
        title = f"📊 SCRM监控 {now}"

    html_content = build_report_html(result, cfg)
    send_pushplus(pushplus_token, title, html_content, template="html")
    report_status_to_ops(result, cfg)

    with open(os.path.join(os.path.dirname(CONFIG), "last_report.txt"), "w", encoding="utf-8") as f:
        f.write(build_report_txt(result))

    print(f"\n[Done] Report sent at {datetime.now().isoformat()}")


if __name__ == "__main__":
    main()
