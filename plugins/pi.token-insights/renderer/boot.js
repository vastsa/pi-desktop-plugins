/**
 * Pre-paint appearance boot.
 *
 * Runs synchronously in <head>, before the body exists, so the first frame that
 * carries content is already in the host's palette and language direction. The
 * host's real appearance arrives asynchronously through plugin settings, which
 * is one round-trip too late to avoid a flash — so the last known appearance is
 * cached in localStorage and replayed here.
 *
 * Until an appearance is known the document stays in `booting` state: the CSS
 * keeps content invisible (not black, not white — nothing) for a few
 * milliseconds rather than painting a palette we would immediately correct.
 */
(function () {
  "use strict";

  var CACHE_KEY = "tokenInsights.appearance.v1";
  var root = document.documentElement;
  root.dataset.booting = "true";

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
      return false;
    }
  }

  /** Shared with panel.js through this global so both agree on one algorithm. */
  function applyAppearance(appearance) {
    var resolved = appearance || {};
    var base = resolved.base === "light" || resolved.base === "dark" ? resolved.base : prefersLight() ? "light" : "dark";
    root.dataset.theme = base;
    if (resolved.pluginThemeId) root.dataset.pluginTheme = resolved.pluginThemeId;
    else delete root.dataset.pluginTheme;

    var style = document.getElementById("pluginThemeCss");
    if (resolved.pluginThemeCss) {
      if (!style) {
        style = document.createElement("style");
        style.id = "pluginThemeCss";
        document.head.appendChild(style);
      }
      style.textContent = resolved.pluginThemeCss;
    } else if (style) {
      style.remove();
    }

    var locale = resolved.locale === "zh" ? "zh" : "en";
    root.dataset.lang = locale;
    root.lang = locale === "zh" ? "zh-CN" : "en";
    return { base: base, locale: locale };
  }

  var cached = readCache();
  if (cached) {
    applyAppearance(cached);
  } else {
    // First-ever open with no cached appearance: fall back to the OS palette
    // synchronously rather than leaving [data-theme] unset. The content stays
    // cloaked by [data-booting] until the host's real answer lands, but the
    // painted background — and the host's one-shot window-control capsule
    // color snapshot taken at DOMContentLoaded — now match the user's system
    // instead of the browser's unstyled black-on-white defaults.
    applyAppearance({});
  }

  window.__tokenInsightsBoot = {
    cacheKey: CACHE_KEY,
    cached: cached,
    applyAppearance: applyAppearance,
    prefersLight: prefersLight,
    /** Records what the document showed, so a wrong first frame is detectable. */
    themeTrail: [root.dataset.theme || "(unset)"],
  };
})();
