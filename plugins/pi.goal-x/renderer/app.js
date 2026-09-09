(function () {
  "use strict";

  var PREVIEW = /(?:^|[?&])preview=1(?:&|$)/.test(String(location.search || ""));
  var bridge = window.pluginBridge && typeof window.pluginBridge.invoke === "function" ? window.pluginBridge : null;
  var root = document.documentElement;
  var appElement = document.getElementById("app");
  var toastTimer = null;
  var messages = {
    en: {
      open: "Open", archived: "Archived", activity: "Activity", audit: "Audit", refresh: "Refresh",
      newGoal: "New goal", close: "Close", goalDefinition: "Goal definition", objective: "Objective",
      verificationContract: "Verification contract", contractPlaceholder: "What evidence proves this goal is complete?",
      mode: "Mode", regular: "Regular", sisyphus: "Sisyphus", tokenBudget: "Token budget", optional: "Optional",
      gateCompletion: "Gate completion", gateCompletionHint: "Require every task to be resolved before audit.",
      cancel: "Cancel", save: "Save", taskPlan: "Task plan", addTask: "Add task", taskTitle: "Task title",
      parentTask: "Parent task", noParent: "No parent", lightweightSubtasks: "Lightweight subtasks",
      lightweightHint: "Parent may complete while children remain pending.", add: "Add", lifecycle: "Lifecycle",
      pauseGoal: "Pause goal", pauseReason: "Reason", suggestedAction: "Suggested next action", pause: "Pause", taskUpdate: "Task update",
      confirm: "Confirm", independentReview: "Independent review", runCompletionAudit: "Run completion audit",
      auditExplanation: "The auditor checks the objective, contract, tasks, and available evidence before completion.",
      completionSummary: "Completion summary", completionPlaceholder: "Summarize the result and supporting evidence.",
      runAudit: "Run audit", archiveGoal: "Archive goal", archiveExplanation: "This removes the goal from Open. You can restore it later.",
      archiveReason: "Reason", archivePlaceholder: "Archived by user", archive: "Archive", workspace: "Workspace",
      noWorkspace: "Global scope", focused: "Focused", updated: "Updated", status: "Status", elapsed: "Active time",
      budget: "Budget", tasks: "Tasks", unlimited: "Unlimited", taskProgress: "Task progress", current: "Current",
      noContract: "No verification contract defined.", noTasks: "No tasks yet. Add the first task to make progress observable.",
      editGoal: "Edit goal", focusGoal: "Focus goal", resumeGoal: "Resume goal", completeGoal: "Complete goal",
      restoreGoal: "Restore goal", startTask: "Set current task", completeTask: "Complete task", skipTask: "Skip task",
      reopenTask: "Reopen task", addSubtask: "Add subtask", evidence: "Evidence", evidenceOptional: "Evidence (optional)",
      evidenceRequired: "Evidence is required by this task's verification contract.", skipReason: "Skip reason",
      complete: "Complete", skip: "Skip", reopen: "Reopen", emptyOpenTitle: "No open goals", emptyOpenBody: "Create a goal to begin a tracked work session.",
      emptyArchiveTitle: "Archive is empty", emptyArchiveBody: "Completed and archived goals appear here.", createGoal: "Create goal",
      recentActivity: "Recent activity", events: "events", noActivity: "No activity has been recorded.", auditSettings: "Audit settings",
      auditEnabled: "Independent completion audit", auditEnabledHint: "Review completion in an isolated agent session.", auditorModel: "Auditor model",
      inheritModel: "Inherit current session model", thinkingLevel: "Thinking level", defaultCompletionGate: "Default completion gate",
      defaultCompletionGateHint: "Require all tasks to resolve on newly created goals.", saved: "Saved", saving: "Saving...",
      settingsUnavailable: "Audit settings are unavailable.", latestAudit: "Latest audit", approved: "Approved", rejected: "More work requested",
      auditSkipped: "Skipped", noAudit: "No audit has run for this goal.", archivedAt: "Archived", restored: "Goal restored.",
      created: "Goal created.", edited: "Goal updated.", paused: "Goal paused.", resumed: "Goal resumed.",
      focusedToast: "Goal focused.", archivedToast: "Goal archived.", taskAdded: "Task added.", taskUpdated: "Task updated.",
      refreshed: "State refreshed.", auditApproved: "Audit approved. Goal completed and archived.",
      auditRejected: "Audit requested more work. Review the report before retrying.", resolveTasksFirst: "Resolve pending tasks before audit.",
      pauseNotice: "Paused", blockedNotice: "Blocked", budgetNotice: "Budget limited", suggested: "Suggested",
      archivedGoal: "Archived goal", openGoal: "Open goal", agoNow: "just now", minutesAgo: "{count}m ago", hoursAgo: "{count}h ago",
      daysAgo: "{count}d ago", minutesShort: "{count}m", hoursShort: "{hours}h {minutes}m", taskCount: "{done}/{total} resolved",
      settings: "Settings", inspectPanel: "Activity and audit", loading: "Loading goals...", errorPrefix: "Could not complete the action: ",
      createdEvent: "Goal created and focused.", editedEvent: "Goal definition updated.", pausedEvent: "Goal paused.",
      resumedEvent: "Goal resumed.", tasksSetEvent: "Task plan updated.", taskProgressEvent: "Task progress updated.",
      auditRejectedEvent: "Completion audit requested more work.", completedEvent: "Goal completed after audit approval.",
      archivedEvent: "Goal archived.", restoredEvent: "Goal restored from archive.", modelDefault: "Default",
      off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum",
      archivedReason: "Archived by user", auditPendingHint: "The completion gate is active and {count} task(s) remain pending.",
      selectedTask: "Selected task", mockMode: "Preview data", none: "None", goals: "Goals", disconnected: "Goal X is not connected to PI-Desktop."
    },
    zh: {
      open: "进行中", archived: "已归档", activity: "动态", audit: "审计", refresh: "刷新",
      newGoal: "新建目标", close: "关闭", goalDefinition: "目标定义", objective: "目标",
      verificationContract: "验收契约", contractPlaceholder: "什么证据可以证明目标已经完成？",
      mode: "模式", regular: "常规", sisyphus: "Sisyphus", tokenBudget: "Token 预算", optional: "可选",
      gateCompletion: "完成门禁", gateCompletionHint: "审计前要求所有任务都已处理。",
      cancel: "取消", save: "保存", taskPlan: "任务计划", addTask: "添加任务", taskTitle: "任务标题",
      parentTask: "父任务", noParent: "无父任务", lightweightSubtasks: "轻量子任务",
      lightweightHint: "允许父任务在子任务仍待处理时完成。", add: "添加", lifecycle: "生命周期",
      pauseGoal: "暂停目标", pauseReason: "原因", suggestedAction: "建议的下一步", pause: "暂停", taskUpdate: "更新任务",
      confirm: "确认", independentReview: "独立复核", runCompletionAudit: "运行完成审计",
      auditExplanation: "审计器会检查目标、验收契约、任务和现有证据，再决定是否完成。",
      completionSummary: "完成摘要", completionPlaceholder: "概括结果和支持证据。",
      runAudit: "运行审计", archiveGoal: "归档目标", archiveExplanation: "目标将移出进行中列表，之后仍可恢复。",
      archiveReason: "原因", archivePlaceholder: "由用户归档", archive: "归档", workspace: "工作区",
      noWorkspace: "全局范围", focused: "已聚焦", updated: "更新于", status: "状态", elapsed: "活跃时长",
      budget: "预算", tasks: "任务", unlimited: "不限", taskProgress: "任务进度", current: "当前",
      noContract: "尚未定义验收契约。", noTasks: "尚无任务。添加首个任务，让进度清晰可见。",
      editGoal: "编辑目标", focusGoal: "聚焦目标", resumeGoal: "恢复目标", completeGoal: "完成目标",
      restoreGoal: "恢复目标", startTask: "设为当前任务", completeTask: "完成任务", skipTask: "跳过任务",
      reopenTask: "重新打开任务", addSubtask: "添加子任务", evidence: "证据", evidenceOptional: "证据（可选）",
      evidenceRequired: "该任务的验收契约要求提供证据。", skipReason: "跳过原因",
      complete: "完成", skip: "跳过", reopen: "重新打开", emptyOpenTitle: "没有进行中的目标", emptyOpenBody: "创建目标以开始可跟踪的工作会话。",
      emptyArchiveTitle: "归档为空", emptyArchiveBody: "完成和手动归档的目标会出现在这里。", createGoal: "创建目标",
      recentActivity: "最近动态", events: "条", noActivity: "尚未记录任何动态。", auditSettings: "审计设置",
      auditEnabled: "独立完成审计", auditEnabledHint: "在隔离的 Agent 会话中复核完成情况。", auditorModel: "审计模型",
      inheritModel: "继承当前会话模型", thinkingLevel: "思考级别", defaultCompletionGate: "默认完成门禁",
      defaultCompletionGateHint: "新建目标默认要求所有任务均已处理。", saved: "已保存", saving: "保存中...",
      settingsUnavailable: "审计设置暂不可用。", latestAudit: "最近审计", approved: "已批准", rejected: "需要继续工作",
      auditSkipped: "已跳过", noAudit: "此目标尚未运行审计。", archivedAt: "已归档", restored: "目标已恢复。",
      created: "目标已创建。", edited: "目标已更新。", paused: "目标已暂停。", resumed: "目标已恢复。",
      focusedToast: "目标已聚焦。", archivedToast: "目标已归档。", taskAdded: "任务已添加。", taskUpdated: "任务已更新。",
      refreshed: "状态已刷新。", auditApproved: "审计通过，目标已完成并归档。",
      auditRejected: "审计要求继续工作，请查看报告后重试。", resolveTasksFirst: "请先处理待办任务，再运行审计。",
      pauseNotice: "已暂停", blockedNotice: "已阻塞", budgetNotice: "预算已达上限", suggested: "建议",
      archivedGoal: "归档目标", openGoal: "进行中的目标", agoNow: "刚刚", minutesAgo: "{count} 分钟前", hoursAgo: "{count} 小时前",
      daysAgo: "{count} 天前", minutesShort: "{count} 分钟", hoursShort: "{hours} 小时 {minutes} 分", taskCount: "已处理 {done}/{total}",
      settings: "设置", inspectPanel: "动态与审计", loading: "正在加载目标...", errorPrefix: "操作未完成：",
      createdEvent: "目标已创建并聚焦。", editedEvent: "目标定义已更新。", pausedEvent: "目标已暂停。",
      resumedEvent: "目标已恢复。", tasksSetEvent: "任务计划已更新。", taskProgressEvent: "任务进度已更新。",
      auditRejectedEvent: "完成审计要求继续工作。", completedEvent: "目标在审计通过后完成。",
      archivedEvent: "目标已归档。", restoredEvent: "目标已从归档恢复。", modelDefault: "默认",
      off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
      archivedReason: "由用户归档", auditPendingHint: "完成门禁已启用，仍有 {count} 个任务待处理。",
      selectedTask: "所选任务", mockMode: "预览数据", none: "无", goals: "目标", disconnected: "Goal X 未连接到 PI-Desktop。"
    }
  };

  var state = {
    workspace: null,
    descriptor: null,
    settings: null,
    models: [],
    selectedGoalId: null,
    listMode: "open",
    inspectorTab: "activity",
    locale: root.dataset.lang === "zh" || String(root.lang).toLowerCase().startsWith("zh") ? "zh" : "en",
    localeOverride: false,
    busy: false,
    goalDialogMode: "create",
    taskParentId: null,
    taskAction: null,
    settingsSaveState: "",
    pendingCreateMode: null,
    loaded: false
  };

  function nowIso(offsetMinutes) {
    return new Date(Date.now() - (offsetMinutes || 0) * 60000).toISOString();
  }

  var mock = {
    settings: {
      auditorEnabled: true,
      auditorModelKey: "openai/gpt-5.2",
      auditorEffort: "high",
      defaultBlockCompletion: true
    },
    models: [
      { key: "openai/gpt-5.2", label: "OpenAI / GPT-5.2" },
      { key: "anthropic/claude-sonnet-4", label: "Anthropic / Claude Sonnet 4" },
      { key: "google/gemini-2.5-pro", label: "Google / Gemini 2.5 Pro" }
    ],
    workspace: {
      key: "workspace-preview",
      name: "pi-desktop",
      hasWorkspace: true,
      focusedGoalId: "goal-migration",
      updatedAt: nowIso(2),
      goals: [
        {
          id: "goal-migration",
          objective: "Migrate Goal X into a native PI-Desktop plugin with complete lifecycle controls",
          mode: "regular",
          status: "active",
          revision: 7,
          verificationContract: "Plugin check passes; desktop and narrow layouts remain usable; lifecycle and audit actions persist through the panel bridge.",
          tokenBudget: 32000,
          blockCompletion: true,
          currentTaskId: "task-panel",
          tasks: [
            { id: "task-contract", title: "Map the source behavior and bridge contract", status: "complete", evidence: "Lifecycle matrix reviewed.", completedAt: nowIso(68), subtasks: [] },
            { id: "task-panel", title: "Build the operational goal panel", status: "pending", verificationContract: "Visual QA at desktop and narrow widths.", subtasks: [
              { id: "task-theme", title: "Synchronize host theme and locale", status: "complete", evidence: "Appearance channel wired.", completedAt: nowIso(18), subtasks: [] },
              { id: "task-responsive", title: "Verify responsive task controls", status: "pending", subtasks: [] }
            ] },
            { id: "task-release", title: "Package and publish the plugin", status: "pending", subtasks: [] }
          ],
          audits: [
            { id: "audit-preview", approved: false, skipped: false, modelKey: "openai/gpt-5.2", report: "The implementation is coherent, but release evidence is still missing.", at: nowIso(95) }
          ],
          activity: [
            { id: "event-1", type: "task_progress", message: "Applied 1 task update.", at: nowIso(18) },
            { id: "event-2", type: "tasks_set", message: "Task plan updated (5 tasks).", at: nowIso(43) },
            { id: "event-3", type: "audit_rejected", message: "Completion audit requested more work.", at: nowIso(95) },
            { id: "event-4", type: "created", message: "Goal created and focused.", at: nowIso(166) }
          ],
          usage: { activeSeconds: 5840 },
          activeSince: nowIso(21),
          createdAt: nowIso(166),
          updatedAt: nowIso(2)
        },
        {
          id: "goal-docs",
          objective: "Write bilingual installation and operating documentation",
          mode: "sisyphus",
          status: "paused",
          revision: 3,
          verificationContract: null,
          tokenBudget: null,
          blockCompletion: false,
          pauseReason: "Waiting for the final package name.",
          suggestedAction: "Resume after the manifest is finalized.",
          currentTaskId: null,
          tasks: [
            { id: "task-readme", title: "Draft README", status: "pending", subtasks: [] }
          ],
          audits: [],
          activity: [
            { id: "event-docs-1", type: "paused", message: "Goal paused.", at: nowIso(240) },
            { id: "event-docs-2", type: "created", message: "Goal created and focused.", at: nowIso(410) }
          ],
          usage: { activeSeconds: 1240 },
          createdAt: nowIso(410),
          updatedAt: nowIso(240)
        }
      ],
      archivedGoals: [
        {
          id: "goal-discovery",
          objective: "Review the upstream Goal X architecture and identify portable behavior",
          mode: "regular",
          status: "complete",
          revision: 5,
          verificationContract: "Source modules, persistence boundaries, and settings are documented.",
          tokenBudget: 12000,
          blockCompletion: true,
          currentTaskId: null,
          tasks: [
            { id: "task-source", title: "Inspect source repository", status: "complete", evidence: "Architecture notes recorded.", completedAt: nowIso(880), subtasks: [] },
            { id: "task-api", title: "Map desktop APIs", status: "complete", evidence: "Bridge mapping recorded.", completedAt: nowIso(840), subtasks: [] }
          ],
          audits: [{ id: "audit-done", approved: true, modelKey: "openai/gpt-5.2", report: "All discovery requirements are supported by concrete repository evidence.", at: nowIso(810) }],
          activity: [{ id: "event-done", type: "completed", message: "Goal completed after audit approval.", at: nowIso(810) }],
          usage: { activeSeconds: 3920 },
          createdAt: nowIso(1100),
          updatedAt: nowIso(810),
          completedAt: nowIso(810),
          archiveReason: "audited_completion"
        }
      ]
    }
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function interpolate(text, values) {
    return String(text).replace(/\{(\w+)\}/g, function (_, key) {
      return values && values[key] !== undefined ? String(values[key]) : "";
    });
  }

  function t(key, values) {
    var table = messages[state.locale] || messages.en;
    return interpolate(table[key] !== undefined ? table[key] : messages.en[key] || key, values);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function icon(name) {
    return '<i data-lucide="' + escapeHtml(name) + '" aria-hidden="true"></i>';
  }

  function tooltipButton(action, iconName, label, options) {
    options = options || {};
    var attrs = options.attrs || "";
    var className = "icon-button" + (options.className ? " " + options.className : "");
    return '<button type="button" class="' + className + '" data-action="' + escapeHtml(action) + '" data-tooltip="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '" ' + attrs + (options.disabled ? " disabled" : "") + '>' + icon(iconName) + "</button>";
  }

  function useIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      try { window.lucide.createIcons({ attrs: { "aria-hidden": "true" } }); } catch (_) {}
    }
  }

  function unwrapResult(result) {
    if (result && result.ok === false) {
      var failure = result.error;
      throw new Error(typeof failure === "string" ? failure : failure && failure.message ? failure.message : result.message || "Unknown bridge error");
    }
    return result && result.data !== undefined ? result.data : result;
  }

  async function rpc(channel, payload) {
    if (bridge) return unwrapResult(await bridge.invoke(channel, payload || {}));
    if (PREVIEW) return unwrapResult(await mockInvoke(channel, payload || {}));
    throw new Error(t("disconnected"));
  }

  function goalList() {
    if (!state.workspace) return [];
    return state.listMode === "archived" ? state.workspace.archivedGoals || [] : state.workspace.goals || [];
  }

  function allGoals() {
    if (!state.workspace) return [];
    return (state.workspace.goals || []).concat(state.workspace.archivedGoals || []);
  }

  function selectedGoal() {
    return allGoals().find(function (goal) { return goal.id === state.selectedGoalId; }) || null;
  }

  function flattenTasks(tasks, depth, parentId, output) {
    var rows = output || [];
    (tasks || []).forEach(function (task) {
      rows.push({ task: task, depth: depth || 0, parentId: parentId || null });
      flattenTasks(task.subtasks || [], (depth || 0) + 1, task.id, rows);
    });
    return rows;
  }

  function goalStats(goal) {
    if (goal && goal.stats && Number.isFinite(goal.stats.total)) return goal.stats;
    var tasks = flattenTasks(goal && goal.tasks || []).map(function (entry) { return entry.task; });
    return {
      total: tasks.length,
      pending: tasks.filter(function (task) { return task.status === "pending"; }).length,
      complete: tasks.filter(function (task) { return task.status === "complete"; }).length,
      skipped: tasks.filter(function (task) { return task.status === "skipped"; }).length
    };
  }

  function formatInteger(value) {
    return new Intl.NumberFormat(state.locale === "zh" ? "zh-CN" : "en-US").format(Number(value) || 0);
  }

  function formatDuration(seconds) {
    var minutes = Math.max(0, Math.floor((Number(seconds) || 0) / 60));
    if (minutes < 60) return t("minutesShort", { count: minutes });
    return t("hoursShort", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }

  function formatRelative(value) {
    var time = new Date(value).getTime();
    if (!Number.isFinite(time)) return "";
    var minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (minutes < 1) return t("agoNow");
    if (minutes < 60) return t("minutesAgo", { count: minutes });
    if (minutes < 1440) return t("hoursAgo", { count: Math.floor(minutes / 60) });
    return t("daysAgo", { count: Math.floor(minutes / 1440) });
  }

  function statusLabel(status) {
    var labels = state.locale === "zh"
      ? { active: "进行中", paused: "已暂停", blocked: "已阻塞", budget_limited: "预算受限", complete: "已完成", archived: "已归档" }
      : { active: "Active", paused: "Paused", blocked: "Blocked", budget_limited: "Budget limited", complete: "Complete", archived: "Archived" };
    return labels[status] || status || t("none");
  }

  function statusMarkup(status) {
    return '<span class="status-pill status-' + escapeHtml(status || "unknown") + '"><span class="status-dot"></span>' + escapeHtml(statusLabel(status)) + "</span>";
  }

  function setBusy(value) {
    state.busy = value;
    appElement.setAttribute("aria-busy", value ? "true" : "false");
    var refresh = document.querySelector('[data-action="refresh"]');
    if (refresh) refresh.classList.toggle("is-spinning", value);
  }

  function showToast(message, error) {
    var node = document.getElementById("toast");
    node.textContent = message;
    node.classList.toggle("is-error", Boolean(error));
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove("is-visible"); }, error ? 4800 : 2600);
  }

  function applyStaticTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(function (node) { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) { node.placeholder = t(node.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (node) {
      var label = t(node.dataset.i18nAria);
      node.setAttribute("aria-label", label);
      node.dataset.tooltip = label;
    });
    document.querySelector(".goal-sidebar").setAttribute("aria-label", t("goals"));
    document.getElementById("inspector").setAttribute("aria-label", t("inspectPanel"));
  }

  function normalizeWorkspaceResponse(value) {
    var payload = value || {};
    var workspace = payload.workspace || (payload.state && payload.state.workspace) || payload;
    if (!workspace || !Array.isArray(workspace.goals) || !Array.isArray(workspace.archivedGoals)) {
      throw new Error("goal.state returned an invalid workspace");
    }
    return {
      workspace: workspace,
      descriptor: payload.descriptor || payload.workspaceDescriptor || {
        key: workspace.key,
        name: workspace.name,
        hasWorkspace: workspace.hasWorkspace
      }
    };
  }

  function normalizeSettingsResponse(value) {
    var payload = value || {};
    var settings = payload.settings || payload.value || payload;
    var rawModels = payload.models || payload.availableModels || [];
    var models = Array.isArray(rawModels) ? rawModels.map(function (entry) {
      if (typeof entry === "string") return { key: entry, label: entry };
      var key = entry.key || entry.value || entry.modelKey || [entry.provider, entry.id || entry.model].filter(Boolean).join("/");
      return key ? { key: key, label: entry.label || entry.name || key } : null;
    }).filter(Boolean) : [];
    return {
      settings: {
        disabled: settings.disabled === true || settings.auditEnabled === false || settings.auditorEnabled === false,
        model: settings.model || settings.auditorModel || settings.modelKey || settings.auditorModelKey || "",
        thinkingLevel: settings.thinkingLevel || settings.thinking || settings.auditorEffort || "medium",
        defaultBlockCompletion: settings.defaultBlockCompletion !== false
      },
      models: models
    };
  }

  async function refresh(options) {
    options = options || {};
    if (state.busy && !options.force) return;
    setBusy(true);
    try {
      var results = await Promise.allSettled([rpc("goal.state", {}), rpc("goal.settings.get", {})]);
      if (results[0].status !== "fulfilled") throw results[0].reason;
      var normalized = normalizeWorkspaceResponse(results[0].value);
      state.workspace = normalized.workspace;
      state.descriptor = normalized.descriptor;
      state.pendingCreateMode = results[0].value && results[0].value.pendingCreateMode || null;
      if (results[1].status === "fulfilled") {
        var settingData = normalizeSettingsResponse(results[1].value);
        state.settings = settingData.settings;
        state.models = settingData.models;
      }
      var currentList = goalList();
      var selectedStillExists = currentList.some(function (goal) { return goal.id === state.selectedGoalId; });
      if (!selectedStillExists) {
        if (state.listMode === "open" && state.workspace.focusedGoalId && currentList.some(function (goal) { return goal.id === state.workspace.focusedGoalId; })) {
          state.selectedGoalId = state.workspace.focusedGoalId;
        } else {
          state.selectedGoalId = currentList.length ? currentList[0].id : null;
        }
      }
      state.loaded = true;
      renderAll();
      if (state.pendingCreateMode === "regular" || state.pendingCreateMode === "sisyphus") {
        var requestedMode = state.pendingCreateMode;
        state.pendingCreateMode = null;
        openGoalDialog("create", requestedMode);
      }
      if (!options.quiet) showToast(t("refreshed"));
    } catch (error) {
      renderLoadError(error);
      showToast(t("errorPrefix") + errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function mutate(channel, payload, successMessage, after) {
    if (state.busy) return null;
    setBusy(true);
    try {
      var result = await rpc(channel, payload);
      if (typeof after === "function") after(result);
      setBusy(false);
      await refresh({ quiet: true, force: true });
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      setBusy(false);
      showToast(t("errorPrefix") + errorMessage(error), true);
      return null;
    }
  }

  function errorMessage(error) {
    return error && error.message ? error.message : String(error || "Unknown error");
  }

  function renderAll() {
    applyStaticTranslations();
    renderChrome();
    renderGoalList();
    renderGoalMain();
    renderInspector();
    syncTabs();
    useIcons();
  }

  function renderChrome() {
    var descriptor = state.descriptor || {};
    var name = descriptor.name || state.workspace && state.workspace.name || t("noWorkspace");
    var prefix = bridge ? t("workspace") : t("mockMode");
    document.getElementById("workspace-chip").innerHTML = '<span>' + escapeHtml(prefix) + '</span> &nbsp;·&nbsp; <strong>' + escapeHtml(name) + "</strong>";
    document.getElementById("open-count").textContent = String(state.workspace ? (state.workspace.goals || []).length : 0);
    document.getElementById("archived-count").textContent = String(state.workspace ? (state.workspace.archivedGoals || []).length : 0);
  }

  function syncTabs() {
    document.querySelectorAll("[data-list-mode]").forEach(function (button) {
      var active = button.dataset.listMode === state.listMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-inspector-tab]").forEach(function (button) {
      var active = button.dataset.inspectorTab === state.inspectorTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function renderGoalList() {
    var list = goalList();
    var node = document.getElementById("goal-list");
    if (!list.length) {
      node.innerHTML = '<div class="empty-state"><div><div class="empty-icon">' + icon(state.listMode === "archived" ? "archive" : "inbox") + '</div><h2>' + escapeHtml(t(state.listMode === "archived" ? "emptyArchiveTitle" : "emptyOpenTitle")) + '</h2><p>' + escapeHtml(t(state.listMode === "archived" ? "emptyArchiveBody" : "emptyOpenBody")) + "</p>" + (state.listMode === "open" ? '<button class="text-button compact" type="button" data-action="create-goal">' + icon("plus") + '<span>' + escapeHtml(t("createGoal")) + "</span></button>" : "") + "</div></div>";
      return;
    }
    node.innerHTML = list.map(function (goal) {
      var stats = goalStats(goal);
      var resolved = stats.complete + stats.skipped;
      var percent = stats.total ? Math.round(resolved / stats.total * 100) : 0;
      var focused = state.workspace.focusedGoalId === goal.id;
      return '<button type="button" class="goal-row' + (state.selectedGoalId === goal.id ? " is-selected" : "") + '" data-goal-id="' + escapeHtml(goal.id) + '" aria-pressed="' + (state.selectedGoalId === goal.id ? "true" : "false") + '">' +
        '<span class="goal-row-top">' + statusMarkup(goal.status) + (focused ? '<span class="goal-focus">' + icon("crosshair") + escapeHtml(t("focused")) + "</span>" : '<span class="mini-progress"><span style="width:' + percent + '%"></span></span>') + "</span>" +
        '<span class="goal-objective">' + escapeHtml(goal.objective) + "</span>" +
        '<span class="goal-row-meta"><span>' + escapeHtml(t("taskCount", { done: resolved, total: stats.total })) + '</span><span>' + escapeHtml(formatRelative(goal.updatedAt)) + "</span></span>" +
        "</button>";
    }).join("");
  }

  function renderGoalMain() {
    var goal = selectedGoal();
    var main = document.getElementById("goal-main");
    if (!state.loaded) {
      main.innerHTML = '<div class="empty-state"><div><div class="empty-icon">' + icon("loader-circle") + '</div><h2>' + escapeHtml(t("loading")) + "</h2></div></div>";
      return;
    }
    if (!goal) {
      var archived = state.listMode === "archived";
      main.innerHTML = '<div class="empty-state"><div><div class="empty-icon">' + icon(archived ? "archive" : "target") + '</div><h2>' + escapeHtml(t(archived ? "emptyArchiveTitle" : "emptyOpenTitle")) + '</h2><p>' + escapeHtml(t(archived ? "emptyArchiveBody" : "emptyOpenBody")) + "</p>" + (!archived ? '<button class="text-button primary" type="button" data-action="create-goal">' + icon("plus") + '<span>' + escapeHtml(t("createGoal")) + "</span></button>" : "") + "</div></div>";
      return;
    }
    var archivedGoal = state.listMode === "archived";
    var stats = goalStats(goal);
    var resolved = stats.complete + stats.skipped;
    var actions = archivedGoal ? renderArchivedActions(goal) : renderOpenActions(goal, stats);
    var notice = renderGoalNotice(goal);
    var tasks = flattenTasks(goal.tasks || []);
    var contractClass = goal.verificationContract ? "contract" : "contract is-empty";
    main.innerHTML = '<article class="goal-view">' +
      '<header class="goal-heading"><div class="goal-title-wrap"><span class="eyebrow">' + escapeHtml(t(archivedGoal ? "archivedGoal" : "openGoal")) + '</span><h1>' + escapeHtml(goal.objective) + '</h1></div><div class="goal-actions">' + actions + "</div></header>" +
      '<div class="metrics-strip">' +
        renderMetric(t("status"), statusLabel(goal.status)) +
        renderMetric(t("elapsed"), formatDuration(goal.usage && goal.usage.activeSeconds)) +
        renderMetric(t("budget"), goal.tokenBudget ? formatInteger(goal.tokenBudget) : t("unlimited")) +
        renderMetric(t("tasks"), t("taskCount", { done: resolved, total: stats.total })) +
      "</div>" + notice +
      '<section class="section"><div class="section-heading"><h2>' + escapeHtml(t("verificationContract")) + '</h2><span class="section-meta">' + escapeHtml(goal.mode === "sisyphus" ? t("sisyphus") : t("regular")) + '</span></div><p class="' + contractClass + '">' + escapeHtml(goal.verificationContract || t("noContract")) + "</p></section>" +
      '<section class="section"><div class="section-heading"><h2>' + escapeHtml(t("taskProgress")) + '</h2><span class="section-meta">' + escapeHtml(t("taskCount", { done: resolved, total: stats.total })) + "</span></div>" +
        (tasks.length ? '<div class="task-list">' + tasks.map(function (entry) { return renderTaskRow(goal, entry, archivedGoal); }).join("") + "</div>" : '<p class="contract is-empty">' + escapeHtml(t("noTasks")) + "</p>") +
        (!archivedGoal && (goal.status === "active" || goal.status === "paused") ? '<button class="text-button compact task-add" type="button" data-action="add-task">' + icon("plus") + '<span>' + escapeHtml(t("addTask")) + "</span></button>" : "") +
      "</section></article>";
  }

  function renderMetric(label, value) {
    return '<div class="metric"><span class="metric-label">' + escapeHtml(label) + '</span><span class="metric-value">' + escapeHtml(value) + "</span></div>";
  }

  function renderOpenActions(goal, stats) {
    var controls = [];
    if (state.workspace.focusedGoalId !== goal.id) controls.push(tooltipButton("focus-goal", "crosshair", t("focusGoal")));
    controls.push(tooltipButton("edit-goal", "pencil", t("editGoal")));
    if (goal.status === "active") controls.push(tooltipButton("pause-goal", "pause", t("pauseGoal")));
    if (["paused", "blocked", "budget_limited"].indexOf(goal.status) >= 0) controls.push(tooltipButton("resume-goal", "play", t("resumeGoal")));
    controls.push(tooltipButton("archive-goal", "archive", t("archiveGoal")));
    var auditBlocked = goal.blockCompletion && stats.pending > 0;
    var completionStateAllowed = ["active", "paused", "budget_limited"].indexOf(goal.status) >= 0;
    controls.push('<button type="button" class="text-button primary" data-action="complete-goal"' + (auditBlocked || !completionStateAllowed ? " disabled" : "") + ' title="' + escapeHtml(auditBlocked ? t("resolveTasksFirst") : t("runCompletionAudit")) + '">' + icon("shield-check") + '<span>' + escapeHtml(t("complete")) + "</span></button>");
    return controls.join("");
  }

  function renderArchivedActions() {
    return '<button type="button" class="text-button primary" data-action="restore-goal">' + icon("archive-restore") + '<span>' + escapeHtml(t("restoreGoal")) + "</span></button>";
  }

  function renderGoalNotice(goal) {
    if (["paused", "blocked", "budget_limited"].indexOf(goal.status) < 0) return "";
    var titleKey = goal.status === "blocked" ? "blockedNotice" : goal.status === "budget_limited" ? "budgetNotice" : "pauseNotice";
    var reason = goal.pauseReason || goal.blocker && goal.blocker.reason || "";
    var suggested = goal.suggestedAction ? " " + t("suggested") + ": " + goal.suggestedAction : "";
    return '<div class="notice' + (goal.status === "blocked" ? " danger" : "") + '">' + icon(goal.status === "blocked" ? "alert-triangle" : "pause-circle") + '<div><strong>' + escapeHtml(t(titleKey)) + '</strong><p>' + escapeHtml(reason + suggested) + "</p></div></div>";
  }

  function renderTaskRow(goal, entry, archivedGoal) {
    var task = entry.task;
    var current = goal.currentTaskId === task.id;
    var stateIcon = task.status === "complete" ? "circle-check" : task.status === "skipped" ? "circle-minus" : current ? "circle-dot" : "circle";
    var controls = [];
    if (!archivedGoal && goal.status === "active") {
      if (task.status === "pending") {
        if (!current) controls.push(tooltipButton("start-task", "locate-fixed", t("startTask"), { attrs: 'data-task-id="' + escapeHtml(task.id) + '"' }));
        controls.push(tooltipButton("complete-task", "check", t("completeTask"), { attrs: 'data-task-id="' + escapeHtml(task.id) + '"' }));
        controls.push(tooltipButton("skip-task", "skip-forward", t("skipTask"), { attrs: 'data-task-id="' + escapeHtml(task.id) + '"' }));
      } else if (task.status === "skipped") {
        controls.push(tooltipButton("reopen-task", "rotate-ccw", t("reopenTask"), { attrs: 'data-task-id="' + escapeHtml(task.id) + '"' }));
      }
    }
    if (!archivedGoal && (goal.status === "active" || goal.status === "paused") && entry.depth < 3) {
      controls.push(tooltipButton("add-subtask", "list-plus", t("addSubtask"), { attrs: 'data-task-id="' + escapeHtml(task.id) + '"' }));
    }
    var contract = task.verificationContract ? '<div class="task-contract" title="' + escapeHtml(task.verificationContract) + '">' + escapeHtml(task.verificationContract) + "</div>" : "";
    return '<div class="task-row status-' + escapeHtml(task.status) + (current ? " is-current" : "") + '" style="--depth:' + entry.depth + '">' +
      '<span class="task-state">' + icon(stateIcon) + '</span><div class="task-copy"><div class="task-title">' + escapeHtml(task.title) + (current ? '<span class="current-label">' + escapeHtml(t("current")) + "</span>" : "") + "</div>" + contract + '</div><div class="task-controls">' + controls.join("") + "</div></div>";
  }

  function renderInspector() {
    var node = document.getElementById("inspector-content");
    var goal = selectedGoal();
    if (state.inspectorTab === "audit") {
      node.innerHTML = renderAuditSettings(goal);
    } else {
      node.innerHTML = renderActivity(goal);
    }
  }

  function renderActivity(goal) {
    if (!goal) return '<div class="empty-state"><div><div class="empty-icon">' + icon("activity") + '</div><p>' + escapeHtml(t("noActivity")) + "</p></div></div>";
    var items = (goal.activity || []).slice(0, 40);
    var audit = goal.audits && goal.audits[0];
    var auditMarkup = audit ? renderLatestAudit(audit) : "";
    return '<div class="inspector-title"><h2>' + escapeHtml(t("recentActivity")) + '</h2><span>' + items.length + " " + escapeHtml(t("events")) + "</span></div>" + auditMarkup + (items.length ? '<div class="timeline">' + items.map(function (item) {
      return '<div class="timeline-item type-' + escapeHtml(item.type || "goal") + '"><div class="timeline-copy">' + escapeHtml(activityText(item)) + '</div><div class="timeline-time">' + escapeHtml(formatRelative(item.at)) + "</div></div>";
    }).join("") + "</div>" : '<p class="contract is-empty">' + escapeHtml(t("noActivity")) + "</p>");
  }

  function activityText(item) {
    var known = {
      created: "createdEvent", edited: "editedEvent", paused: "pausedEvent", resumed: "resumedEvent",
      tasks_set: "tasksSetEvent", task_progress: "taskProgressEvent", audit_rejected: "auditRejectedEvent",
      completed: "completedEvent", completed_without_audit: "completedEvent", archived: "archivedEvent", restored: "restoredEvent"
    };
    return known[item.type] ? t(known[item.type]) : item.message || item.type || "";
  }

  function renderLatestAudit(audit) {
    var skipped = audit.skipped === true;
    var approved = !skipped && audit.approved === true;
    var label = skipped ? t("auditSkipped") : approved ? t("approved") : t("rejected");
    var verdict = skipped ? "skipped" : approved ? "approved" : "rejected";
    var glyph = skipped ? "shield-off" : approved ? "badge-check" : "shield-alert";
    return '<div class="audit-result"><div class="audit-result-head"><span class="verdict ' + verdict + '">' + icon(glyph) + escapeHtml(label) + '</span><span class="timeline-time">' + escapeHtml(formatRelative(audit.at)) + '</span></div>' + (audit.report ? '<p>' + escapeHtml(audit.report) + "</p>" : "") + "</div>";
  }

  function renderAuditSettings(goal) {
    if (!state.settings) return '<div class="empty-state"><div><div class="empty-icon">' + icon("shield-off") + '</div><p>' + escapeHtml(t("settingsUnavailable")) + "</p></div></div>";
    var settings = state.settings;
    var modelOptions = [{ key: "", label: t("inheritModel") }].concat(state.models || []);
    if (settings.model && !modelOptions.some(function (entry) { return entry.key === settings.model; })) {
      modelOptions.push({ key: settings.model, label: settings.model });
    }
    var thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    var latestAudit = goal && goal.audits && goal.audits[0];
    return '<div class="inspector-title"><h2>' + escapeHtml(t("auditSettings")) + '</h2><span>' + icon("settings-2") + "</span></div>" +
      (latestAudit ? renderLatestAudit(latestAudit) : '<p class="contract is-empty">' + escapeHtml(t("noAudit")) + "</p>") +
      '<div class="settings-list"><div class="settings-row"><label class="toggle-row"><span><strong>' + escapeHtml(t("auditEnabled")) + '</strong><small>' + escapeHtml(t("auditEnabledHint")) + '</small></span><input type="checkbox" role="switch" data-setting="auditEnabled"' + (!settings.disabled ? " checked" : "") + "></label></div>" +
      '<div class="settings-row"><label class="settings-label" for="audit-model">' + escapeHtml(t("auditorModel")) + '</label><select id="audit-model" data-setting="model">' + modelOptions.map(function (entry) { return '<option value="' + escapeHtml(entry.key) + '"' + (entry.key === settings.model ? " selected" : "") + '>' + escapeHtml(entry.label) + "</option>"; }).join("") + "</select></div>" +
      '<div class="settings-row"><label class="settings-label" for="audit-thinking">' + escapeHtml(t("thinkingLevel")) + '</label><select id="audit-thinking" data-setting="thinkingLevel">' + thinking.map(function (level) { return '<option value="' + level + '"' + (settings.thinkingLevel === level ? " selected" : "") + '>' + escapeHtml(t(level)) + "</option>"; }).join("") + "</select></div>" +
      '<div class="settings-row"><label class="toggle-row"><span><strong>' + escapeHtml(t("defaultCompletionGate")) + '</strong><small>' + escapeHtml(t("defaultCompletionGateHint")) + '</small></span><input type="checkbox" role="switch" data-setting="defaultBlockCompletion"' + (settings.defaultBlockCompletion ? " checked" : "") + "></label></div></div>" +
      '<div class="save-state">' + escapeHtml(state.settingsSaveState ? t(state.settingsSaveState) : "") + "</div>";
  }

  function renderLoadError(error) {
    state.loaded = true;
    document.getElementById("goal-main").innerHTML = '<div class="empty-state"><div><div class="empty-icon">' + icon("triangle-alert") + '</div><h2>' + escapeHtml(t("errorPrefix")) + '</h2><p>' + escapeHtml(errorMessage(error)) + '</p><button class="text-button" type="button" data-action="refresh">' + icon("refresh-cw") + '<span>' + escapeHtml(t("refresh")) + "</span></button></div></div>";
    useIcons();
  }

  function openDialog(id) {
    var dialog = document.getElementById(id);
    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
      useIcons();
    }
  }

  function closeDialog(node) {
    var dialog = node && node.closest ? node.closest("dialog") : null;
    if (dialog) dialog.close();
  }

  function openGoalDialog(mode, requestedMode) {
    var goal = selectedGoal();
    state.goalDialogMode = mode;
    document.getElementById("goal-dialog-title").textContent = t(mode === "edit" ? "editGoal" : "newGoal");
    document.getElementById("goal-objective").value = mode === "edit" && goal ? goal.objective || "" : "";
    document.getElementById("goal-contract").value = mode === "edit" && goal ? goal.verificationContract || "" : "";
    document.getElementById("goal-budget").value = mode === "edit" && goal && goal.tokenBudget ? String(goal.tokenBudget) : "";
    document.getElementById("goal-block-completion").checked = mode === "edit" && goal ? goal.blockCompletion === true : state.settings ? state.settings.defaultBlockCompletion : true;
    var modeValue = mode === "edit" && goal && goal.mode === "sisyphus" ? "sisyphus" : requestedMode === "sisyphus" ? "sisyphus" : "regular";
    document.querySelectorAll('input[name="goal-mode"]').forEach(function (input) { input.checked = input.value === modeValue; });
    openDialog("goal-dialog");
    setTimeout(function () { document.getElementById("goal-objective").focus(); }, 0);
  }

  function openTaskDialog(parentId) {
    var goal = selectedGoal();
    if (!goal) return;
    state.taskParentId = parentId || null;
    var select = document.getElementById("task-parent");
    var entries = flattenTasks(goal.tasks || []);
    select.innerHTML = '<option value="">' + escapeHtml(t("noParent")) + "</option>" + entries.filter(function (entry) { return entry.depth < 3; }).map(function (entry) {
      return '<option value="' + escapeHtml(entry.task.id) + '">' + escapeHtml("  ".repeat(entry.depth) + entry.task.title) + "</option>";
    }).join("");
    select.value = state.taskParentId || "";
    document.getElementById("task-title").value = "";
    document.getElementById("task-contract").value = "";
    document.getElementById("task-lightweight").checked = false;
    openDialog("task-dialog");
    setTimeout(function () { document.getElementById("task-title").focus(); }, 0);
  }

  function openTaskAction(action, taskId) {
    var goal = selectedGoal();
    var entry = goal && flattenTasks(goal.tasks || []).find(function (row) { return row.task.id === taskId; });
    if (!entry) return;
    var task = entry.task;
    state.taskAction = { action: action, taskId: taskId };
    var completing = action === "complete";
    document.getElementById("task-action-title").textContent = t(completing ? "completeTask" : "skipTask");
    document.getElementById("task-action-context").textContent = task.title;
    var label = completing ? (task.verificationContract ? t("evidence") : t("evidenceOptional")) : t("skipReason");
    var input = document.getElementById("task-action-note");
    document.getElementById("task-action-label").textContent = label;
    input.value = "";
    input.required = !completing || Boolean(task.verificationContract);
    input.placeholder = completing && task.verificationContract ? t("evidenceRequired") : "";
    openDialog("task-action-dialog");
    setTimeout(function () { input.focus(); }, 0);
  }

  function flattenForSave(tasks, parentId, output) {
    var rows = output || [];
    (tasks || []).forEach(function (task) {
      rows.push({
        id: task.id,
        title: task.title,
        parentId: parentId || null,
        verificationContract: task.verificationContract || null,
        lightweightSubtasks: task.lightweightSubtasks === true
      });
      flattenForSave(task.subtasks || [], task.id, rows);
    });
    return rows;
  }

  function randomTaskId() {
    return "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  async function saveSettingsFromUi() {
    if (!state.settings || state.busy) return;
    var enabledNode = document.querySelector('[data-setting="auditEnabled"]');
    var modelNode = document.querySelector('[data-setting="model"]');
    var thinkingNode = document.querySelector('[data-setting="thinkingLevel"]');
    var gateNode = document.querySelector('[data-setting="defaultBlockCompletion"]');
    var next = {
      auditorEnabled: enabledNode ? enabledNode.checked : !state.settings.disabled,
      auditorModelKey: modelNode ? modelNode.value : state.settings.model || "",
      auditorEffort: thinkingNode ? thinkingNode.value : state.settings.thinkingLevel,
      defaultBlockCompletion: gateNode ? gateNode.checked : state.settings.defaultBlockCompletion
    };
    state.settingsSaveState = "saving";
    renderInspector();
    useIcons();
    try {
      await rpc("goal.settings.set", next);
      state.settings = {
        disabled: !next.auditorEnabled,
        model: next.auditorModelKey || "",
        thinkingLevel: next.auditorEffort,
        defaultBlockCompletion: next.defaultBlockCompletion
      };
      state.settingsSaveState = "saved";
      renderInspector();
      useIcons();
      setTimeout(function () {
        if (state.settingsSaveState === "saved") {
          state.settingsSaveState = "";
          renderInspector();
          useIcons();
        }
      }, 1800);
    } catch (error) {
      state.settingsSaveState = "";
      renderInspector();
      useIcons();
      showToast(t("errorPrefix") + errorMessage(error), true);
    }
  }

  document.addEventListener("click", function (event) {
    var close = event.target.closest("[data-close-dialog]");
    if (close) {
      closeDialog(close);
      return;
    }
    var listTab = event.target.closest("[data-list-mode]");
    if (listTab) {
      state.listMode = listTab.dataset.listMode;
      var list = goalList();
      state.selectedGoalId = state.listMode === "open" && state.workspace && state.workspace.focusedGoalId && list.some(function (goal) { return goal.id === state.workspace.focusedGoalId; })
        ? state.workspace.focusedGoalId
        : list.length ? list[0].id : null;
      renderAll();
      return;
    }
    var inspectorTab = event.target.closest("[data-inspector-tab]");
    if (inspectorTab) {
      state.inspectorTab = inspectorTab.dataset.inspectorTab;
      renderInspector();
      syncTabs();
      useIcons();
      return;
    }
    var goalRow = event.target.closest("[data-goal-id]");
    if (goalRow) {
      state.selectedGoalId = goalRow.dataset.goalId;
      renderGoalList();
      renderGoalMain();
      renderInspector();
      useIcons();
      return;
    }
    var button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    var action = button.dataset.action;
    var goal = selectedGoal();
    if (action === "toggle-language") {
      state.locale = state.locale === "zh" ? "en" : "zh";
      state.localeOverride = true;
      root.lang = state.locale === "zh" ? "zh-CN" : "en";
      root.dataset.lang = state.locale;
      renderAll();
    } else if (action === "refresh") {
      refresh();
    } else if (action === "toggle-inspector") {
      document.getElementById("inspector").classList.toggle("is-open");
      document.querySelector(".drawer-scrim").classList.toggle("is-open");
    } else if (action === "close-inspector") {
      document.getElementById("inspector").classList.remove("is-open");
      document.querySelector(".drawer-scrim").classList.remove("is-open");
    } else if (action === "create-goal") {
      openGoalDialog("create");
    } else if (action === "edit-goal") {
      openGoalDialog("edit");
    } else if (action === "focus-goal" && goal) {
      mutate("goal.focus", { goalId: goal.id }, t("focusedToast"));
    } else if (action === "pause-goal" && goal) {
      document.getElementById("pause-reason").value = "";
      document.getElementById("pause-action").value = "";
      openDialog("pause-dialog");
    } else if (action === "resume-goal" && goal) {
      mutate("goal.status", { goalId: goal.id, action: "resume", expectedRevision: goal.revision }, t("resumed"));
    } else if (action === "archive-goal" && goal) {
      document.getElementById("archive-reason").value = "";
      openDialog("archive-dialog");
    } else if (action === "restore-goal" && goal) {
      mutate("goal.restore", { goalId: goal.id, expectedRevision: goal.revision }, t("restored"), function () {
        state.listMode = "open";
        state.selectedGoalId = goal.id;
      });
    } else if (action === "complete-goal" && goal) {
      document.getElementById("completion-summary").value = "";
      openDialog("complete-dialog");
    } else if (action === "add-task") {
      openTaskDialog(null);
    } else if (action === "add-subtask") {
      openTaskDialog(button.dataset.taskId);
    } else if (action === "start-task" && goal) {
      mutate("goal.updateTask", { goalId: goal.id, taskId: button.dataset.taskId, status: "start", expectedRevision: goal.revision }, t("taskUpdated"));
    } else if (action === "complete-task") {
      openTaskAction("complete", button.dataset.taskId);
    } else if (action === "skip-task") {
      openTaskAction("skipped", button.dataset.taskId);
    } else if (action === "reopen-task" && goal) {
      mutate("goal.updateTask", { goalId: goal.id, taskId: button.dataset.taskId, status: "pending", expectedRevision: goal.revision }, t("taskUpdated"));
    }
  });

  document.getElementById("goal-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var goal = selectedGoal();
    var selectedMode = document.querySelector('input[name="goal-mode"]:checked');
    var budgetValue = document.getElementById("goal-budget").value.trim();
    var payload = {
      objective: document.getElementById("goal-objective").value.trim(),
      verificationContract: document.getElementById("goal-contract").value.trim() || null,
      tokenBudget: budgetValue ? Number(budgetValue) : null,
      mode: selectedMode ? selectedMode.value : "regular",
      blockCompletion: document.getElementById("goal-block-completion").checked
    };
    if (!payload.objective) return;
    document.getElementById("goal-dialog").close();
    if (state.goalDialogMode === "edit" && goal) {
      payload.goalId = goal.id;
      payload.expectedRevision = goal.revision;
      mutate("goal.edit", payload, t("edited"));
    } else {
      mutate("goal.create", payload, t("created"), function (result) {
        state.listMode = "open";
        var created = result && (result.goal || result.createdGoal || result);
        if (created && created.id) state.selectedGoalId = created.id;
      });
    }
  });

  document.getElementById("task-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var goal = selectedGoal();
    if (!goal) return;
    var items = flattenForSave(goal.tasks || []);
    items.push({
      id: randomTaskId(),
      title: document.getElementById("task-title").value.trim(),
      parentId: document.getElementById("task-parent").value || null,
      verificationContract: document.getElementById("task-contract").value.trim() || null,
      lightweightSubtasks: document.getElementById("task-lightweight").checked
    });
    if (!items[items.length - 1].title) return;
    document.getElementById("task-dialog").close();
    mutate("goal.setTasks", {
      goalId: goal.id,
      tasks: items,
      blockCompletion: goal.blockCompletion === true,
      changeSummary: "Added task " + items[items.length - 1].id,
      expectedRevision: goal.revision
    }, t("taskAdded"));
  });

  document.getElementById("pause-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var goal = selectedGoal();
    var reason = document.getElementById("pause-reason").value.trim();
    if (!goal || !reason) return;
    document.getElementById("pause-dialog").close();
    mutate("goal.status", {
      goalId: goal.id,
      action: "pause",
      reason: reason,
      suggestedAction: document.getElementById("pause-action").value.trim() || null,
      expectedRevision: goal.revision
    }, t("paused"));
  });

  document.getElementById("task-action-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var goal = selectedGoal();
    if (!goal || !state.taskAction) return;
    var note = document.getElementById("task-action-note").value.trim();
    var payload = {
      goalId: goal.id,
      taskId: state.taskAction.taskId,
      status: state.taskAction.action,
      expectedRevision: goal.revision
    };
    if (state.taskAction.action === "complete") payload.evidence = note || null;
    else payload.reason = note;
    document.getElementById("task-action-dialog").close();
    mutate("goal.updateTask", payload, t("taskUpdated"));
  });

  document.getElementById("complete-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var goal = selectedGoal();
    if (!goal || state.busy) return;
    var payload = {
      goalId: goal.id,
      completionSummary: document.getElementById("completion-summary").value.trim() || null,
      expectedRevision: goal.revision
    };
    document.getElementById("complete-dialog").close();
    setBusy(true);
    try {
      var result = await rpc("goal.complete", payload);
      var audit = result && (result.audit || result.result && result.result.audit);
      var archived = Boolean(result && (result.archived || result.result && result.result.archived));
      if (archived || audit && audit.approved) {
        state.listMode = "archived";
        state.selectedGoalId = goal.id;
      }
      setBusy(false);
      await refresh({ quiet: true, force: true });
      showToast(archived || audit && audit.approved ? t("auditApproved") : t("auditRejected"), !(archived || audit && audit.approved));
    } catch (error) {
      setBusy(false);
      showToast(t("errorPrefix") + errorMessage(error), true);
    }
  });

  document.getElementById("archive-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var goal = selectedGoal();
    if (!goal) return;
    document.getElementById("archive-dialog").close();
    mutate("goal.archive", {
      goalId: goal.id,
      reason: document.getElementById("archive-reason").value.trim() || "archived_by_user",
      expectedRevision: goal.revision
    }, t("archivedToast"));
  });

  document.getElementById("inspector-content").addEventListener("change", function (event) {
    if (event.target.matches("[data-setting]")) saveSettingsFromUi();
  });

  function syncDockedMode() {
    var raw = (getComputedStyle(root).getPropertyValue("--pi-plugin-titlebar-height") || "").trim();
    document.body.classList.toggle("is-docked", raw === "0px" || raw === "0");
  }

  function localeFromHost(value) {
    return String(value || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function applyHostLocale(locale) {
    if (state.localeOverride) return;
    var next = localeFromHost(locale);
    if (next === state.locale) return;
    state.locale = next;
    root.lang = next === "zh" ? "zh-CN" : "en";
    root.dataset.lang = next;
    if (state.loaded) renderAll();
  }

  function initAppearance() {
    if (window.__appearance && typeof window.__appearance.init === "function") {
      window.__appearance.init(bridge);
      if (typeof window.__appearance.onLocaleChange === "function") {
        window.__appearance.onLocaleChange(applyHostLocale);
      }
      var current = typeof window.__appearance.current === "function" ? window.__appearance.current() : null;
      if (current && current.locale) applyHostLocale(current.locale);
    }
    syncDockedMode();
    window.addEventListener("resize", syncDockedMode);
  }

  function findMockGoal(id, archived) {
    var list = archived ? mock.workspace.archivedGoals : mock.workspace.goals;
    return list.find(function (goal) { return goal.id === id; });
  }

  function mockActivity(goal, type, message) {
    goal.activity = goal.activity || [];
    goal.activity.unshift({ id: "event-" + Date.now().toString(36), type: type, message: message, at: nowIso(0) });
    goal.updatedAt = nowIso(0);
    goal.revision = (goal.revision || 0) + 1;
    mock.workspace.updatedAt = goal.updatedAt;
  }

  function mockTask(goal, id) {
    var entry = flattenTasks(goal.tasks || []).find(function (row) { return row.task.id === id; });
    if (!entry) throw new Error("Task not found: " + id);
    return entry.task;
  }

  function buildMockTree(items) {
    var nodes = new Map();
    (items || []).forEach(function (item) {
      var node = clone(item);
      var existing = null;
      mock.workspace.goals.concat(mock.workspace.archivedGoals).some(function (goal) {
        var found = flattenTasks(goal.tasks || []).find(function (entry) { return entry.task.id === item.id; });
        if (found) existing = found.task;
        return Boolean(found);
      });
      node.status = existing ? existing.status : "pending";
      node.evidence = existing ? existing.evidence || null : null;
      node.skipReason = existing ? existing.skipReason || null : null;
      node.subtasks = [];
      nodes.set(node.id, node);
    });
    var roots = [];
    (items || []).forEach(function (item) {
      var node = nodes.get(item.id);
      var parentId = item.parentId || item.parent_id;
      if (parentId && nodes.has(parentId)) nodes.get(parentId).subtasks.push(node);
      else roots.push(node);
    });
    return roots;
  }

  async function mockInvoke(channel, payload) {
    await new Promise(function (resolve) { setTimeout(resolve, 55); });
    var goal;
    if (channel === "goal.state") return { workspace: clone(mock.workspace), descriptor: { key: mock.workspace.key, name: mock.workspace.name, hasWorkspace: true } };
    if (channel === "goal.settings.get") return { settings: clone(mock.settings), models: clone(mock.models) };
    if (channel === "goal.settings.set") {
      mock.settings = Object.assign({}, mock.settings, clone(payload));
      return { settings: clone(mock.settings), models: clone(mock.models) };
    }
    if (channel === "goal.create") {
      goal = {
        id: "goal-" + Date.now().toString(36), objective: payload.objective, mode: payload.mode || "regular", status: "active", revision: 0,
        verificationContract: payload.verificationContract || null, tokenBudget: payload.tokenBudget || null, blockCompletion: payload.blockCompletion === true,
        tasks: [], currentTaskId: null, audits: [], activity: [], usage: { activeSeconds: 0 }, activeSince: nowIso(0), createdAt: nowIso(0), updatedAt: nowIso(0)
      };
      mockActivity(goal, "created", "Goal created and focused.");
      mock.workspace.goals.unshift(goal);
      mock.workspace.focusedGoalId = goal.id;
      return { goal: clone(goal) };
    }
    if (channel === "goal.focus") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      mock.workspace.focusedGoalId = goal.id;
      return { goal: clone(goal) };
    }
    if (channel === "goal.edit") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      ["objective", "verificationContract", "tokenBudget", "mode", "blockCompletion"].forEach(function (key) {
        if (payload[key] !== undefined) goal[key] = payload[key];
      });
      mockActivity(goal, "edited", "Goal definition updated.");
      return { goal: clone(goal) };
    }
    if (channel === "goal.status") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      if (payload.action === "pause") {
        goal.status = "paused";
        goal.pauseReason = payload.reason;
        goal.suggestedAction = payload.suggestedAction || null;
        mockActivity(goal, "paused", "Goal paused.");
      } else {
        goal.status = "active";
        goal.pauseReason = null;
        goal.suggestedAction = null;
        goal.activeSince = nowIso(0);
        mock.workspace.focusedGoalId = goal.id;
        mockActivity(goal, "resumed", "Goal resumed.");
      }
      return { goal: clone(goal) };
    }
    if (channel === "goal.setTasks") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      goal.tasks = buildMockTree(payload.tasks);
      goal.blockCompletion = payload.blockCompletion === true;
      mockActivity(goal, "tasks_set", "Task plan updated.");
      return { goal: clone(goal) };
    }
    if (channel === "goal.updateTask") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      var task = mockTask(goal, payload.taskId);
      if (payload.status === "start") goal.currentTaskId = task.id;
      else if (payload.status === "complete") {
        if (task.verificationContract && !payload.evidence) throw new Error("Evidence is required by the verification contract.");
        task.status = "complete";
        task.evidence = payload.evidence || null;
        task.completedAt = nowIso(0);
        if (goal.currentTaskId === task.id) goal.currentTaskId = null;
      } else if (payload.status === "skipped") {
        if (!payload.reason) throw new Error("A skip reason is required.");
        task.status = "skipped";
        task.skipReason = payload.reason;
        task.skippedAt = nowIso(0);
        if (goal.currentTaskId === task.id) goal.currentTaskId = null;
      } else {
        task.status = "pending";
        task.evidence = null;
        task.skipReason = null;
      }
      mockActivity(goal, "task_progress", "Task progress updated.");
      return { goal: clone(goal) };
    }
    if (channel === "goal.archive") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      mock.workspace.goals = mock.workspace.goals.filter(function (entry) { return entry.id !== goal.id; });
      goal.status = "archived";
      goal.archiveReason = payload.reason || "archived_by_user";
      goal.currentTaskId = null;
      mockActivity(goal, "archived", "Goal archived.");
      mock.workspace.archivedGoals.unshift(goal);
      if (mock.workspace.focusedGoalId === goal.id) mock.workspace.focusedGoalId = null;
      return { goal: clone(goal) };
    }
    if (channel === "goal.restore") {
      goal = findMockGoal(payload.goalId, true);
      if (!goal) throw new Error("Goal not found");
      mock.workspace.archivedGoals = mock.workspace.archivedGoals.filter(function (entry) { return entry.id !== goal.id; });
      goal.status = "paused";
      goal.completedAt = null;
      goal.archiveReason = null;
      goal.pauseReason = "Restored from archive. Resume when ready.";
      mockActivity(goal, "restored", "Goal restored from archive.");
      mock.workspace.goals.unshift(goal);
      mock.workspace.focusedGoalId = goal.id;
      return { goal: clone(goal) };
    }
    if (channel === "goal.complete") {
      goal = findMockGoal(payload.goalId, false);
      if (!goal) throw new Error("Goal not found");
      var stats = goalStats(goal);
      if (goal.blockCompletion && stats.pending) throw new Error(stats.pending + " tasks are still pending.");
      var audit = { id: "audit-" + Date.now().toString(36), approved: true, skipped: mock.settings.auditorEnabled === false, modelKey: mock.settings.auditorModelKey || null, report: "The objective and available evidence satisfy the completion contract.", at: nowIso(0) };
      goal.audits.unshift(audit);
      goal.status = "complete";
      goal.completedAt = nowIso(0);
      mockActivity(goal, "completed", "Goal completed after audit approval.");
      mock.workspace.goals = mock.workspace.goals.filter(function (entry) { return entry.id !== goal.id; });
      mock.workspace.archivedGoals.unshift(goal);
      if (mock.workspace.focusedGoalId === goal.id) mock.workspace.focusedGoalId = null;
      return { approved: true, archived: true, audit: clone(audit) };
    }
    if (channel === "app.getAppearance") return { base: root.dataset.theme, locale: state.locale === "zh" ? "zh-CN" : "en" };
    throw new Error("Unsupported mock channel: " + channel);
  }

  initAppearance();
  renderGoalMain();
  useIcons();
  refresh({ quiet: true, force: true });
})();
