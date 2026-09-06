"use strict";

const STRINGS = {
  en: {
    newTab: "New tab",
    closeTab: "Close tab",
    menu: "Menu",
    untitled: "Terminal",
    exited: "exited",
    helperMissing: "The PTY helper is missing for this platform.",
    spawnFailed: "Could not start a shell.",
    copy: "Copy",
    paste: "Paste",
    copyFailed: "Could not copy the selection.",
    pasteFailed: "Could not paste from the clipboard.",
    clear: "Clear screen",
    find: "Find",
    findPlaceholder: "Find in terminal",
    larger: "Larger text",
    smaller: "Smaller text",
    close: "Close tab",
  },
  "zh-CN": {
    newTab: "新建标签",
    closeTab: "关闭标签",
    menu: "菜单",
    untitled: "终端",
    exited: "已退出",
    helperMissing: "当前平台缺少 PTY 助手。",
    spawnFailed: "无法启动 shell。",
    copy: "复制",
    paste: "粘贴",
    copyFailed: "无法复制选区。",
    pasteFailed: "无法从剪贴板粘贴。",
    clear: "清屏",
    find: "查找",
    findPlaceholder: "在终端中查找",
    larger: "增大字号",
    smaller: "减小字号",
    close: "关闭标签",
  },
};

const DARK_THEME = {
  background: "#0d0d0d",
  foreground: "#d7dadc",
  cursor: "#ffffff",
  cursorAccent: "#0d0d0d",
  selectionBackground: "#3d4248",
  selectionForeground: "#ffffff",
  black: "#181818",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d7dadc",
  brightBlack: "#5d5d5d",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

const LIGHT_THEME = {
  background: "#fbfbfa",
  foreground: "#1a1c1f",
  cursor: "#1a1c1f",
  cursorAccent: "#ffffff",
  selectionBackground: "#d9dde3",
  black: "#1a1c1f",
  red: "#c0392b",
  green: "#1e8e62",
  yellow: "#a8751c",
  blue: "#2f6fd6",
  magenta: "#7a3ea8",
  cyan: "#0f7a86",
  white: "#1a1c1f",
  brightBlack: "#5d5d5d",
  brightRed: "#d0392f",
  brightGreen: "#1e8e62",
  brightYellow: "#a8751c",
  brightBlue: "#2f6fd6",
  brightMagenta: "#7a3ea8",
  brightCyan: "#0f7a86",
  brightWhite: "#303030",
};

const state = {
  locale: "en",
  fontSize: 13,
  scrollback: 5000,
  profiles: [],
  home: "",
  workspaceKey: null,
  switching: false,
  activeId: null,
  tabs: new Map(),
  pumping: new Set(),
  find: { query: "", index: -1, total: 0 },
};

function t(key) {
  return (STRINGS[state.locale] || STRINGS.en)[key] || STRINGS.en[key] || key;
}

function $(id) {
  return document.getElementById(id);
}

function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform || "");
}

function mod(event) {
  return isMac() ? event.metaKey : event.ctrlKey;
}

async function invoke(channel, payload) {
  if (!window.pluginBridge || typeof window.pluginBridge.invoke !== "function") {
    throw new Error("pluginBridge is unavailable");
  }
  return window.pluginBridge.invoke(channel, payload || {});
}

function showBanner(message) {
  const banner = $("banner");
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
}

function decodeBase64(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function xtermTheme(base) {
  const preset = base === "light" ? LIGHT_THEME : DARK_THEME;
  return {
    ...preset,
    background: cssVar("--term-bg", preset.background),
    foreground: cssVar("--term-fg", preset.foreground),
    cursor: cssVar("--term-cursor", preset.cursor),
    cursorAccent: cssVar("--term-bg", preset.cursorAccent),
    selectionBackground: cssVar("--term-selection", preset.selectionBackground),
  };
}

function currentBase() {
  const attr =
    document.documentElement.getAttribute("data-theme") ||
    document.documentElement.getAttribute("data-base");
  if (attr === "light" || attr === "dark") return attr;
  const appearance = window.__appearance;
  if (appearance && appearance.current) {
    const now = appearance.current();
    if (now && (now.base === "light" || now.base === "dark")) return now.base;
  }
  return "dark";
}

function FitCtor() {
  if (window.FitAddon && typeof window.FitAddon.FitAddon === "function") return window.FitAddon.FitAddon;
  if (typeof window.FitAddon === "function") return window.FitAddon;
  return null;
}

function prettyPath(full) {
  if (!full) return "—";
  const home = state.home;
  if (home && (full === home || full.startsWith(`${home}/`) || full.startsWith(`${home}\\`))) {
    return `~${full.slice(home.length).replace(/\\/g, "/") || ""}`;
  }
  return full.replace(/\\/g, "/");
}

function tabLabel(tab) {
  if (tab.processTitle && tab.processTitle !== tab.cwd) return tab.processTitle;
  if (tab.cwd) {
    const parts = tab.cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || tab.title || t("untitled");
  }
  return tab.title || t("untitled");
}

function createTerminal() {
  const Ctor = window.Terminal;
  if (typeof Ctor !== "function") throw new Error("xterm.js failed to load");
  const term = new Ctor({
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 1.5,
    fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: state.fontSize,
    lineHeight: 1.35,
    letterSpacing: 0,
    scrollback: state.scrollback,
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
    theme: xtermTheme(currentBase()),
  });
  const Fit = FitCtor();
  const fit = Fit ? new Fit() : null;
  if (fit) term.loadAddon(fit);
  return { term, fit };
}

function renderTabs() {
  const root = $("tabs");
  root.textContent = "";
  for (const tab of state.tabs.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab" + (tab.id === state.activeId ? " active" : "") + (tab.bell ? " bell" : "");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", tab.id === state.activeId ? "true" : "false");
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabLabel(tab) + (tab.exited ? ` (${t("exited")})` : "");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.title = t("closeTab");
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });
    button.append(label, close);
    button.addEventListener("click", () => activate(tab.id));
    button.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(tab.id);
      }
    });
    root.appendChild(button);
  }
  updateChrome();
}

function updateChrome() {
  const tab = state.tabs.get(state.activeId);
  const cwd = $("statusCwd");
  const sep = $("statusSep");
  const sh = $("statusShell");
  const meta = $("meta");
  if (!tab) {
    cwd.textContent = "—";
    sep.hidden = true;
    sh.textContent = "";
    meta.textContent = "";
    return;
  }
  cwd.textContent = prettyPath(tab.cwd);
  cwd.title = tab.cwd || "";
  const shellName = (tab.shell || "").replace(/\\/g, "/").split("/").pop() || "";
  sep.hidden = !shellName;
  sh.textContent = shellName.replace(/\.exe$/i, "");
  meta.textContent = tab.cols && tab.rows ? `${tab.cols}×${tab.rows}` : "";
}

function fitTab(tab) {
  if (!tab || !tab.fit || !tab.term) return;
  try {
    tab.fit.fit();
  } catch {
    return;
  }
  const cols = tab.term.cols;
  const rows = tab.term.rows;
  if (cols && rows && (cols !== tab.cols || rows !== tab.rows)) {
    tab.cols = cols;
    tab.rows = rows;
    invoke("pty.resize", { sessionId: tab.id, cols, rows }).catch(() => {});
    updateChrome();
  }
}

function activate(id) {
  state.activeId = id;
  for (const tab of state.tabs.values()) {
    tab.element.hidden = tab.id !== id;
    if (tab.id === id) tab.bell = false;
  }
  renderTabs();
  const tab = state.tabs.get(id);
  if (!tab) return;
  requestAnimationFrame(() => {
    fitTab(tab);
    tab.term.focus();
  });
}

function parseOsc7(data) {
  try {
    const url = new URL(data);
    if (url.protocol !== "file:") return "";
    let pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    const match = String(data || "").match(/file:\/\/[^/]*(\/.*)$/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

async function pump(tab) {
  if (state.pumping.has(tab.id)) return;
  state.pumping.add(tab.id);
  try {
    while (state.tabs.has(tab.id) && !tab.exited) {
      const result = await invoke("pty.drain", {
        sessionId: tab.id,
        afterSeq: tab.seq,
        waitMs: 250,
      });
      if (!result || result.ok === false) {
        if (state.tabs.has(tab.id) && result && result.error) showBanner(result.error);
        break;
      }
      if (result.data) {
        tab.term.write(decodeBase64(result.data));
        tab.seq = result.seq;
      }
      if (result.exited) {
        tab.exited = true;
        renderTabs();
        break;
      }
    }
  } catch (error) {
    if (state.tabs.has(tab.id)) showBanner(error.message || t("spawnFailed"));
  } finally {
    state.pumping.delete(tab.id);
  }
}

function attachSession(session, options = {}) {
  const existing = state.tabs.get(session.id);
  if (existing) {
    existing.title = session.title || existing.title;
    existing.profileId = session.profileId || existing.profileId;
    existing.cwd = session.cwd || existing.cwd;
    existing.shell = session.shell || existing.shell;
    existing.exited = Boolean(session.exited);
    if (options.replay) existing.seq = 0;
    renderTabs();
    if (!existing.exited) pump(existing);
    return existing;
  }
  const { term, fit } = createTerminal();
  const element = document.createElement("div");
  element.className = "session";
  element.hidden = true;
  $("stage").appendChild(element);
  term.open(element);
  term.onData((data) => {
    invoke("pty.write", { sessionId: session.id, data }).catch(() => {});
  });
  const tab = {
    id: session.id,
    title: session.title || t("untitled"),
    profileId: session.profileId || "default",
    cwd: session.cwd || "",
    shell: session.shell || "",
    processTitle: "",
    seq: options.replay ? 0 : session.seq || 0,
    cols: session.cols,
    rows: session.rows,
    exited: Boolean(session.exited),
    bell: false,
    term,
    fit,
    element,
  };
  if (term.parser && typeof term.parser.registerOscHandler === "function") {
    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data);
      if (cwd) {
        tab.cwd = cwd;
        if (tab.id === state.activeId) updateChrome();
        renderTabs();
      }
      return true;
    });
  }
  term.onTitleChange((title) => {
    const next = String(title || "").trim();
    if (!next) return;
    tab.processTitle = next;
    renderTabs();
  });
  term.onBell(() => {
    if (tab.id !== state.activeId) {
      tab.bell = true;
      renderTabs();
    }
  });
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  });
  state.tabs.set(session.id, tab);
  renderTabs();
  if (!tab.exited) pump(tab);
  return tab;
}

function detachLocalTabs() {
  for (const tab of state.tabs.values()) {
    try {
      tab.term.dispose();
    } catch {
      /* ignore */
    }
    tab.element.remove();
  }
  state.tabs.clear();
  state.activeId = null;
  state.pumping.clear();
  closeFind();
  closeMenu();
}

async function showWorkspace(sessions) {
  detachLocalTabs();
  showBanner("");
  const list = Array.isArray(sessions) ? sessions : [];
  if (list.length === 0) {
    await spawnTab("default");
    return;
  }
  for (const session of list) attachSession(session, { replay: true });
  activate(list[list.length - 1].id);
}

async function syncWorkspace() {
  if (state.switching) return;
  const result = await invoke("pty.list");
  if (!result || result.ok === false) return;
  const key = result.workspaceKey == null ? "" : String(result.workspaceKey);
  if (state.workspaceKey === key) return;
  state.switching = true;
  try {
    state.workspaceKey = key;
    await showWorkspace(result.sessions);
  } finally {
    state.switching = false;
  }
}

async function spawnTab(profileId) {
  const id = profileId || "default";
  const active = state.tabs.get(state.activeId);
  try {
    const result = await invoke("pty.spawn", {
      profileId: id,
      cols: active && active.term ? active.term.cols : 80,
      rows: active && active.term ? active.term.rows : 24,
    });
    if (!result || result.ok === false) {
      showBanner((result && result.error) || t("spawnFailed"));
      return;
    }
    showBanner("");
    const tab = attachSession(result.session, { replay: true });
    activate(tab.id);
    fitTab(tab);
  } catch (error) {
    showBanner(error.message || t("spawnFailed"));
  }
}

async function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  try {
    await invoke("pty.kill", { sessionId: id });
  } catch {
    /* ignore */
  }
  tab.term.dispose();
  tab.element.remove();
  state.tabs.delete(id);
  if (state.activeId === id) {
    const next = [...state.tabs.keys()].pop() || null;
    if (next) activate(next);
    else {
      state.activeId = null;
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

async function copySelection() {
  const tab = state.tabs.get(state.activeId);
  if (!tab) return;
  const text = tab.term.getSelection();
  if (!text) return;
  try {
    await invoke("clipboard.writeText", { text });
  } catch (error) {
    showBanner(error.message || t("copyFailed"));
  }
}

async function pasteClipboard() {
  const tab = state.tabs.get(state.activeId);
  if (!tab) return;
  try {
    const text = await invoke("clipboard.readText");
    if (text) tab.term.paste(String(text));
  } catch (error) {
    showBanner(error.message || t("pasteFailed"));
  }
}

function clearScreen() {
  const tab = state.tabs.get(state.activeId);
  if (!tab || tab.exited) return;
  invoke("pty.write", { sessionId: tab.id, data: "\u000c" }).catch(() => {});
}

function applyFontSize(next) {
  state.fontSize = Math.min(24, Math.max(10, next));
  for (const tab of state.tabs.values()) {
    tab.term.options.fontSize = state.fontSize;
    fitTab(tab);
  }
  invoke("pty.setPref", { fontSize: state.fontSize }).catch(() => {});
}

function collectMatches(term, query) {
  const q = query.toLowerCase();
  if (!q) return [];
  const buf = term.buffer.active;
  const hits = [];
  for (let y = 0; y < buf.length; y += 1) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    const lower = text.toLowerCase();
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(q, from)) >= 0) {
      hits.push({ y, x: idx, len: query.length });
      from = idx + 1;
    }
  }
  return hits;
}

function jumpFind(delta) {
  const tab = state.tabs.get(state.activeId);
  if (!tab) return;
  const query = $("findInput").value;
  const hits = collectMatches(tab.term, query);
  state.find.total = hits.length;
  if (!hits.length) {
    $("findCount").textContent = "0/0";
    tab.term.clearSelection();
    return;
  }
  let index = state.find.query === query ? state.find.index + delta : 0;
  if (index < 0) index = hits.length - 1;
  if (index >= hits.length) index = 0;
  state.find = { query, index, total: hits.length };
  const hit = hits[index];
  tab.term.select(hit.x, hit.y, hit.len);
  if (typeof tab.term.scrollToLine === "function") tab.term.scrollToLine(hit.y);
  $("findCount").textContent = `${index + 1}/${hits.length}`;
}

function openFind() {
  $("find").hidden = false;
  $("findInput").placeholder = t("findPlaceholder");
  $("findInput").focus();
  $("findInput").select();
}

function closeFind() {
  $("find").hidden = true;
  const tab = state.tabs.get(state.activeId);
  if (tab) {
    tab.term.clearSelection();
    tab.term.focus();
  }
}

function closeMenu() {
  $("menu").hidden = true;
  $("menuBtn").setAttribute("aria-expanded", "false");
}

function openMenu(x, y) {
  const menu = $("menu");
  const items = [
    ["newTab", () => spawnTab(), isMac() ? "⌘T" : "Ctrl+T"],
    ["find", () => openFind(), isMac() ? "⌘F" : "Ctrl+F"],
    null,
    ["copy", () => copySelection(), isMac() ? "⌘C" : "Ctrl+Shift+C"],
    ["paste", () => pasteClipboard(), isMac() ? "⌘V" : "Ctrl+Shift+V"],
    ["clear", () => clearScreen(), isMac() ? "⌘K" : "Ctrl+L"],
    null,
    ["larger", () => applyFontSize(state.fontSize + 1), isMac() ? "⌘+" : "Ctrl++"],
    ["smaller", () => applyFontSize(state.fontSize - 1), isMac() ? "⌘−" : "Ctrl+-"],
    null,
    ["close", () => closeTab(state.activeId), isMac() ? "⌘W" : "Ctrl+W"],
  ];
  if (state.profiles.length > 1) {
    const profileItems = state.profiles.map((profile) => [
      profile.name,
      () => spawnTab(profile.id),
      "",
    ]);
    items.splice(1, 0, null, ...profileItems);
  }
  menu.textContent = "";
  for (const item of items) {
    if (!item) {
      const sep = document.createElement("div");
      sep.className = "sep";
      menu.appendChild(sep);
      continue;
    }
    const [label, run, hint] = item;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    const text = document.createElement("span");
    text.textContent = STRINGS[state.locale]?.[label] || STRINGS.en[label] || label;
    button.appendChild(text);
    if (hint) {
      const kbd = document.createElement("span");
      kbd.className = "hint";
      kbd.textContent = hint;
      button.appendChild(kbd);
    }
    button.addEventListener("click", () => {
      closeMenu();
      run();
    });
    menu.appendChild(button);
  }
  menu.hidden = false;
  $("menuBtn").setAttribute("aria-expanded", "true");
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const band = Number.parseInt(
    getComputedStyle(document.documentElement).getPropertyValue("--pi-plugin-titlebar-height") || "0",
    10,
  ) || 0;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(Math.max(8, band), top)}px`;
}

function bindKeys() {
  document.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "Escape") {
      if (!$("menu").hidden) {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (!$("find").hidden) {
        event.preventDefault();
        closeFind();
        return;
      }
    }
    if (mod(event) && !event.shiftKey && key.toLowerCase() === "t") {
      event.preventDefault();
      spawnTab();
      return;
    }
    if (mod(event) && !event.shiftKey && key.toLowerCase() === "w") {
      event.preventDefault();
      closeTab(state.activeId);
      return;
    }
    if (mod(event) && !event.shiftKey && key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
      return;
    }
    if (mod(event) && !event.shiftKey && key.toLowerCase() === "k") {
      event.preventDefault();
      clearScreen();
      return;
    }
    if (mod(event) && (key === "=" || key === "+")) {
      event.preventDefault();
      applyFontSize(state.fontSize + 1);
      return;
    }
    if (mod(event) && key === "-") {
      event.preventDefault();
      applyFontSize(state.fontSize - 1);
      return;
    }
    if (mod(event) && event.altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      event.preventDefault();
      const ids = [...state.tabs.keys()];
      const index = ids.indexOf(state.activeId);
      if (index < 0 || ids.length < 2) return;
      const next = key === "ArrowRight" ? (index + 1) % ids.length : (index - 1 + ids.length) % ids.length;
      activate(ids[next]);
      return;
    }
    if (isMac() && event.metaKey && !event.shiftKey && key.toLowerCase() === "c") {
      if (state.tabs.get(state.activeId)?.term.hasSelection()) {
        event.preventDefault();
        copySelection();
      }
      return;
    }
    if (isMac() && event.metaKey && !event.shiftKey && key.toLowerCase() === "v") {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (!isMac() && event.ctrlKey && event.shiftKey && key.toLowerCase() === "c") {
      event.preventDefault();
      copySelection();
      return;
    }
    if (!isMac() && event.ctrlKey && event.shiftKey && key.toLowerCase() === "v") {
      event.preventDefault();
      pasteClipboard();
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (!$("menu").hidden && !$("menu").contains(event.target) && event.target !== $("menuBtn")) {
      closeMenu();
    }
  });
}

function applyLocale(locale) {
  state.locale = locale === "zh-CN" ? "zh-CN" : "en";
  document.documentElement.lang = state.locale === "zh-CN" ? "zh-CN" : "en";
  $("newTab").title = t("newTab");
  $("menuBtn").title = t("menu");
  $("findInput").placeholder = t("findPlaceholder");
  renderTabs();
}

let appearanceFingerprint = "";

function applyTheme(base) {
  const resolved = base === "light" || base === "dark" ? base : currentBase();
  const theme = xtermTheme(resolved);
  for (const tab of state.tabs.values()) {
    tab.term.options.theme = theme;
    try {
      if (typeof tab.term.refresh === "function") tab.term.refresh(0, Math.max(0, tab.term.rows - 1));
    } catch {
      /* theme still applied via options */
    }
  }
}

function applyHostAppearance(appearance, force) {
  if (!appearance || typeof appearance !== "object") {
    if (force) applyTheme(currentBase());
    return;
  }
  const fingerprint = [
    appearance.base,
    appearance.theme,
    appearance.locale,
    appearance.pluginThemeCss ? String(appearance.pluginThemeCss).length : 0,
    appearance.pluginTheme && appearance.pluginTheme.id,
  ].join("|");
  if (!force && fingerprint === appearanceFingerprint) return;
  appearanceFingerprint = fingerprint;
  const adapter = window.__appearance;
  if (adapter && typeof adapter.apply === "function") adapter.apply(appearance);
  applyTheme(currentBase());
}

async function pullHostAppearance(force) {
  try {
    const appearance = await invoke("pty.appearance");
    if (appearance && appearance.ok !== false) {
      applyHostAppearance(appearance, force);
      return;
    }
  } catch {
    /* fall through */
  }
  applyTheme(currentBase());
}

function watchThemeDom() {
  if (typeof MutationObserver !== "function") return;
  new MutationObserver(() => applyTheme(currentBase())).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-base"],
  });
}

async function init() {
  const appearance = window.__appearance;
  if (appearance && typeof appearance.init === "function") appearance.init(window.pluginBridge);
  if (appearance && typeof appearance.onLocaleChange === "function") {
    appearance.onLocaleChange((next) => applyLocale(next));
  }
  if (appearance && typeof appearance.onThemeChange === "function") {
    appearance.onThemeChange((base) => applyTheme(base));
  }
  watchThemeDom();
  applyLocale(appearance && appearance.current ? appearance.current().locale : document.documentElement.getAttribute("data-lang"));
  applyTheme(currentBase());

  $("newTab").addEventListener("click", () => spawnTab());
  $("menuBtn").addEventListener("click", (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if ($("menu").hidden) openMenu(rect.right - 168, rect.bottom + 4);
    else closeMenu();
  });
  $("findInput").addEventListener("input", () => jumpFind(0));
  $("findInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpFind(event.shiftKey ? -1 : 1);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  });
  $("findPrev").addEventListener("click", () => jumpFind(-1));
  $("findNext").addEventListener("click", () => jumpFind(1));
  $("findClose").addEventListener("click", () => closeFind());
  bindKeys();
  new ResizeObserver(() => {
    const tab = state.tabs.get(state.activeId);
    if (tab) fitTab(tab);
  }).observe($("stage"));

  try {
    const boot = await invoke("pty.bootstrap");
    if (!boot || boot.ok === false) {
      showBanner((boot && boot.error) || t("helperMissing"));
      return;
    }
    state.fontSize = boot.fontSize || 13;
    state.scrollback = boot.scrollback || 5000;
    state.profiles = boot.profiles || [];
    state.home = boot.home || "";
    state.workspaceKey = boot.workspaceKey == null ? "" : String(boot.workspaceKey);
    if (boot.appearance) applyHostAppearance(boot.appearance, true);
    else await pullHostAppearance(true);
    await showWorkspace(boot.sessions);
    applyTheme(currentBase());
    window.setInterval(() => {
      if (document.hidden) return;
      syncWorkspace().catch(() => {});
      pullHostAppearance(false).catch(() => {});
    }, 1000);
  } catch (error) {
    showBanner(error.message || t("helperMissing"));
  } finally {
    document.documentElement.dataset.booting = "false";
  }
}

init().catch((error) => {
  showBanner(error.message || t("spawnFailed"));
  document.documentElement.dataset.booting = "false";
});
