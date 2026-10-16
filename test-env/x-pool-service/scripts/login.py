#!/usr/bin/env python3
"""X 账号登录 — 用 twscrape login 获取新鲜 token"""
import sys, json, asyncio

async def run():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: login.py <username> <password> [email] [email_password]"}), flush=True)
        return

    username = sys.argv[1]
    password = sys.argv[2]
    email = sys.argv[3] if len(sys.argv) > 3 else None
    email_password = sys.argv[4] if len(sys.argv) > 4 else None

    from twscrape import API
    api = API()

    try:
        # 用账号密码登录
        await api.pool.login(username, password, email=email, email_password=email_password)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        return

    # 获取登录后的 cookie
    try:
        acct = await api.pool.get_account(username)
        if not acct:
            print(json.dumps({"ok": False, "error": "account not found after login"}), flush=True)
            return

        cookies = acct.get("cookies", {})
        if isinstance(cookies, str):
            cookie_dict = {}
            for p in cookies.split(";"):
                p = p.strip()
                if "=" in p:
                    k, _, v = p.partition("=")
                    cookie_dict[k.strip()] = v.strip()
            cookies = cookie_dict

        auth_token = cookies.get("auth_token", "")
        ct0 = cookies.get("ct0", "")

        if not auth_token:
            print(json.dumps({"ok": False, "error": "no auth_token in cookies", "cookies": str(cookies)[:200]}), flush=True)
            return

        result = f"auth_token={auth_token}"
        if ct0:
            result += f"; ct0={ct0}"

        print(json.dumps({"ok": True, "cookie": result, "auth_token": auth_token, "ct0": ct0}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)

asyncio.run(run())
