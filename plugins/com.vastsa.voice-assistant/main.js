/**
 * Voice Assistant — standalone third-party plugin.
 *
 * The panel owns microphone capture and speech synthesis. This process owns
 * model routing and calls the permission-gated desktop controller, so no MCP
 * bearer token is ever passed to the plugin.
 */

const OPEN_COMMAND_ID = "com.vastsa.voice-assistant.open";

const ROUTER_PREFIX = `You are the PI-Desktop voice command router.
Return exactly one JSON object and no Markdown:
{"operation": string|null, "args": array, "reply": string, "confirm": false}

Choose only an operation from the catalog below. "reply" is a short Chinese
acknowledgement or answer for the user. Use null when the request is unclear.
Never set confirm to true: the host panel performs the confirmation step.
For agent/prompt, args must be [{"sessionId":"CURRENT_SESSION_ID","content":"..."}].
For project/set, args must be ["absolute project path"].
For session/create, args must be [{"title":"optional title"}].
For agent/getStatus, args must be ["CURRENT_SESSION_ID"].
For session/get, args must be [{"id":"CURRENT_SESSION_ID","messageLimit":12,"contentLimit":4000}].
Do not invent paths, ids, or arguments. If a command needs missing information,
use null and ask one short follow-up in reply.

Operation catalog:
`;

let operationCatalog = [];
let sessionId = "";
let pendingConfirmation = null;
let pendingAgent = null;

function operationInfo(id) {
  return operationCatalog.find((operation) => operation.id === id) || null;
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return String(part.text ?? part.content ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    return String(content.text ?? content.content ?? "").trim();
  }
  return "";
}

function jsonPreview(value, limit = 1200) {
  try {
    const serialized = JSON.stringify(value ?? null);
    return serialized.length > limit ? `${serialized.slice(0, limit)}…` : serialized;
  } catch {
    return String(value);
  }
}

function parseRouterResult(raw) {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function catalogText() {
  return operationCatalog
    .map((operation) => `${operation.id} | ${operation.risk} | ${operation.description}`)
    .join("\n");
}

async function settings() {
  return pi.plugin.getSettings();
}

async function refreshCatalog() {
  operationCatalog = await pi.desktop.listOperations();
  return operationCatalog;
}

async function ensureSession() {
  if (sessionId) return sessionId;
  const result = await pi.desktop.invoke({ operation: "session/create", args: [{}] });
  sessionId = String(result?.session?.id ?? "").trim();
  if (!sessionId) throw new Error("PI-Desktop did not return a new session id");
  return sessionId;
}

function resultText(operation, result) {
  if (operation === "app/getVersion") {
    return `PI-Desktop ${result?.version ?? result?.appVersion ?? jsonPreview(result)}`;
  }
  if (operation === "project/set") {
    return `已打开项目：${result?.workspace?.path ?? "项目已切换"}`;
  }
  if (operation === "project/clear") return "已清除当前项目。";
  if (operation === "session/create" || operation === "session/fork") {
    return `已准备会话：${result?.session?.title || result?.session?.id || "新会话"}`;
  }
  if (operation === "agent/getStatus") {
    return result?.status?.isRunning ? "Agent 正在运行。" : "Agent 当前空闲。";
  }
  if (operation === "workspace/diff") return jsonPreview(result, 3000);
  if (operation === "fs/read") return textFromContent(result?.content ?? result);
  if (result === undefined || result === null) return `${operation} 已完成。`;
  if (typeof result === "string") return result.slice(0, 4000);
  return `${operation} 已完成：${jsonPreview(result)}`;
}

async function normalizedArgs(operation, args, transcript) {
  const input = Array.isArray(args) ? args : [];
  if (operation === "agent/prompt") {
    await ensureSession();
    const original = input[0] && typeof input[0] === "object" && !Array.isArray(input[0])
      ? { ...input[0] }
      : {};
    const content = String(original.content ?? original.prompt ?? transcript ?? "").trim();
    if (!content) throw new Error("voice prompt is empty");
    return [{ ...original, sessionId, content }];
  }
  if (operation === "agent/getStatus") return [String(input[0] ?? sessionId)];
  if (operation === "session/get") {
    const original = input[0] && typeof input[0] === "object" && !Array.isArray(input[0])
      ? { ...input[0] }
      : {};
    return [{ id: String(original.id ?? sessionId), messageLimit: 12, contentLimit: 4000, ...original }];
  }
  if (operation === "session/create") {
    if (!input.length) return [{}];
    if (typeof input[0] === "string") return [{ title: input[0] }];
  }
  if (operation === "project/set") {
    const path = input[0] && typeof input[0] === "object" ? input[0].path : input[0];
    return [String(path ?? "").trim()];
  }
  return input;
}

async function sessionSnapshot(id) {
  try {
    return await pi.desktop.invoke({
      operation: "session/get",
      args: [{ id, messageLimit: 16, contentLimit: 8000 }],
    });
  } catch {
    return null;
  }
}

async function executeOperation(operation, args, transcript, confirmed = false, reply = "") {
  const info = operationInfo(operation);
  if (!info) {
    return { type: "answer", text: "我还不能调用这个桌面操作。请换一种说法。" };
  }
  const normalized = await normalizedArgs(operation, args, transcript);
  if (info.risk === "dangerous" && !confirmed) {
    pendingConfirmation = {
      token: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      operation,
      args: normalized,
      reply: reply || `即将执行：${info.description}`,
    };
    return {
      type: "confirmation",
      token: pendingConfirmation.token,
      operation,
      description: info.description,
      risk: info.risk,
      text: pendingConfirmation.reply,
    };
  }

  pendingConfirmation = null;
  let baseline = null;
  if (operation === "agent/prompt") baseline = await sessionSnapshot(sessionId);
  const result = await pi.desktop.invoke({
    operation,
    args: normalized,
    confirm: confirmed,
  });
  if (operation === "session/create" || operation === "session/fork") {
    sessionId = String(result?.session?.id ?? sessionId).trim();
  }
  if (operation === "agent/prompt") {
    pendingAgent = {
      sessionId,
      baselineAssistantId: [...(baseline?.session?.messages ?? [])]
        .reverse()
        .find((message) => message?.role === "assistant")?.id ?? "",
      polls: 0,
    };
    return { type: "agent_started", sessionId, text: reply || "Agent 正在执行。" };
  }
  return { type: "answer", text: reply || resultText(operation, result), result };
}

async function routeTranscript(transcript) {
  const text = String(transcript ?? "").trim();
  if (!text) return { type: "error", text: "没有听清，请再说一次。" };
  if (pendingAgent) return { type: "error", text: "Agent 仍在执行，请稍候。" };
  const currentSettings = await settings();
  const modelKey = String(currentSettings.modelKey ?? "").trim();
  if (!modelKey) return { type: "error", text: "请先在面板中选择一个语音模型。" };
  if (!operationCatalog.length) await refreshCatalog();
  const thinkingLevel = String(currentSettings.thinkingLevel ?? "low");
  const result = await pi.agent.complete({
    modelKey,
    thinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
    system: `${ROUTER_PREFIX}${catalogText()}\n\nCurrent session id: ${sessionId || "NONE"}`,
    messages: [{ role: "user", content: text }],
  });
  const command = parseRouterResult(result.text);
  if (!command) return { type: "answer", text: result.text || "我没有解析出可执行的操作。" };
  const operation = typeof command.operation === "string" ? command.operation : "";
  if (!operation) return { type: "answer", text: String(command.reply || "请补充你想执行的操作。") };
  return executeOperation(
    operation,
    command.args,
    text,
    false,
    String(command.reply ?? "").trim(),
  );
}

async function pollAgent() {
  if (!pendingAgent) return { state: "idle", sessionId };
  pendingAgent.polls += 1;
  const statusResult = await pi.desktop.invoke({
    operation: "agent/getStatus",
    args: [pendingAgent.sessionId],
  });
  const status = statusResult?.status ?? statusResult;
  if (status?.isRunning) return { state: "running", sessionId: pendingAgent.sessionId };
  const snapshot = await sessionSnapshot(pendingAgent.sessionId);
  const messages = Array.isArray(snapshot?.session?.messages) ? snapshot.session.messages : [];
  const assistant = [...messages]
    .reverse()
    .find((message) =>
      message?.role === "assistant" &&
      message?.id !== pendingAgent.baselineAssistantId &&
      textFromContent(message.content),
    );
  if (assistant) {
    pendingAgent = null;
    return { state: "done", sessionId, text: textFromContent(assistant.content) };
  }
  if (pendingAgent.polls > 60) {
    pendingAgent = null;
    return { state: "error", sessionId, text: "Agent 已结束，但没有找到新的回复。" };
  }
  return { state: "waiting", sessionId: pendingAgent.sessionId };
}

async function onLoad() {
  await pi.commands.register({
    id: OPEN_COMMAND_ID,
    title: "Voice Assistant: open",
    keywords: ["voice", "assistant", "speech"],
    run: async () => pi.ui.openPanel({ title: "Voice Assistant" }),
  });
}

async function onUnload() {
  await pi.commands.unregister(OPEN_COMMAND_ID);
  operationCatalog = [];
  sessionId = "";
  pendingConfirmation = null;
  pendingAgent = null;
}

async function onPanelInvoke(channel, payload) {
  if (channel === "voice.get") {
    const currentSettings = await settings();
    const [models] = await Promise.all([pi.models.list(), refreshCatalog()]);
    return {
      modelKey: String(currentSettings.modelKey ?? ""),
      thinkingLevel: String(currentSettings.thinkingLevel ?? "low"),
      speakReplies: currentSettings.speakReplies !== false,
      models,
      sessionId,
      operationCount: operationCatalog.length,
      pendingConfirmation,
    };
  }
  if (channel === "voice.set") {
    const current = await settings();
    const thinking = String(payload?.thinkingLevel ?? current.thinkingLevel ?? "low");
    const allowedThinking = new Set(["minimal", "low", "medium", "high"]);
    await pi.plugin.setSettings({
      ...current,
      modelKey: String(payload?.modelKey ?? current.modelKey ?? "").trim(),
      thinkingLevel: allowedThinking.has(thinking) ? thinking : "low",
      speakReplies: payload?.speakReplies !== false,
    });
    return { ok: true };
  }
  if (channel === "voice.newSession") {
    sessionId = "";
    pendingAgent = null;
    pendingConfirmation = null;
    await ensureSession();
    return { sessionId };
  }
  if (channel === "voice.route") return routeTranscript(payload?.text);
  if (channel === "voice.poll") return pollAgent();
  if (channel === "voice.confirm") {
    if (!pendingConfirmation || pendingConfirmation.token !== String(payload?.token ?? "")) {
      return { type: "error", text: "确认请求已过期，请重新说一次。" };
    }
    const request = pendingConfirmation;
    return executeOperation(request.operation, request.args, "", true, request.reply);
  }
  if (channel === "voice.cancel") {
    pendingConfirmation = null;
    return { type: "answer", text: "已取消。" };
  }
  if (channel === "voice.describe") {
    if (!operationCatalog.length) await refreshCatalog();
    return operationCatalog;
  }
  throw Object.assign(new Error(`unsupported panel channel: ${channel}`), { code: "UNSUPPORTED" });
}

export { onLoad, onUnload, onPanelInvoke };
