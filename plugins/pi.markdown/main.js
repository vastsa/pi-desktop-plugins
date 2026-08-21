/**
 * Pi Markdown — PI-Desktop 本地 Markdown 笔记插件（主进程）。
 *
 * 插件 id: local.pi-markdown
 * 命令 id: pi-markdown.open
 * Agent 工具: open_file（经宿主 pi.fs 网关读写用户选定目录内的文件）
 *
 * 数据模型（与面板共享）：
 *   settings.json = { tree: TreeNode[], activeNoteId: string|null,
 *                     theme: 'light'|'dark', themeSource: 'host'|'manual',
 *                     updatedAt: <ms> }
 *   TreeNode = { id, type:'folder', name, children[] } | { id, type:'note', title, content, updatedAt }
 *
 * 权威数据源 = 插件数据目录 settings.json（pi.plugin.getSettings/setSettings）。
 * 面板经 onPanelInvoke 的 "note.sync" 通道把整棵树同步到插件进程；
 * "store.path" 通道向面板返回数据目录（用于状态栏展示）。
 * 写操作在插件进程串行化（promise 队列），避免并发 merge 丢失更新。
 *
 * 外部文件会话（v0.4.x，Agent 工具 open_file）：
 *   execute 校验绝对路径 → 确保本会话用户已选定目录（fs.requestDirectory，
 *   userSelected 根，仅存内存）→ 经 pi.fs.readText 读取（文件必须在选定目录内）→
 *   pendingExternalFile → 面板轮询 file.pull 取走 → activeExternalFile
 *   （file.pull 每次刷新 lastSeenAt 作为心跳）→ 面板 file.save 经 pi.fs.writeText
 *   写回 / file.exit 退出会话。
 *   单槽位：已有 pending 或 60s 内活跃的 active 时，新工具调用返回 CONFLICT；
 *   心跳停止超过 60s 视为陈旧，允许新调用接管（如面板窗口被关闭）。
 *   文件内容读写一律走宿主 pi.fs 权限网关（manifest.fs 声明 userSelected 根，
 *   目录由用户在原生选择器中选定；网关负责真实路径/符号链接越界校验、
 *   凭据路径拒绝与审计），插件进程不再直接 fs.readFile/writeFile 正文。
 *
 * 语言/主题适配（宿主接口）：
 * - pi.app.getLocale() 驱动命令标题、面板标题与工具提示的语言；
 * - manifest.ui.title 声明 { en, "zh-CN" } 双语标题，宿主按界面语言解析；
 * - 面板默认跟随宿主主题（宿主经 --pi-plugin-panel-theme 注入，
 *   渲染端读取 pi-plugin-panel-titlebar[data-theme]），面板内切换为手动覆盖，
 *   以 themeSource: 'manual' 持久化。
 *
 * 权限说明：
 * - ui.panel：面板入口（manifest.ui.panel）
 * - agent.prompt.inject：contributes.skills 索引需要
 * - agent.tool.register：open_file 工具注册（高风险，安装时确认）
 * - fs.read / fs.write：open_file 经 pi.fs 网关读写用户选定目录（userSelected 根）
 */

const path = require("path");

const MAX_TREE_BYTES = 20 * 1024 * 1024; // 全量数据上限 20MB
const MAX_NODES = 20000;

/* ---------- 外部文件（Agent 工具）常量 ---------- */
const EXTERNAL_TOOL_NAME = "open_file";
const EXTERNAL_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_EXTERNAL_BYTES = 5 * 1024 * 1024; // 单文件上限 5MB
const EXTERNAL_STALE_MS = 60 * 1000; // 心跳超时 60s → 允许新工具调用接管

/** 宿主当前亮暗 base（官方外观通道读取；旧版宿主为 null） */
let hostBase = null;

/** 本会话用户选定的目录（userSelected 根，仅存内存，进程退出即失效） */
let userRoot = null;

/** 待面板拉取的外部文件（工具调用成功、面板尚未取走） */
let pendingExternalFile = null;
/** 正在编辑的外部文件；面板每次 file.pull 刷新 lastSeenAt（心跳） */
let activeExternalFile = null;

/* ---------- 语言（宿主接口 pi.app.getLocale） ---------- */
let uiLocale = "zh-CN";

function isZhLocale() {
  return String(uiLocale || "").toLowerCase().startsWith("zh");
}

/** 按界面语言二选一（中文默认） */
function pick(zh, en) {
  return isZhLocale() ? zh : en;
}

/** 数据校验：节点结构必须合法，防止损坏数据写盘 */
function validateNode(node, depth) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "note") {
    return (
      typeof node.id === "string" &&
      node.id.length > 0 &&
      typeof node.title === "string" &&
      typeof node.content === "string" &&
      typeof node.updatedAt === "number"
    );
  }
  if (node.type === "folder") {
    if (typeof node.id !== "string" || node.id.length === 0) return false;
    if (typeof node.name !== "string") return false;
    if (depth > 32) return false; // 防御：层级上限
    return (
      Array.isArray(node.children) &&
      node.children.every((child) => validateNode(child, depth + 1))
    );
  }
  return false;
}

function validateTree(tree) {
  return (
    Array.isArray(tree) &&
    tree.length <= MAX_NODES &&
    tree.every((node) => validateNode(node, 0))
  );
}

/** 写队列：所有 setSettings 串行执行 */
let writeChain = Promise.resolve();

/**
 * 宿主把面板桥接的 skill.* 通道原样转发到这里：
 * 面板 invoke("skill.setEnabled", { id: "note.sync", ... }) 时，
 * 本函数收到 channel="skill.setEnabled"、payload.id="note.sync"；
 * 同时兼容宿主未来直接传自定义通道名的形式。
 */
function normalizeChannel(channel, payload) {
  if (
    channel === "skill.setEnabled" &&
    payload &&
    typeof payload.id === "string" &&
    payload.id
  ) {
    return payload.id;
  }
  return channel;
}

/** 宿主风格错误：err.code 随 IPC 原样返回（面板/Agent 可读） */
function apiError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isAbsolutePath(p) {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

/** 心跳超时的活动会话让位（例如面板窗口被关闭后不再刷新心跳） */
function expireStaleExternal() {
  if (
    activeExternalFile &&
    Date.now() - activeExternalFile.lastSeenAt > EXTERNAL_STALE_MS
  ) {
    activeExternalFile = null;
  }
}

/**
 * 确保本会话已选定目录（host fs 网关的 userSelected 根）。
 * 用户在原生目录选择器中确认；取消则抛 CANCELLED。
 * 每次调用可重新选择（requestDirectory 会替换旧的根）。
 */
async function ensureUserRoot() {
  if (userRoot) return userRoot;
  const picked = await pi.fs.requestDirectory();
  if (!picked || !picked.path) {
    throw apiError(
      "CANCELLED",
      pick(
        "已取消选择目录，open_file 无法打开文件（文件必须位于您选定的目录内）",
        "Directory selection cancelled; open_file needs a directory you pick (files must live inside it)",
      ),
    );
  }
  userRoot = picked.path;
  return userRoot;
}

/** 绝对路径 → userSelected 根内相对路径；越界/非法直接报错 */
function relWithinRoot(target) {
  const root = userRoot;
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw apiError(
      "INVALID_ARGUMENT",
      pick(
        `文件不在已选定的目录内：${target}（请选择包含该文件的目录）`,
        `File is outside the chosen directory: ${target}`,
      ),
    );
  }
  return rel.split(path.sep).join("/");
}

/* ---------- Agent 工具：按绝对路径打开单个文件编辑（单文件模式） ---------- */
async function openFileTool(args) {
  const target = typeof args?.path === "string" ? args.path.trim() : "";
  if (!target) throw apiError("INVALID_ARGUMENT", pick("path 参数不能为空", "path must not be empty"));
  if (!isAbsolutePath(target)) {
    throw apiError("INVALID_ARGUMENT", pick("path 必须是绝对路径", "path must be an absolute path"));
  }

  // 仅做元数据校验（存在性/常规文件/大小），正文读取走宿主 pi.fs 网关
  let stat;
  try {
    stat = await require("fs").promises.stat(target);
  } catch {
    throw apiError("NOT_FOUND", pick(`文件不存在或无法访问：${target}`, `File not found or unreadable: ${target}`));
  }
  if (!stat.isFile()) {
    throw apiError("INVALID_ARGUMENT", pick("目标不是常规文件（可能是目录）", "Target is not a regular file (it may be a directory)"));
  }

  const ext = path.extname(target).toLowerCase();
  if (!EXTERNAL_EXTENSIONS.has(ext)) {
    throw apiError(
      "INVALID_ARGUMENT",
      pick(
        `不支持的文件类型 ${ext || "(无扩展名)"}（仅支持 .md / .markdown / .txt）`,
        `Unsupported file type ${ext || "(none)"} (only .md / .markdown / .txt)`,
      ),
    );
  }
  if (stat.size > MAX_EXTERNAL_BYTES) {
    throw apiError(
      "LIMIT_EXCEEDED",
      pick(
        `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限`,
        `File ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds the 5MB limit`,
      ),
    );
  }

  expireStaleExternal();
  if (pendingExternalFile) {
    throw apiError("CONFLICT", pick("已有待打开的文件，请稍后再试", "A file is already pending, try again later"));
  }
  if (activeExternalFile) {
    throw apiError(
      "CONFLICT",
      pick(
        `已有文件正在编辑：${activeExternalFile.path}（请先点击面板「返回笔记」或稍候）`,
        `Already editing: ${activeExternalFile.path} (exit the single-file mode in the panel first)`,
      ),
    );
  }

  // 第一次使用时请用户选定目录（会话级授权，仅存内存）
  await ensureUserRoot();
  const rel = relWithinRoot(target);

  // 正文读取经宿主 pi.fs 网关（userSelected 根；凭据类路径、越界由网关拒绝）
  let raw;
  try {
    raw = await pi.fs.readText(rel);
  } catch (err) {
    const code = err?.code ?? "INTERNAL";
    if (code === "NOT_FOUND") {
      throw apiError("NOT_FOUND", pick(`文件不存在或无法访问：${target}`, `File not found or unreadable: ${target}`));
    }
    if (code === "PERMISSION_DENIED") {
      throw apiError(
        "PERMISSION_DENIED",
        pick(`没有权限读取该文件：${target}`, `Permission denied reading: ${target}`),
      );
    }
    throw err;
  }
  // 保留 BOM 判定：utf8 解码后剥掉 BOM；写回时按原样还原
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const content = hasBom ? raw.slice(1) : raw;
  if (content.includes("\u0000")) {
    throw apiError("INVALID_ARGUMENT", pick("文件包含 NUL 字节，疑似二进制，拒绝打开", "File contains NUL bytes (binary); refusing to open"));
  }
  if (Buffer.byteLength(content, "utf8") > MAX_EXTERNAL_BYTES) {
    throw apiError(
      "LIMIT_EXCEEDED",
      pick("文件内容超过 5MB 上限，拒绝打开", "File content exceeds the 5MB limit"),
    );
  }

  pendingExternalFile = {
    path: target,
    name: path.basename(target),
    content,
    hasBom,
    bytes: stat.size,
  };
  await pi.ui.openPanel({
    title: pick("Pi Markdown 笔记", "Pi Markdown") + " — " + pendingExternalFile.name,
  });
  return {
    ok: true,
    path: target,
    name: pendingExternalFile.name,
    size: stat.size,
    chars: content.length,
    hint: pick(
      "文件已在 Pi Markdown 面板中打开（单文件模式，目录由您选定），编辑会自动保存回原文件",
      "The file is open in the Pi Markdown panel (single-file mode, in the directory you picked); edits save back automatically",
    ),
  };
}

async function onLoad() {
  // 语言：宿主接口 pi.app.getLocale()（跟随宿主界面语言设置）
  try {
    uiLocale = (await pi.app.getLocale()) || "zh-CN";
  } catch {
    uiLocale = "zh-CN";
  }

  // 外观（官方通道，PI-Desktop ≥ 0.7.1）：记录宿主当前亮暗 base；
  // 旧版宿主无 app.getAppearance 时保持 null，外观由面板降级处理。
  try {
    if (typeof pi.app.getAppearance === "function") {
      const appearance = await pi.app.getAppearance();
      if (appearance && typeof appearance === "object") {
        hostBase = appearance.base === "dark" ? "dark" : "light";
      }
    }
  } catch {
    hostBase = null;
  }

  // 收敛（shell 注释承诺的行为）：未手动覆盖时把 settings.theme 同步为宿主
  // base，使 bundle 下次挂载/同步拿到一致的主题（appearance.sync 通道为
  // 面板侧实时收敛的补充路径）。
  if (hostBase) {
    try {
      const settings = await pi.plugin.getSettings().catch(() => ({}));
      if (settings.themeSource !== "manual") {
        await pi.plugin.setSettings({
          theme: hostBase,
          themeSource: "host",
          updatedAt: Date.now(),
        });
      }
    } catch {
      /* 旧版宿主/写入失败：保持现状 */
    }
  }

  await pi.commands.register({
    id: "pi-markdown.open",
    title: pick("Pi Markdown：打开笔记", "Pi Markdown: Open Notes"),
    keywords: ["markdown", "笔记", "note", "md"],
    category: "Productivity",
    run: async () => {
      // 不传 title：由宿主导用 manifest.ui.title 的本地化标题
      await pi.ui.openPanel();
    },
  });

  await pi.agent.registerTool({
    name: EXTERNAL_TOOL_NAME,
    description: pick(
      "打开一个 Markdown/纯文本文件（绝对路径）在 Pi Markdown 面板中编辑：仅打开指定文件，不显示文档列表、不允许切换其他文件，编辑内容自动保存回原文件。首次调用会弹出目录选择器，请用户选定一个目录——只能打开该目录内的文件；若文件不在已选定目录内会报错。仅支持 .md/.markdown/.txt。",
      "Open one Markdown/text file (absolute path) in the Pi Markdown panel for editing: only that file is shown (no document list, no switching), and edits save back automatically. The first call pops a native directory picker — the user chooses a directory and only files inside it can be opened. Supports .md/.markdown/.txt only.",
    ),
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: pick(
            "文件的绝对路径（Windows 如 C:\\docs\\a.md；macOS/Linux 如 /Users/me/a.md）。文件必须在用户选定的目录内，否则调用会失败",
            "Absolute path of the file (Windows: C:\\docs\\a.md; macOS/Linux: /Users/me/a.md). The file must be inside the directory the user picked, or the call fails",
          ),
        },
      },
      required: ["path"],
    },
    execute: openFileTool,
  });
}

async function onPanelInvoke(channel, payload) {
  const name = normalizeChannel(channel, payload);

  if (name === "app.getLocale") {
    return { ok: true, locale: uiLocale };
  }

  // 面板外观适配器触发：把宿主 base 收敛到 settings.theme（用户未手动覆盖时）。
  if (name === "appearance.sync") {
    // 读取最新宿主 base；旧版宿主无通道时保持现状
    let base = hostBase;
    try {
      if (typeof pi.app.getAppearance === "function") {
        const appearance = await pi.app.getAppearance();
        if (appearance && typeof appearance === "object") {
          base = appearance.base === "dark" ? "dark" : "light";
        }
      }
    } catch {
      /* 旧版宿主：忽略 */
    }
    if (base) {
      const settings = await pi.plugin.getSettings().catch(() => ({}));
      if (settings.themeSource !== "manual") {
        await pi.plugin.setSettings({
          theme: base,
          themeSource: "host",
          updatedAt: Date.now(),
        });
      }
    }
    return { ok: true };
  }

  if (name === "note.sync") {
    const tree = payload?.tree;
    const activeId = payload?.activeId ?? null;
    const theme = payload?.theme === "dark" ? "dark" : "light";
    const themeSource = payload?.themeSource === "manual" ? "manual" : "host";
    if (!validateTree(tree)) {
      const err = new Error(pick("数据校验失败：笔记树结构不合法", "Invalid note tree payload"));
      err.code = "INVALID_ARGUMENT";
      throw err;
    }
    const json = JSON.stringify({ tree, activeNoteId: activeId, theme });
    if (json.length > MAX_TREE_BYTES) {
      const err = new Error(pick("数据过大（超过 20MB），本次保存被拒绝", "Payload too large (over 20MB); save refused"));
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    const snapshot = { tree, activeNoteId: activeId, theme, themeSource, bytes: json.length };
    writeChain = writeChain.then(async () => {
      await pi.plugin.setSettings({
        tree: snapshot.tree,
        activeNoteId: snapshot.activeNoteId,
        theme: snapshot.theme,
        themeSource: snapshot.themeSource,
        updatedAt: Date.now(),
      });
    });
    await writeChain;
    return { ok: true, bytes: snapshot.bytes, updatedAt: Date.now() };
  }

  if (name === "store.path") {
    return { ok: true, path: await pi.plugin.getDataPath() };
  }

  /* ---------- 外部文件会话（Agent 工具 open_file 驱动） ---------- */

  if (name === "file.pull") {
    if (pendingExternalFile) {
      const file = pendingExternalFile;
      pendingExternalFile = null;
      activeExternalFile = {
        path: file.path,
        name: file.name,
        hasBom: file.hasBom,
        lastSeenAt: Date.now(),
      };
      return {
        ok: true,
        file: { path: file.path, name: file.name, content: file.content },
      };
    }
    expireStaleExternal();
    if (activeExternalFile) activeExternalFile.lastSeenAt = Date.now(); // 心跳
    return { ok: true, file: null };
  }

  if (name === "file.save") {
    const target = typeof payload?.path === "string" ? payload.path : "";
    const content = typeof payload?.content === "string" ? payload.content : "";
    if (!activeExternalFile) {
      throw apiError("CONFLICT", pick("当前没有正在编辑的外部文件", "No external file is being edited"));
    }
    const samePath =
      process.platform === "win32"
        ? target.toLowerCase() === activeExternalFile.path.toLowerCase()
        : target === activeExternalFile.path;
    if (!samePath) {
      throw apiError("CONFLICT", pick("保存路径与当前编辑的文件不一致", "Save path does not match the file being edited"));
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_EXTERNAL_BYTES) {
      throw apiError("LIMIT_EXCEEDED", pick("内容超过 5MB 上限，拒绝写盘", "Content exceeds the 5MB limit; write refused"));
    }
    if (!userRoot) {
      // 面板单独存活（插件进程重启过）：重新请用户选定目录
      await ensureUserRoot();
    }
    const rel = relWithinRoot(target);
    // 写回经宿主 pi.fs 网关；保留原 BOM（\uFEFF 原样写入）
    const out = activeExternalFile.hasBom ? "\uFEFF" + content : content;
    try {
      await pi.fs.writeText(rel, out);
    } catch (err) {
      const code = err?.code ?? "INTERNAL";
      if (code === "PERMISSION_DENIED") {
        throw apiError(
          "PERMISSION_DENIED",
          pick(`没有权限写回该文件：${target}`, `Permission denied writing: ${target}`),
        );
      }
      throw err;
    }
    activeExternalFile.lastSeenAt = Date.now();
    return { ok: true, bytes, at: Date.now() };
  }

  if (name === "file.exit") {
    activeExternalFile = null;
    pendingExternalFile = null;
    return { ok: true };
  }

  const err = new Error("unsupported panel channel: " + channel);
  err.code = "UNSUPPORTED";
  throw err;
}

async function onUnload() {
  await pi.commands.unregister("pi-markdown.open");
  await pi.agent.unregisterTool(EXTERNAL_TOOL_NAME);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
