const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');
const { publishDraftSnapshot, protectAssignedSpaces } = require('../services/layoutPublication');
const { areaCapacityMetrics } = require('../services/parkingService');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing area-capacity PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

const password = 'ParkingOps-area-capacity-test-2034';
const ownerName = 'area-capacity-test-owner';
const runNonce = crypto.randomBytes(6).toString('hex');
const idempotency = label => `${label}-${runNonce}`;
const interval = { arrivalLocal: '2034-06-10T09:00', departureLocal: '2034-06-10T12:00' };
let server;
let base;
let owner;
let ownerSession;
let location;
let zone;
let inventory;
let ratePlan;
let draft;
let published;
let category;
let customerSpots;

const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;

function localInput(date, timezone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

async function publicRequest(path, body, idempotencyKey = '') {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function adminRequest(path, { method = 'GET', body } = {}) {
  const headers = { cookie: ownerSession.cookie };
  if (method !== 'GET') headers['x-csrf-token'] = ownerSession.csrfToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}/api/admin/parking/v1${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

function bookingPayload(index, overrides = {}) {
  return {
    parkingAreaId: zone.public_id,
    categoryCode: category.code,
    duration: 'DAILY',
    ...interval,
    firstName: 'Area', lastName: `Driver ${index}`,
    mobilePhone: `+1615555${String(3000 + index)}`,
    email: `area.driver.${index}@example.test`, companyName: 'Area Capacity Test',
    tractorUnitNumber: `AREA-${index}`, licensePlate: `AR${index}`, licensePlateState: 'TN',
    termsAccepted: true, cancellationTermsAccepted: true,
    ...overrides
  };
}

async function availability(overrides = {}) {
  const result = await publicRequest('/availability', {
    parkingAreaId: zone.public_id, categoryCode: category.code, duration: 'DAILY', ...interval, ...overrides
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.results.length, 1, JSON.stringify(result.body));
  return result.body.results[0];
}

async function setMode(mode) {
  const current = (await pool.query('SELECT version FROM parking_locations WHERE id=$1', [location.id])).rows[0];
  const response = await adminRequest(`/locations/${location.id}`, {
    method: 'PATCH', body: { version: current.version, assignment_mode: mode }
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.item;
}

async function cancel(booking) {
  return publicRequest(`/bookings/${booking.publicToken}/cancel`, {
    lookupCredential: booking.lookupCredential, reason: 'Area-capacity integration cleanup'
  });
}

test.before(async () => {
  category = (await pool.query("SELECT id,code FROM parking_categories WHERE code='TRACTOR_TRAILER'")).rows[0];
  assert.ok(category, 'load the development seed before area-capacity tests');
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,'OWNER',true,0,NULL) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,
      role='OWNER',active=true,failed_login_count=0,locked_until=NULL`, [ownerName, await bcrypt.hash(password, 4)]);
  owner = (await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [ownerName])).rows[0];
  location = (await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,payment_instructions,booking_approval_mode,cancellation_cutoff_hours,
      assignment_mode,exact_mode_active,self_service_enabled,check_in_early_minutes,check_in_late_minutes,turnaround_buffer_minutes)
    VALUES($1,'Published physical area-capacity fixture','28 Capacity Way','America/Chicago','+16155550280',
      'Enter at the signed gate and follow the highlighted area.','Use the signed exit lane.','Pay at the parking office.',
      'AUTO_CONFIRM',0,'ZONE_CAPACITY',false,true,120,240,0) RETURNING *`, [`Area Capacity Integration Lot ${Date.now()}`])).rows[0];
  zone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'General Truck Area','Public area-capacity fixture','Follow signs to General Truck Parking.',
      'Leave through the signed exit.',10) RETURNING *`, [location.id])).rows[0];
  inventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,99,'Physical inventory, not this configured number, is authoritative.',true) RETURNING *`, [zone.id, category.id])).rows[0];
  ratePlan = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Area Capacity Standard',2400,42000,true) RETURNING *`, [location.id, zone.id, category.id])).rows[0];
  draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,'Area capacity physical fixture','DRAFT',$2,$2) RETURNING *`, [location.id, owner.id])).rows[0];

  const entranceKey = elementKey();
  const laneKey = elementKey();
  for (const element of [
    ['ENTRANCE', entranceKey, 'Main Entrance', 2, 45, 8, 8, 1],
    ['DRIVE_LANE', laneKey, 'Public Drive Lane', 10, 47, 75, 5, 2],
    ['EXIT', elementKey(), 'Exit', 88, 45, 8, 8, 3]
  ]) {
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true)`, [draft.id, ...element]);
  }

  const definitions = [
    { label: 'A-1', purpose: 'CUSTOMER', active: true, publicBookable: true, eligible: true },
    { label: 'A-2', purpose: 'CUSTOMER', active: true, publicBookable: true, eligible: true },
    { label: 'A-3', purpose: 'CUSTOMER', active: true, publicBookable: true, eligible: true },
    { label: 'SHOP-1', purpose: 'SHOP', active: true, publicBookable: false, eligible: false },
    { label: 'COMPANY-1', purpose: 'COMPANY', active: true, publicBookable: false, eligible: false },
    { label: 'INACTIVE-1', purpose: 'CUSTOMER', active: false, publicBookable: true, eligible: true },
    { label: 'UNRESOLVED-1', purpose: 'UNRESOLVED', active: true, publicBookable: false, eligible: false }
  ];
  const created = [];
  for (const [index, definition] of definitions.entries()) {
    const key = elementKey();
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,
        visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'TEST','NEEDS_CLASSIFICATION',false,'NEEDS_CLASSIFICATION') RETURNING *`,
    [location.id, zone.id, inventory.id, definition.label, index + 1, key, definition.active])).rows[0];
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,
        parking_spot_id,x,y,width,height,layer_order,public_visible,active,parking_purpose,daily_eligible,
        monthly_eligible,space_public_bookable,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,8,5,$9,true,$10,$11,$12,$12,$13,$14)`, [
      draft.id, key, definition.label, zone.id, inventory.id, spot.id,
      18 + (index % 3) * 18, 20 + Math.floor(index / 3) * 18, 10 + index,
      definition.active, definition.purpose, definition.eligible,
      definition.publicBookable, definition.purpose === 'CUSTOMER' ? ratePlan.id : null
    ]);
    created.push(spot);
  }
  customerSpots = created.slice(0, 3);
  await pool.query(`INSERT INTO parking_area_directions(location_id,zone_id,entrance_element_key,arrival_route_element_keys,updated_by_admin_user_id)
    VALUES($1,$2,$3,$4,$5)`, [location.id, zone.id, entranceKey, [entranceKey, laneKey], owner.id]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const publication = await publishDraftSnapshot(client, { layoutId: draft.id, actorId: owner.id });
    published = publication.published;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ownerName, password })
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  ownerSession = { cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: loginBody.csrfToken };
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('migration snapshots modes and physical published inventory is authoritative', async () => {
  const schema = await pool.query(`SELECT
      (SELECT count(*)::int FROM schema_migrations WHERE name='028_area_capacity_booking.sql') migration_count,
      (SELECT is_nullable FROM information_schema.columns WHERE table_name='parking_bookings' AND column_name='assignment_mode_snapshot') booking_nullable,
      (SELECT is_nullable FROM information_schema.columns WHERE table_name='parking_public_quotes' AND column_name='assignment_mode') quote_nullable`);
  assert.deepEqual(schema.rows[0], { migration_count: 1, booking_nullable: 'NO', quote_nullable: 'NO' });
  const result = await availability();
  assert.equal(result.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(result.remainingCapacity, 3, 'configured inventory capacity 99 must not override three eligible physical spaces');
  assert.equal(result.numberedSpacesAvailable, null);
  assert.equal(result.parkingArea.name, 'General Truck Parking');
  const metrics = await areaCapacityMetrics(pool, { locationId: location.id, at: '2034-06-10T15:00:00Z' });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].physicalCapacity, 3);
  assert.equal(metrics[0].availableCapacity, 3);
  const publishedCount = await pool.query(`SELECT count(*)::int count FROM parking_layout_elements
    WHERE layout_id=$1 AND parking_spot_id IS NOT NULL`, [published.id]);
  assert.equal(publishedCount.rows[0].count, 7, 'all physical history remains in the immutable published map');
});

test('owner mode cutover invalidates quotes without rewriting prior snapshots', async () => {
  const quoted = await publicRequest('/quotes', bookingPayload(1));
  assert.equal(quoted.response.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.assignmentMode, 'ZONE_CAPACITY');
  const exactSetup = await setMode('EXACT_SPOT');
  assert.equal(exactSetup.assignment_mode, 'EXACT_SPOT');
  assert.equal(exactSetup.exact_mode_active, false, 'exact public assignment stays disabled until setup is republished');
  const stale = await publicRequest('/bookings', {
    ...bookingPayload(1), quoteToken: quoted.body.quoteToken, termsVersion: quoted.body.terms.version
  }, idempotency('area-mode-stale-quote-00000001'));
  assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'QUOTE_STALE');
  await setMode('ZONE_CAPACITY');
});

test('legacy exact commitments coexist with area bookings and concurrent final capacity cannot oversell', async () => {
  await setMode('EXACT_SPOT');
  await pool.query('UPDATE parking_locations SET exact_mode_active=true WHERE id=$1', [location.id]);
  const legacyCredential = 'legacy-area-capacity-credential';
  const legacyReservationNumber = `TH-LEGACY-AREA-${Date.now()}`;
  const legacyBooking = (await pool.query(`INSERT INTO parking_bookings(
      reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
      arrival_at,departure_at,first_name,last_name,mobile_phone,email,company_name,tractor_unit_number,
      license_plate,license_plate_state,terms_accepted_at,cancellation_terms_accepted_at,
      assignment_mode_snapshot,parking_product,payment_status)
    VALUES($1,$2,$3,$4,$5,$6,'CONFIRMED','2034-06-10T14:00:00Z','2034-06-10T17:00:00Z',
      'Legacy','Exact','+16155553010','legacy.exact@example.test','Historical Carrier','LEG-10','LEG10','TN',
      now(),now(),'EXACT_SPOT','LEGACY','NOT_REQUIRED') RETURNING *`, [legacyReservationNumber,
    `legacy-area-token-${Date.now()}`, await bcrypt.hash(legacyCredential, 4), inventory.id, location.id, category.id])).rows[0];
  await pool.query(`INSERT INTO reservation_spot_assignments(
      booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source)
    VALUES($1,$2,$3,$4,$4,'SYSTEM')`, [legacyBooking.id, customerSpots[0].id,
    legacyBooking.arrival_at, legacyBooking.departure_at]);
  await pool.query(`INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)`,
    [legacyBooking.id, JSON.stringify({ duration: 'DAILY', unitRateCents: 2400, quantity: 1, totalCents: 2400, currency: 'USD' })]);
  await pool.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
    VALUES($1,'CONFIRMED','SYSTEM','Historical exact compatibility fixture',1)`, [legacyBooking.id]);
  const legacyExact = await publicRequest('/bookings/lookup', {
    reservationNumber: legacyReservationNumber, lookupCredential: legacyCredential
  });
  assert.equal(legacyExact.response.status, 200, JSON.stringify(legacyExact.body));
  assert.equal(legacyExact.body.booking.assignmentMode, 'EXACT_SPOT');
  assert.ok(legacyExact.body.booking.assignedSpace?.label);

  await setMode('ZONE_CAPACITY');
  const exactLookup = await publicRequest('/bookings/lookup', {
    reservationNumber: legacyExact.body.booking.reservationNumber,
    lookupCredential: legacyCredential
  });
  assert.equal(exactLookup.body.booking.assignmentMode, 'EXACT_SPOT', 'location cutover must not rewrite an existing booking');
  assert.ok(exactLookup.body.booking.assignedSpace?.label);

  const exactRow = (await pool.query(`SELECT booking.id,assignment.parking_spot_id FROM parking_bookings booking
    JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
    WHERE booking.reservation_number=$1`, [legacyExact.body.booking.reservationNumber])).rows[0];
  const blockedSpot = customerSpots.find(spot => String(spot.id) !== String(exactRow.parking_spot_id));
  const blockResponse = await adminRequest(`/spots/${blockedSpot.id}/block`, {
    method: 'POST', body: {
      startsAt: '2034-06-10T14:00:00Z', endsAt: '2034-06-10T18:00:00Z', reason: 'Area final-capacity test'
    }
  });
  assert.equal(blockResponse.status, 201, JSON.stringify(await blockResponse.json()));
  assert.equal((await availability()).remainingCapacity, 1, 'one exact commitment plus one physical block leave one unit');

  const attempts = await Promise.all([...Array(8)].map((_, index) => publicRequest('/bookings',
    bookingPayload(100 + index), idempotency(`area-concurrency-${String(index).padStart(20, '0')}`))));
  const winners = attempts.filter(result => result.response.status === 201);
  const rejected = attempts.filter(result => result.body.error?.code === 'PARKING_NOT_AVAILABLE');
  assert.equal(winners.length, 1);
  assert.equal(rejected.length, 7);
  const winner = winners[0].body.booking;
  assert.equal(winner.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(winner.assignedSpace, null);
  assert.equal(winner.assignedSpotLabel, null);
  assert.equal(winner.parkingArea.name, 'General Truck Parking');
  assert.equal(winner.map.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(winner.map.elements.filter(element => element.permitted).length, 2, 'the physical block is excluded from the highlighted area');
  assert.equal((await pool.query('SELECT count(*)::int count FROM reservation_spot_assignments WHERE booking_id=(SELECT id FROM parking_bookings WHERE reservation_number=$1)', [winner.reservationNumber])).rows[0].count, 0);
  await assert.rejects(pool.query(`INSERT INTO reservation_spot_assignments(booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source)
    SELECT id,$2,arrival_at,departure_at,departure_at,'SYSTEM' FROM parking_bookings WHERE reservation_number=$1`,
  [winner.reservationNumber, blockedSpot.id]), /customer-selected monthly or historical exact booking/);
  await assert.rejects(pool.query("UPDATE parking_bookings SET assignment_mode_snapshot='EXACT_SPOT' WHERE reservation_number=$1", [winner.reservationNumber]), /immutable/);

  await setMode('EXACT_SPOT');
  const areaLookup = await publicRequest('/bookings/lookup', {
    reservationNumber: winner.reservationNumber, lookupCredential: winner.lookupCredential
  });
  assert.equal(areaLookup.body.booking.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(areaLookup.body.booking.assignedSpace, null);
  await setMode('ZONE_CAPACITY');

  const cancelled = await cancel(winner);
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  assert.equal((await availability()).remainingCapacity, 1, 'cancellation releases the area commitment');
  const boundary = await publicRequest('/bookings', bookingPayload(250, {
    arrivalLocal: interval.departureLocal, departureLocal: '2034-06-10T15:00'
  }), idempotency('area-half-open-boundary-000250'));
  assert.equal(boundary.response.status, 201, JSON.stringify(boundary.body));
  await cancel(boundary.body.booking);
  const exactCancelled = await cancel({ ...legacyExact.body.booking, lookupCredential: legacyCredential });
  assert.equal(exactCancelled.response.status, 200, JSON.stringify(exactCancelled.body));
  const unblock = await adminRequest(`/spots/${blockedSpot.id}/unblock`, { method: 'POST', body: {} });
  assert.equal(unblock.status, 200, JSON.stringify(await unblock.json()));
});

test('area self-service, closures, and admin metrics remain mode-aware', async () => {
  const serviceBooking = await publicRequest('/bookings', bookingPayload(300, {
    arrivalLocal: '2034-07-10T09:00', departureLocal: '2034-07-10T12:00'
  }), idempotency('area-self-service-00000300'));
  assert.equal(serviceBooking.response.status, 201, JSON.stringify(serviceBooking.body));
  const starts = new Date(Date.now() + 5 * 60000);
  const ends = new Date(Date.now() + 2 * 3600000);
  await pool.query('UPDATE parking_bookings SET arrival_at=$2,departure_at=$3 WHERE reservation_number=$1',
    [serviceBooking.body.booking.reservationNumber, starts.toISOString(), ends.toISOString()]);
  const checkedIn = await publicRequest(`/bookings/${serviceBooking.body.booking.publicToken}/check-in`, {
    lookupCredential: serviceBooking.body.booking.lookupCredential
  });
  assert.equal(checkedIn.response.status, 200, JSON.stringify(checkedIn.body));
  assert.equal(checkedIn.body.booking.status, 'CHECKED_IN');
  assert.equal(checkedIn.body.booking.assignedSpace, null);
  const checkedOut = await publicRequest(`/bookings/${serviceBooking.body.booking.publicToken}/check-out`, {
    lookupCredential: serviceBooking.body.booking.lookupCredential
  });
  assert.equal(checkedOut.response.status, 200, JSON.stringify(checkedOut.body));
  assert.equal(checkedOut.body.booking.status, 'CHECKED_OUT');

  await pool.query(`INSERT INTO parking_closures(inventory_id,closure_type,starts_at,ends_at,reason)
    VALUES($1,'FULL_CLOSURE','2034-08-10T14:00:00Z','2034-08-10T18:00:00Z','Area closure verification')`, [inventory.id]);
  const closed = await availability({ arrivalLocal: '2034-08-10T09:00', departureLocal: '2034-08-10T12:00' });
  assert.equal(closed.available, false);
  assert.equal(closed.remainingCapacity, 0);
  await pool.query("DELETE FROM parking_closures WHERE reason='Area closure verification'");

  const dashboard = await adminRequest('/dashboard');
  const dashboardBody = await dashboard.json();
  assert.equal(dashboard.status, 200, JSON.stringify(dashboardBody));
  const area = dashboardBody.areaCapacity.find(item => String(item.inventoryId) === String(inventory.id));
  assert.ok(area);
  assert.equal(area.physicalCapacity, 3);
  assert.ok(Object.hasOwn(area, 'blockedPhysical') && Object.hasOwn(area, 'shortfall'));
  const detailId = (await pool.query('SELECT id FROM parking_bookings WHERE reservation_number=$1', [serviceBooking.body.booking.reservationNumber])).rows[0].id;
  const detail = await adminRequest(`/bookings/${detailId}`);
  const detailBody = await detail.json();
  assert.equal(detail.status, 200, JSON.stringify(detailBody));
  assert.equal(detailBody.booking.assignment_mode_snapshot, 'ZONE_CAPACITY');
  assert.deepEqual(detailBody.assignments, []);
  assert.equal(localInput(starts).length, 16);
});

test('publication rejects a PII-free area-capacity shortfall and leaves history untouched', async () => {
  const committed = await publicRequest('/bookings', bookingPayload(400, {
    arrivalLocal: '2034-09-10T09:00', departureLocal: '2034-09-10T12:00'
  }), idempotency('area-publication-guard-000400'));
  assert.equal(committed.response.status, 201, JSON.stringify(committed.body));
  const before = await pool.query(`SELECT count(*)::int count FROM parking_layout_elements
    WHERE layout_id=$1 AND parking_spot_id IS NOT NULL`, [published.id]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE parking_layout_elements SET active=false
      WHERE layout_id=$1 AND inventory_id=$2 AND parking_purpose='CUSTOMER'`, [draft.id, inventory.id]);
    let conflict;
    try {
      await protectAssignedSpaces(client, draft);
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict);
    assert.equal(conflict.code, 'AREA_CAPACITY_COMMITMENT_CONFLICT');
    assert.equal(conflict.status, 409);
    assert.ok(conflict.details.conflicts.some(item => item.physicalCapacity === 0 && item.shortfall >= 1));
    const serialized = JSON.stringify(conflict.details);
    assert.ok(!serialized.includes('area.driver') && !serialized.includes(committed.body.booking.reservationNumber));
    await client.query('ROLLBACK');
  } finally { client.release(); }
  const after = await pool.query(`SELECT count(*)::int count FROM parking_layout_elements
    WHERE layout_id=$1 AND parking_spot_id IS NOT NULL`, [published.id]);
  assert.equal(after.rows[0].count, before.rows[0].count);
  assert.equal((await availability({ arrivalLocal: '2034-09-10T09:00', departureLocal: '2034-09-10T12:00' })).remainingCapacity, 2);
});

test('canonical Trucker Heaven keeps Daily area reservations and rejects legacy exact creation', async () => {
  const originalName = published.name;
  const shadowedCanonicalLayouts = (await pool.query(`SELECT id,name FROM parking_lot_layouts
    WHERE status='PUBLISHED' AND name LIKE 'Trucker Heaven physical lot%' AND id<>$1`, [published.id])).rows;
  const markerClient = await pool.connect();
  try {
    await markerClient.query('BEGIN');
    await markerClient.query("SELECT set_config('parking.layout_publication','on',true)");
    for (const layout of shadowedCanonicalLayouts) {
      await markerClient.query("UPDATE parking_lot_layouts SET name='Temporarily hidden canonical layout ' || id WHERE id=$1", [layout.id]);
    }
    await markerClient.query("UPDATE parking_lot_layouts SET name='Trucker Heaven physical lot · canonical area-only test' WHERE id=$1", [published.id]);
    await markerClient.query('COMMIT');
  } catch (error) {
    await markerClient.query('ROLLBACK');
    throw error;
  } finally { markerClient.release(); }

  try {
    const schema = await pool.query("SELECT count(*)::int count FROM schema_migrations WHERE name='029_canonical_area_only.sql'");
    assert.equal(schema.rows[0].count, 1);
    const canonical = (await pool.query('SELECT assignment_mode,exact_mode_active,version FROM parking_locations WHERE id=$1', [location.id])).rows[0];
    assert.equal(canonical.assignment_mode, 'ZONE_CAPACITY');
    assert.equal(canonical.exact_mode_active, false);

    const lotResponse = await fetch(`${base}/api/public/parking/v1/canonical-lot`);
    const lotBody = await lotResponse.json();
    assert.equal(lotResponse.status, 200, JSON.stringify(lotBody));
    assert.equal(lotBody.lot.assignmentMode, 'TERM_BASED');

    const attemptedExact = await publicRequest('/availability', {
      parkingAreaId: zone.public_id, categoryCode: category.code, assignmentMode: 'EXACT_SPOT', ...interval
    });
    assert.equal(attemptedExact.response.status, 409, JSON.stringify(attemptedExact.body));
    assert.equal(attemptedExact.body.error.code, 'ASSIGNMENT_BEHAVIOR_MISMATCH');

    const ownerAttempt = await adminRequest(`/locations/${location.id}`, {
      method: 'PATCH', body: { version: canonical.version, assignment_mode: 'EXACT_SPOT' }
    });
    const ownerAttemptBody = await ownerAttempt.json();
    assert.equal(ownerAttempt.status, 409, JSON.stringify(ownerAttemptBody));
    assert.equal(ownerAttemptBody.error.code, 'CANONICAL_AREA_BOOKING_REQUIRED');
    await assert.rejects(
      pool.query("UPDATE parking_locations SET assignment_mode='EXACT_SPOT' WHERE id=$1", [location.id]),
      /must use ZONE_CAPACITY/
    );

    const canonicalInterval = { arrivalLocal: '2034-11-10T09:00', departureLocal: '2034-11-10T12:00' };
    const created = await publicRequest('/bookings', bookingPayload(900, canonicalInterval), idempotency('canonical-area-only-00000900'));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.booking.assignmentMode, 'ZONE_CAPACITY');
    assert.equal(created.body.booking.assignedSpace, null);
    const persisted = await pool.query(`SELECT booking.assignment_mode_snapshot,booking.assigned_spot_label,
        count(assignment.id)::int assignment_count
      FROM parking_bookings booking
      LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
      WHERE booking.reservation_number=$1
      GROUP BY booking.id`, [created.body.booking.reservationNumber]);
    assert.deepEqual(persisted.rows[0], {
      assignment_mode_snapshot: 'ZONE_CAPACITY', assigned_spot_label: null, assignment_count: 0
    });
    const noAdminCreation = await adminRequest('/bookings', { method: 'POST', body: {} });
    assert.equal(noAdminCreation.status, 404, 'Admin API must not expose a reservation-creation route');
    await cancel(created.body.booking);
  } finally {
    const restoreClient = await pool.connect();
    try {
      await restoreClient.query('BEGIN');
      await restoreClient.query("SELECT set_config('parking.layout_publication','on',true)");
      await restoreClient.query('UPDATE parking_lot_layouts SET name=$2 WHERE id=$1', [published.id, originalName]);
      for (const layout of shadowedCanonicalLayouts) {
        await restoreClient.query('UPDATE parking_lot_layouts SET name=$2 WHERE id=$1', [layout.id, layout.name]);
      }
      await restoreClient.query('COMMIT');
    } catch (error) {
      await restoreClient.query('ROLLBACK');
      throw error;
    } finally { restoreClient.release(); }
  }
});
