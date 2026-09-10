/**
 * Deps Audit — plugin entry.
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

async function workspaceRoot(pi) {
  if (pi && pi.workspace && typeof pi.workspace.get === 'function') {
    try {
      const w = await pi.workspace.get();
      if (w && w.path) return w.path;
    } catch { /* fall through */ }
  }
  return process.cwd();
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
    workspaceRoot: root,
    scannerPath: opts.scannerPath || settings.scannerPath || 'osv-scanner',
    manifests: opts.manifests,
    severityMin: opts.severityMin || settings.severityMin || 'low',
    timeoutMs: SCAN_TIMEOUT_MS,
  });
}

async function onLoad(pi) {
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
      risk: 'low',
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

async function onUnload(pi) {
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
  switch (channel) {
    case 'deps-audit.refresh': {
      // view calls this with no payload (settings are read inside runAudit)
      const result = await runAudit(null, payload || {});
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
