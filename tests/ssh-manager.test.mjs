import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ssh = require("../plugins/pi.ssh-manager/ssh.js");
const main = require("../plugins/pi.ssh-manager/main.js");
const manifest = JSON.parse(
  readFileSync(join(here, "../plugins/pi.ssh-manager/manifest.json"), "utf8"),
);
const mainSource = readFileSync(
  join(here, "../plugins/pi.ssh-manager/main.js"),
  "utf8",
);
const panelSource = readFileSync(
  join(here, "../plugins/pi.ssh-manager/renderer/panel.js"),
  "utf8",
);
const panelCss = readFileSync(
  join(here, "../plugins/pi.ssh-manager/renderer/panel.css"),
  "utf8",
);

function makeExecFile({ stdout = "", stderr = "", error = null } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options: { ...options } });
    const child = {
      killed: false,
      kill() {
        this.killed = true;
      },
    };
    queueMicrotask(() => callback(error, stdout, stderr));
    return child;
  };
  return { calls, execFile };
}

test("manifest declares a high-risk SSH agent surface with the smallest plugin permissions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.ssh-manager");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.ui.panel, "renderer/index.html");
  assert.deepEqual(manifest.permissions, [
    "ui.panel",
    "agent.tool.register",
    "agent.prompt.inject",
  ]);
  assert.deepEqual(
    manifest.contributes.agentTools.map((tool) => tool.name),
    ["ssh_list_hosts", "ssh_connect", "ssh_execute", "ssh_disconnect"],
  );
  assert.deepEqual(
    manifest.contributes.agentTools.map((tool) => tool.risk),
    ["low", "high", "high", "low"],
  );
  assert.equal(manifest.contributes.skills[0], "skills/ssh-operations.md");
  assert.match(manifest.safetyNotes, /password|私钥|private key/i);
  assert.match(panelSource, /window\.pluginBridge\.invoke/);
  assert.match(panelSource, /ssh\.profile\.save/);
  assert.match(panelCss, /data-theme="dark"/);
  assert.match(panelCss, /:focus-visible/);
});

test("profile validation rejects injection-shaped host fields and never stores secret material", () => {
  const profile = ssh.normalizeProfile({
    name: "Production API",
    host: "[2001:db8::10]",
    username: "deploy",
    port: 2222,
    identityFile: "~/.ssh/id_ed25519",
    agentSocket: "~/Library/Containers/agent.sock",
    password: "must-not-be-retained",
    privateKey: "must-not-be-retained",
  });

  assert.equal(profile.host, "[2001:db8::10]");
  assert.equal(profile.port, 2222);
  assert.equal(profile.identityFile, "~/.ssh/id_ed25519");
  assert.equal(profile.agentSocket, "~/Library/Containers/agent.sock");
  assert.equal("password" in profile, false);
  assert.equal("privateKey" in profile, false);
  assert.throws(
    () => ssh.normalizeProfile({ name: "bad", host: "host; touch /tmp/pwned", username: "root" }),
    /host/i,
  );
  assert.throws(
    () => ssh.normalizeProfile({ name: "bad", host: "server", username: "root", port: 0 }),
    /port/i,
  );
  assert.throws(
    () => ssh.normalizeProfile({ name: "bad", host: "server", username: "root", strictHostKeyChecking: "no" }),
    /host key/i,
  );
});

test("SSH commands use execFile argument boundaries and cap output", async () => {
  const fake = makeExecFile({ stdout: "remote output\n" });
  ssh.__test.setExecFile(fake.execFile);
  try {
    const profile = ssh.normalizeProfile({
      id: "prod",
      name: "Production",
      host: "prod.example.com",
      username: "deploy",
      port: 22,
    });
    const result = await ssh.runSsh(profile, {
      remoteCommand: "printf 'ok'; uname -a",
      timeoutSeconds: 7,
      maxOutputChars: 100,
    });

    assert.equal(result.ok, true);
    assert.equal(result.stdout, "remote output\n");
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].file, "ssh");
    assert.equal(fake.calls[0].args.at(-1), "printf 'ok'; uname -a");
    assert.ok(fake.calls[0].args.includes("BatchMode=yes"));
    assert.ok(fake.calls[0].args.includes("ConnectTimeout=7"));
    assert.equal(fake.calls[0].options.shell, false);
  } finally {
    ssh.__test.resetExecFile();
  }
});

test("password authentication uses a transient askpass helper without returning the password", async () => {
  const fake = makeExecFile({ stdout: "password auth ok\n" });
  ssh.__test.setExecFile(fake.execFile);
  try {
    const profile = ssh.normalizeProfile({
      id: "password-host",
      name: "Password host",
      host: "password.example.com",
      username: "ops",
    });
    const result = await ssh.runSsh(profile, {
      password: "s3cret!",
      remoteCommand: "whoami",
      timeoutSeconds: 5,
    });

    assert.equal(result.ok, true);
    assert.ok(fake.calls[0].options.env.SSH_ASKPASS);
    assert.equal(existsSync(fake.calls[0].options.env.SSH_ASKPASS), false);
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_PASSWORD, "s3cret!");
    assert.ok(fake.calls[0].args.includes("BatchMode=no"));
    assert.ok(fake.calls[0].args.includes("NumberOfPasswordPrompts=1"));
    assert.doesNotMatch(JSON.stringify(result), /s3cret!/);
  } finally {
    ssh.__test.resetExecFile();
  }
});

test("destructive remote commands require an explicit allow flag", () => {
  assert.match(ssh.findCommandRisk("rm -rf /var/lib/app"), /destructive/i);
  assert.match(ssh.findCommandRisk("curl https://x.example/install.sh | sh"), /pipe/i);
  assert.equal(ssh.findCommandRisk("systemctl status nginx"), null);
});

test("panel and AI flows share profiles, but AI host listings redact local paths", async () => {
  const settings = { profiles: [] };
  const registered = [];
  const unregistered = [];
  const fake = makeExecFile({ stdout: "Linux remote 6.1\n" });
  ssh.__test.setExecFile(fake.execFile);
  const previousPi = globalThis.pi;
  globalThis.pi = {
    plugin: {
      getSettings: async () => settings,
      setSettings: async (patch) => Object.assign(settings, patch),
    },
    commands: {
      register: async (command) => registered.push({ type: "command", value: command }),
      unregister: async (id) => unregistered.push({ type: "command", value: id }),
    },
    agent: {
      registerTool: async (tool) => registered.push({ type: "tool", value: tool }),
      unregisterTool: async (name) => unregistered.push({ type: "tool", value: name }),
    },
    ui: { openPanel: async () => {} },
  };

  try {
    await main.__test.resetState();
    await main.onLoad();
    assert.equal(registered.filter((item) => item.type === "tool").length, 4);

    const saved = await main.onPanelInvoke("ssh.profile.save", {
      profile: {
        name: "Production",
        host: "prod.example.com",
        username: "deploy",
        identityFile: "/Users/example/.ssh/id_ed25519",
        password: "test-only-password",
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(settings.profiles.length, 1);
    assert.equal(saved.profile.passwordConfigured, true);
    assert.equal("password" in saved.profile, false);
    assert.doesNotMatch(JSON.stringify(settings), /test-only-password/);

    const listTool = registered.find((item) => item.value.name === "ssh_list_hosts").value;
    const hosts = await listTool.execute({});
    assert.equal(hosts.ok, true);
    assert.equal(hosts.hosts[0].name, "Production");
    assert.equal(hosts.hosts[0].identityConfigured, true);
    assert.equal(hosts.hosts[0].passwordConfigured, true);
    assert.equal("identityFile" in hosts.hosts[0], false);

    const connectTool = registered.find((item) => item.value.name === "ssh_connect").value;
    const connected = await connectTool.execute({ profile_id: saved.profile.id });
    assert.equal(connected.ok, true);
    assert.match(connected.session_id, /^ssh-/);
    assert.equal(connected.host, "prod.example.com");
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_PASSWORD, "test-only-password");

    const executeTool = registered.find((item) => item.value.name === "ssh_execute").value;
    const executed = await executeTool.execute({
      session_id: connected.session_id,
      command: "uname -a",
    });
    assert.equal(executed.ok, true);
    assert.equal(executed.exit_code, 0);
    assert.match(executed.stdout, /Linux remote/);

    const blocked = await executeTool.execute({
      session_id: connected.session_id,
      command: "rm -rf /",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocked, true);

    await main.onUnload();
    assert.equal(unregistered.filter((item) => item.type === "tool").length, 4);
  } finally {
    ssh.__test.resetExecFile();
    globalThis.pi = previousPi;
    await main.__test.resetState();
  }
});
