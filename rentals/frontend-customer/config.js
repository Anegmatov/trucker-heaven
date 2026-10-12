(function configureDriveOps() {
  "use strict";
  const local = new Set(["localhost", "127.0.0.1", "0.0.0.0"]).has(window.location.hostname);
  const supplied = window.DriveOpsRuntimeConfig || window.DriveOpsConfig || {};
  const defaults = local
    ? { PARENT_SITE_URL: "https://truckerheaven.com", CUSTOMER_SITE_URL: "http://localhost:5174", ADMIN_SITE_URL: "http://localhost:5175", API_BASE: "http://localhost:3000" }
    : { PARENT_SITE_URL: "https://truckerheaven.com", CUSTOMER_SITE_URL: "https://rentals.truckerheaven.com", ADMIN_SITE_URL: "https://rentals-admin.truckerheaven.com", API_BASE: "https://rentals-api.truckerheaven.com" };

  function validUrl(value, fallback) {
    try {
      const parsed = new URL(String(value || fallback));
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid URL");
      return parsed.href.replace(/\/$/, "");
    } catch (_error) {
      return fallback;
    }
  }

  window.DriveOpsConfig = Object.freeze(Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, validUrl(supplied[key], fallback)])
  ));
})();
