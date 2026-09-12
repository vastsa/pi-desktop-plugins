import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, buildScanArgs, resolveBinary, pickManifests } from '../lib/scanner.js';

const here = dirname(fileURLToPath(import.meta.url));

/** In-memory fs gateway stub mirroring `pi.fs.readText` (throws = denied/missing). */
function gateway(files) {
  return {
    readText: async (p) => {
      const hit = files[p];
      if (typeof hit === 'string') return hit;
      throw new Error('PERMISSION_DENIED or missing: ' + p);
    },
  };
}

function freshWorkspace(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-audit-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test('resolveBinary returns null for a missing absolute path', async () => {
  assert.equal(await resolveBinary('/this/path/does/not/exist/osv-scanner'), null);
});

test('resolveBinary returns null for a name not on PATH', async () => {
  assert.equal(await resolveBinary('definitely-not-osv-scanner-xyz'), null);
});

test('buildScanArgs pins the osv-scanner v2 CLI contract', () => {
  const args = buildScanArgs('/tmp/stage-xyz');
  assert.deepEqual(args, ['scan', 'source', '--format', 'json', '--recursive', '/tmp/stage-xyz']);
});

test('audit rejects non-absolute workspace root', async () => {
  const r = await audit({ workspaceRoot: 'relative/path', fsGateway: gateway({}) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_workspace_root');
});

test('audit reports a missing fs gateway instead of reading raw fs', async () => {
  const ws = freshWorkspace({ 'package.json': '{}' });
  try {
    const r = await audit({ workspaceRoot: ws });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_fs_gateway');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('audit returns binary_missing with a helpful message when scanner absent', async () => {
  const ws = freshWorkspace({ 'package.json': '{}' });
  try {
    const r = await audit({
      fsGateway: gateway({ [join(ws, 'package.json')]: '{}' }),
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

test('pickManifests goes through the gateway and skips missing files', async () => {
  const ws = freshWorkspace();
  try {
    const g = gateway({ [join(ws, 'package.json')]: '{"name":"x"}' });
    const got = await pickManifests(g, ws, ['package.json', 'requirements.txt', 'go.mod']);
    assert.equal(got.length, 1);
    assert.equal(got[0].name, 'package.json');
    assert.equal(got[0].content, '{"name":"x"}');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('audit returns empty when no manifests are present behind the gateway', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(dir, 'osv-scanner');
  // Any runnable binary works: the empty-manifest short-circuit fires before
  // the scanner is ever spawned.
  writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ws = freshWorkspace();
  try {
    const r = await audit({ fsGateway: gateway({}), workspaceRoot: ws, scannerPath: stub });
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 0);
    assert.match(r.message, /No supported manifest files/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Stub-binary end-to-end: the stub records the argv it was invoked with and
 * prints the osv-scanner v2 JSON fixture, so the spawn path, the exact CLI
 * contract, and the staging containment are all asserted deterministically.
 */
function stubBinary(fixturePath) {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(dir, 'osv-scanner');
  const argvFile = join(dir, 'argv.txt');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\ncat "${fixturePath}"\n`,
    { mode: 0o755 },
  );
  return { stub, argvFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('audit stages gateway copies and runs the v2 CLI over the stage dir', async () => {
  const fixture = join(here, 'fixtures', 'osv-v2.json');
  const { stub, argvFile, cleanup } = stubBinary(fixture);
  const ws = freshWorkspace({ 'package.json': '{"name":"x","dependencies":{"lodash":"4.17.20"}}' });
  try {
    const r = await audit({
      fsGateway: gateway({ [join(ws, 'package.json')]: '{"name":"x","dependencies":{"lodash":"4.17.20"}}' }),
      workspaceRoot: ws,
      scannerPath: stub,
    });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.ok(r.findings.length >= 1, 'should have parsed at least one finding');
    assert.equal(r.manifest_count, 1);

    const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
    assert.deepEqual(argv.slice(0, 4), ['scan', 'source', '--format', 'json']);
    assert.equal(argv[4], '--recursive');
    const stageDir = argv[5];
    assert.ok(stageDir.startsWith(tmpdir()), 'scanner only ever sees the staged temp dir');
    assert.ok(stageDir.includes('deps-audit-'), 'stage dir belongs to deps-audit');
    // The staged copies (and nothing else of the workspace) are what got scanned.
    assert.ok(!stageDir.includes(ws), 'stage dir is not inside the workspace');
  } finally {
    cleanup();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('audit returns parse_error when scanner output is not JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(dir, 'osv-scanner');
  writeFileSync(stub, '#!/bin/sh\necho "this is not json"\nexit 0\n', { mode: 0o755 });
  const ws = freshWorkspace({ 'package.json': '{}' });
  try {
    const r = await audit({
      fsGateway: gateway({ [join(ws, 'package.json')]: '{}' }),
      workspaceRoot: ws,
      scannerPath: stub,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'parse_error');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit returns non_zero_exit when scanner exits non-zero with no stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(dir, 'osv-scanner');
  writeFileSync(stub, '#!/bin/sh\necho "boom" 1>&2\nexit 2\n', { mode: 0o755 });
  const ws = freshWorkspace({ 'package.json': '{}' });
  try {
    const r = await audit({
      fsGateway: gateway({ [join(ws, 'package.json')]: '{}' }),
      workspaceRoot: ws,
      scannerPath: stub,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'non_zero_exit');
    assert.ok(r.stderr.includes('boom'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit reports timeout when the scanner overruns the budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const stub = join(dir, 'osv-scanner');
  writeFileSync(stub, '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
  const ws = freshWorkspace({ 'package.json': '{}' });
  try {
    const r = await audit({
      fsGateway: gateway({ [join(ws, 'package.json')]: '{}' }),
      workspaceRoot: ws,
      scannerPath: stub,
      timeoutMs: 150,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Real-binary path (skipped when osv-scanner is not installed): proves the
 * staged-copy design produces real OSV findings end to end.
 */
test('real osv-scanner finds the seeded vulnerability through the staged copies', async (t) => {
  const real = await resolveBinary('osv-scanner');
  if (!real) {
    t.skip('osv-scanner not installed');
    return;
  }
  const ws = freshWorkspace({
    'package-lock.json': JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies: { lodash: { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz' } },
    }),
  });
  try {
    const r = await audit({
      fsGateway: gateway({ [join(ws, 'package-lock.json')]: readFileSync(join(ws, 'package-lock.json'), 'utf8') }),
      workspaceRoot: ws,
      scannerPath: 'osv-scanner',
      timeoutMs: 120_000,
    });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    const lodash = r.findings.find((f) => f.package === 'lodash');
    assert.ok(lodash, 'expected a lodash finding from the seeded 4.17.15 lockfile');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
