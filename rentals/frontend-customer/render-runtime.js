(() => {
  "use strict";

  if (!window.location.hostname.endsWith(".onrender.com")) return;

  window.DriveOpsRuntimeConfig = Object.freeze({
    PARENT_SITE_URL: "https://truckerheaven.com",
    CUSTOMER_SITE_URL: "https://trucker-heaven-rentals-customer.onrender.com",
    ADMIN_SITE_URL: "https://trucker-heaven-rentals-operations.onrender.com",
    API_BASE: "https://trucker-heaven-rental-api.onrender.com"
  });
})();
