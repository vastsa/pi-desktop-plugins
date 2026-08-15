/**
 * Pi Markdown — PI-Desktop 本地 Markdown 笔记插件（主进程）。
 *
 * 插件 id: pi.markdown
 * 命令 id: pi-markdown.open
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
 * 主题跟随（v0.4.0）：
 * - 宿主提供 app.getAppearance（Part A）时，main.js 在未手动覆盖的前提下把
 *   settings.theme 同步为宿主解析后的 base（light/dark），面板 bundle 挂载时
 *   读取该值并设置 documentElement[data-theme]，由 CSS 变量驱动整体配色；
 * - 面板侧 appearance.js 订阅 appearance:changed 实时重写 data-theme（CSS
 *   层面即时跟随），并通过 "appearance.sync" 通道让 main.js 收敛 settings.theme；
 * - 手动覆盖判定：bundle 每次 note.sync 都会上报它当前持有的 theme；与上次
 *   上报不一致 → 用户点击过面板内的切换按钮 → 记 themeSource='manual'，此后
 *   宿主不再覆盖；一致 → 保持跟随宿主（themeSource='host'）。
 * - 旧版宿主（无 app.getAppearance）时 hostBase 恒为 null，settings.theme
 *   保持面板上报值，跟随逻辑静默失效，面板照常工作。
 *
 * 权限说明：
 * - ui.panel：面板入口（manifest.ui.panel）
 * - agent.prompt.inject：contributes.skills 索引需要
 */

const MAX_TREE_BYTES = 20 * 1024 * 1024; // 全量数据上限 20MB
const MAX_NODES = 20000;

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

/** 宿主解析后的外观 base（'light'|'dark'）；旧版宿主/未知时为 null。 */
let hostBase = null;

/** 面板 bundle 最近一次 note.sync 上报的 theme（用于手动覆盖判定）。 */
let bundleTheme = null;

/** 规范化 bundle 上报的 theme。 */
function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

/** 刷新 hostBase。旧版宿主（无 app.getAppearance 通道）时静默保持 null。 */
async function refreshHostBase() {
  try {
    const appearance = await pi.app.getAppearance();
    const base =
      appearance && typeof appearance === "object" ? appearance.base : null;
    if (base === "light" || base === "dark") hostBase = base;
  } catch {
    /* 旧版宿主没有该通道：保持 null，跟随逻辑静默失效 */
  }
}

/** 用户未手动覆盖（themeSource !== 'manual'）时，把 settings.theme 同步为宿主 base。 */
async function syncThemeFromHost() {
  await refreshHostBase();
  if (hostBase === null) return;
  try {
    const settings = await pi.plugin.getSettings();
    if (settings.themeSource !== "manual") {
      await pi.plugin.setSettings({
        theme: hostBase,
        themeSource: "host",
      });
    }
  } catch {
    /* 读/写失败不致命：下次 note.sync / appearance.sync 会重试 */
  }
}

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

async function onLoad() {
  await pi.commands.register({
    id: "pi-markdown.open",
    title: "Pi Markdown：打开笔记",
    keywords: ["markdown", "笔记", "note", "md"],
    category: "Productivity",
    run: async () => {
      // 不传 title：让宿主解析 manifest.ui.title 的本地化标题
      await pi.ui.openPanel();
    },
  });
  // 插件进程在 app 启动时即加载：趁早把 settings.theme 收敛为宿主外观，
  // 保证面板首次挂载（bundle 读 settings.theme）就拿到正确的主题。
  await syncThemeFromHost();
}

async function onPanelInvoke(channel, payload) {
  const name = normalizeChannel(channel, payload);

  // 面板 appearance.js 在初始化与每次 appearance:changed 时调用：
  // 让 settings.theme 实时收敛为宿主 base（未手动覆盖时）。
  if (name === "appearance.sync") {
    await syncThemeFromHost();
    return { ok: true, base: hostBase };
  }

  if (name === "note.sync") {
    const tree = payload?.tree;
    const activeId = payload?.activeId ?? null;
    const theme = normalizeTheme(payload?.theme);
    if (!validateTree(tree)) {
      const err = new Error("数据校验失败：笔记树结构不合法");
      err.code = "INVALID_ARGUMENT";
      throw err;
    }
    const json = JSON.stringify({ tree, activeNoteId: activeId, theme });
    if (json.length > MAX_TREE_BYTES) {
      const err = new Error("数据过大（超过 20MB），本次保存被拒绝");
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }

    // —— 主题归属判定 ——
    // bundle 每次同步都上报它当前持有的 theme：
    //   · 与上次上报一致 → 用户没动过切换按钮 → 继续跟随宿主（host）；
    //   · 不一致 → 用户在面板内手动切换 → 转 manual，宿主不再覆盖。
    let themeSource = "host";
    try {
      const stored = await pi.plugin.getSettings();
      if (stored.themeSource === "manual") {
        themeSource = "manual";
      } else if (bundleTheme !== null && theme !== bundleTheme) {
        themeSource = "manual";
      } else {
        await refreshHostBase();
        themeSource = "host";
      }
    } catch {
      themeSource = "host";
    }
    bundleTheme = theme;

    const snapshot = {
      tree,
      activeNoteId: activeId,
      theme: themeSource === "manual" ? theme : hostBase ?? theme,
      themeSource,
      bytes: json.length,
    };
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

  const err = new Error("unsupported panel channel: " + channel);
  err.code = "UNSUPPORTED";
  throw err;
}

async function onUnload() {
  await pi.commands.unregister("pi-markdown.open");
}

module.exports = { onLoad, onUnload, onPanelInvoke };
