"use strict";

/**
 * pi.clipboard-history — main process entry.
 *
 * Runs inside an Electron utilityProcess with full Node access. The host
 * injects the global `pi` before this module is evaluated. Module eval and
 * onLoad stay light; history files are loaded lazily on first request.
 *
 * Export shape: { onLoad, onUnload, onPanelInvoke }.
 * Panel RPC: window.pluginBridge.invoke(channel, payload) → onPanelInvoke.
 */

const { CaptureService } = require("./lib/capture");

let service = null;
let registered = null;

async function onLoad() {
  const dataPath = await pi.plugin.getDataPath();
  service = new CaptureService(pi, dataPath);
  registered = pi.services.register({
    id: "watcher",
    start: (ctx) => service.start(ctx),
    stop: () => service.stop(),
  });
  await registered;
  await pi.commands.register({
    id: "pi-clipboard-history.open",
    title: "剪贴板历史：打开面板",
    keywords: ["clipboard", "剪贴板", "剪贴板历史", "history"],
    run: async () => {
      // No title option: the host resolves the localized manifest title.
      await pi.ui.openPanel();
    },
  });
}

async function onPanelInvoke(channel, payload) {
  const p = payload || {};
  switch (channel) {
    case "history.list":
      return { ...service.getState(), groups: service.getList() };
    case "history.copy":
      return service.copyById(p.id);
    case "history.remove":
      return service.removeById(p.id);
    case "history.clearDay":
      return service.clearDay(p.dateKey);
    case "history.clearAll":
      return service.clearAll();
    case "history.setPaused":
      return { paused: await service.setPaused(p.paused) };
    case "history.setInterval":
      return { pollIntervalMs: await service.setIntervalMs(p.ms) };
    default: {
      const err = new Error(`Unsupported channel: ${channel}`);
      err.code = "UNSUPPORTED";
      throw err;
    }
  }
}

async function onUnload() {
  try {
    if (registered) await registered;
  } catch {
    /* best effort */
  }
  try {
    await pi.services.unregister("watcher");
  } catch {
    /* best effort */
  }
  try {
    await pi.commands.unregister("pi-clipboard-history.open");
  } catch {
    /* best effort */
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
