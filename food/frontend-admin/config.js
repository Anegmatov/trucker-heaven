(() => {
  const local = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  // Served by the shared backend at /sites/admin: this is the unified Trucker Heaven admin. The food
  // API is this origin's /api/v1/admin; the parking and rentals staff sites sit next to it.
  const unified = /^\/sites\/admin(\/|$)/.test(window.location.pathname);
  const origin = window.location.origin;
  const defaults = unified
    ? { apiBaseUrl: `${origin}/api/v1/admin`, publicSiteUrl: "https://silkroadgrilltn.com", parentSiteUrl: "https://truckerheaven.com", unified: true,
        parkingStaffUrl: `${origin}/sites/parking-staff/`, rentalsStaffUrl: `${origin}/sites/rentals-staff/`, ssoBaseUrl: `${origin}/api/v1/admin/sso` }
    : local
      ? { apiBaseUrl: "http://localhost:3011/api/v1/admin", publicSiteUrl: "http://localhost:5173", parentSiteUrl: "http://localhost:5173" }
      : { apiBaseUrl: "https://trucker-heaven-food-api.onrender.com/api/v1/admin", publicSiteUrl: "https://trucker-heaven-food.onrender.com", parentSiteUrl: "https://truckerheaven.com" };
  window.FOODOPS_ADMIN_CONFIG = Object.freeze({ ...defaults, ...(window.FOODOPS_ADMIN_CONFIG || {}) });
})();
