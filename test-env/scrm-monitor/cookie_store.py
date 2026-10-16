# -*- coding: utf-8 -*-
"""SCRM cookie persist + Playwright normalize."""
from __future__ import annotations

import json
import os
import time
from typing import Any

COOKIE_FILE_NAME = "scrm_cookies.json"
RELOAD_FLAG_NAME = "scrm_cookies.reload"
META_FILE_NAME = "scrm_cookies.meta.json"


def _data_dir() -> str:
    cfg = os.environ.get("CONFIG_FILE", "")
    if cfg:
        return os.path.dirname(os.path.abspath(cfg))
    return os.path.dirname(os.path.abspath(__file__))


def cookie_path() -> str:
    return os.path.join(_data_dir(), COOKIE_FILE_NAME)


def reload_flag_path() -> str:
    return os.path.join(_data_dir(), RELOAD_FLAG_NAME)


def meta_path() -> str:
    return os.path.join(_data_dir(), META_FILE_NAME)


def normalize_same_site(raw: Any) -> str | None:
    if raw is None or raw == "":
        return None
    s = str(raw).lower().replace("_", "-")
    if s in ("no_restriction", "none"):
        return "None"
    if s in ("lax",):
        return "Lax"
    if s in ("strict",):
        return "Strict"
    if s in ("unspecified",):
        return None
    # Chrome extension may send "no_restriction"
    if "no" in s and "restrict" in s:
        return "None"
    return None


def chrome_cookie_to_playwright(c: dict) -> dict | None:
    name = c.get("name")
    value = c.get("value")
    if not name or value is None:
        return None
    domain = str(c.get("domain") or "").strip()
    if not domain:
        return None
    # Playwright wants domain without leading dot preference handled OK either way
    path = c.get("path") or "/"
    out = {
        "name": str(name),
        "value": str(value),
        "domain": domain,
        "path": path,
        "httpOnly": bool(c.get("httpOnly", False)),
        "secure": bool(c.get("secure", False)),
    }
    # expires: chrome uses expirationDate as unix seconds float
    exp = c.get("expirationDate")
    if exp is None:
        exp = c.get("expires")
    if exp is not None:
        try:
            exp_f = float(exp)
            if exp_f > 0:
                out["expires"] = int(exp_f)
        except (TypeError, ValueError):
            pass
    ss = normalize_same_site(c.get("sameSite"))
    if ss:
        out["sameSite"] = ss
    return out


def save_cookies(cookies: list, source: str = "") -> dict:
    pw_list = []
    for raw in cookies or []:
        if not isinstance(raw, dict):
            continue
        item = chrome_cookie_to_playwright(raw)
        if item:
            pw_list.append(item)
    # also accept already-playwright shaped
    if not pw_list:
        for raw in cookies or []:
            if isinstance(raw, dict) and raw.get("name") and raw.get("domain"):
                item = chrome_cookie_to_playwright(raw)
                if item:
                    pw_list.append(item)

    path = cookie_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cookies": pw_list, "source": source, "saved_at": time.time()}, f, ensure_ascii=False, indent=2)

    meta = {
        "count": len(pw_list),
        "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "imported_at_epoch": time.time(),
        "source": source or "",
        "domains": sorted({c["domain"] for c in pw_list}),
    }
    with open(meta_path(), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # touch reload flag for running scraper
    with open(reload_flag_path(), "w", encoding="utf-8") as f:
        f.write(str(time.time()))

    return meta


def load_playwright_cookies() -> list:
    path = cookie_path()
    if not os.path.isfile(path):
        return []
    try:
        data = json.load(open(path, encoding="utf-8"))
        cookies = data.get("cookies") if isinstance(data, dict) else data
        if not isinstance(cookies, list):
            return []
        out = []
        for c in cookies:
            item = chrome_cookie_to_playwright(c) if isinstance(c, dict) else None
            if not item:
                continue
            # 丢弃升级冒烟假 cookie / 空值
            name = str(item.get("name") or "")
            val = str(item.get("value") or "")
            if name.startswith("_quiet") or name.startswith("_smoke"):
                continue
            if not val or val in ("1", "true", "test"):
                continue
            out.append(item)
        # 无 cf_clearance 时几乎必被墙；仍返回其余 cookie，但调用方可检测
        return out
    except Exception:
        return []


def has_cf_clearance(cookies: list | None = None) -> bool:
    items = cookies if cookies is not None else load_playwright_cookies()
    return any(str(c.get("name") or "") == "cf_clearance" and str(c.get("value") or "") for c in items)


def read_meta() -> dict:
    path = meta_path()
    if not os.path.isfile(path):
        return {}
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}


def consume_reload_flag() -> bool:
    path = reload_flag_path()
    if not os.path.isfile(path):
        return False
    try:
        os.remove(path)
        return True
    except Exception:
        return True


def cookie_file_mtime() -> float:
    path = cookie_path()
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0
