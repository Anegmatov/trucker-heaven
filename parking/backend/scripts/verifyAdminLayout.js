const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend-admin/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend-admin/app.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'frontend-admin/config.js'), 'utf8');
const adminRoutes = require(path.join(root, 'frontend-admin/routes.js'));
const backendRoutes = fs.readFileSync(path.join(root, 'backend/routes/adminParking.js'), 'utf8');

const expectedNavigation = [
  ['dashboard', 'Dashboard'], ['live-lot', 'Live Lot'], ['reservations', 'Reservations'], ['lot-setup', 'Lot Setup'],
  ['pricing-policies', 'Pricing & Policies'], ['staff-accounts', 'Users'], ['business-settings', 'Business Settings']
];
const checks = [
  ['canonical application navigation', JSON.stringify(adminRoutes.primaryNavigation.map(item => [item.view, item.label])) === JSON.stringify(expectedNavigation)],
  ['legacy routes normalize to final routes', adminRoutes.normalize('physical-map') === 'lot-setup' && adminRoutes.normalize('parking-types') === 'lot-setup' && adminRoutes.normalize('pricing') === 'pricing-policies' && adminRoutes.normalize('settings') === 'business-settings'],
  ['map-first route points to the editor rather than Physical Map', adminRoutes.panels['lot-setup'][0] === 'lotLayoutPanel' && html.includes('id="lotLayoutPanel"') && !html.includes('id="physicalMapPanel"')],
  ['Business Settings exposes one canonical property editor', JSON.stringify(adminRoutes.visibleConfigTabs('business-settings')) === JSON.stringify(['property', 'contact', 'instructions']) && !html.includes('id="config-zones"') && !html.includes('id="config-categories"') && !html.includes('id="config-inventory"') && !html.includes('Add location') && !html.includes('Delete location') && html.includes('id="businessSettingsForm"') && html.includes('Business hours')],
  ['Pricing is owner-facing and hides legacy scope controls', JSON.stringify(adminRoutes.visibleConfigTabs('pricing-policies')) === JSON.stringify(['rates', 'fees', 'policies', 'closures']) && !html.includes('rateLocationId') && !html.includes('rateZoneId') && !html.includes('closureLocationId') && !html.includes('closureZoneId') && html.includes('Monthly rate (USD)') && html.includes('Fees &amp; Taxes') && html.includes('Booking Policies')],
  ['rate and setting safeguards stay wired', app.includes('Enter at least one daily, weekly, or monthly rate.') && app.includes('Tax rate must be between 0% and 100%') && app.includes('businessDirty') && backendRoutes.includes('rejectAmbiguousActiveRate') && backendRoutes.includes("configure: permit('OWNER')")],
  ['app has one canonical route registry', app.includes('adminRoutes.normalize(view)') && !app.includes('const aliases =') && html.includes('routes.js?v=__PARKING_ADMIN_BUILD_REVISION__')],
  ['editor keeps draft-safe operational controls', ['space-positions', 'parkingPurpose', 'monthlyEligible', 'layoutUndo', 'layoutRedo', 'layoutSpaceSearch', 'layoutRotate'].every(value => app.includes(value) || html.includes(value))],
  ['customer and parent links remain wired', html.includes('customerParkingLink') && html.includes('parentSiteLink') && config.includes('customerAppUrl') && config.includes('parentSiteUrl')],
  ['staff authorization guard', app.includes('adminRoutes.ownerViews.has(view)') && app.includes("$$('[data-owner-nav]').forEach(item => { item.hidden = !isOwner(); });")],
  ['canonical Live Lot is retained', ['canonical-live-lot/snapshot', 'operational-detail', '/timeline?from=', 'canonical-live-lot/search', 'liveLotFutureOnly', 'live-fallback', 'data-live-close', 'ArrowDown'].every(value => app.includes(value) || html.includes(value))],
  ['backend publication safety remains enforced', backendRoutes.includes("PARKING_CANONICAL_LAYOUT_MAINTENANCE === 'true'") && backendRoutes.includes('CANONICAL_LAYOUT_LOCKED') && backendRoutes.includes('requireCanonicalLayoutMaintenance(client, locationId)')]
];
for (const [name, passed] of checks) assert.ok(passed, `Admin layout verification failed: ${name}`);
console.log(`Admin layout frontend verified: ${checks.length} checks.`);
