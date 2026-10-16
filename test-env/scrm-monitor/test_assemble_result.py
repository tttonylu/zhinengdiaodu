#!/usr/bin/env python3
"""Pure unit tests for locate/status assemble logic."""
from scraper_final import assemble_result, normalize_targets, compute_changes


def test_inherit_skips_not_found():
    raw = normalize_targets(["@871sbroc"])
    located = {
        "@871sbroc": {
            "firstSeenAt": "t0",
            "lastSeenAt": "t1",
            "lastGood": {
                "agentId": "@871sbroc",
                "online": True,
                "statusText": "在线",
                "nickname": "井上 葵",
            },
        }
    }
    result, new_loc = assemble_result(raw, {}, located, {}, 0, "status")
    assert result["notFound"] == []
    assert "@871sbroc" in result["agents"]
    assert result["agents"]["@871sbroc"]["inherited"] is True
    assert result["agents"]["@871sbroc"]["online"] is True
    assert "@871sbroc" in result["inherited"]


def test_never_located_is_not_found():
    raw = normalize_targets(["@newagent"])
    result, _ = assemble_result(raw, {}, {}, {}, 10, "locate")
    assert result["notFound"] == ["@newagent"]
    assert result["agents"] == {}


def test_live_updates_located():
    raw = normalize_targets(["@871sbroc"])
    live = {
        "@871sbroc": {
            "agentId": "@871sbroc",
            "online": False,
            "statusText": "离线",
            "nickname": "井上 葵",
        }
    }
    result, new_loc = assemble_result(raw, live, {}, {}, 24, "locate")
    assert result["notFound"] == []
    assert result["agents"]["@871sbroc"]["online"] is False
    assert "inherited" not in result["agents"]["@871sbroc"]
    assert new_loc["@871sbroc"]["lastGood"]["statusText"] == "离线"


def test_changes_ignore_inherited():
    prev = {"@a": {"online": True, "statusText": "在线", "todayDone": 0}}
    cur = {
        "@a": {
            "agentId": "@a",
            "online": True,
            "statusText": "在线",
            "todayDone": 0,
            "inherited": True,
        }
    }
    assert compute_changes(prev, cur) == {}


if __name__ == "__main__":
    test_inherit_skips_not_found()
    test_never_located_is_not_found()
    test_live_updates_located()
    test_changes_ignore_inherited()
    print("OK")
