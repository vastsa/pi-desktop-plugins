/**
 * Appearance pre-paint boot — copy into a plugin's renderer/ and include
 * synchronously in <head> (before the body) so the first painted frame is
 * already in the app's palette and language direction.
 *
 * The host's real appearance arrives asynchronously through the panel bridge
 * (`app.getAppearance`), one round-trip too late to avoid a flash, so the last
 * known *app* appearance is cached in localStorage and replayed here.
 *
 * Never follow the OS color scheme for the live palette. The app can be dark
 * while the OS is light (or the reverse); resolving "system" against the OS
 * fights the host and flashes.
 *
 * Usage (in the plugin's index.html <head>, before other scripts):
 *   <script>window.__APPEARANCE_CACHE_KEY = "my.plugin.appearance.v1";</script>
 *   <script src="./appearance-boot.js"></script>
 */
(function () {
  "use strict";

  var DEFAULT_KEY = "pi.appearance.v1";
  var CACHE_KEY =
    (typeof window.__APPEARANCE_CACHE_KEY === "string" &&
      window.__APPEARANCE_CACHE_KEY) ||
    DEFAULT_KEY;
  var root = document.documentElement;

  function readCache() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function currentTheme() {
    var theme = root.getAttribute("data-theme");
    return theme === "light" || theme === "dark" ? theme : "";
  }

  /**
   * Only an explicit light/dark value counts. "system" and missing values keep
   * the current app theme (or stay unset) — they must not snap to the OS.
   */
  function resolveBase(base) {
    if (base === "light" || base === "dark") return base;
    return currentTheme();
  }

  function resolveLocale(locale) {
    return String(locale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function explicitBase(appearance) {
    if (!appearance || typeof appearance !== "object") return "";
    if (appearance.base === "light" || appearance.base === "dark") return appearance.base;
    if (appearance.theme === "light" || appearance.theme === "dark") return appearance.theme;
    return "";
  }

  function applyAppearance(appearance) {
    var resolved = appearance || {};
    var base = explicitBase(resolved) || resolveBase(resolved.base);
    var locale = resolveLocale(resolved.locale);

    if (base === "light" || base === "dark") {
      root.dataset.theme = base;
    }

    root.dataset.lang = locale === "zh-CN" ? "zh" : "en";
    root.lang = locale;

    var style = document.getElementById("pi-appearance-theme-css");
    if (resolved.pluginThemeCss) {
      if (!style) {
        style = document.createElement("style");
        style.id = "pi-appearance-theme-css";
        document.head.appendChild(style);
      }
      style.textContent = resolved.pluginThemeCss;
    } else if (style) {
      style.remove();
    }

    return { base: base || currentTheme() || null, locale: locale, raw: resolved };
  }

  var cached = readCache();
  if (cached && (cached.base === "light" || cached.base === "dark" || cached.locale)) {
    applyAppearance(cached);
  }
  // No cache: leave data-theme unset until the host answers. CSS :root defaults
  // cover the first frame; do not paint the OS palette.

  window.__appearanceBoot = {
    cacheKey: CACHE_KEY,
    cached: cached,
    applyAppearance: applyAppearance,
    resolveBase: resolveBase,
    resolveLocale: resolveLocale,
    explicitBase: explicitBase,
  };
})();
