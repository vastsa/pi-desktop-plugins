/**
 * Appearance runtime — copy into a plugin's renderer/ and load after the body
 * (defer or end-of-body) so the boot script has already painted the first frame.
 *
 * Wires the panel to the host's official appearance channel:
 *   - `bridge.invoke("app.getAppearance")` reads the app's current palette,
 *     language and active plugin theme;
 *   - `bridge.on("appearance:changed", ...)` re-applies live when the app
 *     switches theme or language;
 *   - the resolved appearance is cached (same key as the boot script) so the
 *     next open paints correctly before any script runs;
 *   - hosts that do not expose the channel (older PI-Desktop) reject the
 *     invoke; we fall back to the boot-time value (cache or OS) and stay
 *     silent — plugins keep working with their own theme/locale handling.
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

  var state = {
    base: null,
    locale: null,
    raw: null,
    themeOverride: null,
    started: false,
  };
  var themeListeners = [];
  var localeListeners = [];

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

  /** Apply a host appearance (or an override) and notify listeners. */
  function apply(entry) {
    var resolved = entry || {};
    var base = state.themeOverride || normalizeBase(resolved.base);
    var locale = normalizeLocale(resolved.locale);
    var themeChanged = base !== state.base;
    var localeChanged = locale !== state.locale;

    state.base = base;
    state.locale = locale;
    state.raw = resolved;

    if (boot) {
      // boot.applyAppearance resolves "system" against the OS and injects the
      // plugin-theme CSS; force the same base the host told us about.
      var applied = boot.applyAppearance({
        base: state.themeOverride || resolved.base,
        locale: resolved.locale,
        pluginThemeCss:
          state.themeOverride === null && resolved.pluginThemeCss
            ? resolved.pluginThemeCss
            : null,
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
      pluginThemeCss:
        state.themeOverride === null && resolved.pluginThemeCss
          ? resolved.pluginThemeCss
          : undefined,
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

  /** Pull the host appearance once and subscribe to live changes. */
  function init(bridge) {
    if (state.started) return;
    state.started = true;
    if (!bridge || typeof bridge.invoke !== "function") return;

    bridge
      .invoke("app.getAppearance")
      .then(function (appearance) {
        if (appearance && typeof appearance === "object") {
          apply(appearance);
        }
      })
      .catch(function () {
        // Host without the channel (or an unreachable plugin process): the
        // boot script already applied the cache or the OS preference.
      });

    if (typeof bridge.on === "function") {
      try {
        bridge.on("appearance:changed", function (appearance) {
          if (appearance && typeof appearance === "object") {
            apply(appearance);
          }
        });
      } catch (error) {
        /* subscription is best-effort */
      }
    }
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
