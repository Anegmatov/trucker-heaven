(() => {
  'use strict';
  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  const production = host === 'trucker-heaven-parking-a437.onrender.com';
  const rawPhone = String(window.PARKING_SUPPORT_PHONE || window.PARKING_SUPPORT_PHONE_DISPLAY || '+16154705075').trim();
  const phoneDigits = rawPhone.replace(/[^\d+]/g, '');
  const tenDigits = phoneDigits.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const phoneDisplay = tenDigits.length === 10 ? `${tenDigits.slice(0, 3)}-${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}` : rawPhone;
  const safeHttpUrl = value => { try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href.replace(/\/$/, '') : ''; } catch (_) { return ''; } };
  const apiBase = safeHttpUrl(window.PARKING_API_BASE || (local ? `${window.location.origin}/api/public/parking/v1` : production ? 'https://trucker-heaven-parking-api-vkf9.onrender.com/api/public/parking/v1' : ''));
  const accountApiBase = safeHttpUrl(window.PARKING_ACCOUNT_API_BASE || (local ? `${window.location.origin}/api/customer/parking/v1` : production ? 'https://trucker-heaven-parking-api-vkf9.onrender.com/api/customer/parking/v1' : ''));
  const parentSiteUrl = safeHttpUrl(window.TRUCKER_HEAVEN_SITE_URL || (local ? 'http://localhost:5176' : production ? 'https://trucker-heaven-main-website.onrender.com' : ''));
  window.PARKING_CONFIG = Object.freeze({
    apiBase,
    accountApiBase,
    parentSiteUrl,
    supportPhone: phoneDigits,
    supportPhoneDisplay: phoneDisplay,
    configured: Boolean(apiBase)
  });
})();
