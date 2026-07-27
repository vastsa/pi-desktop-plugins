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


def collect_files(src: Path) -> list[tuple[str, bytes]]:
    files: list[tuple[str, bytes]] = []
    for path in sorted(src.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP for part in path.parts):
            continue
        rel = path.relative_to(src).as_posix()
        files.append((rel, path.read_bytes()))
    if not any(name == "manifest.json" for name, _ in files):
        raise SystemExit(f"manifest.json missing in {src}")
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("plugin_dir", type=Path, help="plugins/<id> directory")
    args = parser.parse_args()
    src = args.plugin_dir
    if not src.is_absolute():
        src = (Path.cwd() / src).resolve()
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    plugin_id = manifest["id"]
    version = manifest["version"]
    blob = make_zip(collect_files(src))
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
