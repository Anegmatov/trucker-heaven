(() => {
  "use strict";

  if (!window.location.hostname.endsWith(".onrender.com")) return;

  window.DriveOpsAdminRuntimeConfig = Object.freeze({
    API_BASE: "https://trucker-heaven-rental-api.onrender.com"
  });
})();
