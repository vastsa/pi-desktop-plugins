/**
 * Appearance runtime — copy into a plugin's renderer/ and load after the body
 * (defer or end-of-body) so the boot script has already painted the first frame.
 *
 * Wires the panel to the host's official appearance channel:
 *   - `bridge.invoke("app.getAppearance")` reads the app's current palette,
 *     language and active plugin theme;
 *   - `bridge.on("appearance:changed", ...)` re-applies live when the app
 *     switches theme or language;
 *   - work-panel *views* have no push channel, so we also poll
 *     `app.getAppearance` while the page is visible;
 *   - the resolved appearance is cached (same key as the boot script) so the
 *     next open paints correctly before any script runs;
 *   - hosts that do not expose the channel (older PI-Desktop) reject the
 *     invoke; we fall back to the boot-time value (cache or OS) and stay
 *     silent — plugins keep working with their own theme/locale handling.
 *
 * Work-panel views forward every invoke to the plugin's `onPanelInvoke`. Those
 * plugins should handle `app.getAppearance` by calling `pi.app.getAppearance()`
 * and returning `{ theme, base, locale, pluginTheme, pluginThemeCss }`.
 *
 * Exposed as window.__appearance:
 *   init(bridge)                     — start reading + subscribing (call once)
 *   current()                        — { base, locale, raw }
 *   onThemeChange(fn)                — fn(base) on palette changes
 *   onLocaleChange(fn)               — fn(locale) on language changes
 *   setThemeOverride(base|null)      — force "light"/"dark", or null to follow
 *                                      the app again (for in-panel theme toggles)
 *
 * Usage:
 *   <script src="./appearance.js"></script>
 *   <script>
 *     window.__appearance.init(window.pluginBridge);
 *   </script>
 */
(function () {
  "use strict";

  var boot = window.__appearanceBoot || null;
  var CACHE_KEY = boot ? boot.cacheKey : "pi.appearance.v1";
  var POLL_MS = 1000;

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

  function normalizeBase(value) {
    return value === "light" || value === "dark" ? value : boot ? boot.resolveBase(value) : "light";
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
      entry.base,
      entry.theme,
      entry.locale,
      css ? String(css).length : 0,
      entry.pluginTheme && entry.pluginTheme.id,
    ].join("|");
  }

  /** Apply a host appearance (or an override) and notify listeners. */
  function apply(entry) {
    var resolved = entry || {};
    var css = pluginThemeCss(resolved);
    var base = state.themeOverride || normalizeBase(resolved.base);
    var locale = normalizeLocale(resolved.locale);
    var themeChanged = base !== state.base;
    var localeChanged = locale !== state.locale;

    state.base = base;
    state.locale = locale;
    state.raw = resolved;
    lastFingerprint = fingerprint(resolved);

    if (boot) {
      // boot.applyAppearance resolves "system" against the OS and injects the
      // plugin-theme CSS; force the same base the host told us about.
      var applied = boot.applyAppearance({
        base: state.themeOverride || resolved.base,
        locale: resolved.locale,
        pluginThemeCss: state.themeOverride === null && css ? css : null,
      });
      state.base = applied.base;
      state.locale = applied.locale;
    } else {
      document.documentElement.dataset.theme = base;
      document.documentElement.dataset.lang = locale === "zh-CN" ? "zh" : "en";
      document.documentElement.lang = locale;
    }

    // Cache the *resolved* palette so the next boot paints without a flash,
    // and cache the locale so text lands in the right language.
    writeCache({
      base: state.base,
      locale: state.locale,
      pluginThemeCss: state.themeOverride === null && css ? css : undefined,
    });

    if (themeChanged) {
      for (var i = 0; i < themeListeners.length; i += 1) {
        try {
          themeListeners[i](state.base);
        } catch (error) {
          /* a listener must not break appearance handling */
        }
      }
    }
    if (localeChanged) {
      for (var j = 0; j < localeListeners.length; j += 1) {
        try {
          localeListeners[j](state.locale);
        } catch (error) {
          /* a listener must not break appearance handling */
        }
      }
    }
    return state;
  }

  function ingest(appearance) {
    if (!appearance || typeof appearance !== "object") return;
    var next = fingerprint(appearance);
    if (next && next === lastFingerprint) return;
    apply(appearance);
  }

  function pull(bridge) {
    if (!bridge || typeof bridge.invoke !== "function") return;
    if (typeof document !== "undefined" && document.hidden) return;
    bridge.invoke("app.getAppearance").then(ingest).catch(function () {
      // Host without the channel (or an unreachable plugin process): the
      // boot script already applied the cache or the OS preference.
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

  /** Pull the host appearance once and subscribe to live changes. */
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
    // Views never receive appearance:changed. Polling is cheap (fingerprint
    // skips no-ops) and also covers a missed first push on panel windows.
    startPoll(bridge);
  }

  /** Force a palette ("light"/"dark") or clear the override to follow the app. */
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
    /** For debugging / devtools. */
    __state: state,
  };
})();
