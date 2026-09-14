"use strict";

/**
 * C盘防垃圾 — PI-Desktop 插件入口。
 *
 * 插件启用期间会把 skill 注入 Agent。工具用来解析项目根，
 * 并拒绝把测试/临时/垃圾文件写到系统盘、桌面、下载或系统临时目录。
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
      "只在需要时创建这些文件夹。一次性文件放 Temp 或 scratch；正式源码放项目树。",
  });
}

async function onLoad() {
  const registered = [];
  try {
    await pi.agent.registerTool({
      name: "project_root",
      description:
        "解析当前打开的 PI-Desktop 工作区、PI scratch，以及推荐的 Temp 布局。未打开工作区且未传 root 时失败。写测试/临时/草稿文件前先调用。",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: "可选的绝对项目根覆盖；仅在用户明确指定时使用。工具无法核实该选择。",
          },
        },
      },
      execute: (args) => toolProjectRoot(args),
    });
    registered.push("project_root");

    await pi.agent.registerTool({
      name: "check_path",
      description:
        "判断写入路径是否允许。看 allowed，不要看 ok：ok=true 只表示分类成功。相对路径相对工作区解析，不是插件进程 cwd。allowed=false 必须改写到工作区或 PI scratch。",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "准备写入的路径" },
          root: {
            type: "string",
            description: "可选的绝对项目根覆盖；仅在用户明确指定时使用。工具无法核实该选择。",
          },
          explicit: {
            type: "boolean",
            description:
              "仅当本轮用户消息点名了这个绝对路径时设为 true。工具无法核实；桌面、下载、系统临时目录仍然禁止。",
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
        "返回 TMP/TEMP/缓存环境变量赋值，把工具垃圾关在项目 Temp 和 PI scratch。未打开工作区且未传 root 时失败。",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: "可选的绝对项目根覆盖；仅在用户明确指定时使用。工具无法核实该选择。",
          },
          shell: {
            type: "string",
            enum: ["powershell", "cmd", "bash", "json"],
            description: "环境变量脚本方言",
          },
        },
      },
      execute: (args) => toolTempEnv(args),
    });
    registered.push("temp_env");

    await pi.agent.registerTool({
      name: "tmp_layout",
      description:
        "返回推荐的 $project/Temp/{tests,scripts,cache,out} 布局，不创建文件。未打开工作区且未传 root 时失败。",
      risk: "low",
      schema: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: "可选的绝对项目根覆盖；仅在用户明确指定时使用。工具无法核实该选择。",
          },
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
