/**
 * Appearance pre-paint boot — copy into a plugin's renderer/ and include
 * synchronously in <head> (before the body) so the first painted frame is
 * already in the app's palette and language direction.
 *
 * The host's real appearance arrives asynchronously through the panel bridge
 * (`app.getAppearance`), one round-trip too late to avoid a flash, so the last
 * known appearance is cached in localStorage and replayed here. Without a
 * cache the document follows the OS preference, which is also the correct
 * fallback on hosts that do not expose the appearance channel yet.
 *
 * Usage (in the plugin's index.html <head>, before other scripts):
 *   <script>window.__APPEARANCE_CACHE_KEY = "my.plugin.appearance.v1";</script>
 *   <script src="./appearance-boot.js"></script>
 *
 * The optional cache-key global lets each plugin keep its own history; the
 * default is "pi.appearance.v1". The script is plain ES5-ish JavaScript so it
 * runs on any Electron renderer.
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

  function prefersLight() {
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch (error) {
      return true;
    }
  }

  /** "system" or missing base resolves against the OS. */
  function resolveBase(base) {
    if (base === "light" || base === "dark") return base;
    return prefersLight() ? "light" : "dark";
  }

  /** A locale tag to render with: zh → "zh-CN", anything else → "en". */
  function resolveLocale(locale) {
    return String(locale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  /** Shared with appearance.js through this global so both agree on one algorithm. */
  function applyAppearance(appearance) {
    var resolved = appearance || {};
    var base = resolveBase(resolved.base);
    var locale = resolveLocale(resolved.locale);

    root.dataset.theme = base;
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

    return { base: base, locale: locale, raw: resolved };
  }

  var cached = readCache();
  if (cached && (cached.base || cached.locale)) {
    applyAppearance(cached);
  } else {
    // No history: follow the OS palette and the panel's own navigator language.
    root.dataset.theme = prefersLight() ? "light" : "dark";
    root.dataset.lang = resolveLocale(navigator.language) === "zh-CN" ? "zh" : "en";
    root.lang = resolveLocale(navigator.language);
  }

  window.__appearanceBoot = {
    cacheKey: CACHE_KEY,
    cached: cached,
    applyAppearance: applyAppearance,
    prefersLight: prefersLight,
    resolveBase: resolveBase,
    resolveLocale: resolveLocale,
  };
})();
