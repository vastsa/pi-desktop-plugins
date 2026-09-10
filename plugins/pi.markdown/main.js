/**
 * Pi Markdown — PI-Desktop 本地 Markdown 笔记插件（主进程）。
 *
 * 插件 id: local.pi-markdown
 * 命令 id: pi-markdown.open
 * Agent 工具: preview_file（本地 node fs 只读预览，无需目录授权）
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
 * 外部文件会话（Agent 工具 preview_file）：
 *   校验路径 → 用本地 node fs 读取正文（无需选定目录，任意绝对路径）→
 *   pendingExternalFile → 面板轮询 file.pull 取走 → activeExternalFile
 *   （file.pull 每次刷新 lastSeenAt 作为心跳）→ 面板 file.save 写回 / file.exit 结束会话。
 *   单槽位：已有 pending 或 60s 内活跃的 active 时，新工具调用返回 CONFLICT；
 *   心跳停止超过 60s 视为陈旧，允许新调用接管（如面板窗口被关闭）。
 *   正文读写直接使用 Node.js 的 fs，不经过宿主 pi.fs 权限网关，因此无需目录
 *   授权，也没有网关的越界/凭据路径校验与审计日志；插件侧保留了必要的校验
 *   （绝对路径、常规文件、扩展名白名单、≤5MB、拒绝二进制）。
 *   面板以只读状态呈现，用户点「编辑」后才能修改，保存仍走本地 fs 写回。
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
 * - agent.tool.register：preview_file 工具注册（高风险，安装时确认）
 *
 * 注意：笔记数据一律经 pi.plugin.getSettings/setSettings 存在插件数据目录，
 * 不申请 fs.read / fs.write（那两个权限只服务于已移除的 pi.fs 网关路径）。
 */

const fs = require("fs");
const path = require("path");

const MAX_TREE_BYTES = 20 * 1024 * 1024; // 全量数据上限 20MB
const MAX_NODES = 20000;

/* ---------- 外部文件（Agent 工具 preview_file）常量 ---------- */
const PREVIEW_TOOL_NAME = "preview_file";
const EXTERNAL_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_EXTERNAL_BYTES = 5 * 1024 * 1024; // 单文件上限 5MB
const EXTERNAL_STALE_MS = 60 * 1000; // 心跳超时 60s → 允许新工具调用接管

/** 宿主当前亮暗 base（官方外观通道读取；旧版宿主为 null） */
let hostBase = null;

/** 待面板拉取的外部文件（工具调用成功、面板尚未取走） */
let pendingExternalFile = null;
/** 正在预览的外部文件；面板每次 file.pull 刷新 lastSeenAt（心跳） */
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

/* ---------- Agent 工具：按绝对路径预览单个文件（单文件模式） ---------- */

/**
 * 工具入参校验：绝对路径 → 元数据校验。
 * 存在性/常规文件/扩展名白名单/大小上限。
 */
async function validateExternalTarget(args) {
  const target = typeof args?.path === "string" ? args.path.trim() : "";
  if (!target) throw apiError("INVALID_ARGUMENT", pick("path 参数不能为空", "path must not be empty"));
  if (!isAbsolutePath(target)) {
    throw apiError("INVALID_ARGUMENT", pick("path 必须是绝对路径", "path must be an absolute path"));
  }

  let stat;
  try {
    stat = await fs.promises.stat(target);
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
  return { target, stat };
}

/** 解码为文本：剥 BOM（写回时还原）、拒绝 NUL 字节（二进制）、复核字节上限 */
function decodeExternalText(raw) {
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
  return { content, hasBom };
}

/** 占用外部文件槽位：陈旧会话让位，仍有活跃/待取会话则报 CONFLICT */
function claimExternalSlot() {
  expireStaleExternal();
  if (pendingExternalFile) {
    throw apiError("CONFLICT", pick("已有待打开的文件，请稍后再试", "A file is already pending, try again later"));
  }
  if (activeExternalFile) {
    throw apiError(
      "CONFLICT",
      pick(
        `已有文件正在预览：${activeExternalFile.path}（请先关闭该面板或稍候）`,
        `Already previewing: ${activeExternalFile.path} (close that panel first, or try again later)`,
      ),
    );
  }
}

/** 投递到面板：写入待取槽位并唤起面板，返回工具结果 */
async function stageExternalFile({ target, content, hasBom, size }) {
  const name = path.basename(target);
  pendingExternalFile = { path: target, name, content, hasBom, bytes: size };
  await pi.ui.openPanel({ title: pick("Pi Markdown 笔记", "Pi Markdown") + " — " + name });
  return {
    ok: true,
    path: target,
    name,
    size,
    chars: content.length,
    hint: pick(
      "文件已在 Pi Markdown 面板中以只读预览打开。用户点面板上的「编辑」后可修改，修改会自动保存回原文件",
      "The file is open in the Pi Markdown panel as a read-only preview. The user can click Edit to modify it, and edits save back automatically",
    ),
  };
}

/**
 * preview_file：只读预览模式。
 * 正文读写直接使用 Node.js 的 fs——无需选定目录，任意绝对路径均可打开；
 * 面板以只读状态呈现，用户点「编辑」后转为可编辑，保存同样走本地 fs 写回。
 */
async function previewFileTool(args) {
  const { target, stat } = await validateExternalTarget(args);
  claimExternalSlot();

  let raw;
  try {
    raw = await fs.promises.readFile(target, "utf8");
  } catch (err) {
    const code = err?.code ?? "INTERNAL";
    if (code === "ENOENT") {
      throw apiError("NOT_FOUND", pick(`文件不存在或无法访问：${target}`, `File not found or unreadable: ${target}`));
    }
    if (code === "EACCES" || code === "EPERM") {
      throw apiError(
        "PERMISSION_DENIED",
        pick(`没有权限读取该文件：${target}`, `Permission denied reading: ${target}`),
      );
    }
    throw err;
  }

  const { content, hasBom } = decodeExternalText(raw);
  return stageExternalFile({ target, content, hasBom, size: stat.size });
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
    name: PREVIEW_TOOL_NAME,
    description: pick(
      "以只读预览方式打开一个 Markdown/纯文本文件（绝对路径）在 Pi Markdown 面板中查看：标题、代码块、公式与 Mermaid 图表都会渲染出来，用户点面板上的「编辑」才能修改，修改后自动保存回原文件。该工具直接读取磁盘，无需用户选择目录，任意绝对路径都能打开（仅支持 .md/.markdown/.txt，≤5MB）。",
      "Open one Markdown/text file (absolute path) in the Pi Markdown panel as a read-only preview: headings, code blocks, formulas and Mermaid diagrams are rendered, and the user clicks Edit in the panel to modify it — edits then save back automatically. This tool reads the disk directly, so no directory picker is needed and any absolute path works (supports .md/.markdown/.txt, ≤5MB).",
    ),
    risk: "high",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: pick(
            "文件的绝对路径（Windows 如 C:\\docs\\a.md；macOS/Linux 如 /Users/me/a.md）。任意绝对路径均可，无需事先选定目录",
            "Absolute path of the file (Windows: C:\\docs\\a.md; macOS/Linux: /Users/me/a.md). Any absolute path works; no directory grant needed",
          ),
        },
      },
      required: ["path"],
    },
    execute: previewFileTool,
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

  /* ---------- 外部文件会话（Agent 工具 preview_file 驱动） ---------- */

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
    // 保留原 BOM（\uFEFF 原样写入）
    const out = activeExternalFile.hasBom ? "\uFEFF" + content : content;
    // 写回走本地 node fs（与读取一致，任意绝对路径）
    try {
      await fs.promises.writeFile(target, out, "utf8");
    } catch (err) {
      const code = err?.code ?? "INTERNAL";
      if (code === "EACCES" || code === "EPERM") {
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
  await pi.agent.unregisterTool(PREVIEW_TOOL_NAME);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
