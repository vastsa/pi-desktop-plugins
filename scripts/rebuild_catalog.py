#!/usr/bin/env python3
"""Rebuild catalog.json from plugins/*/manifest.json + packages/*.piplug.

Plugins in UNPUBLISHED_PLUGIN_IDS stay in plugins/ but are omitted from the
marketplace catalog (delisted).
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
PACKAGES = ROOT / "packages"

# Present in plugins/ but not listed in catalog.json.
UNPUBLISHED_PLUGIN_IDS = frozenset({
    "com.vastsa.voice-assistant",
})


def catalog_author(value) -> str:
    """Marketplace catalog author is a string (PI-Desktop MarketCatalogEntry)."""
    if isinstance(value, dict):
        name = str(value.get("name") or "").strip()
        return name or "PI-Desktop"
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "PI-Desktop"



def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def main() -> int:
    out = ROOT / "catalog.json"
    existing_catalog = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    existing_published_at = {}
    for plugin in existing_catalog.get("plugins", []):
        if not isinstance(plugin, dict):
            continue
        versions = plugin.get("versions", [])
        if not isinstance(versions, list):
            continue
        for version_entry in versions:
            if not isinstance(version_entry, dict):
                continue
            published_at = version_entry.get("publishedAt")
            if published_at:
                key = (plugin.get("id"), version_entry.get("version"))
                existing_published_at[key] = published_at
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    plugins = []
    for manifest_path in sorted(PLUGINS.glob("*/manifest.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        plugin_id = manifest["id"]
        if plugin_id in UNPUBLISHED_PLUGIN_IDS:
            continue
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
                "author": catalog_author(manifest.get("author")),
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
                        "publishedAt": existing_published_at.get((plugin_id, version)) or now,
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
        "updatedAt": now,
        "homepage": "https://github.com/vastsa/pi-desktop-plugins",
        "plugins": plugins,
    }
    out.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(plugins)} plugins)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
