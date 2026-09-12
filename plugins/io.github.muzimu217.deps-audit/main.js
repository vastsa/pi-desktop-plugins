/**
 * Deps Audit — plugin entry.
 *
 * Host contract (plugin-host-process.mjs): the host builds the API as
 * `globalThis.pi` and then calls `pluginModule.onLoad()` with no argument —
 * the API is never passed as a parameter (review F1, #20). Everything that
 * needs the API reads `globalThis.pi`.
 *
 * Communication model (per PI-Desktop plugin SDK):
 *   - view → main:  `window.pluginBridge.invoke(channel, payload)` is
 *     forwarded to `onPanelInvoke(channel, payload)` (module export).
 *   - main → view:  no push channel. The view pulls state via `invoke()`.
 *
 * Agent tool is registered in `onLoad` via `pi.agent.registerTool`.
 */
'use strict';

const { audit } = require('./lib/scanner.js');

const SCAN_TIMEOUT_MS = 120_000;

/** The host API, or null outside the plugin host process (e.g. unit tests). */
function hostApi() {
  return globalThis.pi || null;
}

async function workspaceRoot(pi) {
  if (pi && pi.workspace && typeof pi.workspace.get === 'function') {
    try {
      const w = await pi.workspace.get();
      if (w && w.path) return w.path;
    } catch { /* fall through */ }
  }
  // Review F3: never fall back to process.cwd() — the plugin process cwd is
  // not the user's project. No workspace means nothing to audit.
  return null;
}

async function readSettings(pi) {
  if (pi && pi.plugin && typeof pi.plugin.getSettings === 'function') {
    try { return (await pi.plugin.getSettings()) || {}; } catch { return {}; }
  }
  return {};
}

async function runAudit(pi, opts) {
  opts = opts || {};
  const root = await workspaceRoot(pi);
  const settings = await readSettings(pi);
  return audit({
    fsGateway: pi && pi.fs,
    workspaceRoot: root,
    scannerPath: opts.scannerPath || settings.scannerPath || 'osv-scanner',
    manifests: opts.manifests,
    severityMin: opts.severityMin || settings.severityMin || 'low',
    timeoutMs: SCAN_TIMEOUT_MS,
  });
}

async function onLoad() {
  const pi = hostApi();
  if (!pi) return;

  if (pi.commands && typeof pi.commands.register === 'function') {
    await pi.commands.register({
      id: 'deps-audit.open',
      title: 'Deps Audit: Open Work-Panel View',
      keywords: ['deps', 'audit', 'vuln', 'osv', '依赖', '漏洞', '扫描'],
      category: 'Security',
      run: async () => {
        if (pi.ui && typeof pi.ui.openPanel === 'function') {
          await pi.ui.openPanel({ title: '依赖审计 / Deps Audit' });
        }
      },
    });
    await pi.commands.register({
      id: 'deps-audit.run',
      title: 'Deps Audit: Scan Workspace Now',
      keywords: ['scan', 'audit', 'vuln', '扫描', '依赖'],
      category: 'Security',
      run: async () => {
        if (pi.ui && typeof pi.ui.openPanel === 'function') {
          await pi.ui.openPanel({ title: '依赖审计 / Deps Audit' });
        }
        const result = await runAudit(pi, {});
        if (pi.ui && typeof pi.ui.showToast === 'function') {
          if (result.ok) {
            await pi.ui.showToast(
              `扫描完成：${result.findings ? result.findings.length : 0} 个漏洞 / ${result.manifest_count || 0} 个 manifest`,
              result.findings && result.findings.length > 0 ? 'warn' : 'info',
            );
          } else if (result.reason === 'binary_missing') {
            await pi.ui.showToast('未找到 osv-scanner，请安装后再试（详见依赖审计视图）', 'error');
          } else if (result.reason === 'invalid_workspace_root') {
            await pi.ui.showToast('请先打开一个项目再运行依赖扫描', 'error');
          } else {
            await pi.ui.showToast(`依赖扫描失败：${result.reason || 'unknown'}`, 'error');
          }
        }
      },
    });
  }

  if (pi.agent && typeof pi.agent.registerTool === 'function') {
    pi.agent.registerTool({
      name: 'deps_audit_run',
      description:
        'Run an OSV-Scanner audit on the workspace dependency manifests. Returns a structured vulnerability list. The Agent must summarize and propose; the user applies any fix.',
      // Spawns the local osv-scanner binary (native execution) which contacts
      // the OSV database over the network: High-risk per SECURITY.md (#20).
      risk: 'high',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          manifests: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
                'pom.xml', 'composer.json', 'Gemfile', 'pyproject.toml',
              ],
            },
          },
          severity_min: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
          },
        },
      },
      execute: async (args) => {
        const result = await runAudit(pi, args || {});
        if (result.ok && result.findings && result.findings.length > 200) {
          result.truncated = true;
          result.findings = result.findings.slice(0, 200);
        }
        return result;
      },
    });
  }
}

async function onUnload() {
  const pi = hostApi();
  if (!pi) return;
  if (pi.commands && typeof pi.commands.unregister === 'function') {
    try { await pi.commands.unregister('deps-audit.open'); } catch { /* ignore */ }
    try { await pi.commands.unregister('deps-audit.run'); } catch { /* ignore */ }
  }
  if (pi.agent && typeof pi.agent.unregisterTool === 'function') {
    try { await pi.agent.unregisterTool('deps_audit_run'); } catch { /* ignore */ }
  }
}

async function onPanelInvoke(channel, payload) {
  // The host builds `globalThis.pi` before any parent call reaches this
  // module, so panel invokes resolve the workspace and settings through the
  // live API instead of falling back to the plugin process cwd (review F3).
  const pi = hostApi();
  switch (channel) {
    case 'deps-audit.refresh': {
      const result = await runAudit(pi, payload || {});
      if (result.ok && result.findings && result.findings.length > 200) {
        result.truncated = true;
        result.findings = result.findings.slice(0, 200);
      }
      return result;
    }

    case 'deps-audit.capabilities': {
      return {
        needsOsvScanner: true,
        apiVersion: 1,
      };
    }

    case 'deps-audit.copy': {
      // Review F5: the panel never touches navigator.clipboard. Copying goes
      // through the host clipboard bridge under the declared `clipboard.write`
      // permission.
      const text = payload && typeof payload.text === 'string' ? payload.text : '';
      if (!text) return { ok: false, message: 'missing text' };
      if (!pi || !pi.clipboard || typeof pi.clipboard.writeText !== 'function') {
        return { ok: false, message: 'clipboard bridge unavailable' };
      }
      try {
        await pi.clipboard.writeText(text);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
    }

    case 'deps-audit.fix-request': {
      const f = payload && payload.finding;
      if (!f) return { ok: false, message: 'missing finding' };
      // The view side appends this text to the conversation; the Agent then
      // summarizes and proposes a fix (no auto-apply).
      return {
        ok: true,
        text: [
          `The user selected a known dependency vulnerability and asked you to propose a fix.`,
          `Read-only summary; do not run the upgrade or modify any file without explicit confirmation.`,
          ``,
          `package: ${f.ecosystem} ${f.package}@${f.installed}`,
          `vulnerability: ${f.id}` + (f.aliases && f.aliases.length ? ` (${f.aliases.join(', ')})` : ''),
          `severity: ${f.severity || 'unknown'}`,
          `summary: ${f.summary || '(no summary)'}`,
          f.fixed && f.fixed.length ? `known fixed versions: ${f.fixed.join(', ')}` : 'no known fix yet',
          f.references && f.references[0] ? `advisory: ${f.references[0].url}` : '',
          ``,
          `First, briefly state the risk in one sentence. Then, if the user confirms, propose the smallest possible upgrade (e.g. \`npm install ${f.package}@<fixed>\` or the matching change in the right manifest) and apply it.`,
        ].filter(Boolean).join('\n'),
      };
    }

    default:
      return { ok: false, message: `unknown channel ${channel}` };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
