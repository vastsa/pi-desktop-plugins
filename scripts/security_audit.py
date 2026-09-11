#!/usr/bin/env python3
"""Fail-closed security preflight for PI-Desktop plugins.

This is a static safety net, not a substitute for a maintainer reading the
source and the packed artifact. It rejects high-confidence indicators of
hidden execution, embedded credentials, unsafe manifests, and unsafe package
entries. Legitimate privileged capabilities are reported as manual-review
signals instead of being silently ignored.
"""
from __future__ import annotations

import argparse
import json
import hashlib
import re
import stat
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
PACKAGES = ROOT / "packages"
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
MAX_UNPACKED_BYTES = 200 * 1024 * 1024
PACKAGE_SKIP = {".git", "node_modules", ".DS_Store"}
TEXT_SUFFIXES = {
    ".cjs", ".css", ".html", ".htm", ".js", ".json", ".jsx", ".mjs",
    ".md", ".markdown", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml",
    ".yml",
}
CODE_SUFFIXES = {".cjs", ".html", ".htm", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue"}
APPROVED_GENERATED_HASHES = {
    "pi.markdown/renderer/assets/app.js": "131f8f17518ae1bb60d575727ccd330d477be6600ec9de7474918a6ee9c84b09",
}
REQUIRED_MANIFEST_FIELDS = (
    "schemaVersion", "id", "name", "version", "description", "i18n",
    "author", "main", "permissions", "engines",
)
KNOWN_PERMISSIONS = {
    "agent.complete", "agent.prompt.inject", "agent.tool.register", "background.service",
    "clipboard.read", "clipboard.write", "desktop.control", "fs.read", "fs.read.workspace",
    "fs.write", "fs.write.workspace", "models.list", "net.fetch", "notify", "session.import",
    "session.read", "session.read.own",
    "shell.openExternal", "ui.microphone", "ui.panel", "ui.theme", "ui.view", "usage.read",
}

# These patterns intentionally favor precision. Broad words such as "token" or
# "password" are review signals, not automatic blockers.
SECRET_PATTERNS = (
    (re.compile(r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----"), "embedded private key"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "embedded AWS access key"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"), "embedded GitHub token"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "embedded GitHub token"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"), "embedded Slack token"),
    (re.compile(r"\bsk-[A-Za-z0-9]{24,}\b"), "embedded API key"),
)
DYNAMIC_CODE = (
    (re.compile(r"\beval\s*\(\s*(?![?:*])"), "eval()"),
    (re.compile(r"\b(?:new\s+)?Function\s*\("), "Function()"),
    (re.compile(r"\b(?:vm\.(?:run|compile)|vm\.Script)\b"), "Node VM dynamic execution"),
    (re.compile(r"\b(?:import|require)\s*\(\s*['\"](?:https?://|data:)"), "remote module loading"),
    # Bare import()/require() with a non-literal argument. Do not use a leading
    # \b: `.import(` (pi.session.import) is a host method call, not dynamic load.
    (re.compile(r"(?<![.\w$])(?:import|require)\s*\(\s*(?!['\"?])"), "dynamic module loading"),
)
REMOTE_EXECUTABLE_SCRIPT = re.compile(
    r"<(?:script|iframe)\b[^>]+\b(?:src|data)\s*=\s*['\"]\s*(?:https?://|data:)",
    re.IGNORECASE,
)
REVIEW_SIGNALS = (
    ("process execution", re.compile(r"node:child_process|child_process|(?<![\w.])execFile\s*\(|(?<![\w.])exec\s*\(|(?<![\w.])spawn\s*\(|(?<![\w.])fork\s*\(")),
    ("native/bundled executable", re.compile(r"(?:\.exe\b|\.dylib\b|\.so\b|\.dll\b|forkpty|ConPTY)", re.IGNORECASE)),
    ("filesystem mutation", re.compile(r"(?:\b(?:fs|fsp)\.(?:writeFile|appendFile|rm|unlink|rmdir|rename|chmod|mkdir)\b|pi\.fs\.(?:write|delete|remove))")),
    ("network access", re.compile(r"(?:\bfetch\s*\(|https?\.(?:request|get)\s*\(|\bnet\.fetch\b|\bpi\.net\b)", re.IGNORECASE)),
    ("credential/secret handling", re.compile(r"(?:process\.env|password|private.?key|api.?key|credential|secret)", re.IGNORECASE)),
    ("clipboard access", re.compile(r"(?:navigator\.clipboard|clipboard\.read|clipboard\.write|clipboard\.readText|clipboard\.writeText)", re.IGNORECASE)),
    ("persistent activation/timer", re.compile(r"(?:onStartup|setInterval|background\.service|autoRestart)", re.IGNORECASE)),
    ("agent/prompt or desktop control", re.compile(r"(?:agent\.prompt\.inject|desktop\.control|agent\.tool\.register)", re.IGNORECASE)),
    ("destructive operation", re.compile(r"(?:\b(?:rm|unlink|rmdir|shutdown|reboot|mkfs|chmod|chown|kill)\b|git\s+(?:reset|clean|push))", re.IGNORECASE)),
)


@dataclass(frozen=True)
class Finding:
    severity: str  # BLOCKER or REVIEW
    location: str
    message: str

    def render(self) -> str:
        return f"{self.severity}: {self.location}: {self.message}"


def add(findings: list[Finding], severity: str, location: str, message: str) -> None:
    findings.append(Finding(severity, location, message))


def line_for(text: str, index: int) -> int:
    return text.count("\n", 0, max(index, 0)) + 1


def is_vendor_path(relative: str) -> bool:
    path = PurePosixPath(relative)
    parts = {part.lower() for part in path.parts}
    return (
        "node_modules" in parts
        or "vendor" in parts
        or path.name.lower().endswith((".min.js", ".min.css"))
    )
def is_generated_path(relative: str) -> bool:
    path = PurePosixPath(relative)
    return is_vendor_path(relative) or "assets" in {part.lower() for part in path.parts}


def is_test_path(relative: str) -> bool:
    return any(part.lower() in {"test", "tests", "__tests__"} for part in PurePosixPath(relative).parts)
def read_text(path: Path) -> str | None:
    if path.suffix.lower() not in TEXT_SUFFIXES:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def source_files(plugin_dir: Path, findings: list[Finding]) -> list[Path]:
    files: list[Path] = []
    try:
        paths = sorted(plugin_dir.rglob("*"))
    except OSError as error:
        add(findings, "BLOCKER", str(plugin_dir), f"cannot enumerate plugin: {error}")
        return files
    for path in paths:
        relative = path.relative_to(plugin_dir).as_posix()
        if path.is_symlink():
            add(findings, "BLOCKER", f"{plugin_dir.name}/{relative}", "symlink is not allowed in a plugin")
            continue
        if path.is_file():
            files.append(path)
    return files


def safe_manifest_path(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value:
        return None
    return path.as_posix()


def check_declared_file(
    plugin_dir: Path,
    findings: list[Finding],
    field: str,
    value: object,
    required: bool = True,
) -> None:
    relative = safe_manifest_path(value)
    if relative is None:
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"{field} must be a safe relative path")
        return
    target = plugin_dir / relative
    if not target.is_file() or target.is_symlink():
        if required:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"{field} points to a missing or unsafe file: {value}")


def as_path_list(value: object) -> Iterable[tuple[int, object]]:
    if isinstance(value, list):
        return enumerate(value)
    return ((0, value),)


def audit_manifest(plugin_dir: Path, findings: list[Finding]) -> dict | None:
    path = plugin_dir / "manifest.json"
    if path.is_symlink() or not path.is_file():
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "manifest.json is missing or is a symlink")
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"invalid JSON: {error}")
        return None
    if not isinstance(manifest, dict):
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "manifest root must be an object")
        return None

    for field in REQUIRED_MANIFEST_FIELDS:
        if field not in manifest:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"missing required field: {field}")
    plugin_id = manifest.get("id")
    if not isinstance(plugin_id, str) or not plugin_id.strip():
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "id must be a non-empty string")
    elif plugin_id != plugin_dir.name:
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"id does not match directory name: {plugin_id}")
    if manifest.get("main") != "main.js":
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "main must be exactly main.js")
    check_declared_file(plugin_dir, findings, "main", manifest.get("main"))

    i18n = manifest.get("i18n")
    if not isinstance(i18n, dict):
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "i18n must be an object")
    else:
        for locale in ("en", "zh-CN"):
            entry = i18n.get(locale)
            if not isinstance(entry, dict):
                add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"i18n.{locale} must be an object")
                continue
            for field in ("name", "description", "safetyNotes"):
                if not isinstance(entry.get(field), str) or not entry[field].strip():
                    add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"i18n.{locale}.{field} must be non-empty")

    permissions = manifest.get("permissions")
    if not isinstance(permissions, list) or not all(isinstance(item, str) and item.strip() for item in permissions):
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "permissions must be a list of non-empty strings")
        permissions = []
    if len(set(permissions)) != len(permissions):
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "permissions contain duplicates")
    for permission in permissions:
        if permission not in KNOWN_PERMISSIONS:
            add(findings, "REVIEW", f"{plugin_dir.name}/manifest.json", f"unknown permission requires host-policy review: {permission}")

    engines = manifest.get("engines")
    if not isinstance(engines, dict) or not isinstance(engines.get("piDesktop"), str) or not engines["piDesktop"].strip():
        add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "engines.piDesktop must be a non-empty string")

    ui = manifest.get("ui")
    if isinstance(ui, dict) and "panel" in ui:
        check_declared_file(plugin_dir, findings, "ui.panel", ui.get("panel"))
    contributes = manifest.get("contributes")
    if isinstance(contributes, dict):
        views = contributes.get("views")
        if views is not None and not isinstance(views, list):
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "contributes.views must be a list")
        for index, view in as_path_list(views or []):
            if isinstance(view, dict) and "entry" in view:
                check_declared_file(plugin_dir, findings, f"contributes.views[{index}].entry", view.get("entry"))
        skills = contributes.get("skills")
        if skills is not None and not isinstance(skills, list):
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "contributes.skills must be a list")
        for index, skill in as_path_list(skills or []):
            check_declared_file(plugin_dir, findings, f"contributes.skills[{index}]", skill)
        themes = contributes.get("themes")
        if themes is not None and not isinstance(themes, list):
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "contributes.themes must be a list")
        for index, theme in as_path_list(themes or []):
            if isinstance(theme, dict) and "path" in theme:
                check_declared_file(plugin_dir, findings, f"contributes.themes[{index}].path", theme.get("path"))
        if themes and "ui.theme" not in permissions:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "themes declared without ui.theme permission")
        if contributes.get("agentTools") and "agent.tool.register" not in permissions:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "agentTools declared without agent.tool.register permission")
        if contributes.get("skills") and "agent.prompt.inject" not in permissions:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "skills declared without agent.prompt.inject permission")
        if contributes.get("services") and "background.service" not in permissions:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "services declared without background.service permission")
    fs = manifest.get("fs")
    if isinstance(fs, dict):
        for access in ("read", "write"):
            if access in fs and f"fs.{access}" not in permissions:
                add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"fs.{access} is declared without fs.{access} permission")
    net = manifest.get("net")
    if isinstance(net, dict) and "domains" in net:
        domains = net.get("domains")
        if not isinstance(domains, list) or not domains or not all(isinstance(domain, str) and domain.strip() for domain in domains):
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "net.domains must be a non-empty list of host names")
        else:
            for domain in domains:
                if "://" in domain or "/" in domain or domain.startswith("*"):
                    add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", f"net.domains contains an unsafe entry: {domain}")
        if "net.fetch" not in permissions:
            add(findings, "BLOCKER", f"{plugin_dir.name}/manifest.json", "net.domains is declared without net.fetch permission")
    return manifest



def audit_text(findings: list[Finding], location: str, relative: str, text: str, include_review: bool = True) -> None:
    for pattern, reason in SECRET_PATTERNS:
        match = pattern.search(text)
        if match:
            add(findings, "BLOCKER", f"{location}:{line_for(text, match.start())}", f"{reason} found")
    if relative.lower().endswith((".html", ".htm")):
        match = REMOTE_EXECUTABLE_SCRIPT.search(text)
        if match:
            add(findings, "BLOCKER", f"{location}:{line_for(text, match.start())}", "remote script or iframe source is not allowed")
    if relative.lower().endswith(tuple(CODE_SUFFIXES)) and not is_vendor_path(relative):
        for pattern, reason in DYNAMIC_CODE:
            match = pattern.search(text)
            if match:
                approved_generated = (
                    is_generated_path(relative)
                    and (
                        not include_review
                        or hashlib.sha256(text.encode("utf-8")).hexdigest() == APPROVED_GENERATED_HASHES.get(f"{location.split('/', 1)[0]}/{relative}")
                    )
                )
                if is_test_path(relative) and reason == "dynamic module loading":
                    continue
                if not approved_generated:
                    add(findings, "BLOCKER", f"{location}:{line_for(text, match.start())}", f"dynamic or remote code execution: {reason}")
    if include_review and not is_generated_path(relative):
        for reason, pattern in REVIEW_SIGNALS:
            match = pattern.search(text)
            if match:
                add(findings, "REVIEW", f"{location}:{line_for(text, match.start())}", f"manual review signal: {reason}")


def audit_plugin(plugin_dir: Path, include_review: bool = True) -> tuple[list[Finding], dict | None]:
    findings: list[Finding] = []
    manifest = audit_manifest(plugin_dir, findings)
    for path in source_files(plugin_dir, findings):
        relative = path.relative_to(plugin_dir).as_posix()
        text = read_text(path)
        if text is not None:
            audit_text(
                findings,
                f"{plugin_dir.name}/{relative}",
                relative,
                text,
                include_review=include_review and path.suffix.lower() in CODE_SUFFIXES,
            )
    return findings, manifest


def safe_archive_name(name: str) -> bool:
    if not name or "\\" in name or name.startswith("/"):
        return False
    parts = name.split("/")
    if parts[-1] == "":
        parts = parts[:-1]
    return bool(parts) and all(part not in {"", ".", ".."} for part in parts)


def audit_package(package: Path) -> list[Finding]:
    findings: list[Finding] = []
    location = f"packages/{package.name}"
    try:
        size = package.stat().st_size
    except OSError as error:
        add(findings, "BLOCKER", location, f"cannot stat package: {error}")
        return findings
    if size > MAX_PACKAGE_BYTES:
        add(findings, "BLOCKER", location, f"package exceeds {MAX_PACKAGE_BYTES} byte limit")
    try:
        with zipfile.ZipFile(package) as archive:
            infos = archive.infolist()
            names: set[str] = set()
            normalized_names: set[str] = set()
            unpacked = 0
            manifest_data = None
            for info in infos:
                name = info.filename
                normalized_name = name.replace("\\", "/")
                if name in names or normalized_name in normalized_names:
                    add(findings, "BLOCKER", f"{location}:{name}", "duplicate archive entry")
                names.add(name)
                normalized_names.add(normalized_name)
                if not safe_archive_name(name):
                    add(findings, "BLOCKER", f"{location}:{name}", "path traversal or absolute archive entry")
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    add(findings, "BLOCKER", f"{location}:{name}", "symlink archive entry is not allowed")
                unpacked += info.file_size
                if unpacked > MAX_UNPACKED_BYTES:
                    add(findings, "BLOCKER", location, f"unpacked package exceeds {MAX_UNPACKED_BYTES} byte safety limit")
                    break
                if name == "manifest.json":
                    manifest_data = archive.read(info)
                if not info.is_dir() and Path(name).suffix.lower() in TEXT_SUFFIXES:
                    try:
                        text = archive.read(info).decode("utf-8")
                    except (UnicodeDecodeError, RuntimeError, zipfile.BadZipFile):
                        continue
                    audit_text(findings, f"{location}:{name}", name, text, include_review=False)
            if "manifest.json" not in names:
                add(findings, "BLOCKER", location, "package root is missing manifest.json")
            if manifest_data is not None:
                try:
                    manifest = json.loads(manifest_data.decode("utf-8"))
                    expected_name = f"{manifest.get('id')}-{manifest.get('version')}.piplug"
                    if expected_name != package.name:
                        add(findings, "BLOCKER", location, f"filename does not match packaged manifest: expected {expected_name}")
                except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                    add(findings, "BLOCKER", location, "packaged manifest is invalid JSON")
    except (OSError, zipfile.BadZipFile) as error:
        add(findings, "BLOCKER", location, f"invalid package: {error}")
    return findings


def compare_package_to_source(package: Path, plugin_dir: Path, findings: list[Finding]) -> None:
    expected = {}
    for path in plugin_dir.rglob("*"):
        relative = path.relative_to(plugin_dir).as_posix()
        if path.is_symlink() or not path.is_file() or any(part in PACKAGE_SKIP for part in path.parts):
            continue
        expected[relative] = path.read_bytes()
    try:
        with zipfile.ZipFile(package) as archive:
            actual = {info.filename: archive.read(info) for info in archive.infolist() if not info.is_dir()}
    except (OSError, zipfile.BadZipFile) as error:
        add(findings, "BLOCKER", f"packages/{package.name}", f"cannot compare package with source: {error}")
        return
    if set(actual) != set(expected):
        add(findings, "BLOCKER", f"packages/{package.name}", "packed files do not exactly match the current plugin source")
        return
    for name in sorted(expected):
        if actual[name] != expected[name]:
            add(findings, "BLOCKER", f"packages/{package.name}:{name}", "packed bytes do not match the current plugin source")
def audit_packages(findings: list[Finding], require_current: bool = True) -> None:
    if not PACKAGES.is_dir():
        add(findings, "BLOCKER", "packages", "packages directory is missing")
        return
    for package in sorted(PACKAGES.glob("*.piplug")):
        findings.extend(audit_package(package))
    if require_current:
        for manifest_path in sorted(PLUGINS.glob("*/manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                expected = PACKAGES / f"{manifest['id']}-{manifest['version']}.piplug"
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
                continue
            if not expected.is_file():
                add(findings, "BLOCKER", str(manifest_path.relative_to(ROOT)), f"current manifest has no matching package: {expected.name}")
            else:
                compare_package_to_source(expected, manifest_path.parent, findings)


def plugin_dirs(arguments: list[str]) -> list[Path]:
    if arguments:
        result = []
        for argument in arguments:
            path = Path(argument)
            if not path.is_absolute():
                path = ROOT / path
            result.append(path.resolve())
        return result
    return sorted(path for path in PLUGINS.iterdir() if path.is_dir() and not path.is_symlink() and path.name != "shared")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugins", nargs="*", help="optional plugin directories; defaults to all plugins/*")
    parser.add_argument("--check-packages", action="store_true", help="also inspect every .piplug and current manifest/package presence")
    parser.add_argument("--fail-on-review", action="store_true", help="treat manual-review signals as failures (useful for local release sign-off)")
    args = parser.parse_args(argv)

    findings: list[Finding] = []
    dirs = plugin_dirs(args.plugins)
    if not dirs:
        add(findings, "BLOCKER", "plugins", "no plugin directories found")
    for plugin_dir in dirs:
        if not plugin_dir.is_dir() or not plugin_dir.is_relative_to(PLUGINS):
            add(findings, "BLOCKER", str(plugin_dir), "plugin path must be a directory below plugins/")
            continue
        plugin_findings, _ = audit_plugin(plugin_dir)
        findings.extend(plugin_findings)
    if args.check_packages:
        audit_packages(findings)

    blockers = [finding for finding in findings if finding.severity == "BLOCKER"]
    reviews = [finding for finding in findings if finding.severity == "REVIEW"]
    print(f"Security audit: {len(dirs)} plugin(s), {len(blockers)} blocker(s), {len(reviews)} manual-review signal(s)")
    for finding in findings:
        print(finding.render())
    if blockers:
        print("Security audit failed: resolve every blocker before merge or release.", file=sys.stderr)
        return 1
    if args.fail_on_review and reviews:
        print("Security audit failed: manual-review signals remain.", file=sys.stderr)
        return 1
    print("Security audit passed automatic checks; maintainer review is still required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
