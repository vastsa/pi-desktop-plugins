import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ssh = require("../plugins/pi.ssh-manager/ssh.js");
const main = require("../plugins/pi.ssh-manager/main.js");
const execFileAsync = promisify(nodeExecFile);
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
const panelHtml = readFileSync(
  join(here, "../plugins/pi.ssh-manager/renderer/index.html"),
  "utf8",
);
const panelCss = readFileSync(
  join(here, "../plugins/pi.ssh-manager/renderer/panel.css"),
  "utf8",
);

function makeExecFile({ stdout = "", stderr = "", error = null, onCall = null } = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    const call = { file, args: [...args], options: { ...options } };
    calls.push(call);
    const child = {
      killed: false,
      kill() {
        this.killed = true;
      },
    };
    queueMicrotask(async () => {
      try {
        if (onCall) await onCall(call);
        callback(error, stdout, stderr);
      } catch (callError) {
        callback(callError, "", String(callError?.message || callError));
      }
    });
    return child;
  };
  return { calls, execFile };
}

function readAskpassBroker(endpoint, token) {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${token}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", () => resolve(output));
    socket.on("close", () => resolve(output));
  });
}

test("manifest declares a high-risk SSH agent surface with the smallest plugin permissions", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "pi.ssh-manager");
  assert.equal(manifest.version, "0.1.3");
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
  const executeContribution = manifest.contributes.agentTools.find((tool) => tool.name === "ssh_execute");
  assert.equal("allow_destructive" in executeContribution.schema.properties, false);
  assert.equal(manifest.contributes.skills[0], "skills/ssh-operations.md");
  assert.match(manifest.safetyNotes, /password|私钥|private key/i);
  assert.match(panelSource, /window\.pluginBridge\.invoke/);
  assert.match(panelSource, /ssh\.profile\.save/);
  assert.match(panelSource, /ssh\.config\.import/);
  assert.match(panelSource, /file\.path/);
  assert.match(panelSource, /event\.target\.value = ""/);
  assert.match(panelHtml, /id="configScan"/);
  assert.match(panelHtml, /id="identityFilePicker" type="file"/);
  assert.match(panelCss, /data-theme="dark"/);
  assert.match(panelCss, /:focus-visible/);
  assert.match(mainSource, /source === "panel"/);
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

test("OpenSSH config scanning imports concrete aliases without reading key contents", () => {
  assert.equal(
    ssh.__test.resolveConfigPath(join("relative", "ssh-config")),
    resolve("relative", "ssh-config"),
  );
  const config = [
    "# Defaults must not become a host by themselves",
    "Host *",
    "  ServerAliveInterval 10",
    "Host production",
    "  HostName prod.example.com",
    "  User deploy",
    "  Port 2202",
    "  IdentityFile ~/.ssh/id_production",
    "Host production",
    "  User should-not-win",
    "Host wildcard-*",
    "  HostName wildcard.example.com",
    "Host excluded !excluded",
    "  HostName excluded.example.com",
    "Host windows",
    "  HostName=windows.example.com",
    "  User=win-user",
    String.raw`  IdentityFile C:\Users\alice\.ssh\id_ed25519`,
    "  IdentityAgent SSH_AUTH_SOCK",
    "Match host production",
    "  User must-not-leak-from-match",
  ].join("\n");

  const profiles = ssh.parseSshConfig(config, { username: "local" });
  assert.deepEqual(profiles.map((profile) => profile.alias), ["production", "windows"]);
  assert.equal(profiles.some((profile) => profile.alias === "excluded"), false);
  const production = profiles.find((profile) => profile.alias === "production");
  assert.equal(production.host, "production");
  assert.equal(production.hostName, "prod.example.com");
  assert.equal(production.username, "deploy");
  assert.equal(production.port, 2202);
  assert.equal(production.identityFile, "~/.ssh/id_production");
  assert.equal(production.source, null);
  const windows = profiles.find((profile) => profile.alias === "windows");
  assert.equal(windows.hostName, "windows.example.com");
  assert.equal(windows.username, "win-user");
  assert.equal(windows.identityFile, String.raw`C:\Users\alice\.ssh\id_ed25519`);
  assert.equal(windows.agentSocket, "SSH_AUTH_SOCK");
  const root = mkdtempSync(join(tmpdir(), "pi-ssh-config-"));
  try {
    const includeDir = join(root, "conf.d");
    require("node:fs").mkdirSync(includeDir);
    const configPath = join(root, "config");
    writeFileSync(configPath, "Include conf.d/*\nHost included\n  User include-user\n", "utf8");
    writeFileSync(join(includeDir, "10-hosts"), "Host from-include\n  HostName include.example.com\n", "utf8");
    const discovered = ssh.discoverSshProfiles({ configPath, username: "local" });
    assert.equal(discovered.some((profile) => profile.configAlias === "from-include"), true);
    assert.equal(discovered.some((profile) => profile.configAlias === "included"), true);
    assert.equal(discovered.find((profile) => profile.configAlias === "from-include").host, "from-include");
    assert.match(discovered.find((profile) => profile.configAlias === "from-include").id, /^config-/);
    const importedArgs = ssh.buildSshArgs(discovered.find((profile) => profile.configAlias === "included"), {
      remoteCommand: "true",
    });
    assert.equal(importedArgs.at(-2), "included");
    assert.equal(importedArgs.at(-1), "true");
    const configFlag = importedArgs.indexOf("-F");
    assert.ok(configFlag >= 0);
    assert.equal(importedArgs[configFlag + 1], configPath);
    const importedProfile = discovered.find((profile) => profile.configAlias === "included");
    const redactedFailure = ssh.formatSshFailure(
      { stderr: `Can't open user config file ${configPath}`, exitCode: 255 },
      importedProfile,
    );
    assert.doesNotMatch(redactedFailure, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(importedArgs.includes("-p"), false);
    assert.equal(importedArgs.includes("-i"), false);

    const defaultConfigProfile = ssh.normalizeProfile({
      name: "Default config alias",
      host: "default-alias",
      username: "local",
      configAlias: "default-alias",
      source: join(homedir(), ".ssh", "config"),
    });
    const defaultConfigArgs = ssh.buildSshArgs(defaultConfigProfile, { remoteCommand: "true" });
    assert.equal(defaultConfigArgs.includes("-F"), false);

    const legacyRelativeProfile = ssh.normalizeProfile({
      name: "Legacy relative config",
      host: "legacy-alias",
      username: "local",
      configAlias: "legacy-alias",
      source: join("relative", "config"),
    });
    const legacyRelativeArgs = ssh.buildSshArgs(legacyRelativeProfile, { remoteCommand: "true" });
    assert.equal(
      legacyRelativeArgs[legacyRelativeArgs.indexOf("-F") + 1],
      resolve("relative", "config"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    const sshExecutable = process.platform === "win32"
      ? basename(fake.calls[0].file).toLowerCase()
      : fake.calls[0].file;
    assert.ok(["ssh", "ssh.exe"].includes(sshExecutable));
    assert.equal(fake.calls[0].args.at(-1), "printf 'ok'; uname -a");
    assert.ok(fake.calls[0].args.includes("-n"));
    assert.ok(fake.calls[0].args.includes("BatchMode=yes"));
    assert.ok(fake.calls[0].args.includes("ConnectTimeout=7"));
    assert.ok(fake.calls[0].args.includes("LogLevel=INFO"));
    assert.equal(fake.calls[0].options.shell, false);
  } finally {
    ssh.__test.resetExecFile();
  }
});

test("password authentication uses a transient askpass helper without returning the password", async () => {
  const password = "p%PATH%!bang^caret&pipe|redirect><()\"'$";
  let helperOutput = null;
  let helperScriptPath = null;
  const fake = makeExecFile({
    stdout: "password auth ok\n",
    async onCall(call) {
      const helperPath = call.options.env.SSH_ASKPASS;
      const helperSource = readFileSync(helperPath, "utf8");
      assert.equal(helperSource.includes(password), false);
      assert.equal(JSON.stringify(call.options.env).includes(password), false);
      const broker = ssh.__test.activeAskpassBrokerSnapshot();
      assert.ok(broker);
      const brokerToken = broker.token;
      const invalidToken = `${brokerToken[0] === "0" ? "1" : "0"}${brokerToken.slice(1)}`;
      const rejectedOutput = await readAskpassBroker(
        broker.endpoint,
        invalidToken,
      );
      assert.equal(rejectedOutput, "");
      if (process.platform === "win32") {
        assert.match(helperSource, /DisableDelayedExpansion/);
        assert.doesNotMatch(helperSource, /echo\s+%PI_SSH_ASKPASS_PASSWORD%/i);
        helperScriptPath = call.options.env.PI_SSH_ASKPASS_SCRIPT;
        assert.equal(existsSync(helperScriptPath), true);
        assert.equal(readFileSync(helperScriptPath, "utf8").includes(password), false);
        const commandShell = call.options.env.ComSpec || call.options.env.COMSPEC || "cmd.exe";
        const result = await execFileAsync(
          commandShell,
          ["/d", "/s", "/c", "call", helperPath, "Password:"],
          { encoding: "utf8", env: call.options.env, windowsHide: true },
        );
        helperOutput = result.stdout;
      } else {
        helperScriptPath = call.options.env.PI_SSH_ASKPASS_SCRIPT;
        assert.equal(existsSync(helperScriptPath), true);
        assert.equal(readFileSync(helperScriptPath, "utf8").includes(password), false);
        const result = await execFileAsync(helperPath, ["Password:"], {
          encoding: "utf8",
          env: call.options.env,
        });
        helperOutput = result.stdout;
      }
    },
  });
  ssh.__test.setExecFile(fake.execFile);
  try {
    const profile = ssh.normalizeProfile({
      id: "password-host",
      name: "Password host",
      host: "password.example.com",
      username: "ops",
    });
    const result = await ssh.runSsh(profile, {
      password,
      remoteCommand: "whoami",
      timeoutSeconds: 5,
    });

    assert.equal(result.ok, true);
    assert.ok(fake.calls[0].options.env.SSH_ASKPASS);
    assert.equal(existsSync(fake.calls[0].options.env.SSH_ASKPASS), false);
    assert.equal(existsSync(helperScriptPath), true);
    assert.equal(ssh.__test.activeAskpassBrokerCount(), 0);
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_PASSWORD, undefined);
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_ENDPOINT, undefined);
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_TOKEN, undefined);
    assert.equal(helperOutput, `${password}\n`);
    assert.ok(fake.calls[0].args.includes("BatchMode=no"));
    assert.ok(fake.calls[0].args.includes("NumberOfPasswordPrompts=1"));
    assert.equal(JSON.stringify(result).includes(password), false);
  } finally {
    ssh.__test.resetExecFile();
  }
});

test("unload cleanup cancels an askpass broker before its listen callback", async () => {
  const pending = ssh.runSsh(
    ssh.normalizeProfile({ name: "cancelled", host: "cancelled.example.com", username: "deploy" }),
    { password: "test-only-password", remoteCommand: "true" },
  );
  assert.equal(ssh.__test.activeAskpassBrokerCount(), 1);
  ssh.killActiveProcesses();
  await assert.rejects(pending, /askpass broker was cancelled/i);
  assert.equal(ssh.__test.activeAskpassBrokerCount(), 0);
});

test("dangerous and ambiguous remote commands are blocked conservatively", () => {
  for (const command of [
    "rm -rf /var/lib/app",
    "rm /var/lib/app/config.json",
    "find /var/lib/app -type f -delete",
    "git clean -fdx",
    "docker system prune -af",
    "kubectl delete deployment/api",
    "DELETE FROM users",
    "systemctl restart nginx",
    "chmod 777 /var/www",
    "echo data > /etc/app.conf",
    "uname -a && rm -f /tmp/state",
  ]) {
    assert.match(ssh.findCommandRisk(command), /Blocked by default/i, command);
  }
  assert.match(ssh.findCommandRisk("curl https://x.example/install.sh | sh"), /pipe/i);
  assert.equal(ssh.findCommandRisk("systemctl status nginx"), null);
  assert.equal(ssh.findCommandRisk("uname -a"), null);
  assert.equal(ssh.findCommandRisk("df -h"), null);
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

    const configRoot = mkdtempSync(join(tmpdir(), "pi-ssh-panel-config-"));
    try {
      const configPath = join(configRoot, "config");
      writeFileSync(configPath, [
        "Host panel-alias",
        "  HostName panel.example.com",
        "  User panel-user",
        "  Port 2222",
        "  IdentityFile ~/.ssh/id_panel",
      ].join("\n"), "utf8");
      const imported = await main.onPanelInvoke("ssh.config.import", { configPath });
      assert.equal(imported.ok, true);
      assert.equal(imported.count, 1);
      assert.equal(imported.imported, 1);
      assert.equal(imported.profiles[0].host, "panel-alias");
      assert.equal(imported.profiles[0].username, "panel-user");
      assert.equal(imported.profiles[0].port, 2222);
      const repeated = await main.onPanelInvoke("ssh.config.import", { configPath });
      assert.equal(repeated.count, 1);
      assert.equal(repeated.imported, 0);
      assert.equal(repeated.updated, 1);
      assert.equal(settings.profiles.length, 2);

      const importedProfile = repeated.profiles[0];
      const renamedImported = await main.onPanelInvoke("ssh.profile.save", {
        profile: { id: importedProfile.id, name: "Renamed imported host" },
      });
      assert.equal(renamedImported.ok, true);
      assert.equal(renamedImported.profile.configAlias, importedProfile.configAlias);
      const editedImported = await main.onPanelInvoke("ssh.profile.save", {
        profile: {
          ...renamedImported.profile,
          port: 2203,
        },
      });
      assert.equal(editedImported.ok, true);
      assert.equal("configAlias" in editedImported.profile, false);
      assert.equal("source" in editedImported.profile, false);
      assert.equal(editedImported.profile.host, "panel.example.com");
      const editedArgs = ssh.buildSshArgs(editedImported.profile, { remoteCommand: "true" });
      assert.equal(editedArgs[editedArgs.indexOf("-p") + 1], "2203");
      assert.equal(editedArgs.at(-2), "panel-user@panel.example.com");

      const tokenImported = await main.onPanelInvoke("ssh.profile.save", {
        profile: {
          id: "config-token-test",
          name: "Token identity",
          host: "token-alias",
          hostName: "token.example.com",
          username: "deploy",
          identityFile: "%d/.ssh/id_ed25519",
          configAlias: "token-alias",
          source: configPath,
        },
      });
      await assert.rejects(
        main.onPanelInvoke("ssh.profile.save", {
          profile: { ...tokenImported.profile, port: 2204 },
        }),
        /identityFile must be an absolute path/i,
      );
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }

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
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_PASSWORD, undefined);
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_ENDPOINT, undefined);
    assert.equal(fake.calls[0].options.env.PI_SSH_ASKPASS_TOKEN, undefined);
    assert.equal(JSON.stringify(fake.calls[0].options.env).includes("test-only-password"), false);

    const executeTool = registered.find((item) => item.value.name === "ssh_execute").value;
    assert.equal("allow_destructive" in executeTool.schema.properties, false);
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

    const agentOverride = await executeTool.execute({
      session_id: connected.session_id,
      command: "rm -rf /",
      allow_destructive: true,
    });
    assert.equal(agentOverride.ok, false);
    assert.equal(agentOverride.blocked, true);

    const panelWithoutApproval = await main.onPanelInvoke("ssh.execute", {
      session_id: connected.session_id,
      command: "rm -rf /tmp/pi-ssh-manager-test",
    });
    assert.equal(panelWithoutApproval.ok, false);
    assert.equal(panelWithoutApproval.blocked, true);

    const panelApproved = await main.onPanelInvoke("ssh.execute", {
      session_id: connected.session_id,
      command: "rm -rf /tmp/pi-ssh-manager-test",
      allow_destructive: true,
    });
    assert.equal(panelApproved.ok, true);
    assert.equal(panelApproved.exit_code, 0);

    await main.onUnload();
    assert.equal(unregistered.filter((item) => item.type === "tool").length, 4);
  } finally {
    ssh.__test.resetExecFile();
    globalThis.pi = previousPi;
    await main.__test.resetState();
  }
});

test("connection failures surface OpenSSH diagnostics instead of a bare exit code", () => {
  const profile = ssh.normalizeProfile({ name: "edge", host: "edge.example.com", username: "deploy" });
  assert.match(
    ssh.formatSshFailure({
      stderr: "Permission denied (publickey,password).",
      exitCode: 255,
      error: Object.assign(new Error("ssh exited with code 255"), { code: 255 }),
    }, profile),
    /Permission denied/,
  );
  const empty = ssh.formatSshFailure({
    stderr: "",
    stdout: "",
    exitCode: 255,
    error: Object.assign(new Error("ssh exited with code 255"), { code: 255 }),
  }, profile);
  assert.match(empty, /ssh exited with code 255/i);
  assert.match(empty, /host key|identity|unreachable|OpenSSH/i);
  const missing = ssh.formatSshFailure({
    stderr: "",
    error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }),
  }, profile);
  assert.match(missing, /not found/i);
});

test("runSsh keeps Windows transport diagnostics that OpenSSH reports below ERROR", async () => {
  const fake = makeExecFile({
    stderr: "banner exchange: Connection to UNKNOWN port -1: Connection refused\r\n",
    error: Object.assign(new Error("ssh exited with code 255"), { code: "255" }),
  });
  ssh.__test.setExecFile(fake.execFile);
  try {
    const result = await ssh.runSsh(
      ssh.normalizeProfile({ name: "refused", host: "refused.example.com", username: "deploy" }),
      { remoteCommand: "true", timeoutSeconds: 3 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 255);
    assert.match(result.stderr, /banner exchange/i);
    assert.match(result.error, /Connection refused/i);
  } finally {
    ssh.__test.resetExecFile();
  }
});

test("main preserves the already formatted missing-client diagnostic", async () => {
  const settings = { profiles: [] };
  const spawnError = Object.assign(new Error("spawn ssh.exe ENOENT"), { code: "ENOENT" });
  const fake = makeExecFile({ error: spawnError });
  ssh.__test.setExecFile(fake.execFile);
  const previousPi = globalThis.pi;
  globalThis.pi = {
    plugin: {
      getSettings: async () => settings,
      setSettings: async (patch) => Object.assign(settings, patch),
    },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
    ui: { openPanel: async () => {} },
  };
  try {
    await main.__test.resetState();
    await main.onLoad();
    const saved = await main.onPanelInvoke("ssh.profile.save", {
      profile: { name: "Missing SSH", host: "missing.example.com", username: "deploy" },
    });
    const failed = await main.onPanelInvoke("ssh.connect", { profile_id: saved.profile.id });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /OpenSSH client was not found/i);
    assert.doesNotMatch(failed.error, /^spawn ssh\.exe ENOENT$/i);
  } finally {
    await main.onUnload();
    ssh.__test.resetExecFile();
    globalThis.pi = previousPi;
    await main.__test.resetState();
  }
});

test("Windows SSH environment keeps SYSTEMROOT and locates OpenSSH", () => {
  const env = ssh.__test.inheritWindowsEnv(
    { PATH: "C:\\Windows\\System32", HOME: "C:\\Users\\alice" },
    { SYSTEMROOT: "C:\\Windows", USERNAME: "alice", PATHEXT: ".EXE" },
    "win32",
  );
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(env.Path, env.PATH);
  const merged = ssh.__test.mergePath("C:\\Windows\\System32", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
    home: "C:\\Users\\alice",
  });
  assert.match(merged, /OpenSSH/i);
  const resolved = ssh.__test.resolveSshCommand({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    home: "C:\\Users\\alice",
    existsSync: (candidate) => /openssh[/\\]ssh\.exe$/i.test(candidate),
  });
  assert.match(resolved, /ssh\.exe$/i);
  const args = ssh.buildSshArgs(ssh.normalizeProfile({
    name: "key-host",
    host: "key.example.com",
    username: "deploy",
    identityFile: "~/.ssh/id_ed25519",
  }), { remoteCommand: "true" });
  assert.ok(args.includes("IdentitiesOnly=yes"));
  const stripped = ssh.__test.buildEnvironment(
    ssh.normalizeProfile({ name: "win", host: "win.example.com", username: "alice" }),
    { platform: "win32", processEnv: { PATH: "C:\\Windows\\System32" } },
  );
  assert.equal(stripped.SYSTEMROOT, "C:\\Windows");
  assert.match(stripped.COMSPEC, /cmd\.exe$/i);
  const imported = ssh.buildSshArgs(ssh.normalizeProfile({
    name: "alias",
    host: "alias",
    username: "deploy",
    identityFile: "C:\\Users\\alice\\.ssh\\id_ed25519",
    configAlias: "alias",
  }), { remoteCommand: "true" });
  assert.ok(imported.includes("-i"));
  assert.equal(imported.includes("IdentitiesOnly=yes"), false);
});


test("panel connect failures return diagnostics and unload kills leftover ssh processes", async () => {
  const settings = { profiles: [] };
  const fake = makeExecFile({
    stdout: "",
    stderr: "Permission denied (publickey).",
    error: Object.assign(new Error("ssh exited with code 255"), { code: 255 }),
  });
  ssh.__test.setExecFile(fake.execFile);
  const previousPi = globalThis.pi;
  globalThis.pi = {
    plugin: {
      getSettings: async () => settings,
      setSettings: async (patch) => Object.assign(settings, patch),
    },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
    ui: { openPanel: async () => {} },
  };
  try {
    await main.__test.resetState();
    await main.onLoad();
    const saved = await main.onPanelInvoke("ssh.profile.save", {
      profile: { name: "Broken", host: "broken.example.com", username: "root" },
    });
    const failed = await main.onPanelInvoke("ssh.connect", { profile_id: saved.profile.id });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Permission denied/);
    const hangingCalls = [];
    ssh.__test.setExecFile((file, args, options, callback) => {
      const child = {
        killed: false,
        kill() {
          this.killed = true;
          queueMicrotask(() => callback(new Error("killed"), "", ""));
        },
      };
      hangingCalls.push(child);
      return child;
    });
    const connecting = main.onPanelInvoke("ssh.connect", { profile_id: saved.profile.id });
    for (let i = 0; i < 40 && hangingCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(hangingCalls.length, 1);
    assert.equal(ssh.__test.activeProcessCount(), 1);
    await main.onUnload();
    assert.equal(hangingCalls[0].killed, true);
    assert.equal(ssh.__test.activeProcessCount(), 0);
    await connecting;
  } finally {
    ssh.__test.resetExecFile();
    globalThis.pi = previousPi;
    await main.__test.resetState();
  }
});
