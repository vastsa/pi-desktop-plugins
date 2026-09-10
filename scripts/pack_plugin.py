#!/usr/bin/env python3
"""Pack a plugin source directory into packages/<id>-<version>.piplug."""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
SKIP = {".git", "node_modules", ".DS_Store"}


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def make_zip(files: list[tuple[str, bytes]]) -> bytes:
    out = bytearray()
    central = bytearray()
    offset = 0
    for name, data in files:
        name_b = name.encode("utf-8")
        c = crc32(data)
        local = bytearray()
        local += struct.pack(
            "<IHHHHHIIIHH",
            0x04034B50,
            20,
            0,
            0,
            0,
            0,
            c,
            len(data),
            len(data),
            len(name_b),
            0,
        )
        local += name_b
        local += data
        out += local
        cen = bytearray()
        cen += struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50,
            20,
            20,
            0,
            0,
            0,
            0,
            c,
            len(data),
            len(data),
            len(name_b),
            0,
            0,
            0,
            0,
            0,
            offset,
        )
        cen += name_b
        central += cen
        offset += len(local)
    central_offset = len(out)
    out += central
    count = len(files)
    out += struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        count,
        count,
        len(central),
        central_offset,
        0,
    )
    return bytes(out)
def validate_plugin_dir(src: Path) -> None:
    if src.is_symlink() or not src.is_dir():
        raise SystemExit(f"plugin directory is missing or is a symlink: {src}")
    try:
        src.relative_to(PLUGINS)
    except ValueError:
        raise SystemExit(f"plugin must be below {PLUGINS}: {src}")

def collect_files(src: Path) -> list[tuple[str, bytes]]:
    files: list[tuple[str, bytes]] = []
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src).as_posix()
        if path.is_symlink():
            raise SystemExit(f"symlink is not allowed in a plugin: {rel}")
        if not path.is_file():
            continue
        if any(part in SKIP for part in path.parts):
            continue
        if not rel or rel.startswith("../") or "/../" in f"/{rel}":
            raise SystemExit(f"unsafe plugin path: {rel}")
        files.append((rel, path.read_bytes()))
    if not any(name == "manifest.json" for name, _ in files):
        raise SystemExit(f"manifest.json missing in {src}")
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("plugin_dir", type=Path, help="plugins/<id> directory")
    args = parser.parse_args()
    requested = args.plugin_dir
    if not requested.is_absolute():
        requested = Path.cwd() / requested
    if requested.is_symlink():
        raise SystemExit(f"plugin directory is a symlink: {requested}")
    src = requested.resolve()
    validate_plugin_dir(src)
    try:
        manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"invalid manifest.json in {src}: {error}")
    plugin_id = manifest.get("id")
    version = manifest.get("version")
    if not isinstance(plugin_id, str) or plugin_id != src.name or any(char in plugin_id for char in "/\\"):
        raise SystemExit(f"manifest id must match the plugin directory name: {plugin_id}")
    if not isinstance(version, str) or not version.strip() or any(char in version for char in "/\\") or version in {".", ".."}:
        raise SystemExit(f"manifest version is not a safe filename component: {version}")
    blob = make_zip(collect_files(src))
    if len(blob) > MAX_PACKAGE_BYTES:
        raise SystemExit(f"package exceeds {MAX_PACKAGE_BYTES} byte limit: {len(blob)}")
    out_dir = ROOT / "packages"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{plugin_id}-{version}.piplug"
    out.write_bytes(blob)
    print(out)
    print("sha256", hashlib.sha256(blob).hexdigest())
    print("size", len(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
