#!/usr/bin/env python3
"""Mirror plugins.aiuo.net catalog + artifacts into this GitHub repo.

The GitHub raw tree remains PI-Desktop's fallback market source. Relative
package URLs resolve against this catalog's directory, so a client that loaded
catalog.json from GitHub never follows artifactBaseUrl back to a down origin.

Failure is fail-closed: exit non-zero and do not replace catalog.json or
packages/. Empty or shrinking-to-zero catalogs are rejected.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_SOURCE = "https://plugins.aiuo.net/catalog.json"
UA = "pi-desktop-plugins-mirror/1.0"
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
CATALOG_TIMEOUT = 30
PACKAGE_TIMEOUT = 120

VOLATILE_KEYS = ("catalogId", "generatedAt", "updatedAt")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, timeout: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if getattr(resp, "status", 200) >= 400:
            raise RuntimeError(f"{url} -> HTTP {resp.status}")
        return resp.read()


def validate_catalog(catalog: dict[str, Any]) -> None:
    if not isinstance(catalog, dict):
        raise SystemExit("catalog is not an object")
    if catalog.get("providerId") != "official":
        raise SystemExit(f"unexpected providerId {catalog.get('providerId')!r}")
    plugins = catalog.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        raise SystemExit("catalog has no plugins; refusing to overwrite the mirror")
    for p in plugins:
        if not isinstance(p, dict) or not p.get("id"):
            raise SystemExit("plugin missing id")
        versions = p.get("versions")
        if not isinstance(versions, list) or not versions:
            raise SystemExit(f"{p.get('id')} has no versions")
        for v in versions:
            if not isinstance(v, dict) or not v.get("version"):
                raise SystemExit(f"{p.get('id')} has a version without version")
            if not v.get("shasum"):
                raise SystemExit(f"{p.get('id')}@{v.get('version')} missing shasum")


def package_name(plugin_id: str, version: str) -> str:
    return f"{plugin_id}-{version}.piplug"


def resolve_download_url(catalog: dict[str, Any], rel: str) -> str:
    rel = (rel or "").strip()
    if rel.startswith("http://") or rel.startswith("https://"):
        return rel
    base = (catalog.get("artifactBaseUrl") or catalog.get("artifactBaseURL") or "").strip()
    if not base:
        raise SystemExit(f"relative package url {rel!r} but catalog has no artifactBaseUrl")
    if not base.endswith("/"):
        base += "/"
    return base + rel.lstrip("/")


def rewrite_for_mirror(src: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(src)
    out.pop("artifactBaseUrl", None)
    out.pop("artifactBaseURL", None)
    for p in out.get("plugins") or []:
        pid = p.get("id")
        for v in p.get("versions") or []:
            v["url"] = f"packages/{package_name(pid, v['version'])}"
    return out


def canonical(catalog: dict[str, Any]) -> str:
    stripped = copy.deepcopy(catalog)
    for k in VOLATILE_KEYS:
        stripped.pop(k, None)
    return json.dumps(stripped, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def plan_downloads(src: dict[str, Any]) -> list[dict[str, Any]]:
    items = []
    for p in src.get("plugins") or []:
        pid = p["id"]
        for v in p.get("versions") or []:
            items.append(
                {
                    "id": pid,
                    "version": v["version"],
                    "shasum": str(v.get("shasum") or "").lower(),
                    "yanked": bool(v.get("yanked")),
                    "url": v.get("url") or "",
                    "name": package_name(pid, v["version"]),
                }
            )
    return items


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def sync(root: Path, source: str, dry_run: bool) -> int:
    raw = fetch(source, CATALOG_TIMEOUT)
    try:
        src = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"catalog is not JSON: {e}") from e
    validate_catalog(src)

    mirrored = rewrite_for_mirror(src)
    validate_catalog(mirrored)

    existing = load_json(root / "catalog.json")
    if existing and canonical(existing) == canonical(mirrored):
        print("catalog unchanged (ignoring generatedAt/catalogId/updatedAt)")
        return 0

    packages_dir = root / "packages"
    wanted = plan_downloads(src)
    staging = Path(tempfile.mkdtemp(prefix="pi-mirror-"))
    staged_packages = staging / "packages"
    staged_packages.mkdir()

    try:
        for item in wanted:
            dest = staged_packages / item["name"]
            local = packages_dir / item["name"]
            if local.exists() and sha256_file(local).lower() == item["shasum"]:
                shutil.copy2(local, dest)
                print(f"keep {item['name']}")
                continue
            if item["yanked"]:
                print(f"skip yanked {item['id']}@{item['version']} (no matching local package)")
                continue
            url = resolve_download_url(src, item["url"])
            print(f"get {item['id']}@{item['version']} {url}")
            blob = fetch(url, PACKAGE_TIMEOUT)
            if len(blob) > MAX_PACKAGE_BYTES:
                raise SystemExit(f"{item['name']} exceeds 50MB")
            got = sha256_bytes(blob)
            if got != item["shasum"]:
                raise SystemExit(f"sha256 mismatch {item['name']}: got {got} want {item['shasum']}")
            dest.write_bytes(blob)

        missing = [
            f"{i['id']}@{i['version']}"
            for i in wanted
            if not i["yanked"] and not (staged_packages / i["name"]).exists()
        ]
        if missing:
            raise SystemExit("missing packages: " + ", ".join(missing))

        if dry_run:
            print(f"would write catalog with {len(mirrored['plugins'])} plugins, {len(list(staged_packages.iterdir()))} packages")
            return 0

        catalog_tmp = root / "catalog.json.tmp"
        catalog_tmp.write_text(json.dumps(mirrored, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        packages_tmp = root / "packages.tmp"
        if packages_tmp.exists():
            shutil.rmtree(packages_tmp)
        shutil.copytree(staged_packages, packages_tmp)
        os.replace(catalog_tmp, root / "catalog.json")
        old = root / "packages.old"
        if old.exists():
            shutil.rmtree(old)
        if packages_dir.exists():
            packages_dir.rename(old)
        packages_tmp.rename(packages_dir)
        if old.exists():
            shutil.rmtree(old)

        sig_url = source.rstrip("/") + ".sig"
        try:
            sig = fetch(sig_url, CATALOG_TIMEOUT)
            (root / "catalog.json.sig").write_bytes(sig)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, RuntimeError) as e:
            print(f"catalog.json.sig skipped: {e}")

        print(f"synced {len(mirrored['plugins'])} plugins")
        return 0
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=os.environ.get("PI_PLUGIN_CATALOG_URL", DEFAULT_SOURCE))
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        return sync(Path(args.root), args.source, args.dry_run)
    except urllib.error.HTTPError as e:
        print(f"fetch failed: HTTP {e.code} {e.reason} {e.geturl()}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"fetch failed: {e}", file=sys.stderr)
        return 1
    except SystemExit:
        raise
    except Exception as e:
        print(f"sync failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
