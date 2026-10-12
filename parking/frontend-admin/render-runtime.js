(() => {
  'use strict';

  if (window.PARKING_ADMIN_RUNTIME_CONFIG) return;
  const host = window.location.hostname.toLowerCase();
  const origin = window.location.origin;
  const configurations = {
    'trucker-heaven-parking-admin-krfn.onrender.com': {
      environment: 'production',
      apiBase: 'https://trucker-heaven-parking-api-vkf9.onrender.com/api',
      customerAppUrl: 'https://trucker-heaven-parking-a437.onrender.com',
      parentSiteUrl: 'https://truckerheaven.com'
    },
    localhost: {
      environment: 'local', apiBase: `${origin}/api`, customerAppUrl: 'http://localhost:5181', parentSiteUrl: 'http://localhost:5176'
    },
    '127.0.0.1': {
      environment: 'local', apiBase: `${origin}/api`, customerAppUrl: 'http://127.0.0.1:5181', parentSiteUrl: 'http://127.0.0.1:5176'
    }
  };
  window.PARKING_ADMIN_RUNTIME_CONFIG = configurations[host] || {
    environment: 'unconfigured', error: `ParkingOps has no explicit runtime configuration for ${host || 'this host'}.`
  };
})();
