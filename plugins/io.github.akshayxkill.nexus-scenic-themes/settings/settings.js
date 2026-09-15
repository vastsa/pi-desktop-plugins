(() => {
  const pluginId = "io.github.akshayxkill.nexus-scenic-themes";
  const themes = [
    ["twilight-mountains", "Twilight Mountains", "Blue-violet mountain glass", "assets/twilight-mountains.png"],
    ["alpine-light", "Alpine Light", "Icy light mountain glass", "assets/alpine-light.png"],
    ["obsidian-horizon", "Obsidian Horizon", "Moonlit charcoal glass", "assets/obsidian-horizon.png"],
    ["emerald-afterglow", "Emerald Afterglow", "Sunlit emerald forest glass", "assets/emerald-afterglow.png"],
  ];
  const bridge = window.pluginBridge;
  const cards = document.getElementById("theme-cards"); const range = document.getElementById("blur"); const output = document.getElementById("blur-value"); const applyButton = document.getElementById("apply-blur"); const status = document.getElementById("status");
  const values = new Map(themes.map(([id]) => [id, 6])); let active = themes[0][0]; let confirmed = 6; let timer = 0; let generation = 0;
  const fullId = (id) => `plugin:${pluginId}:${id}`;
  const clamp = (value) => Number.isInteger(value) && value >= 0 && value <= 20 ? value : 6;
  const invoke = (channel, payload) => { if (!bridge?.invoke) return Promise.reject(new Error("The PI-Desktop plugin bridge is unavailable.")); return bridge.invoke(channel, payload); };
  const setStatus = (message) => { status.textContent = message; };
  const sync = () => { document.documentElement.dataset.nexusTheme = active; range.value = String(values.get(active)); output.textContent = `${range.value}px`; cards.querySelectorAll("button").forEach((card) => card.setAttribute("aria-pressed", String(card.dataset.theme === active))); };
  const save = async (id, value, token) => { try { await invoke("themes.setVariables", { themeId: id, values: { "--nexus-backdrop-blur": value } }); if (token === generation && id === active) { confirmed = value; setStatus(""); } } catch { if (token === generation && id === active) { values.set(id, confirmed); sync(); setStatus("Could not save backdrop blur. The previous value was restored."); } } };
  const schedule = (flush = false) => { window.clearTimeout(timer); const id = active; const value = values.get(id); const token = ++generation; const run = () => void save(id, value, token); timer = flush ? 0 : window.setTimeout(run, 180); if (flush) run(); };
  const select = async (id) => { active = id; confirmed = values.get(id); sync(); try { await invoke("app.setTheme", { themeId: fullId(id) }); schedule(true); } catch { setStatus("Could not apply this theme. Check that the plugin is enabled."); } };
  for (const [id, label, description, asset] of themes) { const button = document.createElement("button"); button.type = "button"; button.className = "theme-card"; button.dataset.theme = id; button.setAttribute("aria-pressed", "false"); button.style.backgroundImage = `url("../${asset}")`; const name = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = label; const small = document.createElement("small"); small.textContent = description; name.append(strong, small); button.append(name); button.addEventListener("click", () => void select(id)); cards.append(button); }
  range.addEventListener("input", () => { values.set(active, clamp(Number(range.value))); sync(); });
  applyButton.addEventListener("click", () => schedule(true));
  window.addEventListener("pagehide", () => schedule(true));
  const initialize = async () => {
    try {
      const [appearance] = await Promise.all([invoke("app.getAppearance"), invoke("plugin.getSettings")]);
      const selected = String(appearance?.theme ?? appearance?.themeId ?? "").replace(`plugin:${pluginId}:`, "");
      if (values.has(selected)) active = selected;
    } catch { setStatus("Theme controls will become available when the plugin bridge reconnects."); }
    confirmed = values.get(active); sync();
  };
  void initialize();
})();
