(() => {
  'use strict';

  const source = window.PARKING_ADMIN_RUNTIME_CONFIG || {};
  const parseUrl = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing.`);
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
    if (/__[A-Z0-9_]+__/.test(value)) throw new Error(`${label} contains an unresolved deployment placeholder.`);
    return parsed.toString().replace(/\/$/, '');
  };
  try {
    if (source.error) throw new Error(source.error);
    window.PARKING_ADMIN_CONFIG = Object.freeze({
      valid: true,
      environment: String(source.environment || 'explicit'),
      apiBase: parseUrl(source.apiBase, 'API base URL'),
      customerAppUrl: parseUrl(source.customerAppUrl, 'Customer application URL'),
      parentSiteUrl: parseUrl(source.parentSiteUrl, 'Parent site URL')
    });
  } catch (error) {
    window.PARKING_ADMIN_CONFIG = Object.freeze({ valid: false, error: error.message || 'ParkingOps runtime configuration is invalid.' });
  }
})();
