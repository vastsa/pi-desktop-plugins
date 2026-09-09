import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createGoal } = require("../plugins/pi.goal-x/lib/goal-engine.js");
const {
  STATE_SETTING_KEY,
  readSettings,
  mutateCurrentWorkspace,
  updatePluginSettings,
  __test,
} = require("../plugins/pi.goal-x/lib/store.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function host(initial = {}) {
  const settings = clone(initial);
  const writes = [];
  return {
    settings,
    writes,
    pi: {
      workspace: {
        get: async () => ({ path: "/workspace/alpha", name: "Alpha" }),
      },
      plugin: {
        getSettings: async () => clone(settings),
        setSettings: async (patch) => {
          writes.push(clone(patch));
          for (const key of Object.keys(settings)) delete settings[key];
          Object.assign(settings, clone(patch));
        },
      },
    },
  };
}

test("storage and workspace read failures abort without writing", async () => {
  const previousPi = globalThis.pi;
  const current = host({ [STATE_SETTING_KEY]: { version: 1, workspaces: {} } });
  globalThis.pi = current.pi;
  __test.resetQueue();

  try {
    current.pi.plugin.getSettings = async () => {
      throw new Error("temporary settings read failure");
    };
    await assert.rejects(
      mutateCurrentWorkspace(() => assert.fail("mutator must not run")),
      /temporary settings read failure/,
    );
    assert.equal(current.writes.length, 0);

    current.pi.plugin.getSettings = async () => clone(current.settings);
    current.pi.workspace.get = async () => {
      throw new Error("temporary workspace read failure");
    };
    await assert.rejects(
      mutateCurrentWorkspace(() => assert.fail("mutator must not run")),
      /temporary workspace read failure/,
    );
    assert.equal(current.writes.length, 0);
  } finally {
    globalThis.pi = previousPi;
    __test.resetQueue();
  }
});

test("goal state and ordinary settings writes share one queue", async () => {
  const previousPi = globalThis.pi;
  const current = host({ auditorEnabled: false });
  globalThis.pi = current.pi;
  __test.resetQueue();

  try {
    const goalWrite = mutateCurrentWorkspace((workspace) => createGoal(
      workspace,
      { objective: "Preserve both writes" },
      { id: "goal-queued" },
    ));
    const preferenceWrite = updatePluginSettings(() => ({ auditorEnabled: true }));
    await Promise.all([goalWrite, preferenceWrite]);

    assert.equal(current.settings.auditorEnabled, true);
    const workspaces = Object.values(current.settings[STATE_SETTING_KEY].workspaces);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].goals[0].id, "goal-queued");
  } finally {
    globalThis.pi = previousPi;
    __test.resetQueue();
  }
});

test("oversized state is rejected before the host settings file is touched", async () => {
  const previousPi = globalThis.pi;
  const current = host();
  globalThis.pi = current.pi;
  __test.resetQueue();

  try {
    await assert.rejects(
      mutateCurrentWorkspace((workspace, { root }) => {
        root.oversized = "x".repeat(__test.MAX_STATE_BYTES + 1);
        return workspace;
      }),
      (error) => error?.code === "STATE_LIMIT_EXCEEDED",
    );
    assert.equal(current.writes.length, 0);
    assert.deepEqual(await readSettings(), {});
  } finally {
    globalThis.pi = previousPi;
    __test.resetQueue();
  }
});

test("malformed goalXState aborts without writing or dropping other settings", async () => {
  const previousPi = globalThis.pi;
  const current = host({ [STATE_SETTING_KEY]: "not-an-object", auditorEnabled: true });
  globalThis.pi = current.pi;
  __test.resetQueue();

  try {
    await assert.rejects(
      mutateCurrentWorkspace(() => assert.fail("mutator must not run")),
      (error) => error?.code === "STORAGE_INVALID",
    );
    assert.equal(current.writes.length, 0);
    assert.equal(current.settings.auditorEnabled, true);
    assert.equal(current.settings[STATE_SETTING_KEY], "not-an-object");
  } finally {
    globalThis.pi = previousPi;
    __test.resetQueue();
  }
});
