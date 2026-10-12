(() => {
  'use strict';
  const PRODUCTION_CUSTOMER_HOSTS = new Set(['trucker-heaven-parking-a437.onrender.com']);
  if (!PRODUCTION_CUSTOMER_HOSTS.has(window.location.hostname)) return;
  if (!window.PARKING_API_BASE) window.PARKING_API_BASE = 'https://trucker-heaven-parking-api-vkf9.onrender.com/api/public/parking/v1';
  if (!window.PARKING_ACCOUNT_API_BASE) window.PARKING_ACCOUNT_API_BASE = 'https://trucker-heaven-parking-api-vkf9.onrender.com/api/customer/parking/v1';
  if (!window.TRUCKER_HEAVEN_SITE_URL) window.TRUCKER_HEAVEN_SITE_URL = 'https://trucker-heaven-main-website.onrender.com';
})();
