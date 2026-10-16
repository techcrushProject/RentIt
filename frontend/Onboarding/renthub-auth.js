/* RentHub shared client: token storage, API client, HTML escaping, image helpers.
 * Requires renthub-config.js. Exposes window.RentHubAuth.
 *
 * SECURITY NOTES
 *  - The JWT lives in localStorage (same as before). That means any XSS can read it, so
 *    every place that renders server data into HTML MUST use esc(). A cookie-based session
 *    (httpOnly + SameSite + CSRF protection) is the stronger design but needs a backend change.
 *  - role()/isLoggedIn() decode the token WITHOUT verifying it. They are UX hints for redirects.
 *    The server re-checks the role from the database on every request. */
(function (global) {
  "use strict";
  var cfg = global.RENTHUB_CONFIG;
  if (!cfg) throw new Error("renthub-config.js must be loaded before renthub-auth.js");

  var TOKEN_KEY = "renthub_token";
  var LEGACY_TOKEN_KEYS = ["renthub_auth_token", "ownerToken"]; // three keys used to co-exist
  var SESSION_KEYS = ["renthub_session"];

  var store = null;
  try { store = global.localStorage; } catch (e) { store = null; }

  // One-time migration so users who are already logged in stay logged in.
  (function migrate() {
    try {
      if (!store) return;
      var current = store.getItem(TOKEN_KEY);
      LEGACY_TOKEN_KEYS.forEach(function (key) {
        var value = store.getItem(key);
        if (value && !current) { store.setItem(TOKEN_KEY, value); current = value; }
        if (value) store.removeItem(key);
      });
    } catch (e) { /* storage blocked */ }
  })();

  function getToken() {
    try { return (store && store.getItem(TOKEN_KEY)) || ""; } catch (e) { return ""; }
  }
  function setToken(token) {
    try {
      if (!store) return;
      if (token) store.setItem(TOKEN_KEY, token); else store.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
  }
  function clearAuth() {
    setToken("");
    try {
      SESSION_KEYS.forEach(function (key) {
        if (store) store.removeItem(key);
        if (global.sessionStorage) global.sessionStorage.removeItem(key);
      });
    } catch (e) { /* ignore */ }
  }

  function decodeToken(token) {
    try {
      var part = String(token || getToken()).split(".")[1];
      if (!part) return null;
      part = part.replace(/-/g, "+").replace(/_/g, "/");
      while (part.length % 4) part += "=";
      var json = decodeURIComponent(atob(part).split("").map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      return JSON.parse(json);
    } catch (e) { return null; }
  }
  function claims() {
    var c = decodeToken();
    if (!c || typeof c !== "object") return null;
    if (c.exp && c.exp * 1000 < Date.now()) return null;
    return c;
  }
  function isLoggedIn() { return !!claims(); }
  function role() { var c = claims(); return c && c.role ? String(c.role) : ""; }
  function userId() { var c = claims(); return c && c.id ? String(c.id) : ""; }

  function goLogin() { global.location.replace(cfg.LOGIN_URL); }

  /** Redirect to the login page unless the visitor holds a valid-looking token for one of `roles`. */
  function requireLogin(roles) {
    var allowed = !roles || !roles.length || roles.indexOf(role()) !== -1;
    if (!isLoggedIn() || !allowed) {
      try { document.documentElement.style.visibility = "hidden"; } catch (e) { /* ignore */ }
      goLogin();
      return false;
    }
    global.addEventListener("renthub:unauthorized", goLogin);
    return true;
  }

  function homeFor(userRole) {
    if (userRole === "admin") return cfg.ADMIN_URL;
    if (userRole === "owner") return cfg.OWNER_URL;
    return cfg.RENTER_URL;
  }

  function ApiError(message, status, data) {
    var err = new Error(message);
    err.status = status;
    err.data = data;
    return err;
  }

  /**
   * request("/auth/login", { method: "POST", json: {...}, auth: false })
   *   opts.json   object sent as JSON        opts.body   FormData / string sent as is
   *   opts.auth   false = never send the token
   *   opts.blob   true  = resolve with a Blob (used for KYC documents)
   * Throws Error with .status and .data. A 401 while a token was sent clears the session
   * and fires "renthub:unauthorized". */
  async function request(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: opts.blob ? "*/*" : "application/json" }, opts.headers || {});
    var body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["Content-Type"] = "application/json";
    }
    var token = opts.auth === false ? "" : getToken();
    if (token) headers.Authorization = "Bearer " + token;

    var res;
    try {
      res = await fetch(cfg.API_BASE_URL + path, {
        method: opts.method || "GET",
        headers: headers,
        body: body,
        cache: "no-store",
        signal: opts.signal
      });
    } catch (e) {
      throw ApiError("Could not reach the RentHub server. Check your connection and try again.", 0);
    }

    if (opts.blob && res.ok) return res.blob();

    var data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch (e) { data = null; }
    }
    if (!res.ok) {
      if (res.status === 401 && token) {
        clearAuth();
        try { global.dispatchEvent(new CustomEvent("renthub:unauthorized")); } catch (e) { /* ignore */ }
      }
      throw ApiError((data && data.message) || "Request failed (" + res.status + ")", res.status, data);
    }
    return data;
  }

  /* ---------- HTML safety ---------- */
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
  /** Escape any value before placing it inside an HTML template string. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"'`]/g, function (c) { return ESC[c]; });
  }
  /** Returns the URL only when it is safe for src/href; otherwise "". */
  function safeUrl(url, opts) {
    opts = opts || {};
    var u = String(url == null ? "" : url).trim();
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (opts.allowBlob && /^blob:/i.test(u)) return u;
    if (opts.allowData && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/=]+$/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return ""; // javascript:, data:, vbscript:, ...
    return u; // relative path
  }

  /* ---------- images ---------- */
  /** Resize + re-encode to JPEG so uploads stay small. Resolves with a data URL under opts.maxBytes. */
  function downscaleImage(file, opts) {
    opts = Object.assign({ maxDim: 1600, quality: 0.85, maxBytes: 1.8 * 1024 * 1024 }, opts || {});
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
        return reject(new Error("Please choose a JPEG, PNG or WebP image."));
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var dim = opts.maxDim, quality = opts.quality, attempt = 0;
        (function render() {
          var scale = Math.min(1, dim / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var data = canvas.toDataURL("image/jpeg", quality);
          var bytes = Math.floor((data.length - data.indexOf(",") - 1) * 3 / 4);
          if (bytes <= opts.maxBytes) return resolve(data);
          if (attempt++ >= 6) return reject(new Error("That image is too large. Try a smaller photo."));
          dim = Math.round(dim * 0.8);
          quality = Math.max(0.5, quality - 0.08);
          render();
        })();
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
      img.src = url;
    });
  }

  /** Equipment photo -> URL string for the listing. Uses a server-signed Cloudinary upload when
   *  configured, otherwise falls back to a small inline JPEG that the API also accepts. */
  async function uploadEquipmentImage(file) {
    var sign;
    try {
      sign = await request("/uploads/sign", { method: "POST", json: { purpose: "equipment" } });
    } catch (e) {
      // Inline photos are stored in the database (max 3MB per listing), so keep each one small.
      if (e.status === 503) return downscaleImage(file, { maxDim: 1280, maxBytes: 450 * 1024 });
      throw e;
    }
    var data = await downscaleImage(file, { maxDim: 1920, maxBytes: Math.min(sign.maxBytes || 5242880, 5242880) });
    var form = new FormData();
    form.append("file", data);
    form.append("api_key", sign.apiKey);
    form.append("timestamp", String(sign.timestamp));
    form.append("signature", sign.signature);
    form.append("folder", sign.folder);
    form.append("allowed_formats", sign.allowedFormats);
    var res = await fetch(sign.uploadUrl, { method: "POST", body: form });
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok || !out.secure_url) {
      throw ApiError((out.error && out.error.message) || "Image upload failed. Please try again.", res.status);
    }
    return out.secure_url;
  }

  global.RentHubAuth = Object.freeze({
    config: cfg,
    getToken: getToken, setToken: setToken, clearAuth: clearAuth,
    decodeToken: decodeToken, isLoggedIn: isLoggedIn, role: role, userId: userId,
    requireLogin: requireLogin, goLogin: goLogin, homeFor: homeFor,
    api: request, esc: esc, safeUrl: safeUrl,
    downscaleImage: downscaleImage, uploadEquipmentImage: uploadEquipmentImage
  });
})(window);
