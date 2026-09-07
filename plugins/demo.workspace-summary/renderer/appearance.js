/**
 * Appearance runtime — copy into a plugin's renderer/ and load after the body
 * (defer or end-of-body) so the boot script has already painted the first frame.
 *
 * Wires the panel to the host's official appearance channel:
 *   - `bridge.invoke("app.getAppearance")` reads the app's current palette,
 *     language and active plugin theme;
 *   - `bridge.on("appearance:changed", ...)` re-applies live when the app
 *     switches theme or language;
 *   - a slow poll covers docked views that miss a push;
 *   - the resolved appearance is cached (same key as the boot script) so the
 *     next open paints correctly before any script runs.
 *
 * Follow the *app* palette only. Never resolve "system" / missing base against
 * `prefers-color-scheme`: when the app is dark and the OS is light (or the
 * reverse), that fight flashes the UI every poll.
 *
 * Exposed as window.__appearance:
 *   init(bridge)                     — start reading + subscribing (call once)
 *   current()                        — { base, locale, raw }
 *   onThemeChange(fn)                — fn(base) on palette changes
 *   onLocaleChange(fn)               — fn(locale) on language changes
 *   setThemeOverride(base|null)      — force "light"/"dark", or null to follow
 *                                      the app again (for in-panel theme toggles)
 */
(function () {
  "use strict";

  var boot = window.__appearanceBoot || null;
  var CACHE_KEY = boot ? boot.cacheKey : "pi.appearance.v1";
  var POLL_MS = 2000;

  var state = {
    base: null,
    locale: null,
    raw: null,
    themeOverride: null,
    started: false,
  };
  var themeListeners = [];
  var localeListeners = [];
  var pollTimer = null;
  var lastFingerprint = "";

  function writeCache(entry) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    } catch (error) {
      /* cache is best-effort */
    }
  }

  function documentTheme() {
    try {
      var theme = document.documentElement.getAttribute("data-theme");
      return theme === "light" || theme === "dark" ? theme : "";
    } catch (error) {
      return "";
    }
  }

  /** Explicit app light/dark only — never the OS. */
  function explicitBase(entry) {
    if (!entry || typeof entry !== "object") return "";
    if (typeof boot?.explicitBase === "function") return boot.explicitBase(entry) || "";
    if (entry.base === "light" || entry.base === "dark") return entry.base;
    if (entry.theme === "light" || entry.theme === "dark") return entry.theme;
    return "";
  }

  function normalizeLocale(value) {
    return boot ? boot.resolveLocale(value) : String(value || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function pluginThemeCss(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.pluginThemeCss) return entry.pluginThemeCss;
    if (entry.pluginTheme && typeof entry.pluginTheme === "object") return entry.pluginTheme.css || null;
    return null;
  }

  function fingerprint(entry) {
    if (!entry || typeof entry !== "object") return "";
    var css = pluginThemeCss(entry);
    return [
      explicitBase(entry) || entry.base,
      entry.theme,
      entry.locale,
      css ? String(css).length : 0,
      entry.pluginTheme && entry.pluginTheme.id,
    ].join("|");
  }

  function notify(list, value) {
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](value);
      } catch (error) {
        /* a listener must not break appearance handling */
      }
    }
  }

  /** Apply a host appearance (or an override) and notify listeners. */
  function apply(entry) {
    var resolved = entry || {};
    var incoming = explicitBase(resolved);
    var base =
      state.themeOverride ||
      incoming ||
      state.base ||
      documentTheme();
    if (base !== "light" && base !== "dark") base = null;
    var locale = normalizeLocale(resolved.locale);
    var css = pluginThemeCss(resolved);
    var themeChanged = base && base !== state.base;
    var localeChanged = locale !== state.locale;

    if (base) state.base = base;
    state.locale = locale;
    state.raw = resolved;
    lastFingerprint = fingerprint(resolved);

    if (boot) {
      var applied = boot.applyAppearance({
        base: state.themeOverride || incoming || state.base,
        locale: resolved.locale,
        pluginThemeCss: state.themeOverride === null && css ? css : null,
      });
      if (applied.base === "light" || applied.base === "dark") state.base = applied.base;
      state.locale = applied.locale;
    } else if (base) {
      document.documentElement.dataset.theme = base;
      document.documentElement.dataset.lang = locale === "zh-CN" ? "zh" : "en";
      document.documentElement.lang = locale;
    }

    if (state.base === "light" || state.base === "dark") {
      writeCache({
        base: state.base,
        locale: state.locale,
        pluginThemeCss: state.themeOverride === null && css ? css : undefined,
      });
    }

    if (themeChanged) notify(themeListeners, state.base);
    if (localeChanged) notify(localeListeners, state.locale);
    return state;
  }

  function ingest(appearance) {
    if (!appearance || typeof appearance !== "object") return;
    // Ignore OS-fallback payloads (`base: "system"` with no explicit theme).
    // Applying those snaps the UI to prefers-color-scheme and fights the app.
    if (!explicitBase(appearance) && !appearance.locale && !pluginThemeCss(appearance)) return;
    if (!explicitBase(appearance) && !state.base && !documentTheme()) {
      // Locale/css-only update with no palette yet: keep waiting for the app.
      if (appearance.locale) {
        var locale = normalizeLocale(appearance.locale);
        if (locale !== state.locale) {
          state.locale = locale;
          notify(localeListeners, locale);
        }
      }
      return;
    }
    var next = fingerprint(appearance);
    if (next && next === lastFingerprint) return;
    apply(appearance);
  }

  function pull(bridge) {
    if (!bridge || typeof bridge.invoke !== "function") return;
    if (typeof document !== "undefined" && document.hidden) return;
    bridge.invoke("app.getAppearance").then(ingest).catch(function () {
      // Missing channel: keep the last app theme. Do not snap to the OS.
    });
  }

  function startPoll(bridge) {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      pull(bridge);
    }, POLL_MS);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) pull(bridge);
      });
    }
  }

  function init(bridge) {
    if (state.started) return;
    state.started = true;
    if (!bridge || typeof bridge.invoke !== "function") return;

    pull(bridge);

    if (typeof bridge.on === "function") {
      try {
        bridge.on("appearance:changed", ingest);
      } catch (error) {
        /* subscription is best-effort */
      }
    }
    startPoll(bridge);
  }

  function setThemeOverride(base) {
    var next = base === "light" || base === "dark" ? base : null;
    if (next === state.themeOverride) return;
    state.themeOverride = next;
    apply(state.raw || {});
  }

  window.__appearance = {
    init: init,
    apply: apply,
    current: function () {
      return { base: state.base, locale: state.locale, raw: state.raw };
    },
    onThemeChange: function (fn) {
      themeListeners.push(fn);
    },
    onLocaleChange: function (fn) {
      localeListeners.push(fn);
    },
    setThemeOverride: setThemeOverride,
    __state: state,
  };
})();
