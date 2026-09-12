(() => {
  "use strict";

  const bridge = window.pluginBridge;
  const root = document.getElementById("workers");
  const refreshButton = document.getElementById("refresh");
  const errorNode = document.getElementById("error");
  let timer = 0;
  let loading = false;

  const strings = {
    en: {
      eyebrow: "SESSION ORCHESTRATOR",
      title: "Agents",
      refresh: "Refresh",
      empty: "No workers yet.",
      open: "Open Session",
      stop: "Stop",
      stopping: "Stopping…",
      completed: "Completed",
      running: "Running",
      waiting_permission: "Waiting for permission",
      created: "Starting",
      failed: "Failed",
      cancelled: "Cancelled",
      openUnavailable: "Open Session is unavailable on this host; use the session list.",
      loadFailed: "Unable to read workers",
      actionFailed: "Worker action failed",
    },
    "zh-CN": {
      eyebrow: "SESSION ORCHESTRATOR",
      title: "Agents",
      refresh: "刷新",
      empty: "还没有 Worker。",
      open: "打开 Session",
      stop: "停止",
      stopping: "停止中…",
      completed: "已完成",
      running: "运行中",
      waiting_permission: "等待权限",
      created: "启动中",
      failed: "失败",
      cancelled: "已取消",
      openUnavailable: "当前宿主不支持直接打开 Session，请从 Session 列表进入。",
      loadFailed: "无法读取 Worker",
      actionFailed: "Worker 操作失败",
    },
  };
  let locale = "en";

  function t(key) {
    return strings[locale]?.[key] || strings.en[key] || key;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showError(message) {
    errorNode.textContent = message || t("actionFailed");
    errorNode.hidden = !message;
  }

  function statusGlyph(status) {
    if (status === "completed") return "✓";
    if (status === "failed" || status === "cancelled") return "!";
    return "●";
  }

  function statusLabel(status) {
    return t(status);
  }

  function render(workers) {
    if (!workers.length) {
      root.innerHTML = `<div class="empty">${escapeHtml(t("empty"))}</div>`;
      return;
    }

    root.innerHTML = workers.map((worker) => {
      const terminal = worker.status === "completed" ||
        worker.status === "failed" || worker.status === "cancelled";
      return `
        <article class="worker">
          <div class="worker-row">
            <span class="status status-${escapeHtml(worker.status)}" aria-label="${escapeHtml(statusLabel(worker.status))}">${statusGlyph(worker.status)}</span>
            <span class="worker-title" title="${escapeHtml(worker.title)}">${escapeHtml(worker.title)}</span>
          </div>
          <div class="status-label">${escapeHtml(statusLabel(worker.status))}</div>
          <div class="worker-task">${escapeHtml(worker.task)}</div>
          <div class="actions">
            <button type="button" data-open="${escapeHtml(worker.workerId)}">${escapeHtml(t("open"))}</button>
            <button class="secondary" type="button" data-stop="${escapeHtml(worker.workerId)}" ${terminal ? "disabled" : ""}>${escapeHtml(t("stop"))}</button>
          </div>
        </article>`;
    }).join("");
  }

  async function refresh() {
    if (loading || !bridge?.invoke) return;
    loading = true;
    refreshButton.disabled = true;
    showError("");
    try {
      const result = await bridge.invoke("workers.list");
      render(Array.isArray(result?.workers) ? result.workers : []);
    } catch (error) {
      showError(error?.message || t("loadFailed"));
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!document.hidden) {
      timer = window.setTimeout(async () => {
        await refresh();
        schedule();
      }, 2_000);
    }
  }

  function updateLocale(nextLocale) {
    locale = String(nextLocale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.dataset.i18n;
      if (strings[locale][key]) node.textContent = strings[locale][key];
    });
  }

  refreshButton.addEventListener("click", async () => {
    await refresh();
    schedule();
  });

  root.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    target.disabled = true;
    try {
      if (target.dataset.open) {
        await bridge.invoke("workers.open", { workerId: target.dataset.open });
      } else if (target.dataset.stop) {
        target.textContent = t("stopping");
        await bridge.invoke("workers.cancel", { workerId: target.dataset.stop });
        await refresh();
      }
    } catch (error) {
      showError(error?.message || t("actionFailed"));
      target.disabled = false;
    } finally {
      schedule();
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) window.clearTimeout(timer);
    else {
      await refresh();
      schedule();
    }
  });

  window.__sessionOrchestratorPanel = {
    render,
    refresh,
    updateLocale,
    showError,
  };

  updateLocale(document.documentElement.lang);
  void refresh().then(schedule);
})();
