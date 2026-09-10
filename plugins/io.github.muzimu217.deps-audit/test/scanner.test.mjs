import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, resolveBinary, pickManifests } from '../lib/scanner.js';

const here = dirname(fileURLToPath(import.meta.url));

function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'deps-audit-test-'));
  return dir;
}

test('resolveBinary returns null for a missing absolute path', async () => {
  const r = await resolveBinary('/this/path/does/not/exist/osv-scanner');
  assert.equal(r, null);
});

test('resolveBinary returns null for a name not on PATH', async () => {
  const r = await resolveBinary('definitely-not-osv-scanner-xyz');
  assert.equal(r, null);
});

test('audit rejects non-absolute workspace root', async () => {
  const r = await audit({ workspaceRoot: 'relative/path' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_workspace_root');
});

test('audit returns binary_missing with a helpful message when scanner absent', async () => {
  const ws = freshWorkspace();
  try {
    const r = await audit({
      workspaceRoot: ws,
      scannerPath: 'definitely-not-osv-scanner-xyz',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'binary_missing');
    assert.ok(r.message.includes('brew install osv-scanner'), 'should hint at brew');
    assert.ok(r.message.includes('go install'), 'should hint at go install');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('audit returns empty when no manifests are present', async () => {
  const ws = freshWorkspace();
  try {
    const r = await audit({
      workspaceRoot: ws,
      scannerPath: 'osv-scanner', // may not exist; but we never reach spawn
      // Provide a custom scannerPath that does exist on PATH so we don't bail early.
    });
    // If osv-scanner is not on the system the binary_missing path fires first.
    if (r.reason === 'binary_missing') return;
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 0);
    assert.match(r.message, /No supported manifest files/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('pickManifests returns only the ones that exist', () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws, 'package.json'), '{"name":"x","dependencies":{"lodash":"4.17.20"}}');
    writeFileSync(join(ws, 'requirements.txt'), 'django==2.0.0\n');
    // go.mod is missing
    const got = pickManifests(ws, ['package.json', 'requirements.txt', 'go.mod']);
    assert.equal(got.length, 2);
    assert.ok(got.every((p) => existsSync(p)));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('pickManifests with no argument scans all known manifests', () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws, 'Cargo.toml'), '[package]\nname="x"\n');
    const got = pickManifests(ws);
    assert.equal(got.length, 1);
    assert.ok(got[0].endsWith('Cargo.toml'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('pickManifests ignores directories (only files)', () => {
  const ws = freshWorkspace();
  try {
    mkdirSync(join(ws, 'package.json'), { recursive: true }); // a dir, not a file
    const got = pickManifests(ws, ['package.json']);
    assert.equal(got.length, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/**
 * End-to-end with a stub binary. We only do this when a real osv-scanner is
 * not available (CI / dev without the binary), so the suite still proves the
 * spawn-and-parse path works.
 */
test('audit spawns a stub binary and parses its output', async (t) => {
  // Skip if real osv-scanner happens to be present; this test isolates the
  // spawn path with deterministic input.
  const real = await resolveBinary('osv-scanner');
  if (real) {
    t.skip('real osv-scanner present; spawn path is exercised by hand');
    return;
  }

  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(stubDir, 'osv-scanner');
  const fixture = join(here, 'fixtures', 'osv-v2.json');
  // shell script that prints the fixture and exits 0
  writeFileSync(stub, `#!/bin/sh\ncat "${fixture}"\n`, { mode: 0o755 });

  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws, 'package.json'), '{}');
    const r = await audit({ workspaceRoot: ws, scannerPath: stub });
    assert.equal(r.ok, true);
    assert.ok(r.findings.length >= 1, 'should have parsed at least one finding');
    assert.equal(r.manifest_count, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('audit returns parse_error when scanner output is not JSON', async (t) => {
  const real = await resolveBinary('osv-scanner');
  if (real) {
    t.skip('real osv-scanner present');
    return;
  }
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(stubDir, 'osv-scanner');
  writeFileSync(stub, '#!/bin/sh\necho "this is not json"\nexit 0\n', { mode: 0o755 });
  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws, 'package.json'), '{}');
    const r = await audit({ workspaceRoot: ws, scannerPath: stub });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'parse_error');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('audit returns non_zero_exit when scanner exits non-zero with no stdout', async (t) => {
  const real = await resolveBinary('osv-scanner');
  if (real) {
    t.skip('real osv-scanner present');
    return;
  }
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(stubDir, 'osv-scanner');
  writeFileSync(stub, '#!/bin/sh\necho "boom" 1>&2\nexit 2\n', { mode: 0o755 });
  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws, 'package.json'), '{}');
    const r = await audit({ workspaceRoot: ws, scannerPath: stub });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'non_zero_exit');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});
