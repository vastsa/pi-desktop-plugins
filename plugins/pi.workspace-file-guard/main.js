"use strict";

/**
 * Workspace File Guard — PI-Desktop plugin entry.
 *
 * Skills in this pack are injected into the agent prompt while the plugin
 * is enabled. Tools let the agent resolve the project root and reject writes
 * that would leak test/temp/junk files onto the system volume, Desktop, Downloads, or temp dirs.
 */

const {
  classify,
  defaultShell,
  envAssignments,
  formatEnv,
  resolveToolRoot,
  scratchRoot,
  tmpLayout,
} = require("./guard");

const TOOLS = ["project_root", "check_path", "temp_env", "tmp_layout"];

async function workspacePath() {
  try {
    const workspace = await pi.workspace.get();
    if (workspace && workspace.path) return workspace.path;
  } catch {
    // caller must fail closed; do not guess process.cwd()
  }
  return null;
}

async function resolveRoot(explicit) {
  if (explicit) return resolveToolRoot({ explicit });
  const workspace = await workspacePath();
  return resolveToolRoot({ workspace });
}

function toolOk(payload) {
  return { ok: true, ...payload };
}

async function toolProjectRoot(args) {
  const resolved = await resolveRoot(args?.root);
  if (!resolved.ok) return resolved;
  const projectRoot = resolved.projectRoot;
  const scratch = scratchRoot();
  return toolOk({
    projectRoot,
    scratch,
    tmp: tmpLayout(projectRoot),
  });
}

async function toolCheckPath(args) {
  const target = String(args?.path || "").trim();
  if (!target) return { ok: false, error: "path is required" };
  const resolved = await resolveRoot(args?.root);
  if (!resolved.ok) return resolved;
  const projectRoot = resolved.projectRoot;
  const result = classify(target, projectRoot, {
    explicit: args?.explicit === true,
    scratch: scratchRoot(),
  });
  return {
    ok: true,
    allowed: result.allowed,
    path: result.path,
    projectRoot: result.projectRoot,
    scratch: result.scratch,
    reasons: result.reasons,
  };
}

async function toolTempEnv(args) {
  const resolved = await resolveRoot(args?.root);
  if (!resolved.ok) return resolved;
  const projectRoot = resolved.projectRoot;
  const scratch = scratchRoot();
  const mapping = envAssignments({ projectRoot, scratch });
  const shell = ["powershell", "cmd", "bash", "json"].includes(args?.shell)
    ? args.shell
    : defaultShell();
  return toolOk({
    projectRoot,
    scratch,
    shell,
    env: mapping,
    script: formatEnv(mapping, shell),
  });
}

async function toolTmpLayout(args) {
  const resolved = await resolveRoot(args?.root);
  if (!resolved.ok) return resolved;
  const projectRoot = resolved.projectRoot;
  const scratch = scratchRoot();
  return toolOk({
    projectRoot,
    scratch,
    layout: tmpLayout(projectRoot),
    hint:
      "Create these folders only when needed. Put throwaway files in scratch; keep durable source in the project tree.",
  });
}

async function onLoad() {
  const registered = [];
  try {
  await pi.agent.registerTool({
    name: "project_root",
    description:
      "Resolve the active PI-Desktop workspace, PI scratch directory, and recommended .tmp layout. Fails if no workspace is open and root is omitted. Use before creating test/temp/scratch files.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Optional absolute project root override; use only for a root explicitly selected by the user. The tool cannot verify that selection." }
      },
    },
    execute: (args) => toolProjectRoot(args),
  });
  registered.push("project_root");

  await pi.agent.registerTool({
    name: "check_path",
    description:
      "Classify whether a write path is allowed. Read allowed, not ok: ok=true only means classification succeeded. Relative paths are resolved against the workspace, not the plugin process cwd. allowed=false must be redirected into the workspace or PI scratch.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path that would be written" },
        root: { type: "string", description: "Optional absolute project root override; use only for a root explicitly selected by the user. The tool cannot verify that selection." },
        explicit: {
          type: "boolean",
          description:
            "Set true only when this turn's user message named this absolute destination. The tool cannot verify that; Desktop/Downloads/temp stay forbidden anyway.",
        },
      },
      required: ["path"],
    },
    execute: (args) => toolCheckPath(args),
  });
  registered.push("check_path");

  await pi.agent.registerTool({
    name: "temp_env",
    description:
      "Return TMP/TEMP/cache environment assignments that keep tool junk inside the project .tmp and PI scratch. Fails if no workspace is open and root is omitted.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Optional absolute project root override; use only for a root explicitly selected by the user. The tool cannot verify that selection." },
        shell: {
          type: "string",
          enum: ["powershell", "cmd", "bash", "json"],
          description: "Script dialect for the env assignments",
        },
      },
    },
    execute: (args) => toolTempEnv(args),
  });
  registered.push("temp_env");

  await pi.agent.registerTool({
    name: "tmp_layout",
    description:
      "Return the recommended $project/.tmp/{tests,scripts,cache,out} layout without creating files. Fails if no workspace is open and root is omitted.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Optional absolute project root override; use only for a root explicitly selected by the user. The tool cannot verify that selection." }
      },
    },
    execute: (args) => toolTmpLayout(args),
  });
  registered.push("tmp_layout");
  } catch (error) {
    for (const name of registered.reverse()) {
      try {
        await pi.agent.unregisterTool(name);
      } catch {
        // best-effort rollback
      }
    }
    throw error;
  }
}

async function onUnload() {
  for (const name of TOOLS) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      // already gone
    }
  }
}

module.exports = { onLoad, onUnload, toolCheckPath, toolProjectRoot, toolTempEnv, toolTmpLayout };
