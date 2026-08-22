#!/usr/bin/env python3
"""Rebuild catalog.json from plugins/*/manifest.json + packages/*.piplug."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
PACKAGES = ROOT / "packages"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def main() -> int:
    plugins = []
    for manifest_path in sorted(PLUGINS.glob("*/manifest.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        plugin_id = manifest["id"]
        version = manifest["version"]
        package = PACKAGES / f"{plugin_id}-{version}.piplug"
        if not package.exists():
            raise SystemExit(f"missing package for {plugin_id}@{version}: {package}")
        readme = manifest_path.parent / "README.md"
        plugins.append(
            {
                "id": plugin_id,
                "name": manifest.get("name", plugin_id),
                "description": manifest.get("description", ""),
                "i18n": manifest.get("i18n") or {},
                "author": manifest.get("author", "PI-Desktop"),
                "categories": manifest.get("categories")
                or (["official"] if plugin_id.startswith("demo.") else ["community"]),
                "verified": True,
                "downloads": 0,
                "homepage": f"https://github.com/vastsa/pi-desktop-plugins/tree/main/plugins/{plugin_id}",
                "repository": "https://github.com/vastsa/pi-desktop-plugins",
                "readmeMarkdown": readme.read_text(encoding="utf-8") if readme.exists() else None,
                "safetyNotes": manifest.get("safetyNotes"),
                "versions": [
                    {
                        "version": version,
                        "publishedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "changelog": manifest.get("changelog") or f"Release {version}",
                        "minPiDesktop": (manifest.get("engines") or {}).get("piDesktop", ">=0.2.0"),
                        "shasum": sha256(package),
                        "url": f"packages/{package.name}",
                        "sizeBytes": package.stat().st_size,
                        "permissions": manifest.get("permissions") or [],
                        "fs": manifest.get("fs") or {},
                    }
                ],
            }
        )

    catalog = {
        "schemaVersion": 1,
        "providerId": "official",
        "name": "PI-Desktop Official Plugins",
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "homepage": "https://github.com/vastsa/pi-desktop-plugins",
        "plugins": plugins,
    }
    out = ROOT / "catalog.json"
    out.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(plugins)} plugins)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
