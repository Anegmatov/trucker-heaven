(function registerParkingAdminRoutes(root, factory) {
  const registry = factory();
  if (typeof module === 'object' && module.exports) module.exports = registry;
  if (root) root.ParkingAdminRoutes = registry;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  'use strict';

  const routes = Object.freeze({
    dashboard: Object.freeze({ view: 'dashboard', label: 'Overview', title: 'Overview', subtitle: 'Today’s parking operations.', panels: ['dashboardOverviewPanel', 'recentActivityPanel'], primary: true }),
    'live-lot': Object.freeze({ view: 'live-lot', label: 'Live Lot', title: 'Live Lot', subtitle: 'See what is happening in the parking lot right now.', panels: ['liveLotPanel'], primary: true }),
    reservations: Object.freeze({ view: 'reservations', label: 'Reservations', title: 'Reservations', subtitle: 'Find, review, and manage parking reservations.', panels: ['reservationsPanel', 'reservationDetailPanel'], primary: true }),
    'reservation-desk': Object.freeze({ view: 'reservation-desk', label: 'Reservation Desk', title: 'Reservation Desk', subtitle: 'Create a capacity-safe reservation for a customer.', panels: [], primary: true }),
    'lot-setup': Object.freeze({ view: 'lot-setup', label: 'Lot Setup', title: 'Lot Setup', subtitle: 'Configure parking-space numbers, vehicle types, rental types, and availability.', panels: ['lotLayoutPanel'], primary: true, ownerOnly: true }),
    'staff-accounts': Object.freeze({ view: 'staff-accounts', label: 'Team', title: 'Team', subtitle: 'Manage team access and permissions.', panels: ['adminUsersPanel'], primary: true, ownerOnly: true }),
    'business-settings': Object.freeze({ view: 'business-settings', label: 'Business Settings', title: 'Business Settings', subtitle: 'Manage property information, customer guidance, booking policies, and closures.', panels: ['configuration'], primary: true, ownerOnly: true })
  });

  const aliases = Object.freeze({
    overview: Object.freeze({ view: 'dashboard' }),
    layout: Object.freeze({ view: 'lot-setup' }),
    'advanced-configuration': Object.freeze({ view: 'lot-setup' }),
    users: Object.freeze({ view: 'staff-accounts' }),
    'physical-map': Object.freeze({ view: 'lot-setup' }),
    'parking-types': Object.freeze({ view: 'lot-setup' }),
    arrivals: Object.freeze({ view: 'reservations', reservationTab: 'arriving-today' }),
    departures: Object.freeze({ view: 'reservations', reservationTab: 'departing-today' }),
    attention: Object.freeze({ view: 'reservations', reservationTab: 'attention' }),
    'new-reservation': Object.freeze({ view: 'reservation-desk' }),
    closures: Object.freeze({ view: 'business-settings', configTab: 'closures' }),
    rates: Object.freeze({ view: 'lot-setup' }),
    pricing: Object.freeze({ view: 'lot-setup' }),
    'pricing-policies': Object.freeze({ view: 'lot-setup' }),
    'rates-rules': Object.freeze({ view: 'lot-setup' }),
    settings: Object.freeze({ view: 'business-settings', configTab: 'property' }),
    configuration: Object.freeze({ view: 'business-settings', configTab: 'property' }),
    'general-settings': Object.freeze({ view: 'business-settings', configTab: 'property' }),
    property: Object.freeze({ view: 'business-settings', configTab: 'property' }),
    contact: Object.freeze({ view: 'business-settings', configTab: 'contact' }),
    instructions: Object.freeze({ view: 'business-settings', configTab: 'instructions' }),
    policies: Object.freeze({ view: 'business-settings', configTab: 'policies' })
  });

  const primaryNavigation = Object.freeze(Object.values(routes).filter(route => route.primary).map(route => Object.freeze({ view: route.view, label: route.label, ownerOnly: Boolean(route.ownerOnly) })));
  const panels = Object.freeze(Object.fromEntries(Object.entries(routes).map(([key, route]) => [key, route.panels])));
  const ownerViews = new Set(Object.values(routes).filter(route => route.ownerOnly).map(route => route.view));
  const configurationTabs = Object.freeze(['property', 'contact', 'instructions', 'policies', 'closures']);

  function requestedKey(value) {
    return String(value || '').trim().replace(/^#/, '').toLowerCase();
  }

  function resolve(value) {
    const requested = requestedKey(value) || 'dashboard';
    const target = routes[requested] ? { view: requested } : aliases[requested];
    if (!target) return Object.freeze({ requested, supported: false, view: null, notice: `“${requested}” is not a supported ParkingOps page.` });
    return Object.freeze({ requested, supported: true, ...target, route: routes[target.view] });
  }

  function normalize(value) {
    return resolve(value).view;
  }

  function visibleConfigTabs(view) {
    return resolve(view).view === 'business-settings' ? [...configurationTabs] : [];
  }

  return Object.freeze({ routes, primaryNavigation, panels, aliases, ownerViews, configurationTabs, resolve, normalize, visibleConfigTabs });
});
