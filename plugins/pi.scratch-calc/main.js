/**
 * 草稿计算器 — PI-Desktop plugin entry.
 *
 * 插件 id: pi.scratch-calc
 * 命令 id: scratchCalc.open
 *
 * 面板（renderer/index.html）内自包含完整计算器：
 * 回车计算，结果保留在输入框可链式续算；历史单行「公式 = 结果」最新置顶；
 * 纯数字不记录；Esc 清空；↑/↓ 浏览历史；localStorage 持久化。
 */

async function onLoad() {
  await pi.commands.register({
    id: "scratchCalc.open",
    title: "草稿计算器：打开面板",
    keywords: ["草稿计算器", "计算器", "calculator", "草稿", "draft", "公式", "calc"],
    run: async () => {
      await pi.ui.openPanel({ title: "草稿计算器" });
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("scratchCalc.open");
}

module.exports = { onLoad, onUnload };
