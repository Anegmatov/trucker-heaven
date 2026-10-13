(() => {
  "use strict";

  if (!window.location.hostname.endsWith(".onrender.com")) return;
  // The unified admin served by the shared backend (/sites/admin) configures itself in config.js.
  if (/^\/sites\/admin(\/|$)/.test(window.location.pathname)) return;

  window.FOODOPS_ADMIN_CONFIG = Object.freeze({
    apiBaseUrl:
      "https://trucker-heaven-food-api.onrender.com/api/v1/admin",
    publicSiteUrl:
      "https://trucker-heaven-food.onrender.com",
    parentSiteUrl:
      "https://trucker-heaven-main-website.onrender.com"
  });
})();
