/**
 * Lifecycle contract tests (review F1/F3/F5, #20).
 *
 * The host builds `globalThis.pi` and then calls `pluginModule.onLoad()` with
 * no argument — these tests pin that contract: nothing registers without the
 * global, and everything registers through it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const plugin = require(join(here, '../main.js'));

function mockHost({ workspacePath = '/ws', settings = {}, failWorkspace = false } = {}) {
  const registered = { commands: [], tools: [] };
  const clipboardWrites = [];
  const pi = {
    commands: {
      register: async (rec) => registered.commands.push(rec),
      unregister: async (id) => {
        const i = registered.commands.findIndex((c) => c.id === id);
        if (i >= 0) registered.commands.splice(i, 1);
      },
    },
    agent: {
      registerTool: (tool) => registered.tools.push(tool),
      unregisterTool: async (name) => {
        const i = registered.tools.findIndex((t) => t.name === name);
        if (i >= 0) registered.tools.splice(i, 1);
      },
    },
    workspace: {
      get: async () => {
        if (failWorkspace) throw new Error('no project open');
        return { path: workspacePath };
      },
    },
    plugin: { getSettings: async () => settings },
    fs: {
      readText: async (p) => {
        if (p.endsWith('package.json')) return '{"name":"x","dependencies":{"lodash":"4.17.20"}}';
        throw new Error('missing: ' + p);
      },
    },
    ui: { openPanel: async () => {}, showToast: async () => {} },
    clipboard: {
      writeText: async (text) => clipboardWrites.push(text),
    },
  };
  return { pi, registered, clipboardWrites };
}

test('onLoad registers commands and the agent tool through the global host API', async () => {
  const host = mockHost();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    assert.equal(host.registered.commands.length, 2, 'both commands registered');
    assert.deepEqual(
      host.registered.commands.map((c) => c.id).sort(),
      ['deps-audit.open', 'deps-audit.run'],
    );
    assert.equal(host.registered.tools.length, 1);
    assert.equal(host.registered.tools[0].name, 'deps_audit_run');
    // Review F4: the tool spawns a native binary that reaches the network —
    // it must never be presented as low-risk again.
    assert.equal(host.registered.tools[0].risk, 'high');
  } finally {
    delete globalThis.pi;
  }
});

test('onLoad without a host API is a no-op, not a crash (old bug: pi param was undefined)', async () => {
  const saved = globalThis.pi;
  delete globalThis.pi;
  try {
    await plugin.onLoad(); // the old code returned here and registered nothing
    await plugin.onUnload();
  } finally {
    if (saved !== undefined) globalThis.pi = saved;
  }
});

test('onUnload unregisters through the same global API', async () => {
  const host = mockHost();
  globalThis.pi = host.pi;
  try {
    await plugin.onLoad();
    assert.equal(host.registered.commands.length, 2);
    await plugin.onUnload();
    assert.equal(host.registered.commands.length, 0);
    assert.equal(host.registered.tools.length, 0);
  } finally {
    delete globalThis.pi;
  }
});

test('panel refresh resolves the workspace and settings through the host API (F3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-audit-panel-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  const fixture = join(here, 'fixtures', 'osv-v2.json');
  const stub = join(stubDir, 'osv-scanner');
  const argvFile = join(stubDir, 'argv.txt');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\ncat "${fixture}"\n`, { mode: 0o755 });

  const host = mockHost({
    workspacePath: dir,
    settings: { scannerPath: stub, severityMin: 'low' },
  });
  host.pi.fs.readText = async (p) => {
    if (p === join(dir, 'package.json')) return '{"name":"x","dependencies":{"lodash":"4.17.20"}}';
    throw new Error('missing: ' + p);
  };
  globalThis.pi = host.pi;
  try {
    const r = await plugin.onPanelInvoke('deps-audit.refresh', {});
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.ok(r.findings.length >= 1);
    assert.equal(r.manifest_count, 1);
    // Settings flowed through: the scannerPath setting reached the spawn.
    const argv = require('node:fs').readFileSync(argvFile, 'utf8');
    assert.ok(argv.length > 0);
  } finally {
    delete globalThis.pi;
    rmSync(dir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('panel refresh without an open workspace reports invalid_workspace_root (F3)', async () => {
  const host = mockHost({ failWorkspace: true });
  globalThis.pi = host.pi;
  try {
    const r = await plugin.onPanelInvoke('deps-audit.refresh', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_workspace_root');
    assert.match(r.message, /project open/);
  } finally {
    delete globalThis.pi;
  }
});

test('copy channel goes through the host clipboard bridge (F5)', async () => {
  const host = mockHost();
  globalThis.pi = host.pi;
  try {
    const r = await plugin.onPanelInvoke('deps-audit.copy', { text: 'fix request text' });
    assert.equal(r.ok, true);
    assert.deepEqual(host.clipboardWrites, ['fix request text']);

    const empty = await plugin.onPanelInvoke('deps-audit.copy', { text: '' });
    assert.equal(empty.ok, false);
    assert.deepEqual(host.clipboardWrites, ['fix request text']);
  } finally {
    delete globalThis.pi;
  }
});
