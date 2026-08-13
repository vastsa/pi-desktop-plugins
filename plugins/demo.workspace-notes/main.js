const NOTE_FILE = "NOTES.md";
async function onLoad() {
  await pi.commands.register({
    id: "notes.open",
    title: "Notes: Open Panel",
    keywords: ["notes", "workspace"],
    run: async () => {
      await pi.ui.openPanel();
    },
  });
  await pi.agent.registerTool({
    name: "save_note",
    description: "Append a note to NOTES.md in the workspace",
    risk: "high",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => {
      const text = String(args?.text ?? "").trim();
      let current = "";
      try { current = await pi.fs.readText(NOTE_FILE); } catch {}
      const next = current ? `${current.trimEnd()}
- ${text}
` : `# Notes

- ${text}
`;
      await pi.fs.writeText(NOTE_FILE, next);
      await pi.ui.notify({ title: "Note saved", body: text.slice(0, 80) });
      return { ok: true, path: NOTE_FILE, bytes: next.length };
    },
  });
}
async function onUnload() {
  await pi.commands.unregister("notes.open");
  await pi.agent.unregisterTool("save_note");
}
module.exports = { onLoad, onUnload };
