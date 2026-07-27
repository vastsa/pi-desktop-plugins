async function onLoad() {
  const settings = await pi.plugin.getSettings();
  await pi.commands.register({
    id: "hello.open",
    title: "Hello: Open Panel",
    keywords: ["hello", "demo"],
    run: async () => {
      await pi.ui.openPanel({ title: "Hello Plugin" });
      await pi.ui.showToast(settings.greeting || "Hello from marketplace");
    },
  });
  await pi.agent.registerTool({
    name: "echo_text",
    description: "Echo text back to the agent",
    risk: "low",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => ({
      ok: true,
      echo: String(args?.text ?? ""),
      pluginId: pi.plugin.getId(),
    }),
  });
}
async function onUnload() {
  await pi.commands.unregister("hello.open");
  await pi.agent.unregisterTool("echo_text");
}
module.exports = { onLoad, onUnload };
