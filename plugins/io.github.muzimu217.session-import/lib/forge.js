/**
 * Forge — 把导入的会话蒸馏成项目规则与可复用技能。
 *
 * 为什么必须长在 session-import 这个 plugin_id 里（架构硬约束）：
 * host-core 的 `plugin_sessions::list` SQL 是
 *   ... JOIN session_import_origins oi ON oi.session_id = s.id
 *   WHERE oi.plugin_id = ?1
 * 也就是说 `pi.session.list()` 只返回**本插件自己导入**的行。宿主原生产生的
 * 会话对任何插件都不可见。所以"读回并蒸馏"只能做在导入方插件内，独立插件
 * 拿不到数据源。
 *
 * 这正是本模块难以被复刻的原因：它需要同时具备
 *   1. 六来源会话适配器（读取侧，lib/sources/*）
 *   2. PI-Desktop 独有的 session.read.own + agent.complete 组合
 * 前者要逆向各家的磁盘格式，后者是 ADR 0200 / 0174 刚落地的 API。
 */
"use strict";

/** agent.complete 的硬上限（ADR 0174）。 */
const COMPLETE_LIMITS = {
  systemMax: 32 * 1024,
  messagesMaxChars: 200_000,
  callsPerMinute: 8,
};

/** 滚动窗口限速：ADR 0174 规定每插件每 60s 最多 8 次。 */
const callLog = [];

function withinRateLimit() {
  const now = Date.now();
  while (callLog.length > 0 && now - callLog[0] > 60_000) callLog.shift();
  if (callLog.length >= COMPLETE_LIMITS.callsPerMinute) {
    const waitMs = 60_000 - (now - callLog[0]);
    return { ok: false, retryAfterMs: waitMs };
  }
  callLog.push(now);
  return { ok: true };
}

/**
 * 把一批会话压成一条适合 side completion 的语料。
 * 超出预算时按"每个会话均摊、优先保留尾部（结论通常出现在后面）"裁剪，
 * 保证任何输入规模都不会撞上 200k 字符上限。
 */
function buildCorpus(sessions, budgetChars = COMPLETE_LIMITS.messagesMaxChars) {
  if (sessions.length === 0) return "";
  const perSession = Math.floor(budgetChars / sessions.length);
  const parts = [];

  for (const session of sessions) {
    const lines = [`## 会话：${session.title || "(无标题)"}`];
    if (session.projectPath) lines.push(`- 项目：${session.projectPath}`);
    if (session.modelId) lines.push(`- 模型：${session.modelId}`);
    lines.push("");

    const messages = Array.isArray(session.messages) ? session.messages : [];
    let used = lines.join("\n").length;

    for (const m of messages) {
      const role = m.role === "assistant" ? "助手" : m.role === "tool" ? "工具" : "用户";
      const body = String(m.content ?? "").trim();
      if (!body) continue;
      const chunk = `**${role}**: ${body}\n`;
      if (used + chunk.length > perSession) break; // 保留更早的内容，尾部溢出即止
      lines.push(chunk);
      used += chunk.length;
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n---\n\n");
}

const SYSTEM_PROMPT = `你是一位资深工程负责人，负责从一批真实的人机协作会话记录中提炼出可长期复用的知识。

输出要求：
1. 只提炼会话中**确实出现过**的模式：反复踩到的坑、被验证有效的做法、用户明确表达的偏好与约束。
2. 不要编造会话里没有的事实。不确定的内容单独列入"待确认"，不要混入正文。
3. 用简体中文输出，技术术语与命令保留英文原文。
4. 结构紧凑，条目化，可直接落地执行。不要客套话。

按以下结构输出：

## 项目约定
（从会话中体现出的、这个项目/用户遵循的规则。每条一行，祈使句。）

## 已验证做法
（在会话中被证明有效的具体方法、命令、参数或工作流。附简短依据。）

## 反复出现的坑
（多次踩到或代价高昂的错误，以及对应的规避方式。）

## 待确认
（证据不足、需要用户拍板的观察。）`;

/**
 * 调用宿主的一次性补全做蒸馏。
 * 凭据始终留在 Electron 主进程（ADR 0174），插件拿不到任何 key。
 */
async function distill({ sessions, modelKey, thinkingLevel, goal }) {
  const rate = withinRateLimit();
  if (!rate.ok) {
    throw Object.assign(new Error("agent.complete 触发限速，请稍后重试"), {
      code: "RATE_LIMITED",
      retryAfterMs: rate.retryAfterMs,
    });
  }

  const corpus = buildCorpus(sessions);
  if (!corpus.trim()) throw new Error("没有可蒸馏的会话内容");

  const userPrompt = [
    goal ? `本次提炼的重点：${goal}\n` : "",
    `共 ${sessions.length} 个会话，记录如下：\n\n${corpus}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await pi.agent.complete({
    ...(modelKey ? { modelKey } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  return { text: extractText(result), usage: result?.usage ?? null };
}

/** 兼容宿主可能返回的不同补全形状。 */
function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.text === "string") return result.text;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
      .join("");
  }
  return "";
}

/** 列出本插件导入过的会话（宿主按 plugin_id 隔离，只能看到自己的行）。 */
async function listImported({ source, limit = 100 } = {}) {
  const args = { limit: Math.min(Math.max(Number(limit) || 100, 1), 200) };
  if (source) args.source = source;
  const res = await pi.session.list(args);
  // 不同宿主版本可能返回 { sessions } 或直接数组
  return Array.isArray(res) ? res : (res?.sessions ?? []);
}

async function readMessages(sessionId, { limit = 500 } = {}) {
  const res = await pi.session.listMessages({ sessionId, limit });
  return Array.isArray(res) ? res : (res?.messages ?? []);
}

module.exports = {
  distill,
  listImported,
  readMessages,
  buildCorpus,
  COMPLETE_LIMITS,
};
