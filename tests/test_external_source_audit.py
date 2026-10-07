"""Explicit source directories can belong to a separate plugin repository."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "external_source_audit", Path(__file__).resolve().parents[1] / "scripts" / "security_audit.py",
)
audit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = audit
spec.loader.exec_module(audit)


class ExternalSourceAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "distribution"
        self.repo.mkdir()
        self.plugin = self.root / "sample.plugin"
        self.plugin.mkdir()
        (self.plugin / "main.js").write_text("module.exports = {};\n", encoding="utf-8")
        (self.plugin / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "id": "sample.plugin", "name": "Sample", "version": "0.1.0",
            "description": "Sample", "author": "test", "main": "main.js", "permissions": [],
            "engines": {"piDesktop": ">=0.2.0"},
            "i18n": {
                "en": {"name": "Sample", "description": "Sample", "safetyNotes": "None"},
                "zh-CN": {"name": "Sample", "description": "Sample", "safetyNotes": "None"},
            },
        }), encoding="utf-8")

    def run_audit(self, args):
        output = io.StringIO()
        with patch.object(audit, "ROOT", self.repo), patch.object(audit, "PLUGINS", self.repo / "plugins"), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = audit.main(args)
        return result, output.getvalue()

    def test_absolute_and_relative_external_paths_are_audited(self):
        for path in (str(self.plugin), "../sample.plugin"):
            with self.subTest(path=path):
                status, output = self.run_audit([path])
                self.assertEqual(status, 0, output)
                self.assertIn("1 plugin source(s), 0 blocker(s)", output)
                self.assertNotIn("Source audit skipped", output)

    def test_external_source_still_fails_static_blockers(self):
        (self.plugin / "main.js").write_text("eval(input);\n", encoding="utf-8")
        status, output = self.run_audit([str(self.plugin)])
        self.assertEqual(status, 1)
        self.assertIn("dynamic or remote code execution: eval()", output)
        self.assertNotIn("Source audit skipped", output)

    def test_missing_and_file_paths_fail(self):
        for path in (self.root / "missing", self.plugin / "main.js"):
            with self.subTest(path=path):
                status, output = self.run_audit([str(path)])
                self.assertEqual(status, 1)
                self.assertIn("plugin path must be a directory", output)

    def test_no_default_sources_reports_skip(self):
        status, output = self.run_audit([])
        self.assertEqual(status, 0, output)
        self.assertIn("Source audit skipped", output)
        self.assertNotIn("every package in packages/ is audited", output)


if __name__ == "__main__":
    unittest.main()
