/* RentHub client configuration. Loaded first on every page.
 * Change PRODUCTION_API when the backend moves; nothing else in the pages hardcodes a host.
 * For one-off testing set window.RENTHUB_API_BASE_URL BEFORE this script loads. */
(function (global) {
  "use strict";
  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/[^\/]*$/, "") : global.location.href.replace(/[^\/]*$/, "");
  var host = global.location.hostname;
  var isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  var PRODUCTION_API = "https://rentit-auth-kyc.onrender.com/api";
  var LOCAL_API = "http://localhost:3000/api";

  function resolve(rel) {
    try { return new URL(rel, base).href; } catch (e) { return rel; }
  }

  // Page locations are resolved against THIS file, so they work from any folder depth.
  global.RENTHUB_CONFIG = Object.freeze({
    API_BASE_URL: String(global.RENTHUB_API_BASE_URL || (isLocal ? LOCAL_API : PRODUCTION_API)).replace(/\/+$/, ""),
    LOGIN_URL: resolve("Onboarding/index.html"),
    ADMIN_URL: resolve("renthub-admin-dashboard.html"),
    OWNER_URL: resolve("Onboarding/index.html"),
    RENTER_URL: resolve("Onboarding/index.html")
  });
})(window);
