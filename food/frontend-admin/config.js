(() => {
  const local = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const defaults = local
    ? { apiBaseUrl: "http://localhost:3011/api/v1/admin", publicSiteUrl: "http://localhost:5173", parentSiteUrl: "http://localhost:5173" }
    : { apiBaseUrl: "https://trucker-heaven-food-api.onrender.com/api/v1/admin", publicSiteUrl: "https://trucker-heaven-food.onrender.com", parentSiteUrl: "https://truckerheaven.com" };
  window.FOODOPS_ADMIN_CONFIG = Object.freeze({ ...defaults, ...(window.FOODOPS_ADMIN_CONFIG || {}) });
})();
