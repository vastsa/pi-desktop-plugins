"""An unchanged catalog must still have every required package on disk."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sync_package_repair", Path(__file__).resolve().parents[1] / "scripts" / "sync_catalog.py",
)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class PackageRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.packages = self.root / "packages"
        self.packages.mkdir()
        self.blob = b"verified-package"
        self.source = "https://center.example/catalog.json"
        self.src = {
            "providerId": "official",
            "artifactBaseUrl": "https://center.example/artifacts/",
            "plugins": [{"id": "demo.hello", "versions": [{
                "version": "1.0.0", "shasum": sync.sha256_bytes(self.blob), "url": "hello.piplug",
            }]}],
        }
        self.package = self.packages / "demo.hello-1.0.0.piplug"
        self.write_catalog()

    def write_catalog(self):
        self.catalog_bytes = (json.dumps(sync.rewrite_for_mirror(self.src)) + "\n").encode()
        (self.root / "catalog.json").write_bytes(self.catalog_bytes)

    def run_sync(self, dry_run=False, blob=None):
        def fetch(url, timeout):
            if url == self.source:
                return json.dumps(self.src).encode()
            if url == self.source + ".sig":
                return b"signature"
            self.assertEqual(url, "https://center.example/artifacts/hello.piplug")
            return self.blob if blob is None else blob
        with patch.object(sync, "fetch", side_effect=fetch) as mocked:
            self.assertEqual(sync.sync(self.root, self.source, dry_run), 0)
        return mocked

    def test_missing_and_corrupt_packages_are_repaired(self):
        for before in (None, b"corrupt"):
            with self.subTest(before=before):
                if before is None:
                    self.package.unlink(missing_ok=True)
                else:
                    self.package.write_bytes(before)
                self.run_sync()
                self.assertEqual(self.package.read_bytes(), self.blob)

    def test_healthy_package_avoids_download_and_replacement(self):
        self.package.write_bytes(self.blob)
        fetched = self.run_sync()
        self.assertEqual(fetched.call_count, 1)
        self.assertEqual((self.root / "catalog.json").read_bytes(), self.catalog_bytes)

    def test_yanked_package_is_optional(self):
        self.src["plugins"][0]["versions"][0]["yanked"] = True
        self.write_catalog()
        fetched = self.run_sync()
        self.assertEqual(fetched.call_count, 1)
        self.assertFalse(self.package.exists())

    def test_failed_hash_verification_preserves_catalog_and_packages(self):
        self.package.write_bytes(b"corrupt-local")
        with self.assertRaisesRegex(SystemExit, "sha256 mismatch"):
            self.run_sync(blob=b"corrupt-remote")
        self.assertEqual(self.package.read_bytes(), b"corrupt-local")
        self.assertEqual((self.root / "catalog.json").read_bytes(), self.catalog_bytes)
        self.assertFalse((self.root / "catalog.json.tmp").exists())
        self.assertFalse((self.root / "packages.tmp").exists())

    def test_dry_run_checks_repair_without_writing(self):
        for before in (None, b"corrupt"):
            with self.subTest(before=before):
                if before is None:
                    self.package.unlink(missing_ok=True)
                else:
                    self.package.write_bytes(before)
                fetched = self.run_sync(dry_run=True)
                self.assertEqual(fetched.call_count, 2)
                self.assertEqual(self.package.read_bytes() if self.package.exists() else None, before)
                self.assertEqual((self.root / "catalog.json").read_bytes(), self.catalog_bytes)


if __name__ == "__main__":
    unittest.main()
