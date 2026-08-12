/**
 * 小清新待办 — PI-Desktop 官方插件 entry.
 *
 * 插件 id: pi.todo
 * 命令 id: todo.open
 *
 * 面板（renderer/index.html）为自包含应用：添加、完成、编辑、删除、
 * 筛选、到期提醒全部在渲染端完成。
 *
 * 权限说明：
 * - ui.panel：面板入口（manifest.ui.panel）
 * - notify：面板到期提醒经 pluginBridge.invoke 调宿主通知 API
 *   （ui.showNativeNotification 原生系统通知，失败降级 ui.notify 应用内
 *   toast；渲染端调用，宿主在 invokePanelBridge 中校验该权限）
 */

async function onLoad() {
  await pi.commands.register({
    id: "todo.open",
    title: "小清新待办：打开面板",
    keywords: ["todo", "待办", "清单", "任务", "官方"],
    run: async () => {
      await pi.ui.openPanel({ title: "小清新待办" });
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("todo.open");
}

module.exports = { onLoad, onUnload };
