"use strict";

/* SSH Manager panel. All user-controlled strings are inserted with textContent. */

const STRINGS = {
  en: {
    appName: "SSH Manager",
    localFirst: "LOCAL FIRST",
    hosts: "Hosts",
    addHost: "Add host",
    credentialNote: "Credentials stay with OpenSSH. This panel stores metadata only.",
    workspace: "REMOTE WORKSPACE",
    pageSubtitle: "Connect to a configured host, then run a bounded command.",
    ready: "Ready",
    refresh: "Refresh",
    hostProfile: "HOST PROFILE",
    profileName: "Display name",
    host: "Host",
    port: "Port",
    username: "Username",
    identityFile: "Identity file path (optional)",
    agentSocket: "SSH agent socket (optional)",
    password: "Password (not saved)",
    clearPassword: "Clear the in-memory password",
    hostKeyPolicy: "Host-key policy",
    verifyStrict: "Strict — verify known hosts",
    verifyNew: "Accept new — add unseen keys",
    formHelp: "Passwords stay in memory only and private-key contents are never read. Use OpenSSH config, ssh-agent, or an identity-file path.",
    cancel: "Cancel",
    saveHost: "Save host",
    editHost: "Edit host",
    connect: "Connect",
    disconnect: "Disconnect",
    deleteHost: "Delete host",
    connected: "Connected",
    offline: "Not connected",
    strict: "Strict host key",
    acceptsNew: "Accepts new host key",
    configuredKey: "Identity configured",
    agent: "Agent configured",
    passwordConfigured: "Password in memory",
    noAuthHint: "OpenSSH auth",
    hostEmptyTitle: "Add your first SSH host",
    hostEmptyText: "Save only connection metadata here. Authentication stays in your local OpenSSH setup.",
    addFirstHost: "Add first host",
    remoteCommand: "Remote command",
    commandPlaceholder: "e.g. uname -a",
    runCommand: "Run command",
    runOnce: "Run once",
    allowDestructive: "Allow blocked destructive patterns for this run",
    allowDestructiveHint: "Only check this after you have reviewed the command.",
    quickCommands: "Quick commands",
    systemInfo: "System info",
    uptime: "Uptime",
    disk: "Disk usage",
    output: "Output",
    noOutput: "Command output will appear here.",
    aiTitle: "AI connection tools",
    aiText: "The AI can list configured hosts, connect with strict host-key verification, run bounded commands, and forget logical sessions. It cannot read or return stored key material.",
    noSelection: "Select a host to manage it.",
    noHosts: "No SSH hosts configured",
    operationFailed: "Operation failed",
    saved: "Host saved",
    deleted: "Host deleted",
    refreshed: "Refreshed",
    connectFailed: "Connection failed",
    connectedNotice: "Connected to {host}",
    disconnectedNotice: "Session forgotten",
    commandFailed: "Command exited with code {code}",
    commandOk: "Command completed",
    blocked: "Command blocked",
    confirmDelete: "Delete this SSH host profile?",
    close: "Close",
  },
  "zh-CN": {
    appName: "SSH 在线管理",
    localFirst: "本地优先",
    hosts: "主机",
    addHost: "添加主机",
    credentialNote: "凭据交给 OpenSSH 管理，面板只保存连接元数据。",
    workspace: "远程工作区",
    pageSubtitle: "连接已配置主机，然后执行有边界的远程命令。",
    ready: "就绪",
    refresh: "刷新",
    hostProfile: "主机配置",
    profileName: "显示名称",
    host: "主机",
    port: "端口",
    username: "用户名",
    identityFile: "私钥路径（可选）",
    agentSocket: "SSH agent socket（可选）",
    password: "密码（不保存）",
    clearPassword: "清除内存中的密码",
    hostKeyPolicy: "主机密钥策略",
    verifyStrict: "严格校验 — 仅使用已知主机",
    verifyNew: "接受新密钥 — 写入未见过的密钥",
    formHelp: "密码只保存在内存中，插件不会读取私钥内容。请使用 OpenSSH 配置、ssh-agent 或私钥路径。",
    cancel: "取消",
    saveHost: "保存主机",
    editHost: "编辑主机",
    connect: "连接",
    disconnect: "断开",
    deleteHost: "删除主机",
    connected: "已连接",
    offline: "未连接",
    strict: "严格主机密钥",
    acceptsNew: "接受新主机密钥",
    configuredKey: "已配置私钥",
    agent: "已配置 Agent",
    passwordConfigured: "密码在内存中",
    noAuthHint: "使用 OpenSSH 认证",
    hostEmptyTitle: "添加第一台 SSH 主机",
    hostEmptyText: "这里只保存连接元数据，认证仍由本机 OpenSSH 配置负责。",
    addFirstHost: "添加第一台主机",
    remoteCommand: "远程命令",
    commandPlaceholder: "例如 uname -a",
    runCommand: "执行命令",
    runOnce: "执行一次",
    allowDestructive: "允许本次执行被拦截的破坏性模式",
    allowDestructiveHint: "仅在你确认过命令后勾选。",
    quickCommands: "快捷命令",
    systemInfo: "系统信息",
    uptime: "运行时间",
    disk: "磁盘用量",
    output: "输出",
    noOutput: "命令输出会显示在这里。",
    aiTitle: "AI 连接工具",
    aiText: "AI 可以列出已配置主机、在严格校验主机密钥的前提下连接、执行有超时和输出上限的命令，并忘记逻辑会话；它无法读取或返回私钥内容。",
    noSelection: "选择一台主机开始管理。",
    noHosts: "还没有配置 SSH 主机",
    operationFailed: "操作失败",
    saved: "主机已保存",
    deleted: "主机已删除",
    refreshed: "已刷新",
    connectFailed: "连接失败",
    connectedNotice: "已连接到 {host}",
    disconnectedNotice: "已忘记会话",
    commandFailed: "命令退出码 {code}",
    commandOk: "命令执行完成",
    blocked: "命令已拦截",
    confirmDelete: "确认删除这台 SSH 主机配置？",
    close: "关闭",
  },
};

const state = {
  locale: document.documentElement.dataset.lang === "zh" ? "zh-CN" : "en",
  profiles: [],
  sessions: [],
  selectedId: null,
  command: "",
  output: null,
  loading: true,
  notice: "",
  noticeKind: "",
};

const $ = (id) => document.getElementById(id);
const t = (key) => (STRINGS[state.locale] || STRINGS.en)[key] || STRINGS.en[key] || key;
const tr = (key, values = {}) => Object.keys(values).reduce(
  (text, name) => text.replace(`{${name}}`, String(values[name])),
  t(key),
);

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = content;
  return node;
}

function button(label, className, handler, disabled = false) {
  const node = el("button", `button ${className || "button-secondary"}`, label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", handler);
  return node;
}

function invoke(channel, payload, allowFailure = false) {
  return window.pluginBridge.invoke(channel, payload || {}).then((result) => {
    if (!allowFailure && result && typeof result === "object" && result.ok === false) {
      throw new Error(result.error || t("operationFailed"));
    }
    return result || {};
  });
}

function setNotice(message, kind = "") {
  state.notice = message || "";
  state.noticeKind = kind;
  const node = $("notice");
  node.textContent = state.notice;
  node.className = `notice ${kind}`;
  node.hidden = !state.notice;
}

function sessionFor(profileId) {
  return state.sessions.find((session) => session.profileId === profileId) || null;
}

function selectedProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedId) || null;
}

function applyStaticText() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  $("profileHost").placeholder = state.locale === "zh-CN" ? "server.example.com" : "server.example.com";
  $("profileIdentity").placeholder = "~/.ssh/id_ed25519";
  $("profileAgent").placeholder = state.locale === "zh-CN" ? "有 SSH_AUTH_SOCK 时自动使用" : "Uses SSH_AUTH_SOCK when available";
  $("profilePassword").placeholder = state.locale === "zh-CN" ? "仅在本机输入" : "Enter only on this device";
  $("closeModal").setAttribute("aria-label", t("close"));
}

function renderHostList() {
  const list = $("hostList");
  list.textContent = "";
  $("hostCount").textContent = String(state.profiles.length);
  if (!state.profiles.length) {
    list.appendChild(el("div", "sidebar-empty", t("noHosts")));
    return;
  }
  for (const profile of state.profiles) {
    const session = sessionFor(profile.id);
    const item = el("button", `host-item ${profile.id === state.selectedId ? "selected" : ""}`);
    item.type = "button";
    item.setAttribute("role", "listitem");
    item.title = `${profile.username}@${profile.host}:${profile.port}`;
    const top = el("span", "host-item-top");
    top.append(el("span", `status-dot ${session ? "online" : ""}`));
    top.append(el("span", "host-item-name", profile.name));
    if (session) top.append(el("span", "mini-status", t("connected")));
    const address = el("span", "host-item-address", `${profile.username}@${profile.host}`);
    item.append(top, address);
    item.addEventListener("click", () => {
      state.selectedId = profile.id;
      state.output = null;
      render();
    });
    list.appendChild(item);
  }
}

function metaChip(label, value, tone = "") {
  const chip = el("span", `meta-chip ${tone}`);
  chip.append(el("span", "meta-label", label), el("strong", "meta-value", value));
  return chip;
}

function buildEmptyDetail() {
  const empty = el("section", "empty-detail");
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  icon.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z\"/><path d=\"M8 10h8M8 14h5\"/></svg>";
  empty.append(icon, el("h2", "empty-title", state.profiles.length ? t("noSelection") : t("hostEmptyTitle")));
  empty.append(el("p", "empty-text", state.profiles.length ? t("noSelection") : t("hostEmptyText")));
  if (!state.profiles.length) empty.appendChild(button(t("addFirstHost"), "button-primary", () => openModal()));
  return empty;
}

function buildCommandCard(profile, session) {
  const card = el("section", "panel-card command-card");
  const header = el("div", "card-header");
  const titleWrap = el("div");
  titleWrap.append(el("h3", "card-title", t("remoteCommand")), el("p", "card-subtitle", t("commandPlaceholder")));
  header.append(titleWrap);
  const statePill = el("span", `state-pill ${session ? "online" : "offline"}`, session ? t("connected") : t("runOnce"));
  header.append(statePill);
  card.appendChild(header);

  const form = el("form", "command-form");
  const textarea = document.createElement("textarea");
  textarea.id = "commandInput";
  textarea.rows = 3;
  textarea.maxLength = 16384;
  textarea.spellcheck = false;
  textarea.placeholder = t("commandPlaceholder");
  textarea.value = state.command;
  textarea.setAttribute("aria-label", t("remoteCommand"));
  textarea.addEventListener("input", () => { state.command = textarea.value; });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runCommand(profile);
    }
  });
  form.appendChild(textarea);

  const options = el("div", "command-options");
  const allowLabel = el("label", "checkbox-label");
  const allow = document.createElement("input");
  allow.type = "checkbox";
  allow.id = "allowDestructive";
  allowLabel.append(allow, el("span", "checkbox-text", t("allowDestructive")));
  options.append(allowLabel, el("span", "hint", t("allowDestructiveHint")));
  form.appendChild(options);

  const footer = el("div", "command-footer");
  const quick = el("div", "quick-actions");
  quick.append(el("span", "quick-label", t("quickCommands")));
  for (const [label, command] of [[t("systemInfo"), "uname -a"], [t("uptime"), "uptime"], [t("disk"), "df -h"]]) {
    const quickButton = el("button", "quick-button", label);
    quickButton.type = "button";
    quickButton.addEventListener("click", () => {
      state.command = command;
      textarea.value = command;
      textarea.focus();
    });
    quick.appendChild(quickButton);
  }
  footer.appendChild(quick);
  footer.appendChild(button(session ? t("runCommand") : t("runOnce"), "button-primary", () => void runCommand(profile)));
  form.appendChild(footer);
  card.appendChild(form);
  return card;
}

function buildOutputCard() {
  const card = el("section", "panel-card output-card");
  const header = el("div", "card-header");
  header.append(el("h3", "card-title", t("output")));
  if (state.output) {
    const ok = state.output.ok && state.output.exit_code === 0;
    header.append(el("span", `output-status ${ok ? "success" : "failure"}`, ok ? t("commandOk") : tr("commandFailed", { code: state.output.exit_code ?? "—" })));
  }
  card.appendChild(header);
  const pre = el("pre", "terminal-output");
  if (!state.output) {
    pre.appendChild(el("span", "terminal-placeholder", t("noOutput")));
  } else if (state.output.blocked) {
    pre.appendChild(el("span", "terminal-error", `${t("blocked")}\n${state.output.error || ""}`));
  } else {
    const lines = [];
    if (state.output.stdout) lines.push(state.output.stdout.trimEnd());
    if (state.output.stderr) lines.push(`[stderr]\n${state.output.stderr.trimEnd()}`);
    if (!lines.length && state.output.error) lines.push(state.output.error);
    pre.textContent = lines.join("\n\n") || "(no output)";
  }
  card.appendChild(pre);
  return card;
}

function buildAiCard() {
  const card = el("section", "ai-card");
  const icon = el("div", "ai-icon", "AI");
  const copy = el("div");
  copy.append(el("h3", "card-title", t("aiTitle")), el("p", "ai-text", t("aiText")));
  card.append(icon, copy);
  return card;
}

function renderDetail() {
  const detail = $("detail");
  detail.textContent = "";
  const profile = selectedProfile();
  if (!profile) {
    detail.appendChild(buildEmptyDetail());
    return;
  }
  const session = sessionFor(profile.id);
  const top = el("section", "detail-top");
  const identity = el("div", "identity");
  identity.append(el("div", "eyebrow", t("hostProfile")), el("h2", "detail-title", profile.name));
  identity.append(el("p", "detail-address", `${profile.username}@${profile.host}:${profile.port}`));
  const actions = el("div", "detail-actions");
  if (session) {
    actions.append(button(t("disconnect"), "button-secondary", () => void disconnect(profile)));
  } else {
    actions.append(button(t("connect"), "button-primary", () => void connect(profile)));
  }
  actions.append(button(t("editHost"), "button-secondary", () => openModal(profile)));
  actions.append(button(t("deleteHost"), "button-danger", () => void deleteProfile(profile)));
  top.append(identity, actions);
  detail.appendChild(top);

  const chips = el("div", "meta-row");
  chips.append(metaChip(t("host"), profile.host));
  chips.append(metaChip(t("port"), String(profile.port)));
  chips.append(metaChip(t("username"), profile.username));
  chips.append(metaChip(profile.strictHostKeyChecking === "accept-new" ? t("acceptsNew") : t("strict"), profile.strictHostKeyChecking === "accept-new" ? "accept-new" : "yes", profile.strictHostKeyChecking === "accept-new" ? "warning" : "safe"));
  chips.append(metaChip(
    profile.passwordConfigured
      ? t("passwordConfigured")
      : profile.identityFile
        ? t("configuredKey")
        : profile.agentSocket
          ? t("agent")
          : t("noAuthHint"),
    profile.passwordConfigured ? "password" : profile.identityFile ? "key" : profile.agentSocket ? "agent" : "config",
  ));
  detail.appendChild(chips);

  if (session) {
    const connected = el("div", "connected-banner");
    connected.append(el("span", "status-dot online"), el("span", "", tr("connectedNotice", { host: profile.host })), el("span", "connected-time", new Date(session.connectedAt).toLocaleTimeString()));
    detail.appendChild(connected);
  }
  detail.append(buildCommandCard(profile, session), buildOutputCard(), buildAiCard());
}

function render() {
  applyStaticText();
  renderHostList();
  $("globalStatus").querySelector("span:last-child").textContent = state.loading ? "…" : state.profiles.length ? t("ready") : t("noHosts");
  renderDetail();
  document.documentElement.dataset.booting = "false";
}

async function refresh(showNotice = false) {
  state.loading = true;
  render();
  try {
    const snapshot = await invoke("ssh.snapshot");
    state.profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
    state.sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    if (!state.selectedId || !state.profiles.some((profile) => profile.id === state.selectedId)) {
      state.selectedId = state.profiles[0]?.id || null;
    }
    if (showNotice) setNotice(t("refreshed"), "success");
  } catch (error) {
    setNotice(error.message || String(error), "error");
  } finally {
    state.loading = false;
    render();
  }
}

function fillProfileForm(profile) {
  $("profileId").value = profile?.id || "";
  $("profileName").value = profile?.name || "";
  $("profileHost").value = profile?.host || "";
  $("profilePort").value = profile?.port || 22;
  $("profileUsername").value = profile?.username || "";
  $("profileIdentity").value = profile?.identityFile || "";
  $("profileAgent").value = profile?.agentSocket || "";
  $("profilePassword").value = "";
  $("clearPassword").checked = false;
  $("profileHostKey").value = profile?.strictHostKeyChecking || "yes";
}

function openModal(profile = null) {
  fillProfileForm(profile);
  $("modalTitle").textContent = profile ? t("editHost") : t("addHost");
  $("profileModal").hidden = false;
  window.setTimeout(() => $("profileName").focus(), 0);
}

function closeModal() {
  $("profileModal").hidden = true;
}

async function saveProfile(event) {
  event.preventDefault();
  const profile = {
    id: $("profileId").value || undefined,
    name: $("profileName").value,
    host: $("profileHost").value,
    port: Number($("profilePort").value),
    username: $("profileUsername").value,
    identityFile: $("profileIdentity").value,
    agentSocket: $("profileAgent").value,
    password: $("profilePassword").value,
    clearPassword: $("clearPassword").checked,
    strictHostKeyChecking: $("profileHostKey").value,
  };
  try {
    const result = await invoke("ssh.profile.save", { profile });
    state.profiles = state.profiles.filter((item) => item.id !== result.profile.id).concat(result.profile);
    state.profiles.sort((a, b) => a.name.localeCompare(b.name));
    state.selectedId = result.profile.id;
    closeModal();
    setNotice(t("saved"), "success");
    render();
  } catch (error) {
    setNotice(error.message || String(error), "error");
  }
}

async function deleteProfile(profile) {
  if (!window.confirm(t("confirmDelete"))) return;
  try {
    await invoke("ssh.profile.delete", { id: profile.id });
    state.profiles = state.profiles.filter((item) => item.id !== profile.id);
    state.sessions = state.sessions.filter((session) => session.profileId !== profile.id);
    state.selectedId = state.profiles[0]?.id || null;
    state.output = null;
    setNotice(t("deleted"), "success");
    render();
  } catch (error) {
    setNotice(error.message || String(error), "error");
  }
}

async function connect(profile) {
  try {
    const result = await invoke("ssh.connect", {
      profile_id: profile.id,
      accept_new_host_key: profile.strictHostKeyChecking === "accept-new",
    });
    state.sessions = state.sessions.filter((session) => session.profileId !== profile.id);
    if (result.session) state.sessions.push(result.session);
    setNotice(tr("connectedNotice", { host: profile.host }), "success");
    render();
  } catch (error) {
    setNotice(`${t("connectFailed")}: ${error.message || error}`, "error");
  }
}

async function disconnect(profile) {
  const session = sessionFor(profile.id);
  if (!session) return;
  try {
    await invoke("ssh.disconnect", { session_id: session.id });
    state.sessions = state.sessions.filter((item) => item.id !== session.id);
    setNotice(t("disconnectedNotice"), "success");
    render();
  } catch (error) {
    setNotice(error.message || String(error), "error");
  }
}

async function runCommand(profile) {
  const command = state.command.trim();
  if (!command) {
    $("commandInput")?.focus();
    return;
  }
  const session = sessionFor(profile.id);
  const allow = Boolean($("allowDestructive")?.checked);
  try {
    const result = await invoke("ssh.execute", {
      profile_id: profile.id,
      session_id: session?.id,
      command,
      allow_destructive: allow,
      accept_new_host_key: profile.strictHostKeyChecking === "accept-new",
    }, true);
    state.output = result;
    if (result.ok === false) setNotice(result.error || t("operationFailed"), result.blocked ? "warning" : "error");
    else setNotice(t("commandOk"), "success");
    render();
  } catch (error) {
    setNotice(error.message || String(error), "error");
  }
}

function bindEvents() {
  $("addHost").addEventListener("click", () => openModal());
  $("refresh").addEventListener("click", () => void refresh(true));
  $("closeModal").addEventListener("click", closeModal);
  $("cancelModal").addEventListener("click", closeModal);
  $("profileForm").addEventListener("submit", (event) => void saveProfile(event));
  $("profileModal").addEventListener("click", (event) => {
    if (event.target === $("profileModal")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("profileModal").hidden) closeModal();
  });
}

function initAppearance() {
  applyStaticText();
  if (!window.__appearance) return;
  window.__appearance.init(window.pluginBridge);
  window.__appearance.onLocaleChange((locale) => {
    state.locale = locale === "zh-CN" ? "zh-CN" : "en";
    render();
  });
}

async function init() {
  initAppearance();
  bindEvents();
  render();
  await refresh();
}

void init().catch((error) => {
  state.loading = false;
  setNotice(error.message || String(error), "error");
  render();
});
