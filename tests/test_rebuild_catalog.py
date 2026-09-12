#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_rebuild_catalog():
    spec = importlib.util.spec_from_file_location(
        "rebuild_catalog", ROOT / "scripts" / "rebuild_catalog.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class RebuildCatalogTests(unittest.TestCase):
    def test_preserves_existing_publish_dates(self):
        rebuild = load_rebuild_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin_dir = root / "plugins" / "demo.hello"
            packages_dir = root / "packages"
            plugin_dir.mkdir(parents=True)
            packages_dir.mkdir()
            (plugin_dir / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": "demo.hello",
                        "name": "Hello",
                        "version": "1.0.0",
                        "description": "A test plugin",
                        "author": "Test",
                        "main": "main.js",
                        "permissions": [],
                        "engines": {"piDesktop": ">=0.2.0"},
                    }
                ),
                encoding="utf-8",
            )
            (packages_dir / "demo.hello-1.0.0.piplug").write_bytes(b"artifact")
            old_published_at = "2024-01-02T03:04:05Z"
            (root / "catalog.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "providerId": "official",
                        "plugins": [
                            {
                                "id": "demo.hello",
                                "versions": [
                                    {
                                        "version": "1.0.0",
                                        "publishedAt": old_published_at,
                                    }
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            original_paths = (rebuild.ROOT, rebuild.PLUGINS, rebuild.PACKAGES)
            rebuild.ROOT = root
            rebuild.PLUGINS = root / "plugins"
            rebuild.PACKAGES = packages_dir
            try:
                self.assertEqual(rebuild.main(), 0)
            finally:
                rebuild.ROOT, rebuild.PLUGINS, rebuild.PACKAGES = original_paths

            catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
            version = catalog["plugins"][0]["versions"][0]
            self.assertEqual(version["publishedAt"], old_published_at)
            self.assertNotEqual(catalog["updatedAt"], old_published_at)


if __name__ == "__main__":
    unittest.main()
