/**
 * Spawn osv-scanner and return a normalized finding list.
 *
 * The plugin process (utilityProcess) has its own stdio; we use
 * `child_process.spawn` to invoke the user's locally installed osv-scanner
 * binary. The plugin itself makes no network calls — osv-scanner fetches
 * the OSV database on its own.
 *
 * Behaviors:
 *   - binary missing → returns { ok:false, reason:'binary_missing' } (no throw)
 *   - non-zero exit with empty body → returns { ok:false, reason:'non_zero_exit' }
 *   - JSON parse failure → returns { ok:false, reason:'parse_error' }
 *   - success → { ok:true, findings, errors, took_ms }
 *
 * Manifest files to scan: we hand osv-scanner each known manifest under the
 * workspace root. The user can narrow via `manifests` (called by the agent
 * tool with a manifest-type allowlist).
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
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

/** Resolve a binary: try absolute, then PATH (which `which` does for us). */
async function resolveBinary(scannerPath) {
  const name = (scannerPath || 'osv-scanner').trim() || 'osv-scanner';
  if (path.isAbsolute(name)) {
    try {
      await fs.promises.access(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const probe = spawn('which', [name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    probe.stdout.on('data', (b) => (out += b.toString()));
    probe.on('error', () => resolve(null));
    probe.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim().split('\n')[0]);
      else resolve(null);
    });
  });
}

function pickManifests(workspaceRoot, wanted) {
  // wanted: array of manifest filenames (e.g. ["package.json", "requirements.txt"])
  // empty → all known manifests that exist under the root (one level deep is enough)
  const candidates = (wanted && wanted.length ? wanted : KNOWN_MANIFESTS).filter(Boolean);
  const present = [];
  for (const name of candidates) {
    const full = path.join(workspaceRoot, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) present.push(full);
    } catch {
      // missing — skip
    }
  }
  return present;
}

function spawnScanner(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
 * @param {string} opts.workspaceRoot   absolute path to scan
 * @param {string} [opts.scannerPath]   'osv-scanner' or absolute path
 * @param {string[]} [opts.manifests]   manifest filenames to restrict to
 * @param {string} [opts.severityMin]   low|medium|high|critical
 * @param {number} [opts.timeoutMs]
 */
async function audit(opts) {
  const { workspaceRoot, scannerPath = 'osv-scanner', manifests, severityMin, timeoutMs } = opts || {};
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    return { ok: false, reason: 'invalid_workspace_root', message: 'workspaceRoot must be an absolute path' };
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

  const files = pickManifests(workspaceRoot, manifests);
  if (files.length === 0) {
    return {
      ok: true,
      findings: [],
      errors: [],
      manifest_count: 0,
      message: 'No supported manifest files found under the workspace root.',
    };
  }

  // osv-scanner v2:  osv-scanner scan source -L <file> --format json
  // Older:           osv-scanner --lockfile=<file> --format json
  // We pass multiple -L to cover each manifest.
  const args = ['scan', 'source'];
  for (const f of files) args.push('-L', f);
  args.push('--format', 'json');

  const result = await spawnScanner(bin, args, timeoutMs);
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
    manifest_count: files.length,
    binary: bin,
    took_ms: result.took_ms,
  };
}

module.exports = { audit, resolveBinary, pickManifests, DEFAULT_TIMEOUT_MS };
