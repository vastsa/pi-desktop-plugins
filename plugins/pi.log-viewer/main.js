"use strict";

const path = require("node:path");
const { LogEngine, createHostFileSystem } = require("./lib/log-engine.js");

const COMMAND_ID = "log-viewer.open";
let engine = null;

function detectCapabilities() {
  let readRange = false;
  let stat = false;
  try {
    readRange = typeof pi !== "undefined" && pi.fs && typeof pi.fs.readRange === "function";
    stat = typeof pi !== "undefined" && pi.fs && typeof pi.fs.stat === "function";
  } catch {
    // pi global unavailable during early load
  }
  return { hostReadRange: readRange, hostStat: stat };
}

async function onLoad() {
  const capabilities = detectCapabilities();
  if (!capabilities.hostReadRange || !capabilities.hostStat) {
    throw new Error("PI-Desktop fs.stat and fs.readRange APIs are required");
  }
  let dataPath = null;
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null; // state memory disabled without a data path
  }
  engine = new LogEngine({
    dataPath,
    capabilities,
    fileSystem: createHostFileSystem(pi.fs),
  });
  await pi.commands.register({
    id: COMMAND_ID,
    title: "日志查看器：打开",
    keywords: ["log", "日志", "viewer", "tail"],
    run: async () => {
      // 面板标题由 manifest.ui.title 双语字段提供，不要在此覆盖
      await pi.ui.openPanel();
    },
  });
}

async function onUnload() {
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    // already gone
  }
  if (engine) {
    engine.dispose();
    engine = null;
  }
}

async function onPanelInvoke(channel, payload) {
  if (!engine) throw new Error("engine not ready");
  const op = String(channel || "").replace(/^engine\./, "");
  return engine.handle(op, payload || {});
}

module.exports = { onLoad, onUnload, onPanelInvoke };
