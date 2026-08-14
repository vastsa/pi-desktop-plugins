/**
 * Pi Markdown — PI-Desktop 本地 Markdown 笔记插件（主进程）。
 *
 * 插件 id: pi.markdown
 * 命令 id: pi-markdown.open
 *
 * 数据模型（与面板共享）：
 *   settings.json = { tree: TreeNode[], activeNoteId: string|null, theme: 'light'|'dark', updatedAt: <ms> }
 *   TreeNode = { id, type:'folder', name, children[] } | { id, type:'note', title, content, updatedAt }
 *
 * 权威数据源 = 插件数据目录 settings.json（pi.plugin.getSettings/setSettings）。
 * 面板经 onPanelInvoke 的 "note.sync" 通道把整棵树同步到插件进程；
 * "store.path" 通道向面板返回数据目录（用于状态栏展示）。
 * 写操作在插件进程串行化（promise 队列），避免并发 merge 丢失更新。
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
}

async function onPanelInvoke(channel, payload) {
  const name = normalizeChannel(channel, payload);

  if (name === "note.sync") {
    const tree = payload?.tree;
    const activeId = payload?.activeId ?? null;
    const theme = payload?.theme === "dark" ? "dark" : "light";
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
    const snapshot = { tree, activeNoteId: activeId, theme, bytes: json.length };
    writeChain = writeChain.then(async () => {
      await pi.plugin.setSettings({
        tree: snapshot.tree,
        activeNoteId: snapshot.activeNoteId,
        theme: snapshot.theme,
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
