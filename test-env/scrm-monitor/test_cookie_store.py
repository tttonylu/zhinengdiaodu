# -*- coding: utf-8 -*-
import json
import os
import tempfile
import unittest

import cookie_store as cs


class CookieStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = os.path.join(self.tmp.name, "config.json")
        open(self.cfg, "w", encoding="utf-8").write("{}")
        os.environ["CONFIG_FILE"] = self.cfg

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop("CONFIG_FILE", None)

    def test_normalize_and_save(self):
        meta = cs.save_cookies(
            [
                {
                    "name": "sid",
                    "value": "abc",
                    "domain": ".scrmceo.com",
                    "path": "/",
                    "expirationDate": 1999999999,
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "no_restriction",
                }
            ],
            source="test",
        )
        self.assertEqual(meta["count"], 1)
        cookies = cs.load_playwright_cookies()
        self.assertEqual(cookies[0]["name"], "sid")
        self.assertEqual(cookies[0]["sameSite"], "None")
        self.assertTrue(cs.consume_reload_flag())
        self.assertFalse(cs.consume_reload_flag())
        self.assertEqual(cs.read_meta()["source"], "test")


if __name__ == "__main__":
    unittest.main()
