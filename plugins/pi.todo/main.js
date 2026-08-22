/**
 * 小清新待办 — PI-Desktop 官方插件 entry.
 *
 * 插件 id: pi.todo
 * 命令 id: todo.open
 * agent 工具: todo_manage
 *
 * 数据模型（与面板共享）：
 *   settings.json = { todos: [...], todosUpdatedAt: <ms> }
 *   todo = { id, text, done, q(1-4), createdAt, doneAt, due(ms|null), reminded }
 *
 * 权威数据源为插件数据目录 settings.json（pi.plugin.getSettings/setSettings）。
 * 面板经 onPanelInvoke 的 "todo.sync" 通道把本地修改同步到插件进程；
 * agent 工具直接读写 settings.json —— 两条路径共用同一份数据。
 *
 * 权限说明：
 * - ui.panel：面板入口（manifest.ui.panel）
 * - notify：面板到期提醒经 pluginBridge.invoke 调宿主通知 API
 *   （ui.showNativeNotification 原生系统通知、ui.notify 应用内 toast、
 *   ui.getNotificationPermission 权限查询；渲染端调用，宿主在
 *   invokePanelBridge 中校验该权限）
 * - background.service：托管常驻后台服务 due-reminder —— 面板关闭时
 *   由插件进程主线程按最近到期时间调度检查，到期任务经
 *   pi.ui.showNativeNotification 发原生系统通知（无窗口状态限制，
 *   宿主 ADR 0074），与渲染端共用 reminded 字段去重，不重复提醒。
 * - agent.tool.register：注册 agent 工具 todo_manage（AI 管理待办）
 */

const TODO_ACTIONS = ["list", "add", "split", "complete", "uncomplete", "delete", "clear_done", "clear_overdue", "extend"];

/** setTimeout 上限（约 24.8 天）；到期任务比这更远时按上限分次重排 */
const REMINDER_MAX_TIMEOUT_MS = 2147483647;

async function loadTodos() {
  try {
    const settings = await pi.plugin.getSettings();
    if (Array.isArray(settings.todos)) return settings.todos;
  } catch (e) { /* 无设置时返回空 */ }
  return [];
}

async function saveTodos(todos) {
  await pi.plugin.setSettings({ todos: todos, todosUpdatedAt: Date.now() });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 模糊归一化：小写、去空白与标点，用于不精确匹配 */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s，。、；：！？,.!?;:'"“”‘’（）()\-—_·…\t\r\n]/g, "");
}

/** 模糊匹配：归一化后互相包含即命中 */
function fuzzyMatch(todo, query) {
  const nq = normalize(query);
  if (!nq) return false;
  const nt = normalize(todo.text);
  return nt.includes(nq) || nq.includes(nt);
}

function parseDue(due) {
  if (!due) return null;
  const ms = new Date(due).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function publicTodo(t) {
  return {
    id: t.id,
    text: t.text,
    done: !!t.done,
    q: t.q || 2,
    due: t.due || null,
    createdAt: t.createdAt || 0,
    doneAt: t.doneAt || 0,
  };
}

function summarize(todos) {
  return todos.map(publicTodo);
}

/** 按大段文本拆分任务：优先换行，其次句号/分号/顿号/逗号 */
function splitText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const chunks = raw.split(/[。；;]+/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length > 1) return chunks;
  const commas = raw.split(/[，,、]+/).map((s) => s.trim()).filter(Boolean);
  return commas.length > 1 ? commas : [raw];
}

async function runTodoAction(args) {
  const action = String(args.action || "");
  if (!TODO_ACTIONS.includes(action)) {
    return { ok: false, error: "未知 action: " + action };
  }

  let todos = await loadTodos();
  const now = Date.now();

  switch (action) {
    case "list": {
      const filter = String(args.filter || "all");
      let items = todos.slice();
      if (filter === "active") items = items.filter((t) => !t.done);
      else if (filter === "done") items = items.filter((t) => t.done);
      else if (filter === "overdue") items = items.filter((t) => !t.done && t.due && t.due < now);
      items.sort((a, b) => (a.done - b.done) || (b.createdAt - a.createdAt));
      const activeCount = todos.filter((t) => !t.done).length;
      const overdueCount = todos.filter((t) => !t.done && t.due && t.due < now).length;
      return {
        ok: true,
        action: "list",
        total: todos.length,
        active: activeCount,
        done: todos.length - activeCount,
        overdue: overdueCount,
        todos: summarize(items),
      };
    }

    case "add": {
      const text = String(args.text || "").trim();
      if (!text) return { ok: false, error: "缺少 text" };
      const q = [1, 2, 3, 4].includes(Number(args.q)) ? Number(args.q) : 2;
      const due = parseDue(args.due);
      const todo = { id: uid(), text, done: false, q, createdAt: now, doneAt: 0, due, reminded: false };
      todos.unshift(todo);
      await saveTodos(todos);
      return { ok: true, action: "add", added: publicTodo(todo), total: todos.length };
    }

    case "split": {
      const parts = splitText(args.text);
      if (!parts.length) return { ok: false, error: "缺少 text" };
      const q = [1, 2, 3, 4].includes(Number(args.q)) ? Number(args.q) : 2;
      const due = parseDue(args.due);
      const added = [];
      parts.forEach((p) => {
        const todo = { id: uid(), text: p, done: false, q, createdAt: Date.now(), doneAt: 0, due, reminded: false };
        todos.unshift(todo);
        added.push(publicTodo(todo));
      });
      await saveTodos(todos);
      return { ok: true, action: "split", count: added.length, added, total: todos.length };
    }

    case "complete":
    case "uncomplete": {
      const query = String(args.text || "").trim();
      if (!query) return { ok: false, error: "缺少 text（要匹配的任务内容）" };
      const matched = todos.filter((t) => fuzzyMatch(t, query));
      if (!matched.length) {
        return { ok: false, error: "没有匹配到任务（试试更短的关键词）", hint: summarize(todos.slice(0, 10)) };
      }
      const target = action === "complete";
      matched.forEach((t) => {
        t.done = target;
        t.doneAt = target ? Date.now() : 0;
      });
      await saveTodos(todos);
      return {
        ok: true,
        action,
        matched: matched.map(publicTodo),
        count: matched.length,
        message: target
          ? "已将 " + matched.length + " 项标记完成：" + matched.map((t) => "「" + t.text + "」").join("、")
          : "已将 " + matched.length + " 项标记为未完成",
      };
    }

    case "delete": {
      const query = String(args.text || "").trim();
      if (!query) return { ok: false, error: "缺少 text（要删除的任务内容）" };
      const before = todos.length;
      const removed = todos.filter((t) => fuzzyMatch(t, query));
      if (!removed.length) {
        return { ok: false, error: "没有匹配到任务（试试更短的关键词）", hint: summarize(todos.slice(0, 10)) };
      }
      todos = todos.filter((t) => !removed.includes(t));
      await saveTodos(todos);
      return {
        ok: true,
        action: "delete",
        removed: removed.map(publicTodo),
        count: before - todos.length,
      };
    }

    case "clear_done": {
      const removed = todos.filter((t) => t.done);
      todos = todos.filter((t) => !t.done);
      await saveTodos(todos);
      return { ok: true, action: "clear_done", removed: removed.length, total: todos.length };
    }

    case "clear_overdue": {
      const removed = todos.filter((t) => !t.done && t.due && t.due < now);
      todos = todos.filter((t) => !removed.includes(t));
      await saveTodos(todos);
      return {
        ok: true,
        action: "clear_overdue",
        removed: removed.length,
        removedItems: removed.map(publicTodo),
        total: todos.length,
      };
    }

    case "extend": {
      const query = String(args.text || "").trim();
      if (!query) return { ok: false, error: "缺少 text（要延期的任务内容）" };
      const due = parseDue(args.due);
      if (!due) return { ok: false, error: "缺少有效的 due（ISO 时间）" };
      const matched = todos.filter((t) => fuzzyMatch(t, query));
      if (!matched.length) {
        return { ok: false, error: "没有匹配到任务（试试更短的关键词）", hint: summarize(todos.slice(0, 10)) };
      }
      matched.forEach((t) => {
        t.due = due;
        t.reminded = false;
      });
      await saveTodos(todos);
      return {
        ok: true,
        action: "extend",
        due: new Date(due).toISOString(),
        matched: matched.map(publicTodo),
        count: matched.length,
      };
    }

    default:
      return { ok: false, error: "未支持的操作" };
  }
}

/* ------------------------- 后台提醒服务（due-reminder） -------------------------
 *
 * 宿主通过 contributes.services + background.service 权限托管该服务：
 * onLoad 完成后自动调用 start()，面板关闭进程仍常驻；崩溃由宿主退避重启；
 * unload 前自动调用 stop()（宿主 ADR 0040 / plugin-runtime.ts）。
 *
 * 与渲染端共享同一份 settings.json 与 reminded 字段：
 * - 主进程与渲染端都只提醒 `!done && !reminded && due <= now` 的任务；
 * - 任一端提醒成功后都会把 reminded 置位并写回权威数据源，
 *   另一端读取时即跳过——天然去重，不重复通知。
 * - 渲染端负责面板打开期间的即时提醒；本服务兜底面板关闭期间的到期提醒，
 *   经 pi.ui.showNativeNotification 发原生系统通知（无窗口状态限制，
 *   宿主 ADR 0074），权限 manifest 已声明 notify。
 */

let reminderTimer = null;

/** 单一定时器调度：按最近未提醒的到期时间触发一次 → 触发后重排 */
async function scheduleNextReminder(log) {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
  let todos = [];
  try {
    todos = await loadTodos();
  } catch (e) {
    return;
  }
  let next = null;
  for (const t of todos) {
    if (t.done || t.reminded || !t.due) continue;
    if (next === null || t.due < next) next = t.due;
  }
  if (next === null) return; // 没有待提醒任务：完全空闲，零开销
  const delay = Math.max(0, Math.min(next - Date.now(), REMINDER_MAX_TIMEOUT_MS));
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    void fireDueReminders(log).then(() => scheduleNextReminder(log));
  }, delay + 50);
}

/** 找出已到期且未提醒的任务 → 标记 reminded 写回 → 发原生通知（含降级） */
async function fireDueReminders(log) {
  let todos = [];
  try {
    todos = await loadTodos();
  } catch (e) {
    return;
  }
  const now = Date.now();
  const due = todos.filter((t) => !t.done && !t.reminded && t.due && t.due <= now);
  if (!due.length) return;
  due.forEach((t) => { t.reminded = true; });
  try {
    await saveTodos(todos); // 先写回再通知，重启/崩溃不重复提醒
  } catch (e) {
    return;
  }
  const names = due.slice(0, 3).map((t) => t.text).join("、");
  // 通知文案跟随宿主语言（与渲染端 i18n 风格一致）；查询失败默认中文
  let zh = true;
  try {
    const locale = String(await pi.app.getLocale() || "").toLowerCase();
    zh = locale.startsWith("zh");
  } catch (e) { /* 保持默认中文 */ }
  const title = zh
    ? (due.length > 1 ? (names + " 等 " + due.length + " 项到期") : (names + " 到期了"))
    : (due.length > 1 ? (names + " and " + due.length + " more due") : (names + " is due"));
  try {
    const res = await pi.ui.showNativeNotification({ title, body: zh ? "小清新待办" : "Todo List" });
    if (!res || !res.shown) {
      await pi.ui.notify({ title, body: zh ? "小清新待办" : "Todo List" }).catch(() => {});
    }
  } catch (e) {
    try { await pi.ui.notify({ title, body: zh ? "小清新待办" : "Todo List" }).catch(() => {}); } catch (e2) { /* 忽略 */ }
  }
}

function stopReminderService() {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
}

async function onLoad() {
  await pi.commands.register({
    id: "todo.open",
    title: "小清新待办：打开面板",
    keywords: ["todo", "待办", "清单", "任务", "官方"],
    run: async () => {
      await pi.ui.openPanel();
    },
  });

  await pi.agent.registerTool({
    name: "todo_manage",
    description: "管理 PI-Desktop 待办（pi.todo 插件）的任务列表。支持：list 查询任务（filter: all/active/done/overdue）；add 添加一条（text，可选 q 象限 1-4、due 到期时间 ISO）；split 将一大段文本按行/句号/逗号拆分为多条任务；complete 按模糊文本匹配并标记完成（匹配不精确，含空白/标点容错）；uncomplete 撤销完成；delete 按模糊文本删除；clear_done 清空所有已完成；clear_overdue 清空所有过期未完成任务；extend 按模糊文本匹配任务并将到期时间改为 due（ISO）。操作基于同一份本地数据（插件数据目录 settings.json），与待办面板实时共享。",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: TODO_ACTIONS,
          description: "要执行的操作",
        },
        text: {
          type: "string",
          description: "add/split 的任务内容；complete/uncomplete/delete/extend 的模糊匹配文本",
        },
        due: {
          type: "string",
          description: "到期时间 ISO 字符串（如 2026-08-15T18:00:00），add/extend 使用",
        },
        q: {
          type: "integer",
          enum: [1, 2, 3, 4],
          description: "象限：1 重要紧急 / 2 重要不紧急 / 3 紧急不重要 / 4 不重要不紧急（默认 2）",
        },
        filter: {
          type: "string",
          enum: ["all", "active", "done", "overdue"],
          description: "list 的过滤条件（默认 all）",
        },
      },
      required: ["action"],
    },
    execute: async (args) => runTodoAction(args || {}),
  });

  // 托管常驻后台服务：面板关闭时由宿主保持插件进程运行并驱动 start/stop
  // （contributes.services + background.service 权限）。到期提醒靠该服务
  // 兜底——面板未打开也能发原生系统通知；渲染端打开时继续负责即时提醒，
  // 双方共用 reminded 字段去重。
  pi.services.register({
    id: "due-reminder",
    start: ({ log }) => {
      log("due-reminder service started");
      scheduleNextReminder(log).catch(() => {});
    },
    stop: () => {
      stopReminderService();
    },
  });
}

/**
 * 面板 → 插件进程通道（宿主把 skill.* 白名单通道转到这里）。
 * "todo.sync"：面板把本地任务列表同步到权威数据源（settings.json）。
 */
async function onPanelInvoke(channel, payload) {
  if (channel === "todo.sync" && payload && Array.isArray(payload.todos)) {
    await saveTodos(payload.todos);
    return { ok: true };
  }
  throw new Error("unsupported panel channel: " + channel);
}

async function onUnload() {
  stopReminderService();
  try {
    await pi.services.unregister("due-reminder");
  } catch (e) { /* 宿主已在 unload 前置停服务，注销失败可忽略 */ }
  await pi.commands.unregister("todo.open");
  await pi.agent.unregisterTool("todo_manage");
}

module.exports = { onLoad, onUnload, onPanelInvoke };
