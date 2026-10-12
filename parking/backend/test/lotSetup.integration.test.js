const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing Lot Setup PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

const password = 'ParkingOps-lot-setup-test-password-2031';
let server;
let base;
let owner;
let staff;
let locationId;

function adminRequest(path, { method = 'GET', body, auth = owner } = {}) {
  const headers = { cookie: auth.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = auth.csrfToken;
  return fetch(`${base}/api/admin/parking/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test.before(async () => {
  const username = `lot-setup-test-${Date.now()}`;
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'OWNER',true)`, [username, await bcrypt.hash(password, 4)]);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const loginBody = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  owner = { cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: loginBody.csrfToken };
  const staffUsername = `lot-setup-staff-${Date.now()}`;
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'STAFF',true)`, [staffUsername, await bcrypt.hash(password, 4)]);
  const staffLogin = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: staffUsername, password }) });
  const staffBody = await staffLogin.json();
  assert.equal(staffLogin.status, 200, JSON.stringify(staffBody));
  staff = { cookie: staffLogin.headers.get('set-cookie').split(';')[0], csrfToken: staffBody.csrfToken };
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('Lot Setup provisions canonical categories and persists active area inventory relationships', async () => {
  const location = await adminRequest('/locations', { method: 'POST', body: {
    name: `Lot Setup Onboarding ${Date.now()}`, public_description: '', address: '1 Setup Way', timezone: 'America/Chicago',
    arrival_instructions: '', exit_instructions: '', road_directions_url: '', booking_approval_mode: 'AUTO_CONFIRM',
    payment_instructions: '', cancellation_cutoff_hours: 0, assignment_mode: 'ZONE_CAPACITY', self_service_enabled: false,
    check_in_early_minutes: 120, check_in_late_minutes: 1440, turnaround_buffer_minutes: 0, active: true
  } });
  const locationBody = await location.json();
  assert.equal(location.status, 201, JSON.stringify(locationBody));
  locationId = locationBody.item.id;

  const empty = await adminRequest(`/locations/${locationId}/setup`);
  assert.deepEqual((await empty.json()).inventory, []);

  const canonical = await adminRequest('/setup/canonical-categories', { method: 'POST', body: {} });
  const canonicalBody = await canonical.json();
  assert.equal(canonical.status, 200, JSON.stringify(canonicalBody));
  assert.deepEqual(canonicalBody.items.map(item => item.code).sort(), ['BOBTAIL', 'TRACTOR_ONLY', 'TRACTOR_TRAILER', 'TRAILER_ONLY']);
  const categories = Object.fromEntries(canonicalBody.items.map(item => [item.code, item]));

  const rejected = await adminRequest(`/locations/${locationId}/setup/areas`, { method: 'POST', body: {
    name: 'North Zone', description: '', operationalNotes: '', displayOrder: 0, active: true, publicVisible: true, categoryIds: []
  } });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.message, 'Select at least one supported vehicle type.');

  const created = await adminRequest(`/locations/${locationId}/setup/areas`, { method: 'POST', body: {
    name: 'North Zone', description: 'North parking', operationalNotes: 'Use north gate', displayOrder: 0, active: true, publicVisible: true,
    categoryIds: [categories.TRACTOR_TRAILER.id, categories.BOBTAIL.id]
  } });
  const createdBody = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  const zone = createdBody.areas.find(item => item.name === 'North Zone');
  assert.deepEqual(zone.vehicle_types.map(item => item.code).sort(), ['BOBTAIL', 'TRACTOR_TRAILER']);
  assert.deepEqual(createdBody.inventory.map(item => item.category_code).sort(), ['BOBTAIL', 'TRACTOR_TRAILER']);

  const updated = await adminRequest(`/locations/${locationId}/setup/areas/${zone.id}`, { method: 'PATCH', body: {
    version: zone.version, name: 'North Zone', description: 'Updated north parking', operationalNotes: '', displayOrder: 0,
    active: true, publicVisible: true, categoryIds: [categories.BOBTAIL.id]
  } });
  const updatedBody = await updated.json();
  assert.equal(updated.status, 200, JSON.stringify(updatedBody));
  assert.deepEqual(updatedBody.areas.find(item => item.id === zone.id).vehicle_types.map(item => item.code), ['BOBTAIL']);
  assert.deepEqual(updatedBody.inventory.map(item => item.category_code), ['BOBTAIL']);

  const draft = await adminRequest(`/locations/${locationId}/layout`, { method: 'POST', body: { name: 'Onboarding layout' } });
  const draftBody = await draft.json();
  assert.equal(draft.status, 201, JSON.stringify(draftBody));
  const inventory = updatedBody.inventory[0];
  const bulk = await adminRequest(`/locations/${locationId}/spots/bulk`, { method: 'POST', body: {
    zoneId: zone.id, inventoryId: inventory.id, labelPrefix: 'N-', startingNumber: 1, quantity: 1, numberPadding: 2,
    rows: 1, spacesPerRow: 1, orientation: 'HORIZONTAL', rowDirection: 'FORWARD', spacing: 1,
    x: 5, y: 5, width: 6, height: 8, groupName: 'North Bobtail', layoutVersion: draftBody.draft.version
  } });
  assert.equal(bulk.status, 201, JSON.stringify(await bulk.json()));
});

test('Lot Setup assigns shared rate plans and rejects staff configuration writes', async () => {
  const setup = await adminRequest(`/locations/${locationId}/layout`);
  const setupBody = await setup.json();
  assert.equal(setup.status, 200, JSON.stringify(setupBody));
  const element = setupBody.draft.elements.find(item => item.parking_spot_id);
  assert.ok(element, 'A numbered draft space is required for the rate-plan test.');
  const categoriesResponse = await adminRequest('/categories');
  const category = (await categoriesResponse.json()).items.find(item => item.code === 'BOBTAIL');
  assert.ok(category, 'The Bobtail category is required for the rate-plan test.');
  const createdRate = await adminRequest('/rates', { method: 'POST', body: {
    location_id: locationId, zone_id: null, category_id: category.id, daily_rate_cents: 1900, weekly_rate_cents: 10000,
    monthly_rate_cents: 15000, fee_cents: 0, tax_basis_points: 0, priority: 0, active: true
  } });
  const rateBody = await createdRate.json();
  assert.equal(createdRate.status, 201, JSON.stringify(rateBody));
  assert.equal(rateBody.item.daily_rate_cents, 1900);
  assert.equal(rateBody.item.weekly_rate_cents, 10000);
  assert.equal(rateBody.item.monthly_rate_cents, 15000);
  const configured = await adminRequest(`/layouts/${setupBody.draft.id}/spaces/${element.id}`, { method: 'PATCH', body: {
    layoutVersion: setupBody.draft.version, version: element.version, parkingSpotVersion: element.parking_spot_version,
    spaceType: 'BOBTAIL', ratePlanId: rateBody.item.id, publiclyBookable: true, weeklyEligible: true, monthlyEligible: true, active: true, internalNote: ''
  } });
  const configuredBody = await configured.json();
  assert.equal(configured.status, 200, JSON.stringify(configuredBody));
  assert.equal(Number(configuredBody.item.rate_plan_id), Number(rateBody.item.id));
  const editedRate = await adminRequest(`/rate-plans/${rateBody.item.id}`, { method: 'PATCH', body: {
    version: rateBody.item.version, dailyRateCents: 1900, weeklyRateCents: 10000, monthlyRateCents: 15000
  } });
  const editedRateBody = await editedRate.json();
  assert.equal(editedRate.status, 200, JSON.stringify(editedRateBody));
  assert.equal(editedRateBody.item.daily_rate_cents, 1900);
  assert.equal(editedRateBody.item.weekly_rate_cents, 10000);
  assert.equal(editedRateBody.item.monthly_rate_cents, 15000);
  const staffLayoutWrite = await adminRequest(`/layouts/${setupBody.draft.id}/spaces/${element.id}`, { method: 'PATCH', auth: staff, body: {
    layoutVersion: configuredBody.layoutVersion, version: configuredBody.item.version, spaceType: 'INTERNAL', ratePlanId: null,
    publiclyBookable: false, monthlyEligible: false, active: true, internalNote: ''
  } });
  assert.equal(staffLayoutWrite.status, 403);
  const staffRateWrite = await adminRequest(`/rate-plans/${rateBody.item.id}`, { method: 'PATCH', auth: staff, body: {
    version: 2, dailyRateCents: 1900, weeklyRateCents: 10000, monthlyRateCents: 15000
  } });
  assert.equal(staffRateWrite.status, 403);
});
