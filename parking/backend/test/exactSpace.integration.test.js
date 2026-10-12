const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing exact-space PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

const password = 'ParkingOps-exact-space-test-2031';
const ownerName = 'exact-test-owner';
const staffName = 'exact-test-staff';
let server;
let base;
let locationId;
let publicLocationId;
let publicAreaId;
let zoneId;
let inventoryId;
let otherCategoryId;
let draftId;
let draftVersion;
let owner;
let staff;

function localInput(date, zone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

async function createAdmin(username, role) {
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,$3,true,0,NULL) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,
      role=EXCLUDED.role,active=true,failed_login_count=0,locked_until=NULL`, [username, await bcrypt.hash(password, 4), role]);
}

async function loginAs(username) {
  const response = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken };
}

function adminRequest(path, session, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = session.csrfToken;
  return fetch(`${base}/api/admin/parking/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function publicRequest(path, body, idempotencyKey) {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function bookingPayload(index, interval = {}) {
  const arrivalLocal = interval.arrivalLocal || '2032-05-10T09:00';
  const departureLocal = interval.departureLocal || '2032-05-10T12:00';
  return {
    parkingAreaId: publicAreaId, categoryCode: 'TRACTOR_TRAILER', arrivalLocal, departureLocal,
    firstName: 'Exact', lastName: `Driver${index}`, mobilePhone: `+1615555${String(1000 + index)}`,
    email: `exact.driver.${index}@example.test`, companyName: 'Exact Test', tractorUnitNumber: `BT-${index}`,
    licensePlate: `EX${index}`, licensePlateState: 'TN', trailerNumber: '', specialInstructions: '',
    termsAccepted: true, cancellationTermsAccepted: true
  };
}

async function availabilityFor(categoryCode = 'TRACTOR_TRAILER', interval = {}) {
  const result = await publicRequest('/availability', {
    parkingAreaId: publicAreaId,
    categoryCode,
    ...(interval.duration ? { duration: interval.duration } : {}),
    arrivalLocal: interval.arrivalLocal || '2032-05-10T09:00',
    departureLocal: interval.departureLocal || '2032-05-10T12:00'
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.results.length, 1, JSON.stringify(result.body));
  return result.body.results[0];
}

async function dashboardAvailableForInventory() {
  const response = await adminRequest('/dashboard', owner);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const metric = body.areaCapacity.find(item => Number(item.inventoryId) === Number(inventoryId));
  assert.ok(metric, `Dashboard omitted inventory ${inventoryId}`);
  return Number(metric.availableCapacity);
}

async function waitForAdvisoryWaiters(minimum) {
  for (let attempts = 0; attempts < 500; attempts += 1) {
    const waiting = await pool.query(`SELECT count(*)::int count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event='advisory'
        AND query LIKE 'SELECT pg_advisory_xact_lock(%'`);
    if (waiting.rows[0].count >= minimum) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory-lock waiter(s)`);
}

test('availability validates the explicit product without re-deriving it from dates', async () => {
  const shortMonthly = await publicRequest('/availability', {
    parkingAreaId: publicAreaId, categoryCode: 'TRACTOR_TRAILER', duration: 'MONTHLY',
    arrivalLocal: '2032-04-01T09:00', departureLocal: '2032-04-02T09:00'
  });
  assert.equal(shortMonthly.response.status, 422);
  assert.equal(shortMonthly.body.error.code, 'MONTHLY_STAY_TOO_SHORT');

  const validMonthly = await publicRequest('/availability', {
    parkingAreaId: publicAreaId, categoryCode: 'TRACTOR_TRAILER', duration: 'MONTHLY',
    arrivalLocal: '2032-04-01T09:00', departureLocal: '2032-04-29T09:00'
  });
  assert.equal(validMonthly.response.status, 200, JSON.stringify(validMonthly.body));

  const longDaily = await publicRequest('/availability', {
    parkingAreaId: publicAreaId, categoryCode: 'TRACTOR_TRAILER', duration: 'DAILY',
    arrivalLocal: '2032-04-01T09:00', departureLocal: '2032-05-01T09:00'
  });
  assert.equal(longDaily.response.status, 422);
  assert.equal(longDaily.body.error.code, 'BOOKING_STAY_TOO_LONG');
});

test.before(async () => {
  const categories = (await pool.query("SELECT id,code FROM parking_categories WHERE code IN ('TRACTOR_TRAILER','BOBTAIL')")).rows;
  const category = categories.find(item => item.code === 'TRACTOR_TRAILER');
  const otherCategory = categories.find(item => item.code === 'BOBTAIL');
  assert.ok(category && otherCategory, 'load development seed before exact-space tests');
  otherCategoryId = otherCategory.id;
  const location = await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,road_directions_url,payment_instructions,assignment_mode,self_service_enabled,
      check_in_early_minutes,check_in_late_minutes,turnaround_buffer_minutes)
    VALUES('Exact General Truck Integration Lot ${Date.now()}','Exact-space test lot','14 Exact Way','America/Chicago','+16155550140',
      'Enter through the main entrance.','Follow the lane to the south exit.','https://maps.example.test/exact-lot',
      'Pay at the parking office.','EXACT_SPOT',true,120,240,15)
    ON CONFLICT(name) DO UPDATE SET address=EXCLUDED.address RETURNING id,public_id`);
  ({ id: locationId, public_id: publicLocationId } = location.rows[0]);
  const zone = await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'North General Truck Area','Numbered General Truck parking','Enter, pass the office, and follow North Area signs.',
      'Follow the marked lane to the south exit.',10)
    ON CONFLICT(location_id,name) DO UPDATE SET arrival_directions=EXCLUDED.arrival_directions,
      exit_directions=EXCLUDED.exit_directions RETURNING id,public_id`, [locationId]);
  ({ id: zoneId, public_id: publicAreaId } = zone.rows[0]);
  const inventory = await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,0,'Numbered General Truck parking',true)
    ON CONFLICT(zone_id,category_id) DO UPDATE SET active=true RETURNING id`, [zoneId, category.id]);
  inventoryId = inventory.rows[0].id;
  await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,daily_rate_cents,weekly_rate_cents,monthly_rate_cents)
    SELECT $1,$2,$3,2500,15000,45000 WHERE NOT EXISTS (
      SELECT 1 FROM parking_rate_rules WHERE location_id=$1 AND zone_id=$2 AND category_id=$3)`, [locationId, zoneId, category.id]);
  await createAdmin(ownerName, 'OWNER');
  await createAdmin(staffName, 'STAFF');
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await loginAs(ownerName);
  staff = await loginAs(staffName);
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('migration 013 creates exact-space relationships while legacy locations stay zone-capacity', async () => {
  const schema = await pool.query(`SELECT
    to_regclass('public.parking_spots') spots,
    to_regclass('public.parking_spot_blocks') blocks,
    to_regclass('public.reservation_spot_assignments') assignments,
    to_regclass('public.parking_area_directions') directions,
    (SELECT count(*)::int FROM schema_migrations WHERE name='013_exact_space_parking.sql') migration_count,
    (SELECT assignment_mode FROM parking_locations WHERE name='Trucker Heaven Main Lot') legacy_mode`);
  assert.equal(schema.rows[0].spots, 'parking_spots');
  assert.equal(schema.rows[0].blocks, 'parking_spot_blocks');
  assert.equal(schema.rows[0].assignments, 'reservation_spot_assignments');
  assert.equal(schema.rows[0].directions, 'parking_area_directions');
  assert.equal(schema.rows[0].migration_count, 1);
  assert.equal(schema.rows[0].legacy_mode, 'ZONE_CAPACITY');
});

test('OWNER completes setup, bulk-generates N-01 through N-15, and publishes only after confirmation', async () => {
  const draftResponse = await adminRequest(`/locations/${locationId}/layout`, owner, { method: 'POST', body: { name: 'Exact integration layout' } });
  const draftBody = await draftResponse.json();
  assert.equal(draftResponse.status, 201, JSON.stringify(draftBody));
  draftId = draftBody.draft.id;
  draftVersion = Number(draftBody.draft.version);
  const added = [];
  for (const element of [
    { element_type: 'ENTRANCE', label: 'Main Entrance', x: 3, y: 3, width: 10, height: 7, layer_order: 1 },
    { element_type: 'EXIT', label: 'South Exit', x: 86, y: 89, width: 10, height: 7, layer_order: 2 },
    { element_type: 'OFFICE', label: 'Parking Office', x: 15, y: 8, width: 10, height: 10, layer_order: 3 },
    { element_type: 'DRIVE_LANE', label: 'Main Drive Lane', x: 10, y: 20, width: 80, height: 6, layer_order: 4 }
  ]) {
    const response = await adminRequest(`/layouts/${draftId}/elements`, owner, { method: 'POST', body: {
      ...element, rotation: 0, public_visible: true, active: true, layout_version: draftVersion
    } });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    draftVersion = body.layoutVersion;
    added.push(body.item);
  }
  const area = (await pool.query('SELECT version FROM parking_zones WHERE id=$1', [zoneId])).rows[0];
  const directions = await adminRequest(`/locations/${locationId}/areas/${zoneId}/directions`, owner, { method: 'PATCH', body: {
    version: area.version,
    arrivalDirections: 'Enter, pass the office, and follow North Area signs.',
    exitDirections: 'Follow the marked lane to the south exit.',
    entranceElementKey: added[0].element_key, exitElementKey: added[1].element_key,
    arrivalRouteElementKeys: [added[0].element_key, added[3].element_key],
    exitRouteElementKeys: [added[3].element_key, added[1].element_key]
  } });
  assert.equal(directions.status, 200, JSON.stringify(await directions.json()));
  const bulk = await adminRequest(`/locations/${locationId}/spots/bulk`, owner, { method: 'POST', body: {
    zoneId, inventoryId, labelPrefix: 'N-', startingNumber: 1, quantity: 15, numberPadding: 2,
    rows: 3, spacesPerRow: 5, orientation: 'HORIZONTAL', rowDirection: 'FORWARD', spacing: 1,
    x: 10, y: 32, width: 6, height: 8, groupName: 'North General Truck', layoutVersion: draftVersion
  } });
  const bulkBody = await bulk.json();
  assert.equal(bulk.status, 201, JSON.stringify(bulkBody));
  assert.deepEqual(bulkBody.items.map(item => item.spot.public_label), [...Array(15)].map((_, index) => `N-${String(index + 1).padStart(2, '0')}`));
  draftVersion = bulkBody.layoutVersion;
  const duplicate = await adminRequest(`/locations/${locationId}/spots`, owner, { method: 'POST', body: {
    zoneId, inventoryId, publicLabel: 'N-01', layoutVersion: draftVersion, x: 5, y: 80
  } });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'SPOT_LABEL_CONFLICT');
  const denied = await adminRequest(`/locations/${locationId}/spots/bulk`, staff, { method: 'POST', body: {} });
  assert.equal(denied.status, 403);
  const incomplete = await adminRequest(`/layouts/${draftId}/publish`, owner, { method: 'POST', body: { version: draftVersion } });
  assert.equal(incomplete.status, 409);
  assert.equal((await incomplete.json()).error.code, 'EXACT_SPOT_SETUP_INCOMPLETE');
  const publish = await adminRequest(`/layouts/${draftId}/publish`, owner, {
    method: 'POST', body: { version: draftVersion, physicalConfirmation: true }
  });
  const published = await publish.json();
  assert.equal(publish.status, 200, JSON.stringify(published));
  assert.equal(published.published.elements.filter(item => item.parking_spot_id).length, 15);
  const location = (await pool.query('SELECT exact_mode_active,physical_layout_confirmed_at FROM parking_locations WHERE id=$1', [locationId])).rows[0];
  assert.equal(location.exact_mode_active, true);
  assert.ok(location.physical_layout_confirmed_at);
});

test('owner map drafts keep movements and monthly eligibility private until publish', async () => {
  const before = await adminRequest(`/locations/${locationId}/layout`, owner);
  const beforeBody = await before.json();
  assert.equal(before.status, 200, JSON.stringify(beforeBody));
  const draft = beforeBody.draft;
  const published = beforeBody.published;
  const first = draft.elements.find(item => item.label === 'N-01');
  const second = draft.elements.find(item => item.label === 'N-02');
  const publishedFirst = published.elements.find(item => item.parking_spot_id === first.parking_spot_id);
  const moved = await adminRequest(`/layouts/${draft.id}/space-positions`, owner, { method: 'PATCH', body: {
    layoutVersion: draft.version,
    moves: [
      { elementId: first.id, version: first.version, x: Number(first.x) + 1, y: Number(first.y) + 1, rotation: 90 },
      { elementId: second.id, version: second.version, x: Number(second.x) + 1, y: Number(second.y) + 1, rotation: 90 }
    ]
  } });
  const movedBody = await moved.json();
  assert.equal(moved.status, 200, JSON.stringify(movedBody));
  assert.equal(movedBody.items.length, 2);
  const privateRead = await adminRequest(`/locations/${locationId}/layout`, owner);
  const privateBody = await privateRead.json();
  assert.equal(Number(privateBody.draft.elements.find(item => item.id === first.id).x), Number(first.x) + 1);
  assert.equal(Number(privateBody.published.elements.find(item => item.parking_spot_id === first.parking_spot_id).x), Number(publishedFirst.x));
  const stale = await adminRequest(`/layouts/${draft.id}/space-positions`, owner, { method: 'PATCH', body: {
    layoutVersion: draft.version, moves: [{ elementId: first.id, version: first.version, x: Number(first.x), y: Number(first.y), rotation: 0 }]
  } });
  assert.equal(stale.status, 409);
  const configuredFirst = privateBody.draft.elements.find(item => item.id === first.id);
  const spotBeforeDraftConfiguration = (await pool.query('SELECT inventory_id,parking_use,public_bookable,classification_state,version FROM parking_spots WHERE id=$1', [first.parking_spot_id])).rows[0];
  const monthly = await adminRequest(`/layouts/${draft.id}/spaces/${first.id}`, owner, { method: 'PATCH', body: {
    layoutVersion: privateBody.draft.version, version: configuredFirst.version, parkingPurpose: 'CUSTOMER',
    dailyEligible: true, weeklyEligible: true, monthlyEligible: true, publiclyBookable: true, active: true, internalNote: 'Monthly-ready test space'
  } });
  const monthlyBody = await monthly.json();
  assert.equal(monthly.status, 200, JSON.stringify(monthlyBody));
  assert.equal(monthlyBody.item.monthly_eligible, true);
  const spotWhileDraftIsPrivate = (await pool.query('SELECT inventory_id,parking_use,public_bookable,classification_state,version FROM parking_spots WHERE id=$1', [first.parking_spot_id])).rows[0];
  assert.deepEqual(spotWhileDraftIsPrivate, spotBeforeDraftConfiguration, 'draft configuration must not mutate operational parking_spots');
  const internalized = await adminRequest(`/layouts/${draft.id}/spaces/${first.id}`, owner, { method: 'PATCH', body: {
    layoutVersion: monthlyBody.layoutVersion, version: monthlyBody.item.version, parkingPurpose: 'SHOP',
    dailyEligible: true, weeklyEligible: true, monthlyEligible: true, publiclyBookable: true,
    ratePlanId: configuredFirst.rate_plan_id, active: true, internalNote: ''
  } });
  const internalizedBody = await internalized.json();
  assert.equal(internalized.status, 200, JSON.stringify(internalizedBody));
  assert.deepEqual([
    internalizedBody.item.daily_eligible, internalizedBody.item.weekly_eligible, internalizedBody.item.monthly_eligible,
    internalizedBody.item.space_public_bookable, internalizedBody.item.rate_plan_id
  ], [false, false, false, false, null]);
  const restored = await adminRequest(`/layouts/${draft.id}/spaces/${first.id}`, owner, { method: 'PATCH', body: {
    layoutVersion: internalizedBody.layoutVersion, version: internalizedBody.item.version, spaceType: 'GENERAL_TRUCK',
    dailyEligible: true, weeklyEligible: true, monthlyEligible: true, publiclyBookable: true,
    ratePlanId: configuredFirst.rate_plan_id, active: true, internalNote: 'Monthly-ready test space'
  } });
  const restoredBody = await restored.json();
  assert.equal(restored.status, 200, JSON.stringify(restoredBody));
  const publishedResult = await adminRequest(`/layouts/${draft.id}/publish`, owner, {
    method: 'POST', body: { version: restoredBody.layoutVersion, physicalConfirmation: true }
  });
  const publishedBody = await publishedResult.json();
  assert.equal(publishedResult.status, 200, JSON.stringify(publishedBody));
  assert.equal(Number(publishedBody.published.elements.find(item => item.parking_spot_id === first.parking_spot_id).x), Number(first.x) + 1);
  assert.equal(publishedBody.published.elements.find(item => item.parking_spot_id === first.parking_spot_id).monthly_eligible, true);
  const spotAfterPublication = (await pool.query('SELECT version FROM parking_spots WHERE id=$1', [first.parking_spot_id])).rows[0];
  assert.ok(Number(spotAfterPublication.version) > Number(spotBeforeDraftConfiguration.version));
  const history = await pool.query("SELECT status FROM parking_lot_layouts WHERE location_id=$1 AND status='SUPERSEDED'", [locationId]);
  assert.ok(history.rowCount >= 1);
  const staffDenied = await adminRequest(`/layouts/${draft.id}/spaces/${first.id}`, staff, { method: 'PATCH', body: {
    layoutVersion: publishedBody.draft.version, version: publishedBody.draft.elements.find(item => item.parking_spot_id === first.parking_spot_id).version,
    parkingPurpose: 'CUSTOMER', dailyEligible: true, weeklyEligible: true, monthlyEligible: false, publiclyBookable: true, active: true, internalNote: ''
  } });
  assert.equal(staffDenied.status, 403);
});

test('per-space Daily and Monthly eligibility is explicit, draft-private, published atomically, and revalidated for quotes and assignment', async () => {
  const load = async () => (await (await adminRequest(`/locations/${locationId}/layout`, owner)).json()).draft;
  const patchSpace = async (label, changes) => {
    const draft = await load();
    const element = draft.elements.find(item => item.label === label);
    const response = await adminRequest(`/layouts/${draft.id}/spaces/${element.id}`, owner, { method: 'PATCH', body: {
      layoutVersion: draft.version, version: element.version, parkingSpotVersion: element.parking_spot_version, ...changes
    } });
    return { response, body: await response.json() };
  };
  const publish = async () => {
    const draft = await load();
    const response = await adminRequest(`/layouts/${draft.id}/publish`, owner, {
      method: 'POST', body: { version: draft.version, physicalConfirmation: true }
    });
    return { response, body: await response.json() };
  };
  const initial = await load();
  const planId = initial.elements.find(item => item.parking_spot_id && item.rate_plan_id)?.rate_plan_id;
  assert.ok(planId, 'The exact-space fixture requires an assigned General Truck rate plan.');

  // Establish a clean private draft matrix. Direct fixture preparation remains
  // confined to the draft and the API performs every behavior assertion below.
  await pool.query(`UPDATE parking_layout_elements SET daily_eligible=false,weekly_eligible=false,monthly_eligible=false,
    space_public_bookable=true,version=version+1 WHERE layout_id=$1 AND parking_spot_id IS NOT NULL`, [initial.id]);
  await pool.query('UPDATE parking_lot_layouts SET version=version+1 WHERE id=$1', [initial.id]);

  const dailyOnly = await patchSpace('N-01', { dailyEligible: true, monthlyEligible: false, ratePlanId: planId, publiclyBookable: true, active: true });
  assert.equal(dailyOnly.response.status, 200, JSON.stringify(dailyOnly.body));
  assert.deepEqual([dailyOnly.body.item.daily_eligible, dailyOnly.body.item.monthly_eligible], [true, false]);
  const monthlyOnly = await patchSpace('N-02', { dailyEligible: false, monthlyEligible: true, ratePlanId: planId, publiclyBookable: true, active: true });
  assert.equal(monthlyOnly.response.status, 200, JSON.stringify(monthlyOnly.body));
  assert.deepEqual([monthlyOnly.body.item.daily_eligible, monthlyOnly.body.item.monthly_eligible], [false, true]);
  const both = await patchSpace('N-03', { dailyEligible: true, monthlyEligible: true, ratePlanId: planId, publiclyBookable: true, active: true });
  assert.equal(both.response.status, 200, JSON.stringify(both.body));
  const neither = await patchSpace('N-04', { dailyEligible: false, monthlyEligible: false, ratePlanId: planId, publiclyBookable: true, active: true });
  assert.equal(neither.response.status, 200, JSON.stringify(neither.body));

  for (const [label, purpose] of [['N-05', 'SHOP'], ['N-06', 'COMPANY'], ['N-07', 'UNRESOLVED']]) {
    const internal = await patchSpace(label, { parkingPurpose: purpose, dailyEligible: true, monthlyEligible: true, ratePlanId: planId, publiclyBookable: true, active: true });
    assert.equal(internal.response.status, 200, JSON.stringify(internal.body));
    assert.equal(internal.body.item.parking_purpose, purpose);
    assert.deepEqual([internal.body.item.daily_eligible, internal.body.item.monthly_eligible, internal.body.item.space_public_bookable, internal.body.item.rate_plan_id], [false, false, false, null]);
    const restored = await patchSpace(label, { spaceType: 'GENERAL_TRUCK', active: true });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.deepEqual([restored.body.item.daily_eligible, restored.body.item.monthly_eligible, restored.body.item.space_public_bookable, restored.body.item.rate_plan_id], [false, false, false, null], 'returning to a customer classification must not auto-enable products');
  }
  const inactive = await patchSpace('N-08', { dailyEligible: true, monthlyEligible: true, ratePlanId: planId, publiclyBookable: true, active: false });
  assert.equal(inactive.response.status, 200, JSON.stringify(inactive.body));
  assert.deepEqual([inactive.body.item.daily_eligible, inactive.body.item.monthly_eligible, inactive.body.item.space_public_bookable, inactive.body.item.rate_plan_id], [false, false, false, null]);
  await patchSpace('N-08', { spaceType: 'GENERAL_TRUCK', active: true });

  const generalCategory = (await pool.query('SELECT category_id FROM parking_inventory WHERE id=$1', [inventoryId])).rows[0].category_id;
  const missingDailyPlan = (await pool.query(`INSERT INTO parking_rate_rules
    (location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,priority,active)
    VALUES($1,$2,$3,'Missing Daily test plan',NULL,NULL,45000,100,true) RETURNING *`,
  [locationId, zoneId, generalCategory])).rows[0];
  const invalidDaily = await patchSpace('N-04', { dailyEligible: true, monthlyEligible: false, ratePlanId: missingDailyPlan.id, publiclyBookable: true, active: true });
  assert.equal(invalidDaily.response.status, 400);
  assert.equal(invalidDaily.body.error.code, 'DAILY_RATE_REQUIRED');
  const missingMonthlyPlan = (await pool.query(`INSERT INTO parking_rate_rules
    (location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,priority,active)
    VALUES($1,$2,$3,'Missing Monthly test plan',2500,NULL,NULL,101,true) RETURNING *`,
  [locationId, zoneId, generalCategory])).rows[0];
  const invalidMonthly = await patchSpace('N-04', { dailyEligible: false, monthlyEligible: true, ratePlanId: missingMonthlyPlan.id, publiclyBookable: true, active: true });
  assert.equal(invalidMonthly.response.status, 400);
  assert.equal(invalidMonthly.body.error.code, 'MONTHLY_RATE_REQUIRED');
  const incompatibleRate = await adminRequest('/rates', owner, { method: 'POST', body: {
    location_id: locationId, zone_id: zoneId, category_id: otherCategoryId, daily_rate_cents: 1200,
    weekly_rate_cents: null, monthly_rate_cents: 22000, fee_cents: 0, tax_basis_points: 0, priority: 0, active: true
  } });
  const incompatiblePlan = (await incompatibleRate.json()).item;
  const incompatible = await patchSpace('N-04', { dailyEligible: true, monthlyEligible: false, ratePlanId: incompatiblePlan.id, publiclyBookable: true, active: true });
  assert.equal(incompatible.response.status, 400);

  const dailyBefore = await availabilityFor('TRACTOR_TRAILER', { arrivalLocal: '2032-05-20T09:00', departureLocal: '2032-05-20T12:00' });
  const monthlyInterval = { arrivalLocal: '2032-06-01T09:00', departureLocal: '2032-07-01T09:00' };
  const monthlyBefore = await availabilityFor('TRACTOR_TRAILER', monthlyInterval);
  assert.equal(dailyBefore.numberedSpacesAvailable, 15);
  assert.equal(monthlyBefore.numberedSpacesAvailable, 15);

  const firstPublication = await publish();
  assert.equal(firstPublication.response.status, 200, JSON.stringify(firstPublication.body));
  const dailyPublished = await availabilityFor('TRACTOR_TRAILER', { arrivalLocal: '2032-05-20T09:00', departureLocal: '2032-05-20T12:00' });
  const monthlyPublished = await availabilityFor('TRACTOR_TRAILER', monthlyInterval);
  assert.equal(dailyPublished.numberedSpacesAvailable, 2);
  assert.equal(monthlyPublished.numberedSpacesAvailable, 2);
  assert.deepEqual(dailyPublished.offeredDurations.map(item => item.code).sort(), ['DAILY', 'MONTHLY']);
  const dailyMap = new Map(dailyPublished ? (await publicRequest('/availability', {
    parkingAreaId: publicAreaId, categoryCode: 'TRACTOR_TRAILER', arrivalLocal: '2032-05-20T09:00', departureLocal: '2032-05-20T12:00'
  })).body.layout.elements.filter(item => item.space).map(item => [item.label, item.space.available]) : []);
  assert.deepEqual([dailyMap.get('N-01'), dailyMap.get('N-02'), dailyMap.get('N-03'), dailyMap.get('N-04')], [true, false, true, false]);

  const quotePayload = bookingPayload(70, { arrivalLocal: '2032-05-20T09:00', departureLocal: '2032-05-20T12:00' });
  const quoted = await publicRequest('/quotes', quotePayload);
  assert.equal(quoted.response.status, 200, JSON.stringify(quoted.body));
  const changed = await patchSpace('N-01', { dailyEligible: false, monthlyEligible: false, ratePlanId: planId, publiclyBookable: true, active: true });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  const secondPublication = await publish();
  assert.equal(secondPublication.response.status, 200, JSON.stringify(secondPublication.body));
  const staleBooking = await publicRequest('/bookings', {
    ...quotePayload, quoteToken: quoted.body.quoteToken, termsVersion: quoted.body.terms.version
  }, 'eligibility-stale-quote-000070');
  assert.equal(staleBooking.response.status, 409);
  assert.equal(staleBooking.body.error.code, 'QUOTE_STALE');

  const dailyBooking = await publicRequest('/bookings', bookingPayload(71, { arrivalLocal: '2032-05-21T09:00', departureLocal: '2032-05-21T12:00' }), 'eligibility-daily-assign-000071');
  assert.equal(dailyBooking.response.status, 201, JSON.stringify(dailyBooking.body));
  assert.equal(dailyBooking.body.booking.assignedSpotLabel, 'N-03');
  const monthlyBooking = await publicRequest('/bookings', bookingPayload(72, monthlyInterval), 'eligibility-monthly-assign-000072');
  assert.equal(monthlyBooking.response.status, 201, JSON.stringify(monthlyBooking.body));
  assert.equal(monthlyBooking.body.booking.assignedSpotLabel, 'N-02');
  for (const created of [dailyBooking, monthlyBooking]) {
    const cancelled = await publicRequest(`/bookings/${created.body.booking.publicToken}/cancel`, {
      lookupCredential: created.body.booking.lookupCredential, reason: 'Eligibility matrix cleanup'
    });
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  }

  const restore = await load();
  await pool.query(`UPDATE parking_layout_elements SET daily_eligible=true,weekly_eligible=true,monthly_eligible=true,
    space_public_bookable=true,active=true,rate_plan_id=$2,version=version+1
    WHERE layout_id=$1 AND parking_spot_id IS NOT NULL`, [restore.id, planId]);
  await pool.query('UPDATE parking_lot_layouts SET version=version+1 WHERE id=$1', [restore.id]);
  const restoredPublication = await publish();
  assert.equal(restoredPublication.response.status, 200, JSON.stringify(restoredPublication.body));
});

test('published exact General Truck spaces drive public capacity and exclude ineligible spaces', async () => {
  const baseline = await availabilityFor();
  assert.equal(baseline.assignmentMode, 'EXACT_SPOT');
  assert.equal(baseline.available, true);
  assert.equal(baseline.numberedSpacesAvailable, 15);
  assert.equal(await dashboardAvailableForInventory(), 15);
  const filteredLiveLot = await adminRequest(`/locations/${locationId}/live-lot?zoneId=${zoneId}&categoryCode=TRACTOR_TRAILER`, owner);
  assert.equal(filteredLiveLot.status, 200);
  const filteredLiveLotBody = await filteredLiveLot.json();
  assert.equal(filteredLiveLotBody.summary.AVAILABLE, baseline.numberedSpacesAvailable);
  assert.ok(filteredLiveLotBody.spots.every(spot => spot.zone_id === zoneId && spot.category_code === 'TRACTOR_TRAILER'));

  await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,visual_element_key)
    VALUES($1,$2,$3,'N-UNPUBLISHED','le_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`, [locationId, zoneId, inventoryId]);
  assert.equal((await availabilityFor()).numberedSpacesAvailable, 15);
  assert.equal(await dashboardAvailableForInventory(), 15);

  await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,99,'Numbered Bobtail parking',true)`, [zoneId, otherCategoryId]);
  const otherCategory = await availabilityFor('BOBTAIL');
  assert.equal(otherCategory.available, false);
  assert.equal(otherCategory.numberedSpacesAvailable, 0);

  await pool.query("UPDATE parking_spots SET active=false WHERE location_id=$1 AND public_label='N-14'", [locationId]);
  assert.equal((await availabilityFor()).numberedSpacesAvailable, 14);
  assert.equal(await dashboardAvailableForInventory(), 14);

  const blocked = (await pool.query("SELECT id FROM parking_spots WHERE location_id=$1 AND public_label='N-15'", [locationId])).rows[0];
  const block = await adminRequest(`/spots/${blocked.id}/block`, owner, { method: 'POST', body: {
    startsAt: '2032-05-11T00:00:00.000Z', endsAt: '2032-05-12T00:00:00.000Z', reason: 'Capacity verification'
  } });
  assert.equal(block.status, 201, JSON.stringify(await block.json()));
  assert.equal((await availabilityFor('TRACTOR_TRAILER', {
    arrivalLocal: '2032-05-11T09:00', departureLocal: '2032-05-11T12:00'
  })).numberedSpacesAvailable, 13);

  const ownerId = (await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [ownerName])).rows[0].id;
  await pool.query(`INSERT INTO parking_spot_blocks(parking_spot_id,starts_at,ends_at,reason,created_by_admin_user_id)
    SELECT id,'2032-05-16T00:00:00.000Z','2032-05-17T00:00:00.000Z','Zero capacity verification',$2
    FROM parking_spots WHERE location_id=$1 AND active`, [locationId, ownerId]);
  const zeroEligible = await availabilityFor('TRACTOR_TRAILER', {
    arrivalLocal: '2032-05-16T09:00', departureLocal: '2032-05-16T12:00'
  });
  assert.equal(zeroEligible.available, false);
  assert.equal(zeroEligible.numberedSpacesAvailable, 0);
});

test('exact booking assigns one deterministic spot and idempotent replay returns it', async () => {
  const payload = bookingPayload(1);
  const key = 'exact-idempotency-000000000001';
  const created = await publicRequest('/bookings', payload, key);
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.booking.assignedSpotLabel, 'N-01');
  assert.equal(created.body.booking.assignmentMode, 'EXACT_SPOT');
  assert.equal(created.body.booking.map.elements.filter(item => item.assigned).length, 1);
  assert.equal(created.body.booking.map.route.area, 'North General Truck Area');
  assert.equal(created.body.booking.map.route.arrivalRouteElementKeys.length, 2);
  assert.equal(created.body.booking.map.route.exitRouteElementKeys.length, 2);
  const replay = await publicRequest('/bookings', payload, key);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.booking.assignedSpotLabel, 'N-01');
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM parking_bookings WHERE idempotency_hash IS NOT NULL AND email=$1) bookings,
    (SELECT count(*)::int FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id WHERE b.email=$1) assignments`, [payload.email]);
  assert.equal(counts.rows[0].bookings, 1);
  assert.equal(counts.rows[0].assignments, 1);
  assert.equal((await availabilityFor()).numberedSpacesAvailable, 13);
});

test('reassignment preserves history and secure lookup immediately shows the replacement', async () => {
  const created = await publicRequest('/bookings', bookingPayload(2, { arrivalLocal: '2032-05-11T09:00', departureLocal: '2032-05-11T12:00' }), 'exact-reassign-00000000000002');
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const booking = created.body.booking;
  const row = (await pool.query('SELECT id,version FROM parking_bookings WHERE reservation_number=$1', [booking.reservationNumber])).rows[0];
  const alternatives = await adminRequest(`/bookings/${row.id}/spot-alternatives`, staff);
  const alternativesBody = await alternatives.json();
  assert.ok(alternativesBody.alternatives.length);
  const reassigned = await adminRequest(`/bookings/${row.id}/reassign-spot`, staff, { method: 'POST', body: {
    spotId: alternativesBody.alternatives[0].id, reason: 'Move for safe operations', version: row.version
  } });
  const reassignedBody = await reassigned.json();
  assert.equal(reassigned.status, 200, JSON.stringify(reassignedBody));
  assert.notEqual(reassignedBody.assignedSpace, booking.assignedSpotLabel);
  const history = await pool.query('SELECT * FROM reservation_spot_assignments WHERE booking_id=$1 ORDER BY id', [row.id]);
  assert.equal(history.rowCount, 2);
  assert.ok(history.rows[0].released_at);
  assert.equal(String(history.rows[1].previous_assignment_id), String(history.rows[0].id));
  const lookup = await publicRequest('/bookings/lookup', { reservationNumber: booking.reservationNumber, lookupCredential: booking.lookupCredential });
  assert.equal(lookup.body.booking.assignedSpotLabel, reassignedBody.assignedSpace);
});

test('secure customer check-in and check-out are eligible, idempotent, and immediately reflected in Live Lot', async () => {
  const interval = { arrivalLocal: localInput(new Date(Date.now() + 3600000)), departureLocal: localInput(new Date(Date.now() + 7200000)) };
  const created = await publicRequest('/bookings', bookingPayload(3, interval), 'exact-self-service-0000000003');
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const booking = created.body.booking;
  const bad = await publicRequest(`/bookings/${booking.publicToken}/check-in`, { lookupCredential: 'invalid' });
  assert.equal(bad.response.status, 404);
  const checkIn = await publicRequest(`/bookings/${booking.publicToken}/check-in`, { lookupCredential: booking.lookupCredential });
  assert.equal(checkIn.response.status, 200, JSON.stringify(checkIn.body));
  assert.equal(checkIn.body.booking.status, 'CHECKED_IN');
  const repeatCheckIn = await publicRequest(`/bookings/${booking.publicToken}/check-in`, { lookupCredential: booking.lookupCredential });
  assert.equal(repeatCheckIn.body.idempotent, true);
  const live = await adminRequest(`/locations/${locationId}/live-lot`, staff);
  assert.equal((await live.json()).summary.OCCUPIED, 1);
  const checkOut = await publicRequest(`/bookings/${booking.publicToken}/check-out`, { lookupCredential: booking.lookupCredential });
  assert.equal(checkOut.response.status, 200, JSON.stringify(checkOut.body));
  assert.equal(checkOut.body.booking.status, 'CHECKED_OUT');
  const repeatCheckOut = await publicRequest(`/bookings/${booking.publicToken}/check-out`, { lookupCredential: booking.lookupCredential });
  assert.equal(repeatCheckOut.body.idempotent, true);
  const row = (await pool.query('SELECT id FROM parking_bookings WHERE reservation_number=$1', [booking.reservationNumber])).rows[0];
  const history = await pool.query("SELECT actor_type,new_status FROM parking_booking_status_history WHERE booking_id=$1 AND new_status IN ('CHECKED_IN','CHECKED_OUT') ORDER BY version", [row.id]);
  assert.deepEqual(history.rows, [{ actor_type: 'CUSTOMER', new_status: 'CHECKED_IN' }, { actor_type: 'CUSTOMER', new_status: 'CHECKED_OUT' }]);
  const assignment = (await pool.query('SELECT actual_check_in_at,actual_check_out_at,released_at FROM reservation_spot_assignments WHERE booking_id=$1 ORDER BY id DESC LIMIT 1', [row.id])).rows[0];
  assert.ok(assignment.actual_check_in_at);
  assert.ok(assignment.actual_check_out_at);
  assert.ok(assignment.released_at, 'A checked-out customer must release the exact space for a later reservation.');
});

test('blocking prevents assignment, cancellation releases, and STAFF cannot mutate permanent setup', async () => {
  const spots = await adminRequest(`/locations/${locationId}/spots`, owner);
  const items = (await spots.json()).items;
  const target = items.find(item => item.public_label === 'N-15');
  const block = await adminRequest(`/spots/${target.id}/block`, owner, { method: 'POST', body: {
    startsAt: '2032-05-12T00:00:00.000Z', endsAt: '2032-05-13T00:00:00.000Z', reason: 'Surface repair'
  } });
  assert.equal(block.status, 201, JSON.stringify(await block.json()));
  const created = await publicRequest('/bookings', bookingPayload(4, { arrivalLocal: '2032-05-12T09:00', departureLocal: '2032-05-12T12:00' }), 'exact-block-cancel-0000000004');
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.notEqual(created.body.booking.assignedSpotLabel, 'N-15');
  const cancel = await publicRequest(`/bookings/${created.body.booking.publicToken}/cancel`, {
    lookupCredential: created.body.booking.lookupCredential, reason: 'Test cancellation'
  });
  assert.equal(cancel.response.status, 200);
  const booking = (await pool.query('SELECT id,assigned_spot_label FROM parking_bookings WHERE reservation_number=$1', [created.body.booking.reservationNumber])).rows[0];
  assert.equal(booking.assigned_spot_label, null);
  assert.ok((await pool.query('SELECT released_at FROM reservation_spot_assignments WHERE booking_id=$1', [booking.id])).rows[0].released_at);
  const staffPatch = await adminRequest(`/spots/${target.id}`, staff, { method: 'PATCH', body: { version: target.version, active: false } });
  assert.equal(staffPatch.status, 403);
  const staffPublish = await adminRequest(`/layouts/${draftId}/publish`, staff, { method: 'POST', body: { version: draftVersion } });
  assert.equal(staffPublish.status, 403);
});

test('one remaining compatible spot allows exactly one of two concurrent overlapping bookings', async () => {
  const spots = (await pool.query('SELECT id,public_label FROM parking_spots WHERE location_id=$1 AND active ORDER BY public_label', [locationId])).rows;
  const keep = spots[0];
  const ownerId = (await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [ownerName])).rows[0].id;
  for (const spot of spots.slice(1)) {
    await pool.query(`INSERT INTO parking_spot_blocks(parking_spot_id,starts_at,ends_at,reason,created_by_admin_user_id)
      VALUES($1,'2032-05-14T00:00:00.000Z','2032-05-15T00:00:00.000Z','Concurrency isolation',$2)`, [spot.id, ownerId]);
  }
  const interval = { arrivalLocal: '2032-05-14T09:00', departureLocal: '2032-05-14T12:00' };
  const [first, second] = await Promise.all([
    publicRequest('/bookings', bookingPayload(50, interval), 'exact-concurrency-000000000050'),
    publicRequest('/bookings', bookingPayload(51, interval), 'exact-concurrency-000000000051')
  ]);
  const results = [first, second];
  assert.equal(results.filter(item => item.response.status === 201).length, 1);
  assert.equal(results.filter(item => item.body.error?.code === 'NO_EXACT_SPOT_AVAILABLE').length, 1);
  const assignment = await pool.query(`SELECT a.*,s.public_label FROM reservation_spot_assignments a
    JOIN parking_spots s ON s.id=a.parking_spot_id JOIN parking_bookings b ON b.id=a.booking_id
    WHERE b.arrival_at='2032-05-14T14:00:00.000Z' AND b.location_id=$1 AND a.released_at IS NULL`, [locationId]);
  assert.equal(assignment.rowCount, 1);
  assert.equal(assignment.rows[0].public_label, keep.public_label);
});

test('Live Lot operational read APIs are staff-readable, scoped, and return bounded map data', async () => {
  const at = new Date().toISOString();
  const ownerSnapshot = await adminRequest(`/locations/${locationId}/live-lot/snapshot?at=${encodeURIComponent(at)}`, owner);
  const ownerBody = await ownerSnapshot.json();
  assert.equal(ownerSnapshot.status, 200, JSON.stringify(ownerBody));
  assert.equal(ownerBody.location.id, Number(locationId));
  assert.ok(Array.isArray(ownerBody.spaces));
  assert.ok(ownerBody.spaces.every(spot => typeof spot.operationalStatus === 'string' && Array.isArray(spot.vehicleEligibility)));
  assert.ok(ownerBody.layout?.elements?.length);
  const staffSnapshot = await adminRequest(`/locations/${locationId}/live-lot/snapshot?availableOnly=true`, staff);
  assert.equal(staffSnapshot.status, 200, JSON.stringify(await staffSnapshot.json()));
  const space = ownerBody.spaces.find(item => item.number === 'N-01');
  const detail = await adminRequest(`/spaces/${space.id}/operational-detail?at=${encodeURIComponent(at)}`, staff);
  const detailBody = await detail.json();
  assert.equal(detail.status, 200, JSON.stringify(detailBody));
  assert.equal(detailBody.id, space.id);
  assert.ok(detailBody.actions);
  const from = new Date().toISOString(); const to = new Date(Date.now() + 86400000).toISOString();
  const line = await adminRequest(`/spaces/${space.id}/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, staff);
  const lineBody = await line.json();
  assert.equal(line.status, 200, JSON.stringify(lineBody));
  assert.equal(lineBody.intervalConvention, '[start,end)');
  assert.ok(lineBody.intervals.every(item => new Date(item.endsAt) > new Date(item.startsAt)));
  const search = await adminRequest(`/operational-search?locationId=${locationId}&q=N-`, staff);
  const searchBody = await search.json();
  assert.equal(search.status, 200, JSON.stringify(searchBody));
  assert.ok(searchBody.spaces.some(item => item.number === 'N-01'));
  const unauthenticated = await fetch(`${base}/api/admin/parking/v1/locations/${locationId}/live-lot/snapshot`);
  assert.equal(unauthenticated.status, 401);
});

test('canonical maintenance lock allows saved operational publication and blocks structural publication', async () => {
  await pool.query("UPDATE parking_spots SET active=false WHERE location_id=$1 AND public_label='N-UNPUBLISHED'", [locationId]);
  const initialResponse = await adminRequest(`/locations/${locationId}/layout`, owner);
  const initial = await initialResponse.json();
  assert.equal(initialResponse.status, 200, JSON.stringify(initial));
  const historical = (await pool.query("SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='SUPERSEDED' ORDER BY id LIMIT 1", [locationId])).rows[0];
  assert.ok(historical, 'The fixture requires an immutable historical layout.');
  const markerClient = await pool.connect();
  try {
    await markerClient.query('BEGIN');
    await markerClient.query("SELECT set_config('parking.layout_publication','on',true)");
    await markerClient.query("UPDATE parking_lot_layouts SET name='Trucker Heaven physical lot · publication permission test' WHERE id=$1", [historical.id]);
    await markerClient.query('COMMIT');
  } catch (error) {
    await markerClient.query('ROLLBACK');
    throw error;
  } finally { markerClient.release(); }

  const lockedResponse = await adminRequest(`/locations/${locationId}/layout`, owner);
  const locked = await lockedResponse.json();
  assert.equal(locked.canonicalMaintenanceLocked, true);
  const target = locked.draft.elements.find(item => item.parking_spot_id && item.parking_purpose === 'CUSTOMER' && item.rate_plan_id);
  assert.ok(target, 'The fixture requires a configured customer space.');
  const configured = await adminRequest(`/layouts/${locked.draft.id}/spaces/${target.id}`, owner, { method: 'PATCH', body: {
    layoutVersion: locked.draft.version, version: target.version, parkingSpotVersion: target.parking_spot_version,
    monthlyEligible: !target.monthly_eligible
  } });
  const configuredBody = await configured.json();
  assert.equal(configured.status, 200, JSON.stringify(configuredBody));

  const operationalChecklistResponse = await adminRequest(`/locations/${locationId}/setup-checklist?layoutId=${locked.draft.id}`, owner);
  const operationalChecklist = await operationalChecklistResponse.json();
  assert.equal(operationalChecklistResponse.status, 200, JSON.stringify(operationalChecklist));
  assert.deepEqual(operationalChecklist.publication, { maintenanceLocked: true, structuralChanges: false, operationalOnly: true });
  assert.equal(operationalChecklist.checks.find(item => item.code === 'STRUCTURAL_MAINTENANCE_WINDOW').passed, true);

  const publishedResponse = await adminRequest(`/layouts/${locked.draft.id}/publish`, owner, { method: 'POST', body: {
    version: configuredBody.layoutVersion, physicalConfirmation: true
  } });
  const published = await publishedResponse.json();
  assert.equal(publishedResponse.status, 200, JSON.stringify(published));
  assert.equal(published.published.elements.find(item => item.parking_spot_id === target.parking_spot_id).monthly_eligible, !target.monthly_eligible);

  const structuralTarget = published.draft.elements.find(item => item.parking_spot_id);
  await pool.query('UPDATE parking_layout_elements SET x=x+0.25,version=version+1 WHERE id=$1', [structuralTarget.id]);
  const updatedDraft = (await pool.query('UPDATE parking_lot_layouts SET version=version+1 WHERE id=$1 RETURNING version', [published.draft.id])).rows[0];
  const structuralChecklistResponse = await adminRequest(`/locations/${locationId}/setup-checklist?layoutId=${published.draft.id}`, owner);
  const structuralChecklist = await structuralChecklistResponse.json();
  assert.equal(structuralChecklist.publication.structuralChanges, true);
  assert.equal(structuralChecklist.checks.find(item => item.code === 'STRUCTURAL_MAINTENANCE_WINDOW').passed, false);
  const denied = await adminRequest(`/layouts/${published.draft.id}/publish`, owner, { method: 'POST', body: {
    version: updatedDraft.version, physicalConfirmation: true
  } });
  const deniedBody = await denied.json();
  assert.equal(denied.status, 423, JSON.stringify(deniedBody));
  assert.equal(deniedBody.error.code, 'CANONICAL_LAYOUT_LOCKED');
});

test('publication protects future assignments while allowing harmless and historical changes', async () => {
  process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE = 'true';
  const layoutResponse = await adminRequest(`/locations/${locationId}/layout`, owner);
  let layout = (await layoutResponse.json()).draft;
  const target = layout.elements.find(item => item.parking_spot_id && item.label === 'N-09');
  assert.ok(target, 'The publication-conflict fixture requires N-09.');
  await pool.query('UPDATE reservation_spot_assignments SET released_at=COALESCE(released_at,now()),release_reason=COALESCE(release_reason,$2) WHERE parking_spot_id=$1 AND released_at IS NULL',
    [target.parking_spot_id, 'Publication conflict fixture reset']);

  const plans = await pool.query(`SELECT plan.id,category.code FROM parking_rate_rules plan
    JOIN parking_categories category ON category.id=plan.category_id
    WHERE plan.location_id=$1 AND plan.zone_id=$2 AND plan.active
      AND category.code IN ('BOBTAIL','TRACTOR_TRAILER') AND plan.daily_rate_cents IS NOT NULL
    ORDER BY plan.priority,plan.id`, [locationId, zoneId]);
  const planByCode = Object.fromEntries(plans.rows.map(item => [item.code, item.id]));
  assert.ok(planByCode.BOBTAIL && planByCode.TRACTOR_TRAILER);

  async function reloadTarget() {
    const response = await adminRequest(`/locations/${locationId}/layout`, owner);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    layout = body.draft;
    return layout.elements.find(item => item.parking_spot_id === target.parking_spot_id);
  }

  async function configure(changes) {
    const current = await reloadTarget();
    const spot = (await pool.query('SELECT version FROM parking_spots WHERE id=$1', [target.parking_spot_id])).rows[0];
    const response = await adminRequest(`/layouts/${layout.id}/spaces/${current.id}`, owner, { method: 'PATCH', body: {
      layoutVersion: layout.version, version: current.version, parkingSpotVersion: spot.version, ...changes
    } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }

  async function publishExpected(status) {
    const current = await reloadTarget();
    const before = (await pool.query("SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'", [locationId])).rows[0].id;
    const spotBefore = (await pool.query('SELECT inventory_id,parking_use,public_bookable,active,version FROM parking_spots WHERE id=$1', [target.parking_spot_id])).rows[0];
    const response = await adminRequest(`/layouts/${layout.id}/publish`, owner, { method: 'POST', body: {
      version: layout.version, physicalConfirmation: true
    } });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    if (status === 409) {
      assert.equal(body.error.code, 'ACTIVE_ASSIGNMENT_CONFLICT');
      assert.ok(body.error.details.spaces.some(item => item.space === 'N-09' && item.reservationNumber));
      assert.equal((await pool.query("SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'", [locationId])).rows[0].id, before);
      assert.deepEqual((await pool.query('SELECT inventory_id,parking_use,public_bookable,active,version FROM parking_spots WHERE id=$1', [target.parking_spot_id])).rows[0], spotBefore);
    }
    return { body, current };
  }

  // Establish a published Bobtail space, then attach a future Bobtail reservation.
  await configure({ spaceType: 'BOBTAIL', dailyEligible: true, monthlyEligible: false,
    ratePlanId: planByCode.BOBTAIL, publiclyBookable: true, active: true });
  await publishExpected(200);
  const bobtailInventory = (await pool.query(`SELECT i.id,i.category_id FROM parking_inventory i
    JOIN parking_categories c ON c.id=i.category_id WHERE i.zone_id=$1 AND c.code='BOBTAIL'`, [zoneId])).rows[0];
  const booking = (await pool.query(`INSERT INTO parking_bookings(
      reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
      arrival_at,departure_at,first_name,last_name,mobile_phone,email,tractor_unit_number,license_plate,
      license_plate_state,terms_accepted_at,cancellation_terms_accepted_at)
    VALUES($1,$2,'fixture-hash',$3,$4,$5,'CONFIRMED','2035-05-10T14:00:00Z','2035-05-10T18:00:00Z',
      'Publication','Fixture','+16155550000','publication.fixture@example.test','PUB-1','PUB1','TN',now(),now()) RETURNING *`,
  [`TH-PUBLISH-${Date.now()}`, `publish-token-${Date.now()}`, bobtailInventory.id, locationId, bobtailInventory.category_id])).rows[0];
  await pool.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
    VALUES($1,'CONFIRMED','SYSTEM','Synthetic publication conflict fixture',1)`, [booking.id]);
  const assignment = (await pool.query(`INSERT INTO reservation_spot_assignments(
      booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source)
    VALUES($1,$2,$3,$4,$4,'SYSTEM') RETURNING *`,
  [booking.id, target.parking_spot_id, booking.arrival_at, booking.departure_at])).rows[0];

  await configure({ spaceType: 'GENERAL_TRUCK', dailyEligible: true, monthlyEligible: false,
    ratePlanId: planByCode.TRACTOR_TRAILER, publiclyBookable: true, active: true });
  const categoryConflict = await publishExpected(409);
  assert.ok(categoryConflict.body.error.details.spaces[0].reasons.includes('INVENTORY_CHANGED'));

  await configure({ spaceType: 'BOBTAIL', dailyEligible: true, monthlyEligible: false,
    ratePlanId: planByCode.BOBTAIL, publiclyBookable: true, active: true, internalNote: 'Harmless presentation-only note' });
  await publishExpected(200);

  await configure({ spaceType: 'SHOP', active: true });
  const purposeConflict = await publishExpected(409);
  assert.ok(purposeConflict.body.error.details.spaces[0].reasons.includes('PURPOSE_CHANGED'));

  await configure({ spaceType: 'BOBTAIL', dailyEligible: true, monthlyEligible: false,
    ratePlanId: planByCode.BOBTAIL, publiclyBookable: true, active: false });
  const inactiveConflict = await publishExpected(409);
  assert.ok(inactiveConflict.body.error.details.spaces[0].reasons.includes('SPACE_INACTIVE'));

  const completion = await pool.connect();
  try {
    await completion.query('BEGIN');
    await completion.query(`UPDATE reservation_spot_assignments SET released_at=now(),release_reason='Fixture completed'
      WHERE id=$1`, [assignment.id]);
    await completion.query(`UPDATE parking_bookings SET status='COMPLETED',assigned_zone_id=NULL,assigned_spot_label=NULL,version=version+1 WHERE id=$1`, [booking.id]);
    await completion.query(`INSERT INTO parking_booking_status_history(booking_id,previous_status,new_status,actor_type,reason,version)
      VALUES($1,'CONFIRMED','COMPLETED','SYSTEM','Synthetic fixture completed',2)`, [booking.id]);
    await completion.query('COMMIT');
  } catch (error) {
    await completion.query('ROLLBACK');
    throw error;
  } finally { completion.release(); }
  await publishExpected(200);
  delete process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE;
});

test('concurrent exact booking serializes before incompatible publication', async () => {
  process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE = 'true';
  const load = async () => (await (await adminRequest(`/locations/${locationId}/layout`, owner)).json()).draft;
  const configure = async changes => {
    const layout = await load();
    const element = layout.elements.find(item => item.label === 'N-09');
    const spot = (await pool.query('SELECT version FROM parking_spots WHERE id=$1', [element.parking_spot_id])).rows[0];
    const response = await adminRequest(`/layouts/${layout.id}/spaces/${element.id}`, owner, { method: 'PATCH', body: {
      layoutVersion: layout.version, version: element.version, parkingSpotVersion: spot.version, ...changes
    } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const publish = async () => {
    const layout = await load();
    const response = await adminRequest(`/layouts/${layout.id}/publish`, owner, { method: 'POST', body: {
      version: layout.version, physicalConfirmation: true
    } });
    return { response, body: await response.json() };
  };
  const plans = await pool.query(`SELECT plan.id,category.code FROM parking_rate_rules plan
    JOIN parking_categories category ON category.id=plan.category_id
    WHERE plan.location_id=$1 AND plan.zone_id=$2 AND plan.active
      AND category.code IN ('BOBTAIL','TRACTOR_TRAILER') AND plan.daily_rate_cents IS NOT NULL
    ORDER BY plan.priority,plan.id`, [locationId, zoneId]);
  const planByCode = Object.fromEntries(plans.rows.map(item => [item.code, item.id]));

  try {
    await configure({ spaceType: 'BOBTAIL', dailyEligible: true, monthlyEligible: false,
      ratePlanId: planByCode.BOBTAIL, publiclyBookable: true, active: true });
    const compatible = await publish();
    assert.equal(compatible.response.status, 200, JSON.stringify(compatible.body));
    await configure({ spaceType: 'GENERAL_TRUCK', dailyEligible: true, monthlyEligible: false,
      ratePlanId: planByCode.TRACTOR_TRAILER, publiclyBookable: true, active: true });

    const bobtailInventory = (await pool.query(`SELECT i.id FROM parking_inventory i
      JOIN parking_categories category ON category.id=i.category_id
      WHERE i.zone_id=$1 AND category.code='BOBTAIL'`, [zoneId])).rows[0];
    const blocker = await pool.connect();
    let bookingPromise;
    let publicationPromise;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1::bigint)', [bobtailInventory.id]);
      bookingPromise = publicRequest('/bookings', {
        ...bookingPayload(90, { arrivalLocal: '2036-05-10T09:00', departureLocal: '2036-05-10T12:00' }),
        categoryCode: 'BOBTAIL'
      }, 'exact-publication-race-0000000090');
      await waitForAdvisoryWaiters(1);
      publicationPromise = publish();
      await waitForAdvisoryWaiters(2);
      await blocker.query('COMMIT');
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { blocker.release(); }

    const [booked, rejected] = await Promise.all([bookingPromise, publicationPromise]);
    assert.equal(booked.response.status, 201, JSON.stringify(booked.body));
    assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'ACTIVE_ASSIGNMENT_CONFLICT');
    const committed = (await pool.query(`SELECT booking.inventory_id booking_inventory,spot.inventory_id spot_inventory,
        assignment.released_at,layout_element.inventory_id published_inventory
      FROM parking_bookings booking
      JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
      JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
      JOIN parking_lot_layouts layout ON layout.location_id=booking.location_id AND layout.status='PUBLISHED'
      JOIN parking_layout_elements layout_element ON layout_element.layout_id=layout.id AND layout_element.parking_spot_id=spot.id
      WHERE booking.reservation_number=$1`, [booked.body.booking.reservationNumber])).rows[0];
    assert.ok(committed);
    assert.equal(String(committed.booking_inventory), String(committed.spot_inventory));
    assert.equal(String(committed.booking_inventory), String(committed.published_inventory));
    assert.equal(committed.released_at, null);
  } finally {
    delete process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE;
  }
});
