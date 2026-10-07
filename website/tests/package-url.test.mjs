import assert from "node:assert/strict";
import test from "node:test";
import { resolvePackageUrl } from "../lib/package-url.ts";

const catalogUrl = "https://plugins.aiuo.net/catalog.json";
const mirrorBase = "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main";
const packagePath = "packages/pi.gitlens-0.2.7.piplug";

test("relative downloads use the declared artifact base on another host", () => {
  for (const base of [mirrorBase, `${mirrorBase}/`]) {
    assert.equal(resolvePackageUrl(packagePath, catalogUrl, base), `${mirrorBase}/${packagePath}`);
  }
});

test("a leading slash in a package path still uses the artifact directory", () => {
  assert.equal(resolvePackageUrl(`/${packagePath}`, catalogUrl, mirrorBase), `${mirrorBase}/${packagePath}`);
});

test("absolute package URLs keep their own origin and query string", () => {
  for (const url of ["https://cdn.example/plugin.piplug?version=1", "http://localhost/plugin.piplug"]) {
    assert.equal(resolvePackageUrl(url, catalogUrl, mirrorBase), url);
  }
});

test("catalogs without an artifact base resolve relative to the catalog", () => {
  for (const base of [undefined, "", "   "]) {
    assert.equal(
      resolvePackageUrl(packagePath, "https://mirror.example/catalogs/catalog.json", base),
      `https://mirror.example/catalogs/${packagePath}`,
    );
  }
});
