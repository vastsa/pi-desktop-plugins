(function () {
  "use strict";

  function markInteractive() {
    document.querySelectorAll('[class*="cursor-pointer"]').forEach(function (element) {
      element.setAttribute("data-pi-plugin-no-drag", "true");
    });
  }

  function install() {
    if (document.querySelector('link[data-pi-plugin-polish="true"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./panel-polish.css";
    link.dataset.piPluginPolish = "true";
    document.head.appendChild(link);

    markInteractive();
    var root = document.getElementById("root");
    if (root && typeof MutationObserver !== "undefined") {
      var observer = new MutationObserver(markInteractive);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"]
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    window.setTimeout(install, 0);
  }
})();
