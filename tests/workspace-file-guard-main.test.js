"use strict";

const path = require("node:path");
const { toolCheckPath, toolProjectRoot } = require("../plugins/pi.workspace-file-guard/main");

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

  console.log("ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
