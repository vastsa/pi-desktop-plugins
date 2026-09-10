"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  onLoad,
  toolCheckPath,
  toolProjectRoot,
} = require("../plugins/pi.workspace-file-guard/main");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withPi(impl, fn) {
  const previous = global.pi;
  global.pi = impl;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete global.pi;
    else global.pi = previous;
  }
}

async function run() {
  const workspace = process.platform === "win32" ? "D:\\example-project" : "/data/example-project";
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "pi.workspace-file-guard", "manifest.json"), "utf8")
  );
  assert(manifest.version === "0.2.5", "manifest version must match the reviewed release");
  assert(
    JSON.stringify(manifest.permissions) === JSON.stringify(["agent.prompt.inject", "agent.tool.register"]),
    "manifest permissions must remain minimal and exact"
  );
  await withPi(
    {
      workspace: {
        async get() {
          throw new Error("no workspace api");
        },
      },
    },
    async () => {
      const missing = await toolCheckPath({ path: "src/a.js" });
      assert(missing.ok === false, "workspace throw must fail closed");
      assert(/workspace unavailable/.test(missing.error), missing.error);
      const missingRoot = await toolProjectRoot({});
      assert(missingRoot.ok === false, "project_root must fail without workspace");
    }
  );

  await withPi(
    {
      workspace: {
        async get() {
          return { path: workspace };
        },
      },
    },
    async () => {
      const relative = await toolCheckPath({ path: "src/a.js" });
      assert(relative.ok === true, "classification should succeed");
      assert(relative.allowed === true, "workspace relative path should be allowed");
      assert(
        relative.path.toLowerCase() === path.join(workspace, "src", "a.js").toLowerCase(),
        relative.path
      );
    }
  );
  const registered = [];
  const unregistered = [];
  let registerError = null;
  await withPi(
    {
      agent: {
        async registerTool(tool) {
          registered.push(tool.name);
          if (tool.name === "temp_env") throw new Error("simulated registration failure");
        },
        async unregisterTool(name) {
          unregistered.push(name);
        },
      },
    },
    async () => {
      try {
        await onLoad();
      } catch (error) {
        registerError = error;
      }
    }
  );
  assert(registerError && /simulated/.test(registerError.message), "onLoad must surface registration failures");
  assert(
    JSON.stringify(registered) === JSON.stringify(["project_root", "check_path", "temp_env"]),
    "onLoad must track registrations"
  );
  assert(
    JSON.stringify(unregistered) === JSON.stringify(["check_path", "project_root"]),
    "onLoad must roll back registered tools in reverse order"
  );
  console.log("ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
