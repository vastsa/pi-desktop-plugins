(function () {
  "use strict";

  function install() {
    if (document.querySelector('link[data-pi-plugin-polish="true"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./panel-polish.css";
    link.dataset.piPluginPolish = "true";
    document.head.appendChild(link);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    window.setTimeout(install, 0);
  }
})();
