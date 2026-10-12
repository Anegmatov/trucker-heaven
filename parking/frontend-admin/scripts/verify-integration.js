'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const app = read('app.js');
const api = read('api.js');
const config = read('config.js');
const runtime = read('render-runtime.js');
const advanced = read('advanced.js');
const reservationDesk = read('reservation-desk.js');

assert.doesNotMatch(`${html}\n${app}\n${advanced}\n${reservationDesk}`, /<form(?![^>]*\bmethod=)/i,
  'Admin forms must not fall back to GET and expose credentials or operational data in URLs.');

assert.match(html, /render-runtime\.js[\s\S]*config\.js[\s\S]*api\.js[\s\S]*routes\.js[\s\S]*admin-core\.js[\s\S]*reservation-desk\.js[\s\S]*advanced\.js[\s\S]*app\.js/, 'The shared configuration, API adapter, reservation desk, and owner tools must load before the operations shell.');
assert.doesNotMatch(html, /legacy-seed-data/i, 'Entrypoint must not load a legacy seed bundle.');
assert.equal(fs.existsSync(path.join(root, 'legacy-seed-data.js')), false, 'Legacy seed source must not exist.');

for (const screen of ['Overview', 'Live Lot', 'Reservations', 'Reservation Desk', 'Customers', 'Lot Setup', 'Team', 'Business Settings', 'Advanced Map Tools']) {
  assert.ok(app.includes(`'${screen}'`), `Primary navigation is missing ${screen}.`);
}
assert.doesNotMatch(app, /South Zone|Fleet Service Board|Company Yards|Samsara|FSB Reports/, 'The primary shell must not expose unrelated or retired modules.');

for (const marker of [
  'loadAuthoritativeData', 'loadBookingsFromServer', 'loadBookingDetail', 'renderDashboard', 'renderLiveLot',
  'renderReservations', 'renderCustomers', 'renderCalendar', 'renderActivity', 'renderReports', 'renderAdvancedScreen',
  'clearPrivateState', 'handleUnauthorized', 'renderSpaceDetails', 'renderPublishReview', 'renderBulkPreview', 'No static fallback is available'
]) assert.ok(app.includes(marker), `Operations integration is missing ${marker}.`);

for (const pathMarker of [
  '/admin/auth/session', '/admin/auth/login', '/admin/auth/logout', '/admin/parking/v1/dashboard',
  '/admin/parking/v1/canonical-live-lot/snapshot', '/admin/parking/v1/bookings',
  '/admin/parking/v1/customers', '/admin/parking/v1/customers/payment-matrix'
]) assert.ok(api.includes(pathMarker), `API adapter is missing ${pathMarker}.`);
for (const marker of ['reservationDeskBootstrap', 'reservationDeskAvailability', 'createDeskReservation', 'overrideDeskReservationPrice', 'startDeskInsuranceUpload', 'createDeskPaymentLink', 'sendDeskReservationNotice']) {
  assert.ok(api.includes(marker), `Reservation Desk API adapter is missing ${marker}.`);
}
for (const marker of ['NEW BOOKING', 'Create Secure Payment Link', 'Send Reservation Confirmation', 'Send Payment Link', 'arrivalLocal', 'departureLocal', 'reservation.price_override', 'Check Availability', 'COMPLETE BOOKING', 'Review &amp; Save Changes']) {
  assert.ok(reservationDesk.includes(marker), `Reservation Desk workflow is missing ${marker}.`);
}
assert.ok(advanced.includes('/admin/parking/v1/admin-users'), 'Owner user administration endpoint is missing.');
for (const marker of ['editSpace', 'previewBulkSpaces', 'editBulkSpaces', 'reviewLayout', 'publishLayout', 'rollbackLayout']) {
  assert.ok(api.includes(marker), `Direct parking-management API adapter is missing ${marker}.`);
}
assert.ok(api.includes("credentials: 'include'") && api.includes("'X-CSRF-Token'") && api.includes('pendingMutations'), 'Session, CSRF, and duplicate-mutation protection must be centralized.');
assert.ok(api.includes('REQUEST_TIMEOUT') && api.includes('NETWORK_ERROR'), 'Timeout and network failures must be explicit.');
assert.doesNotMatch(`${api}\n${app}`, /localStorage\s*[.\[]|indexedDB\s*[.(\[]|openDatabase\s*\(/i, 'Deployable code must not persist records in a browser database.');
assert.doesNotMatch(`${api}\n${app}`, /supabase|service_role|anonKey/i, 'Deployable code must not call a database vendor directly.');
assert.ok(config.includes('parentSiteUrl') && runtime.includes('parentSiteUrl'), 'Parent-site runtime configuration is required.');
assert.doesNotMatch(`${config}\n${runtime}\n${app}`, /fallbackAdminUrl|parking-operations\.onrender\.com|operationsUrl/, 'Canonical admin code must not depend on a fallback or operations service.');
assert.doesNotMatch(advanced, /fetch\s*\(|\/admin\/auth\/(?:login|session|logout|csrf)/, 'Owner tools must use the shared API/session/CSRF adapter.');
for (const marker of ['advancedAdminRoot', 'lotLayoutPanel', 'layoutCreateDraft', 'layoutPreview', 'publishChecklistDialog', 'layoutPricing', 'configuration', 'bookingPoliciesForm', 'closuresList', 'adminUsersPanel']) assert.ok(html.includes(marker), `Parking admin is missing ${marker}.`);
assert.match(html, /Customers pick their space/, 'Booking Policies must explain how customers get a space.');
assert.match(html, /Daily, Weekly and Monthly customers tap an open numbered space/, 'Booking Policies must describe customer-picked spaces for every term.');
assert.match(html, /Monthly keeps it every month/, 'Booking Policies must explain that Monthly customers keep their space.');
assert.doesNotMatch(html, /name="assignment_mode"|Assign exact numbered space|Customer Parking Assignment/, 'Booking Policies must not expose an assignment-mode toggle.');
assert.doesNotMatch(advanced, /textValue\(form, 'assignment_mode'\)|assignment_mode:\s*assignmentMode/, 'Booking Policies must not submit an assignment mode.');
for (const marker of ['ParkingAdvancedAdmin', 'canonicalMaintenanceLocked', 'physicalConfirmation: true', 'loadLotSetupLocations', 'loadConfig', 'loadAdminUsers']) assert.ok(advanced.includes(marker), `Owner integration is missing ${marker}.`);
assert.ok(app.includes("state.user?.role === 'OWNER' ? [...OWNER_SCREENS, 'Advanced Map Tools'] : []"), 'OWNER navigation is not role-gated.');
assert.ok(app.includes("renderParkingLot({ setup: false })") && app.includes("renderParkingLot({ setup: true })"), 'Live Lot and simple Lot Setup must share one authoritative map while preserving distinct workflows.');
for (const marker of ['Customer Spaces', 'Daily Available', 'Monthly Available', 'Select Multiple', 'Rental Type', 'Availability', 'Spaces 110–148', 'Entrance / Exit']) {
  assert.ok(app.includes(marker), `Parking Lot workflow is missing ${marker}.`);
}

function evaluateRuntime(hostname) {
  const context = { window: { location: { hostname } } };
  vm.runInNewContext(runtime, context);
  return context.window.PARKING_ADMIN_RUNTIME_CONFIG;
}
const production = evaluateRuntime('trucker-heaven-parking-admin-krfn.onrender.com');
assert.equal(production.environment, 'production');
assert.equal(production.apiBase, 'https://trucker-heaven-parking-api-vkf9.onrender.com/api');
assert.equal(production.customerAppUrl, 'https://trucker-heaven-parking-a437.onrender.com');
assert.equal(production.parentSiteUrl, 'https://truckerheaven.com');
assert.equal(evaluateRuntime('preview.example.test').environment, 'unconfigured', 'Unknown hosts must fail closed.');

if (process.env.PARKING_LEGACY_INDEX) {
  const expected = 'e51a94db269010644ab039be14deb105e479b215fb40687875be66099a34f041';
  const actual = crypto.createHash('sha256').update(fs.readFileSync(process.env.PARKING_LEGACY_INDEX)).digest('hex');
  assert.equal(actual, expected, 'The preserved private legacy source changed.');
}

console.log('Canonical admin consolidation verified: one operations shell/session/API, OWNER-only advanced tools, backend-only data, and disconnected non-parking modules.');
