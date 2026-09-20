import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "../plugins/in.memcode.memory");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

function harness(t, responses = []) {
  const registered = new Map();
  const unregistered = [];
  const calls = [];
  const previousPi = global.pi;
  const previousKey = process.env.MEMCODE_API_KEY;
  process.env.MEMCODE_API_KEY = "test-only-key";
  global.pi = {
    agent: {
      registerTool: async (tool) => registered.set(tool.name, tool),
      unregisterTool: async (name) => unregistered.push(name),
    },
    net: {
      fetch: async (request) => {
        calls.push(request);
        return responses.shift() || { status: 200, headers: {}, bodyText: '{"status":"ok","data":{}}' };
      },
    },
  };
  delete require.cache[require.resolve(join(root, "main.js"))];
  const plugin = require(join(root, "main.js"));
  t.after(() => {
    global.pi = previousPi;
    if (previousKey === undefined) delete process.env.MEMCODE_API_KEY;
    else process.env.MEMCODE_API_KEY = previousKey;
  });
  return { plugin, registered, unregistered, calls };
}

test("manifest declares only the reviewed network and tool capabilities", () => {
  assert.equal(manifest.id, "in.memcode.memory");
  assert.deepEqual(manifest.permissions, ["agent.tool.register", "net.fetch"]);
  assert.deepEqual(manifest.net.domains, ["memory.memcode.in"]);
  assert.equal(manifest.contributes.agentTools.length, 4);
  assert.equal(manifest.contributes.agentTools.find((tool) => tool.name === "memcode_save_memory").risk, "high");
  for (const locale of ["en", "zh-CN"]) {
    assert.ok(manifest.i18n[locale].description);
    assert.ok(manifest.i18n[locale].safetyNotes);
  }
});

test("load registers matching tools and unload removes all of them", async (t) => {
  const h = harness(t);
  await h.plugin.onLoad();
  assert.deepEqual([...h.registered.keys()], manifest.contributes.agentTools.map((tool) => tool.name));
  for (const descriptor of manifest.contributes.agentTools) {
    const tool = h.registered.get(descriptor.name);
    assert.deepEqual(tool.schema, descriptor.schema);
    assert.equal(tool.description, descriptor.description);
    assert.equal(tool.risk, descriptor.risk);
  }
  await h.plugin.onUnload();
  assert.deepEqual(h.unregistered.sort(), [...h.registered.keys()].sort());
});

test("save sends a bounded personal-v2 request without user or attribution fields", async (t) => {
  const h = harness(t, [{
    status: 202,
    headers: {},
    bodyText: '{"status":"ok","data":{"job_id":"job-1","status":"queued"}}',
  }]);
  await h.plugin.onLoad();
  const result = await h.registered.get("memcode_save_memory").execute({
    text: "Remember that I prefer concise answers.",
    effort_level: "high",
    idempotency_key: "turn-1",
  });
  assert.deepEqual(result, { job_id: "job-1", status: "queued" });
  const request = h.calls[0];
  assert.equal(request.url, "https://memory.memcode.in/v2/memory/ingest");
  assert.equal(request.headers.authorization, "Bearer test-only-key");
  assert.equal(request.headers["idempotency-key"], "turn-1");
  const body = JSON.parse(request.body);
  assert.equal(body.user_query, "Remember that I prefer concise answers.");
  assert.equal(body.effort_level, "high");
  assert.equal("user_id" in body, false);
  assert.equal(Object.keys(body).some((key) => key.includes("integration") || key.includes("attribution")), false);
  assert.doesNotMatch(JSON.stringify(result), /test-only-key/);
});

test("missing credential and invalid input fail before egress", async (t) => {
  const h = harness(t);
  await h.plugin.onLoad();
  delete process.env.MEMCODE_API_KEY;
  await assert.rejects(
    h.registered.get("memcode_search_memories").execute({ query: "hello" }),
    /MEMCODE_API_KEY is not configured/,
  );
  process.env.MEMCODE_API_KEY = "test-only-key";
  await assert.rejects(
    h.registered.get("memcode_retrieve_answer").execute({ query: "", top_k: 100 }),
    /query is required|top_k must be/,
  );
  assert.equal(h.calls.length, 0);
});

test("HTTP, malformed JSON, and oversized responses fail without leaking bodies or retries", async (t) => {
  const h = harness(t, [
    { status: 429, headers: { "retry-after": "15" }, bodyText: "secret backend detail" },
    { status: 200, headers: {}, bodyText: "not-json" },
    { status: 200, headers: {}, bodyText: `{"data":"${"x".repeat(256 * 1024)}"}` },
  ]);
  await h.plugin.onLoad();
  const tool = h.registered.get("memcode_test_connection");
  await assert.rejects(tool.execute({}), (error) => {
    assert.match(error.message, /HTTP 429.*Retry after 15/);
    assert.doesNotMatch(error.message, /secret backend detail/);
    return true;
  });
  await assert.rejects(tool.execute({}), /invalid JSON/);
  await assert.rejects(tool.execute({}), /256 KiB/);
  assert.equal(h.calls.length, 3);
});
