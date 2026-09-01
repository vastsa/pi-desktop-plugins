(function () {
  "use strict";

  function paintable(value) {
    return value && value !== "transparent" && value !== "rgba(0, 0, 0, 0)";
  }

  function retint() {
    var host = document.querySelector("pi-plugin-panel-chrome");
    if (!host) return;
    var bodyStyle = document.body ? getComputedStyle(document.body) : null;
    var rootStyle = getComputedStyle(document.documentElement);
    var background = bodyStyle && bodyStyle.backgroundColor;
    var foreground = bodyStyle && bodyStyle.color;
    if (!paintable(background)) background = rootStyle.backgroundColor;
    if (!paintable(foreground)) foreground = rootStyle.color;
    if (paintable(background)) host.style.setProperty("--pi-plugin-panel-page-background", background);
    if (paintable(foreground)) host.style.setProperty("--pi-plugin-panel-page-foreground", foreground);
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(function () {
      scheduled = false;
      retint();
    }, 0);
  }

  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-theme", "data-base", "style"],
    });
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }
})();
