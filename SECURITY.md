# Plugin security review policy

This repository publishes code that runs inside PI-Desktop with the user's
local privileges. A plugin is not trusted merely because it is listed in this
repository, and a green test run is not proof that a plugin has no backdoor.
Security review is therefore a release gate, not optional documentation.

## Non-negotiable blockers

Reject a plugin or release when any of the following is present, unless the
finding is a confirmed false positive in an audited vendored dependency and the
package is replaced or the dependency is reviewed separately:

- hidden remote access, reverse shells, credential theft, keylogging, or data
  exfiltration;
- downloading code, loading a remote script, runtime installation of a
  dependency, or executing code received from a network or untrusted input;
- obfuscation that prevents a reviewer from understanding the behavior,
  including unexplained encoded payloads or dynamic code execution;
- hard-coded passwords, API keys, private keys, tokens, cookies, or test data
  that could be mistaken for real credentials;
- changing operating-system security controls, persistence, startup tasks,
  services, accounts, permissions, firewalls, disks, or system files without an
  explicit user action and a clearly described confirmation;
- destructive workspace or remote operations without a visible, specific,
  user-confirmed action and a safe failure path;
- bypassing PI-Desktop permission gates, path boundaries, host-key checks,
  approval prompts, output limits, or audit logging;
- behavior that is absent from the manifest, README, safety notes, or review
  description, even if the behavior appears useful.

A reviewer must not waive a blocker because the code is short, the author is
known, or the plugin is marked official.

## Risk tiers

Classify the highest capability in the plugin:

| Tier | Examples | Required review |
| --- | --- | --- |
| Low | UI, local calculations, plugin-private settings | One maintainer plus automated preflight |
| Medium | Reading user-selected files, clipboard, notifications, agent data tools | One maintainer, data-flow review, and tests for boundary failures |
| High | File writes/deletes, network, credentials, native binaries, shells/PTY, SSH, background services, `agent.prompt.inject`, or `desktop.control` | Two independent maintainers, manual source and package review, threat-model notes, and explicit confirmation tests |

The tier is about capability, not intent. A "read-only" plugin that can read
credentials or clipboard contents is not low risk.

## Review procedure

Before approving a new plugin or a release that changes behavior:

1. **Establish provenance.** Identify the author, upstream dependencies,
   licenses, generated/minified files, native binaries, and every changed file.
   Do not accept unexplained blobs or dependencies copied from an unverified
   source.
2. **Read the complete diff.** Start at activation and `onLoad`, follow every
   command, panel bridge, service, skill, and agent tool to its side effects.
   Search for process execution, filesystem access, network access, clipboard
   access, credential reads, dynamic loading, timers, startup hooks, and native
   code.
3. **Make a capability matrix.** For every side effect record: source entry,
   data read, destination, permission, user action/confirmation, bounds, and
   cleanup. Every requested permission must have a demonstrated use; every
   demonstrated privileged use must be declared and documented.
4. **Check trust boundaries.** Confirm user-selected roots are canonicalized,
   symlinks and path traversal are rejected, files are type/size bounded,
   secrets are not returned to an agent or network, and untrusted text is not
   treated as code or HTML. Confirm network destinations are allowlisted where
   the host supports it.
5. **Check destructive behavior.** It must be opt-in, specific, visible,
   cancellable where practical, bounded, and safe on timeout/error. Agent tools
   must default to the safe operation; an agent or prompt must never be able to
   self-authorize a dangerous override.
6. **Test the negative paths.** Exercise denied permissions, cancelled
   pickers, out-of-root paths, symlink escapes, malformed input, oversized
   input/output, timeouts, process cleanup, unload/reload, and network failure.
   Use temporary fixtures only; never run destructive tests against a real
   workspace, account, host, or credential.
7. **Inspect the artifact.** Run the security preflight, pack the plugin, list
   the `.piplug` contents, check for symlinks/path traversal/secrets, verify the
   manifest in the package, and verify the catalog SHA-256. Review source and
   packed content, not just the PR diff.
8. **Record the decision.** The PR description must include the risk tier,
   permissions matrix, data-flow destinations, commands run, findings and
   mitigations, dependency/native-binary provenance, and the names of the
   required reviewers. A reviewer who did not inspect the package may not sign
   off a high-risk release.

## Automated preflight

Run this before every PR and release:

```bash
python3 scripts/pack_plugin.py plugins/<id>
python3 scripts/security_audit.py --check-packages
python3 scripts/rebuild_catalog.py
node --test tests/*.test.mjs
```
`security_audit.py` is deliberately fail-closed for high-confidence findings:
malformed security metadata, duplicate or undeclared manifest surfaces,
symlinks/path traversal, hard-coded secrets, remote executable scripts,
dynamic code execution, and unsafe package entries fail the command. It also
prints manual-review signals for legitimate but dangerous capabilities such as
shells, native binaries, network, file writes, clipboard, startup services, and
agent prompt injection. A pass means only that the automated checks found no
known blocker; it never replaces the manual review above.

## Changes after approval

Any change to permissions, activation events, agent tools, skills, network
allowlists, native/vendor files, data destinations, or destructive behavior
requires a new security review. A package must be rebuilt after source or
manifest changes. Never hand-edit `catalog.json`, and never publish an artifact
whose hash does not match the generated catalog.

## Reporting a vulnerability

Do not open a public issue containing an exploitable detail or a credential.
Report privately through the repository maintainer/security contact configured
by the Git hosting service. Include the plugin id/version, affected platform,
reproduction steps, impact, and a minimal sanitized proof. Maintainers should
quarantine the plugin from the catalog, preserve the affected artifact and
hash, publish a fixed version, and document the incident and user remediation.
