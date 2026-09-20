const API_ORIGIN = "https://memory.memcode.in";
const RESPONSE_LIMIT = 256 * 1024;
const registeredTools = [];

function requireApiKey() {
  const value = String(process.env.MEMCODE_API_KEY || "").trim();
  if (!value) {
    throw new Error("MEMCODE_API_KEY is not configured for PI-Desktop.");
  }
  if (value.length > 16384 || /[\r\n]/.test(value)) {
    throw new Error("MEMCODE_API_KEY is invalid.");
  }
  return value;
}

function requiredString(value, name, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required.`);
  if (normalized.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters.`);
  return normalized;
}

function optionalString(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name, maxLength);
}

function optionalInteger(value, name, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalNumber(value, name, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalEnum(value, name, values) {
  if (value === undefined || value === null) return undefined;
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  return value;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

async function memcodeRequest(path, { method = "GET", body, headers = {} } = {}) {
  const apiKey = requireApiKey();
  const response = await pi.net.fetch({
    url: `${API_ORIGIN}${path}`,
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeoutMs: 20000,
  });

  if (response.status < 200 || response.status >= 300) {
    const retryAfter = response.headers?.["retry-after"] || response.headers?.["Retry-After"];
    const suffix = response.status === 429 && retryAfter ? ` Retry after ${String(retryAfter).slice(0, 32)}.` : "";
    throw new Error(`Memcode request failed with HTTP ${response.status}.${suffix}`);
  }
  const bodyText = String(response.bodyText || "");
  if (bodyText.length > RESPONSE_LIMIT) throw new Error("Memcode response exceeded the 256 KiB limit.");
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error("Memcode returned an invalid JSON response.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Memcode returned an invalid response shape.");
  }
  return payload.data && typeof payload.data === "object" ? payload.data : payload;
}

const tools = [
  {
    name: "memcode_test_connection",
    description: "Verify that the configured Memcode credential is valid without reading or writing memories.",
    risk: "medium",
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => memcodeRequest("/v2/test"),
  },
  {
    name: "memcode_save_memory",
    description: "Persist user-approved text to the authenticated user's Memcode long-term memory.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 20000 },
        agent_response: { type: "string", maxLength: 20000 },
        effort_level: { type: "string", enum: ["low", "high"] },
        forget: { type: "boolean" },
        idempotency_key: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args = {}) => {
      const idempotencyKey = optionalString(args.idempotency_key, "idempotency_key", 256);
      return memcodeRequest("/v2/memory/ingest", {
        method: "POST",
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
        body: compact({
          user_query: requiredString(args.text, "text", 20000),
          agent_response: optionalString(args.agent_response, "agent_response", 20000),
          effort_level: optionalEnum(args.effort_level, "effort_level", ["low", "high"]) || "low",
          forget: args.forget === undefined ? false : Boolean(args.forget),
        }),
      });
    },
  },
  {
    name: "memcode_search_memories",
    description: "Search the authenticated user's Memcode memories and original stored chunks.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4000 },
        mode: { type: "string", enum: ["default", "chunks", "memories"] },
        top_k: { type: "integer", minimum: 1, maximum: 100 },
        original_top_k: { type: "integer", minimum: 1, maximum: 100 },
        include_original_chunks: { type: "boolean" },
        search_mode: { type: "string", enum: ["default", "global"] },
        minimum_score: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args = {}) => memcodeRequest("/v2/memory/search", {
      method: "POST",
      body: compact({
        query: requiredString(args.query, "query", 4000),
        mode: optionalEnum(args.mode, "mode", ["default", "chunks", "memories"]) || "default",
        top_k: optionalInteger(args.top_k, "top_k", 1, 100) || 10,
        original_top_k: optionalInteger(args.original_top_k, "original_top_k", 1, 100) || 10,
        include_original_chunks: args.include_original_chunks === undefined ? true : Boolean(args.include_original_chunks),
        search_mode: optionalEnum(args.search_mode, "search_mode", ["default", "global"]) || "default",
        minimum_score: optionalNumber(args.minimum_score, "minimum_score", 0, 1) ?? 0,
      }),
    }),
  },
  {
    name: "memcode_retrieve_answer",
    description: "Answer a question from the authenticated user's Memcode memories with source records.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4000 },
        top_k: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args = {}) => memcodeRequest("/v2/memory/retrieve", {
      method: "POST",
      body: {
        query: requiredString(args.query, "query", 4000),
        top_k: optionalInteger(args.top_k, "top_k", 1, 50) || 5,
      },
    }),
  },
];

async function onLoad() {
  try {
    for (const tool of tools) {
      await pi.agent.registerTool(tool);
      registeredTools.push(tool.name);
    }
  } catch (error) {
    await Promise.allSettled(registeredTools.splice(0).map((name) => pi.agent.unregisterTool(name)));
    throw error;
  }
}

async function onUnload() {
  await Promise.allSettled(registeredTools.splice(0).map((name) => pi.agent.unregisterTool(name)));
}

module.exports = { onLoad, onUnload, __test: { memcodeRequest, tools } };
