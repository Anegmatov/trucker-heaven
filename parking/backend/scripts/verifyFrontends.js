'use strict';

const fs = require('node:fs');
const path = require('node:path');

const roots = {
  customer: path.resolve(__dirname, '../../frontend-customer'),
  admin: path.resolve(__dirname, '../../frontend-admin')
};

for (const root of Object.values(roots)) {
  for (const file of ['index.html', 'app.js', 'styles.css', 'config.js']) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${path.basename(root)}/${file}`);
  }
}
if (fs.existsSync(path.resolve(__dirname, '../../frontend-operations'))) throw new Error('Retired frontend-operations directory still exists.');

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const customer = ['index.html', 'app.js', 'customer-core.js', 'styles.css'].map(file => read(roots.customer, file)).join('\n');
const admin = ['index.html', 'render-runtime.js', 'config.js', 'api.js', 'routes.js', 'admin-core.js', 'advanced.js', 'app.js', 'styles.css', 'advanced.css'].map(file => read(roots.admin, file)).join('\n');

function requires(source, name, needles) {
  for (const needle of needles) if (!source.includes(needle)) throw new Error(`${name} is missing required marker: ${needle}`);
}

requires(customer, 'Customer frontend', [
  'Choose a parking type', 'Bobtail Parking', 'General Truck Parking', 'offeredDurations',
  'No supported booking product is currently available for this parking type.', 'parking-type-card',
  'renderMap', 'Choose Your Monthly Parking Position', 'CUSTOMER_SELECTED_SPOT', 'held for you', 'YOUR PARKING AREA',
  'Highlighted permitted parking area', 'is-permitted-area',
  'I Have Arrived', 'I Have Left the Lot', 'Secure lookup credential', '/canonical-lot',
  '/booking-attempts', '/payments/stripe/checkout-sessions', '/documents/insurance/upload',
  'Manage Billing', 'Driver License', 'Insurance', 'Upload Documents', 'Secure payment',
  'WEEKLY', 'Weekly', 'minimumWeeklyDays',
  'invalidateSearchState', 'availabilityController', 'REMEMBERED_STORAGE_KEY', 'localStorage', '@media print'
]);
requires(admin, 'Canonical admin frontend', [
  'Parking Lot', 'Overview', 'Reservations', 'Team', 'Lot Setup', 'Business Settings',
  'Customer Spaces', 'Daily Available', 'Monthly Available', 'Select Multiple', 'Spaces 110–148', 'Entrance / Exit',
  'renderSpaceDetails', 'renderPublishReview', 'renderBulkPreview',
  'ParkingAdminApi', "credentials: 'include'", 'X-CSRF-Token', 'pendingMutations',
  '/admin/auth/session', '/admin/auth/login', '/admin/auth/logout',
  '/admin/parking/v1/dashboard', '/admin/parking/v1/canonical-live-lot/snapshot',
  'loadAuthoritativeData', 'handleUnauthorized', 'clearPrivateState',
  'editSpace', 'previewBulkSpaces', 'editBulkSpaces', 'reviewLayout', 'publishLayout', 'rollbackLayout',
  'advancedAdminRoot', 'lotLayoutPanel', 'Owner-only structural controls for the physical parking map.',
  'Click any numbered space to change its number, vehicle type, rental type, or availability.',
  'layoutCreateDraft', 'layoutPreview', 'publishChecklistDialog', 'physicalConfirmation: true',
  'canonicalMaintenanceLocked', 'layoutPricing', 'Daily parking', 'Weekly', 'Monthly parking',
  'businessSettingsForm', 'bookingPoliciesForm', 'closuresList', 'adminUsersPanel',
  'Term-based customer reservations', 'Parking-area commitment', 'areaCapacity',
  'Payment / billing', 'Insurance Reviews', 'Overdue / Amount Due', 'Driver License', 'Request Replacement',
  'ParkingAdvancedAdmin', "state.user?.role === 'OWNER' ? OWNER_SCREENS : []"
]);

if ((admin.match(/\/admin\/auth\/login/g) || []).length !== 1) throw new Error('Canonical admin must contain exactly one login implementation.');
if (/fallbackAdminUrl|operationsUrl|trucker-heaven-parking-operations\.onrender\.com/.test(admin)) throw new Error('Canonical admin still depends on the retired operations service.');
if (/name="assignment_mode"|Assign exact numbered space|Customer Parking Assignment/.test(admin)) throw new Error('Canonical admin still exposes an exact-space customer booking toggle.');
if (/(postgres(?:ql)?:\/\/|BEGIN PRIVATE KEY|service_role)/i.test(admin)) throw new Error('Canonical admin contains a database credential or private key marker.');
if (/localStorage\s*[.\[]|indexedDB\s*[.(\[]|openDatabase\s*\(|supabase|anonKey/i.test(admin)) throw new Error('Canonical admin contains browser record persistence or direct database access.');

for (const source of [customer, admin]) {
  for (const marker of ['South Zone', 'North Zone', 'Select location', 'Choose location', 'Select zone', 'Choose zone', 'Zone map']) {
    if (source.includes(marker)) throw new Error(`Frontend contains obsolete location/zone UI marker: ${marker}`);
  }
}

console.log('Customer and canonical admin frontend structures verified; frontend-operations is retired.');
