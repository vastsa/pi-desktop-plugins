/**
 * Spawn osv-scanner and return a normalized finding list.
 *
 * Containment model (review F4, #20): the plugin never lets the spawned
 * binary touch the workspace. Manifest files are read through the host fs
 * gateway (`pi.fs.readText`, declared `fs.read` with a root-manifest scope),
 * staged as sanitized copies inside a throwaway temp directory, and
 * osv-scanner only ever scans that directory. The binary itself makes the
 * network calls to the OSV database (declared High-risk capability); the
 * plugin process makes none.
 *
 * Behaviors:
 *   - binary missing → { ok:false, reason:'binary_missing' } (no throw)
 *   - non-zero exit with empty body → { ok:false, reason:'non_zero_exit' }
 *   - JSON parse failure → { ok:false, reason:'parse_error' }
 *   - success → { ok:true, findings, errors, took_ms }
 *
 * osv-scanner exit codes follow the upstream contract: 0 = no vulns found,
 * 1 = vulns found (stdout still carries the JSON report), other = failure.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse, filterSeverity } = require('./parser.js');

const DEFAULT_TIMEOUT_MS = 120_000;

const KNOWN_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
];

/**
 * Resolve a user-configured scanner binary: absolute path first, then a PATH
 * lookup. The PATH probe uses `where` on Windows and `which` elsewhere
 * (review F6) — no shell is involved on either platform.
 *
 * Every PATH hit is exec-probed (`--version`) and the first one that actually
 * runs wins: a truncated or quarantined download earlier on the PATH would
 * otherwise make spawn throw EBADMSG on every scan (#20 follow-up).
 */
async function resolveBinary(scannerPath) {
  const name = (scannerPath || 'osv-scanner').trim() || 'osv-scanner';
  if (path.isAbsolute(name)) {
    try {
      await fs.promises.access(name, fs.constants.X_OK);
      return (await execProbe(name)) ? name : null;
    } catch {
      return null;
    }
  }
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const hits = await new Promise((resolve) => {
    const child = spawn(probe, ['-a', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      resolve(code === 0 ? out.trim().split('\n').filter(Boolean) : []);
    });
  });
  for (const candidate of hits) {
    if (await execProbe(candidate)) return candidate;
  }
  return null;
}

/** Spawn `--version` just to prove the binary executes; resolve true/false. */
function execProbe(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      // The process launched — that is all we need to know. Kill it; the
      // real invocation happens in spawnScanner.
      try { child.kill(); } catch { /* ignore */ }
      resolve(true);
    });
  });
}

/**
 * Resolve the workspace-relative manifest names against the host fs gateway
 * (review F3/F4): nothing on disk is read outside the declared `fs.read`
 * scope. Returns `[{ name, content }]` for every manifest that exists.
 */
async function pickManifests(fsGateway, workspaceRoot, wanted) {
  const candidates = (wanted && wanted.length ? wanted : KNOWN_MANIFESTS).filter(Boolean);
  const picked = [];
  for (const name of candidates) {
    try {
      const content = await fsGateway.readText(path.join(workspaceRoot, name));
      if (typeof content === 'string' && content.length > 0) {
        picked.push({ name, content });
      }
    } catch {
      // outside the declared fs.read scope or missing — skip
    }
  }
  return picked;
}

/**
 * Pure builder so tests can assert the exact CLI contract without spawning.
 * osv-scanner v2: `scan source --format json --recursive <dir>` — recursive
 * so manifests nested inside the staged tree are still picked up.
 */
function buildScanArgs(stageDir) {
  return ['scan', 'source', '--format', 'json', '--recursive', stageDir];
}

function spawnScanner(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // A corrupt download earlier on the PATH can make spawn itself throw
      // (EBADMSG on macOS). surface it as a clean failure, never a crash.
      resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}`, took_ms: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, took_ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr, took_ms: Date.now() - started, killed });
    });
  });
}

/**
 * @param {object} opts
 * @param {object} opts.fsGateway          host fs gateway (`pi.fs`); all
 *                                         workspace reads go through it
 * @param {string} opts.workspaceRoot      absolute path to scan
 * @param {string} [opts.scannerPath]      'osv-scanner' or absolute path
 * @param {string[]} [opts.manifests]      manifest filenames to restrict to
 * @param {string} [opts.severityMin]      low|medium|high|critical
 * @param {number} [opts.timeoutMs]
 */
async function audit(opts) {
  const { fsGateway, workspaceRoot, scannerPath = 'osv-scanner', manifests, severityMin, timeoutMs } = opts || {};
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    return {
      ok: false,
      reason: 'invalid_workspace_root',
      message: 'workspaceRoot must be an absolute path — is a project open?',
    };
  }
  if (!fsGateway || typeof fsGateway.readText !== 'function') {
    return { ok: false, reason: 'no_fs_gateway', message: 'host fs gateway unavailable' };
  }

  const bin = await resolveBinary(scannerPath);
  if (!bin) {
    return {
      ok: false,
      reason: 'binary_missing',
      message:
        `Could not find the osv-scanner binary ("${scannerPath}"). Install one of:\n` +
        '  - brew install osv-scanner\n' +
        '  - go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest\n' +
        '  - download from https://github.com/google/osv-scanner/releases',
    };
  }

  const picked = await pickManifests(fsGateway, workspaceRoot, manifests);
  if (picked.length === 0) {
    return {
      ok: true,
      findings: [],
      errors: [],
      manifest_count: 0,
      message: 'No supported manifest files found under the workspace root.',
    };
  }

  const stageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deps-audit-'));
  try {
    for (const entry of picked) {
      await fs.promises.writeFile(path.join(stageDir, entry.name), entry.content, { encoding: 'utf8' });
    }
    const result = await spawnScanner(bin, buildScanArgs(stageDir), timeoutMs);
    if (result.killed) {
      return { ok: false, reason: 'timeout', message: `osv-scanner exceeded ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`, stderr: result.stderr };
    }
    if (result.code !== 0 && !result.stdout.trim()) {
      return {
        ok: false,
        reason: 'non_zero_exit',
        message: `osv-scanner exited with code ${result.code}`,
        stderr: result.stderr,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      return { ok: false, reason: 'parse_error', message: e.message, stderr: result.stderr };
    }

    const { findings, errors } = parse(parsed);
    const filtered = filterSeverity(findings, severityMin);
    return {
      ok: true,
      findings: filtered,
      errors,
      manifest_count: picked.length,
      binary: bin,
      took_ms: result.took_ms,
    };
  } finally {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
  }
}

module.exports = { audit, buildScanArgs, resolveBinary, pickManifests, DEFAULT_TIMEOUT_MS };
