#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_sync():
    spec = importlib.util.spec_from_file_location("sync_catalog", SCRIPTS / "sync_catalog.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


sync = load_sync()


class RewriteTests(unittest.TestCase):
    def test_rewrite_drops_artifact_base_and_uses_packages(self):
        src = {
            "schemaVersion": 2,
            "providerId": "official",
            "artifactBaseUrl": "https://plugins.aiuo.net/api/pi/v1/",
            "plugins": [
                {
                    "id": "demo.hello",
                    "versions": [
                        {
                            "version": "1.0.0",
                            "shasum": "aa",
                            "url": "plugins/demo.hello/versions/1.0.0/artifact",
                        }
                    ],
                }
            ],
        }
        out = sync.rewrite_for_mirror(src)
        self.assertNotIn("artifactBaseUrl", out)
        self.assertEqual(out["plugins"][0]["versions"][0]["url"], "packages/demo.hello-1.0.0.piplug")
        self.assertEqual(src["plugins"][0]["versions"][0]["url"], "plugins/demo.hello/versions/1.0.0/artifact")

    def test_empty_catalog_rejected(self):
        with self.assertRaises(SystemExit):
            sync.validate_catalog({"providerId": "official", "plugins": []})

    def test_canonical_ignores_volatile_fields(self):
        a = {"providerId": "official", "catalogId": "1", "plugins": [{"id": "x"}]}
        b = {"providerId": "official", "catalogId": "2", "updatedAt": "now", "plugins": [{"id": "x"}]}
        self.assertEqual(sync.canonical(a), sync.canonical(b))


class SyncHttpTests(unittest.TestCase):
    def test_fail_closed_does_not_overwrite(self):
        blob = b"hello-piplug"
        shasum = sync.sha256_bytes(blob)
        catalog = {
            "schemaVersion": 2,
            "providerId": "official",
            "artifactBaseUrl": "http://127.0.0.1/api/pi/v1/",
            "plugins": [
                {
                    "id": "demo.hello",
                    "name": "Hello",
                    "versions": [
                        {
                            "version": "1.0.0",
                            "shasum": shasum,
                            "url": "plugins/demo.hello/versions/1.0.0/artifact",
                        }
                    ],
                }
            ],
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.endswith("/catalog.json"):
                    body = json.dumps(catalog).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.path.endswith("/artifact"):
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(blob)))
                    self.end_headers()
                    self.wfile.write(blob)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, format, *args):
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        host, port = httpd.server_address
        catalog["artifactBaseUrl"] = f"http://{host}:{port}/api/pi/v1/"
        url = f"http://{host}:{port}/catalog.json"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "packages").mkdir()
                old = {"schemaVersion": 1, "providerId": "official", "plugins": [{"id": "keep.me", "versions": [{"version": "0.0.1", "shasum": "00"}]}]}
                (root / "catalog.json").write_text(json.dumps(old), encoding="utf-8")
                (root / "packages" / "keep.me-0.0.1.piplug").write_bytes(b"old")
                rc = sync.sync(root, url, dry_run=False)
                self.assertEqual(rc, 0)
                new = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
                self.assertEqual(new["plugins"][0]["id"], "demo.hello")
                self.assertNotIn("artifactBaseUrl", new)
                pkg = root / "packages" / "demo.hello-1.0.0.piplug"
                self.assertTrue(pkg.exists())
                self.assertEqual(pkg.read_bytes(), blob)
                self.assertFalse((root / "packages" / "keep.me-0.0.1.piplug").exists())
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_http_error_leaves_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "packages").mkdir()
            old = '{"providerId":"official","plugins":[{"id":"keep.me"}]}'
            (root / "catalog.json").write_text(old, encoding="utf-8")
            with self.assertRaises(Exception):
                sync.sync(root, "http://127.0.0.1:1/catalog.json", dry_run=False)
            self.assertEqual((root / "catalog.json").read_text(encoding="utf-8"), old)


if __name__ == "__main__":
    sys.exit(unittest.main())
