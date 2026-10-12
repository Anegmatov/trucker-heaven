(function configureDriveOpsAdmin() {
  "use strict";
  const local = new Set(["localhost", "127.0.0.1", "0.0.0.0"]).has(window.location.hostname);
  const renderHosted = window.location.hostname === "trucker-heaven-rentals-operations.onrender.com";
  const supplied = window.DriveOpsAdminRuntimeConfig || window.DriveOpsAdminConfig || {};
  const fallback = local ? "http://localhost:3000" : "https://rentals-api.truckerheaven.com";

  function validApiUrl(value) {
    try {
      const parsed = new URL(String(value || fallback));
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid URL");
      return parsed.href.replace(/\/$/, "");
    } catch (_error) {
      return fallback;
    }
  }

  window.DriveOpsAdminConfig = Object.freeze({ API_BASE: renderHosted ? window.location.origin : validApiUrl(supplied.API_BASE) });
})();
