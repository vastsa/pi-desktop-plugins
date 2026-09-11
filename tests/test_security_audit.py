#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_audit():
    path = ROOT / "scripts" / "security_audit.py"
    spec = importlib.util.spec_from_file_location("security_audit", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


security_audit = load_audit()


class StaticFindingTests(unittest.TestCase):
    def test_dynamic_code_is_a_blocker_for_authored_code(self):
        findings = []
        security_audit.audit_text(findings, "sample/main.js", "main.js", "const run = eval(input);")
        self.assertTrue(any(item.severity == "BLOCKER" for item in findings))

    def test_remote_script_and_private_key_are_blockers(self):
        findings = []
        security_audit.audit_text(
            findings,
            "sample/index.html",
            "index.html",
            '<script src="https://evil.example/payload.js"></script>\n'
            "-----BEGIN PRIVATE KEY-----",
        )
        self.assertEqual(sum(item.severity == "BLOCKER" for item in findings), 2)

    def test_regex_text_in_generated_asset_is_not_misclassified(self):
        findings = []
        security_audit.audit_text(
            findings,
            "sample/renderer/assets/app.js",
            "renderer/assets/app.js",
            "function: /eval(?:cmd)?/",
        )
        self.assertFalse(any(item.severity == "BLOCKER" for item in findings))

    def test_dynamic_code_in_assets_is_still_a_blocker(self):
        findings = []
        security_audit.audit_text(findings, "sample/renderer/assets/app.js", "renderer/assets/app.js", "eval(input);")
        self.assertTrue(any(item.severity == "BLOCKER" for item in findings))

    def test_host_import_api_is_not_dynamic_module_loading(self):
        findings = []
        security_audit.audit_text(
            findings,
            "sample/main.js",
            "main.js",
            "const res = await pi.session.import({ session, messages });\n"
            "await pi.session.importBatch({ sessions });\n",
        )
        self.assertFalse(
            [item for item in findings if item.severity == "BLOCKER"],
            findings,
        )

    def test_dynamic_require_expression_is_a_blocker(self):
        findings = []
        security_audit.audit_text(findings, "sample/main.js", "main.js", "const mod = require(name);\n")
        self.assertTrue(
            any(
                item.severity == "BLOCKER" and "dynamic module loading" in item.message
                for item in findings
            ),
            findings,
        )

    def test_approved_generated_dependency_requires_exact_hash(self):
        path = ROOT / "plugins" / "pi.markdown" / "renderer" / "assets" / "app.js"
        findings = []
        security_audit.audit_text(
            findings,
            "pi.markdown/renderer/assets/app.js",
            "renderer/assets/app.js",
            path.read_text(encoding="utf-8"),
        )
        self.assertFalse([item for item in findings if item.severity == "BLOCKER"], findings)


class ManifestAndPackageTests(unittest.TestCase):
    def test_current_sample_has_no_automatic_blocker(self):
        findings, _ = security_audit.audit_plugin(ROOT / "plugins" / "demo.hello", include_review=False)
        self.assertFalse([item for item in findings if item.severity == "BLOCKER"], findings)

    def test_manifest_surface_requires_matching_permission(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = Path(tmp) / "sample.plugin"
            plugin.mkdir()
            (plugin / "main.js").write_text("module.exports = {};\n", encoding="utf-8")
            (plugin / "manifest.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": "sample.plugin",
                        "name": "Sample",
                        "version": "0.1.0",
                        "description": "Sample",
                        "i18n": {
                            "en": {"name": "Sample", "description": "Sample", "safetyNotes": "None"},
                            "zh-CN": {"name": "示例", "description": "示例", "safetyNotes": "无"},
                        },
                        "author": "test",
                        "main": "main.js",
                        "permissions": ["ui.panel"],
                        "engines": {"piDesktop": ">=0.2.0"},
                        "contributes": {"agentTools": [{"name": "unsafe"}]},
                    }
                ),
                encoding="utf-8",
            )
            findings, _ = security_audit.audit_plugin(plugin, include_review=False)
            self.assertTrue(any("agentTools" in item.message for item in findings if item.severity == "BLOCKER"))

    def test_package_path_traversal_is_a_blocker(self):
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "sample.plugin-0.1.0.piplug"
            manifest = {"id": "sample.plugin", "version": "0.1.0"}
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("../escape.js", "alert(1)")
            findings = security_audit.audit_package(package)
            self.assertTrue(any(item.severity == "BLOCKER" for item in findings))


if __name__ == "__main__":
    unittest.main()
