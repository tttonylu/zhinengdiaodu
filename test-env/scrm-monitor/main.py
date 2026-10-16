#!/usr/bin/env python3
"""
SCRM Scraper NAS一体化运行
Flask Web管理 + 定时爬虫 + 通知
"""

import os
import random
import sys
import threading
import time
from datetime import datetime

import requests
from web_server import app, load_config, CONFIG_FILE
from scraper_final import scrape as run_scraper, report_status_to_ops, close_session

PUSHPLUS_URL = "https://www.pushplus.plus/send"
_LAST_COOKIE_ALERT_AT = 0.0


def should_run(work_start, work_end):
    now = datetime.now()
    h = now.hour
    if work_start <= work_end:
        return work_start <= h < work_end
    return h >= work_start or h < work_end


def _maybe_alert_cookie_sync(cfg, token):
    """Cookie 失效告警，默认 2 小时节流一次。"""
    global _LAST_COOKIE_ALERT_AT
    if not token:
        return
    try:
        cooldown = float(cfg.get("cookieAlertCooldownSec", 7200))
    except (TypeError, ValueError):
        cooldown = 7200
    now = time.time()
    if now - _LAST_COOKIE_ALERT_AT < cooldown:
        print("  Cookie alert throttled")
        return
    ok = send_pushplus(
        token,
        "🔑 SCRM 需开机同步 Cookie",
        "<p>NAS 爬虫检测到 SCRM 登录失效。</p>"
        "<p>请开机打开 <b>admin.scrmceo.com</b> 登录后，用扩展「同步 Cookie 到 NAS」。</p>"
        "<p>同步后无需保持电脑开机。</p>",
    )
    if ok:
        _LAST_COOKIE_ALERT_AT = now


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


def build_report_html(result, agents_data):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    summary = result.get("summary", {})
    changes = result.get("changes", {})
    notfound = result.get("notFound", [])

    rows_html = ""
    for aid, data in agents_data.items():
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
        <h2 style="color: #409eff;">📊 SCRM 工单监控报告</h2>
        <p style="color: #909399; font-size: 12px;">⏰ {now} | mode={result.get('mode', '-')}</p>
        <div style="background: #f5f7fa; padding: 12px; border-radius: 6px; margin: 10px 0;">
            <b>📋 总览</b><br>
            在线APP: <b>{summary.get('onlineAppCount', 0)}</b> / 总APP: <b>{summary.get('totalAppCount', 0)}</b><br>
            今日线索: <b>{summary.get('todayLeads', 0)}</b> | 总线索: <b>{summary.get('totalLeads', 0)}</b>
        </div>
        {notfound_html}
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="background:#409eff;color:white;">
                <th style="padding:8px;">客服号</th><th style="padding:8px;">昵称</th>
                <th style="padding:8px;">状态</th><th style="padding:8px;">备注</th><th style="padding:8px;">今日</th>
            </tr></thead>
            <tbody>{rows_html}</tbody>
        </table>
        <p style="color:#c0c4cc;font-size:11px;margin-top:20px;">共抓取 {result.get('allCount', 0)} 个APP | NAS自动监控</p>
    </div>"""
    return html


def do_scrape(force_mode=None):
    """执行一次爬取并推送通知。页面不可读时不报 OPS。"""
    try:
        cfg = load_config()
        pushplus_token = cfg.get("pushplusToken", "")
        ws = int(str(cfg.get("workStart", "08")).split(":")[0])
        we = int(str(cfg.get("workEnd", "19")).split(":")[0])
        now_str = datetime.now().strftime("%H:%M")

        if not should_run(ws, we):
            print(f"[Scheduler] {now_str} - Outside work hours, skip (browser kept)")
            sys.stdout.flush()
            return

        print(f"[Scheduler] {now_str} - Running scraper mode={force_mode or 'auto'}")
        sys.stdout.flush()

        result = run_scraper(mode=force_mode)

        if result is None:
            print(f"[Scheduler] {now_str} - Unreadable, snapshot/OPS not updated")
            sys.stdout.flush()
            return

        if isinstance(result, dict) and result.get("authNeeded"):
            print(f"[Scheduler] {now_str} - Auth needed, ask PC to sync cookies")
            sys.stdout.flush()
            _maybe_alert_cookie_sync(cfg, pushplus_token)
            return

        agents = result.get("agents", {})
        notfound = result.get("notFound", [])
        has_changes = bool(result.get("changes", {}))

        # 仅异常/变化时推手机；无变化例行报告不推（OPS 上报仍走下方）
        if pushplus_token and (notfound or has_changes):
            if notfound:
                title = f"⚠️ SCRM监控 {now_str} - 客服号未找到"
            else:
                title = f"📊 SCRM监控 {now_str} - 有变化"
            html_content = build_report_html(result, agents)
            send_pushplus(pushplus_token, title, html_content)

        try:
            report_status_to_ops(result, cfg)
        except Exception as eOps:
            print(f"  OPS status error: {eOps}")

        try:
            report_path = os.path.join(os.path.dirname(CONFIG_FILE), "last_report.txt")
            s = result.get("summary", {})
            report_txt = (
                f"📊 SCRM 工单监控\n\n"
                f"mode: {result.get('mode')}\n"
                f"在线: {s.get('onlineAppCount', 0)}/{s.get('totalAppCount', 0)}\n"
                f"今日线索: {s.get('todayLeads', 0)} | 总线索: {s.get('totalLeads', 0)}\n"
                f"inherited: {result.get('inherited')}\n"
                f"共 {result.get('allCount', 0)} 个APP"
            )
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(report_txt)
        except Exception:
            pass

        print(f"[Scheduler] {now_str} - Done mode={result.get('mode')}")
        sys.stdout.flush()

    except BaseException as e:
        print(f"[Scheduler] Error: {e}")
        sys.stdout.flush()
        cfg = load_config()
        token = cfg.get("pushplusToken", "")
        if token:
            send_pushplus(token, "⚠️ SCRM监控 - 异常", f"<p>爬虫异常：{str(e)[:200]}</p>")


def _interval_seconds(cfg):
    try:
        mins = float(cfg.get("scrapeIntervalMin", 30))
    except (TypeError, ValueError):
        mins = 30
    try:
        jitter = int(cfg.get("scrapeJitterSec", 90))
    except (TypeError, ValueError):
        jitter = 90
    base = max(60, int(mins * 60))
    jitter = max(0, jitter)
    delta = random.randint(-jitter, jitter) if jitter else 0
    return max(60, base + delta)


def scheduler_loop():
    cfg = load_config()
    mins = cfg.get("scrapeIntervalMin", 30)
    jitter = cfg.get("scrapeJitterSec", 90)
    print(f"[Scheduler] Started, interval ~{mins}min ±{jitter}s (resident browser)")
    sys.stdout.flush()
    do_scrape(force_mode="locate")
    while True:
        cfg = load_config()
        wait = _interval_seconds(cfg)
        print(f"[Scheduler] Next run in {wait}s")
        sys.stdout.flush()
        time.sleep(wait)
        do_scrape(force_mode=None)


def main():
    cfg = load_config()
    mins = cfg.get("scrapeIntervalMin", 30)
    print("=" * 50)
    print("🌐 SCRM Scraper NAS Service")
    print(f"   配置文件: {CONFIG_FILE}")
    print(f"   Web界面: http://0.0.0.0:3211")
    print(f"   工作时间: config.json workStart - workEnd (默认至19点)")
    print(f"   调度间隔: ~{mins}分钟 (抖动 scrapeJitterSec)")
    print(f"   常驻浏览器: {cfg.get('residentBrowser', True)}")
    print("=" * 50)
    sys.stdout.flush()

    t = threading.Thread(target=scheduler_loop, daemon=True)
    t.start()

    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_PORT", "3211"))
    try:
        app.run(host=host, port=port, debug=False, use_reloader=False)
    finally:
        close_session()


if __name__ == "__main__":
    main()
