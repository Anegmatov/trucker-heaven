const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { locationInterval, digest } = require('../utils');
const pool = require('../db');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

let server;
let base;
let locationId;
let publicLocationId;
let publicAreaId;
let inventoryId;
let zoneId;
let categoryId;
const categoryCode = 'TRACTOR_TRAILER';
const arrival = '2031-05-10T09:00';
const departure = '2031-05-11T09:00';
const testPassword = 'ParkingOps-test-password-2031';
// These pre-physical-layout capacity fixtures intentionally remain as readable
// history, but they cannot create new customer reservations now that all public
// inventory must come from the one published real-lot layout. Current behavior
// is covered by areaCapacity, monthlyCustomerSelected, and paymentPipeline.
const legacyCapacityTest = test.skip;

function request(path, body, key) {
  return fetch(`${base}/api/public/parking/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body)
  });
}

function payload(index, overrides = {}) {
  return {
    parkingAreaId: publicAreaId,
    categoryCode,
    arrivalLocal: arrival,
    departureLocal: departure,
    firstName: 'Driver',
    lastName: `${index}`,
    mobilePhone: `615555${String(1000 + index).slice(-4)}`,
    email: `driver${index}@example.test`,
    tractorUnitNumber: `UNIT-${index}`,
    licensePlate: `ABC${index}`,
    licensePlateState: 'TN',
    termsAccepted: true,
    cancellationTermsAccepted: true,
    ...overrides
  };
}

async function clearBookings() {
  await pool.query('TRUNCATE parking_booking_notes,parking_booking_status_history,parking_booking_price_snapshots,parking_bookings RESTART IDENTITY CASCADE');
}

async function setCapacity(capacity) {
  await pool.query('UPDATE parking_inventory SET capacity=$1 WHERE id=$2', [capacity, inventoryId]);
}

async function available(overrides = {}) {
  const response = await request('/availability', {
    parkingAreaId: publicAreaId,
    categoryCode,
    arrivalLocal: arrival,
    departureLocal: departure,
    ...overrides
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.results;
}

async function createAdmin(username, role, active = true) {
  const passwordHash = await bcrypt.hash(testPassword, 4);
  const result = await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,$3,$4,0,NULL)
    ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,active=EXCLUDED.active,failed_login_count=0,locked_until=NULL
    RETURNING id,username,role,active,password_hash`, [username, passwordHash, role, active]);
  return result.rows[0];
}

async function loginAs(username, password = testPassword) {
  const response = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'login must set the session cookie');
  return { response, body, cookie: setCookie.split(';')[0], csrfToken: body.csrfToken };
}

function adminRequest(path, session, { method = 'GET', body, csrfToken = session.csrfToken } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }
  return fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function bookingRow(reservationNumber) {
  const result = await pool.query('SELECT * FROM parking_bookings WHERE reservation_number=$1', [reservationNumber]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

test.before(async () => {
  const location = await pool.query(`SELECT l.id,l.public_id,z.public_id area_public_id,i.id inventory_id,z.id zone_id,c.id category_id
    FROM parking_locations l
    JOIN parking_zones z ON z.location_id=l.id
    JOIN parking_inventory i ON i.zone_id=z.id
    JOIN parking_categories c ON c.id=i.category_id
    WHERE l.name='Trucker Heaven Main Lot' AND c.code=$1
    ORDER BY i.id LIMIT 1`, [categoryCode]);
  assert.equal(location.rowCount, 1, 'load the development seed before PostgreSQL integration tests');
  ({ id: locationId, public_id: publicLocationId, area_public_id: publicAreaId, inventory_id: inventoryId, zone_id: zoneId, category_id: categoryId } = location.rows[0]);
  await Promise.all([
    createAdmin('parking-test-owner', 'OWNER'),
    createAdmin('parking-test-owner-config', 'OWNER'),
    createAdmin('parking-test-staff', 'STAFF'),
    createAdmin('parking-test-disabled', 'STAFF', false)
  ]);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test.beforeEach(async () => {
  await clearBookings();
  await pool.query('DELETE FROM parking_closures');
  await pool.query('UPDATE parking_inventory SET capacity=40,active=true,public_remaining_capacity=true WHERE id=$1', [inventoryId]);
  await pool.query('UPDATE parking_categories SET active=true WHERE id=$1', [categoryId]);
  await pool.query('UPDATE parking_zones SET active=true WHERE id=$1', [zoneId]);
  await pool.query("UPDATE parking_locations SET active=true,booking_approval_mode='AUTO_CONFIRM',cancellation_cutoff_hours=0,assignment_mode='ZONE_CAPACITY',exact_mode_active=false WHERE id=$1", [locationId]);
  await pool.query('UPDATE parking_admin_users SET active=true,failed_login_count=0,locked_until=NULL WHERE username IN ($1,$2,$3)', ['parking-test-owner', 'parking-test-owner-config', 'parking-test-staff']);
  await pool.query('UPDATE parking_admin_users SET active=false,failed_login_count=0,locked_until=NULL WHERE username=$1', ['parking-test-disabled']);
  await pool.query('DELETE FROM parking_admin_sessions');
});

test('timezone conversion rejects nonexistent and ambiguous Central Time values', () => {
  assert.equal(locationInterval('2031-01-10T10:00', '2031-01-10T11:00', 'America/Chicago').start, '2031-01-10T16:00:00.000Z');
  assert.equal(locationInterval('2031-07-10T10:00', '2031-07-10T11:00', 'America/Chicago').start, '2031-07-10T15:00:00.000Z');
  assert.throws(() => locationInterval('2031-03-09T02:30', '2031-03-09T04:00', 'America/Chicago'), /does not exist/);
  assert.throws(() => locationInterval('2031-11-02T01:30', '2031-11-02T03:00', 'America/Chicago'), /ambiguous/);
});

legacyCapacityTest('legacy configured-capacity fixture: capacity one permits exactly one booking', async () => {
  await setCapacity(1);
  const responses = await Promise.all([...Array(10)].map((_, index) => request('/bookings', payload(index), `cap-one-${String(index).padStart(20, 'x')}`)));
  const codes = await Promise.all(responses.map(async response => ({ status: response.status, body: await response.json() })));
  assert.equal(codes.filter(result => result.status === 201).length, 1);
  assert.equal(codes.filter(result => result.body.error?.code === 'PARKING_NOT_AVAILABLE').length, 9);
  const count = await pool.query("SELECT count(*)::int count FROM parking_bookings WHERE status='CONFIRMED'");
  assert.equal(count.rows[0].count, 1);
});

legacyCapacityTest('legacy configured-capacity fixture: capacity three permits exactly three bookings', async () => {
  await setCapacity(3);
  const responses = await Promise.all([...Array(10)].map((_, index) => request('/bookings', payload(index), `cap-three-${String(index).padStart(20, 'x')}`)));
  const codes = await Promise.all(responses.map(async response => ({ status: response.status, body: await response.json() })));
  assert.equal(codes.filter(result => result.status === 201).length, 3);
  assert.equal(codes.filter(result => result.body.error?.code === 'PARKING_NOT_AVAILABLE').length, 7);
  const count = await pool.query("SELECT count(*)::int count FROM parking_bookings WHERE status='CONFIRMED'");
  assert.equal(count.rows[0].count, 3);
});

legacyCapacityTest('legacy configured-capacity fixture: availability uses peak simultaneous occupancy', async () => {
  await setCapacity(2);
  const first = await request('/bookings', payload(1, { departureLocal: '2031-05-10T10:00' }), 'peak-first-xxxxxxxxxxxxxxxx');
  const second = await request('/bookings', payload(2, { arrivalLocal: '2031-05-10T10:00', departureLocal: '2031-05-10T11:00' }), 'peak-second-xxxxxxxxxxxxxxx');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const results = await available({ departureLocal: '2031-05-10T11:00' });
  assert.equal(results.length, 1);
  assert.equal(results[0].available, true);
  const spanning = await request('/bookings', payload(3, { departureLocal: '2031-05-10T11:00' }), 'peak-spanning-xxxxxxxxxxxxxx');
  assert.equal(spanning.status, 201, JSON.stringify(await spanning.json()));
});

legacyCapacityTest('legacy configured-capacity fixture: capacity reductions respect half-open intervals', async () => {
  await setCapacity(2);
  const existing = await request('/bookings', payload(1, { departureLocal: '2031-05-10T10:00' }), 'partial-reduction-existing-xxxx');
  assert.equal(existing.status, 201);
  await pool.query(`INSERT INTO parking_closures(inventory_id,closure_type,capacity_reduction,starts_at,ends_at,reason)
    VALUES($1,'CAPACITY_REDUCTION',1,'2031-05-10T10:00:00.000Z','2031-05-10T11:00:00.000Z','Short reduction')`, [inventoryId]);

  const partialOverlap = await available({ departureLocal: '2031-05-10T11:00' });
  assert.equal(partialOverlap[0].available, true, 'the booking and reduction peak at different instants');
  const endsAtReduction = await available({ departureLocal: '2031-05-10T10:00' });
  assert.equal(endsAtReduction[0].available, true, 'a reduction beginning at departure does not overlap [arrival, departure)');
});

legacyCapacityTest('legacy configured-capacity fixture: half-open boundary and idempotency preserve capacity', async () => {
  await setCapacity(1);
  const first = await request('/bookings', payload(1, { departureLocal: '2031-05-10T10:00' }), 'boundary-xxxxxxxxxxxxxxxx');
  const second = await request('/bookings', payload(2, { arrivalLocal: '2031-05-10T10:00', departureLocal: '2031-05-10T12:00' }), 'boundary-yyyyyyyyyyyyyyyy');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  await clearBookings();
  const key = 'same-key-xxxxxxxxxxxxxxxxxxxxxxxx';
  const replies = await Promise.all([...Array(6)].map(() => request('/bookings', payload(9), key)));
  assert.equal((await Promise.all(replies.map(reply => reply.json()))).filter(body => body.booking).length, 6);
  const count = await pool.query('SELECT count(*)::int count FROM parking_bookings');
  assert.equal(count.rows[0].count, 1);
});

legacyCapacityTest('legacy configured-capacity fixture: quote and idempotency persistence', async () => {
  const bookingBody = payload(71);
  const quoteResponse = await request('/quotes', bookingBody);
  const quoteBody = await quoteResponse.json();
  assert.equal(quoteResponse.status, 200, JSON.stringify(quoteBody));
  assert.match(quoteBody.quoteToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(new Date(quoteBody.expiresAt) > new Date());

  const key = 'quote-contract-idempotency-000071';
  const submitted = { ...bookingBody, quoteToken: quoteBody.quoteToken };
  const created = await request('/bookings', submitted, key);
  const createdBody = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  assert.equal(createdBody.booking.price.totalCents, quoteBody.quote.totalCents);
  assert.equal(createdBody.booking.price.quoteId, quoteBody.quote.quoteId);

  const replay = await request('/bookings', submitted, key);
  assert.equal(replay.status, 200, JSON.stringify(await replay.clone().json()));
  const altered = await request('/bookings', { ...submitted, specialInstructions: 'Different request' }, key);
  assert.equal(altered.status, 409);
  assert.equal((await altered.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');

  const reuse = await request('/bookings', { ...payload(72), quoteToken: quoteBody.quoteToken }, 'quote-reuse-idempotency-000072');
  assert.equal(reuse.status, 409);
  assert.equal((await reuse.json()).error.code, 'QUOTE_ALREADY_USED');

  const expiringQuote = await request('/quotes', payload(73, { arrivalLocal: '2031-06-10T09:00', departureLocal: '2031-06-11T09:00' }));
  const expiringBody = await expiringQuote.json();
  assert.equal(expiringQuote.status, 200, JSON.stringify(expiringBody));
  await pool.query('UPDATE parking_public_quotes SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1', [digest(expiringBody.quoteToken)]);
  const expired = await request('/bookings', { ...payload(73, { arrivalLocal: '2031-06-10T09:00', departureLocal: '2031-06-11T09:00' }), quoteToken: expiringBody.quoteToken }, 'quote-expired-idempotency-000073');
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error.code, 'QUOTE_EXPIRED');

  const boundQuote = await request('/quotes', payload(74, { arrivalLocal: '2031-07-10T09:00', departureLocal: '2031-07-11T09:00' }));
  const boundBody = await boundQuote.json();
  assert.equal(boundQuote.status, 200, JSON.stringify(boundBody));
  const mismatched = await request('/bookings', {
    ...payload(74, { arrivalLocal: '2031-07-12T09:00', departureLocal: '2031-07-13T09:00' }), quoteToken: boundBody.quoteToken
  }, 'quote-mismatch-idempotency-000074');
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).error.code, 'QUOTE_REQUEST_MISMATCH');

  const legacyStableQuote = await request('/quotes', payload(75, { arrivalLocal: '2031-07-14T09:00', departureLocal: '2031-07-15T09:00' }));
  const legacyStableBody = await legacyStableQuote.json();
  assert.equal(legacyStableQuote.status, 200, JSON.stringify(legacyStableBody));
  const legacyStableRecord = (await pool.query('SELECT rate_rule_id FROM parking_public_quotes WHERE token_hash=$1', [digest(legacyStableBody.quoteToken)])).rows[0];
  await pool.query('UPDATE parking_rate_rules SET weekly_rate_cents=COALESCE(weekly_rate_cents,0)+1,version=version+1 WHERE id=$1', [legacyStableRecord.rate_rule_id]);
  const unaffected = await request('/bookings', {
    ...payload(75, { arrivalLocal: '2031-07-14T09:00', departureLocal: '2031-07-15T09:00' }), quoteToken: legacyStableBody.quoteToken
  }, 'quote-weekly-basis-idempotency-075');
  assert.equal(unaffected.status, 201, JSON.stringify(await unaffected.json()));

  const staleRecord = (await pool.query('SELECT rate_rule_id FROM parking_public_quotes WHERE token_hash=$1', [digest(boundBody.quoteToken)])).rows[0];
  await pool.query('UPDATE parking_rate_rules SET daily_rate_cents=daily_rate_cents+1,version=version+1 WHERE id=$1', [staleRecord.rate_rule_id]);
  const stale = await request('/bookings', {
    ...payload(74, { arrivalLocal: '2031-07-10T09:00', departureLocal: '2031-07-11T09:00' }), quoteToken: boundBody.quoteToken
  }, 'quote-stale-idempotency-000074');
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'QUOTE_STALE');
});

legacyCapacityTest('legacy configured-capacity fixture: public category and interval policy', async () => {
  const unsupported = await request('/availability', {
    parkingAreaId: publicAreaId, categoryCode: 'TRACTOR_ONLY', arrivalLocal: arrival, departureLocal: departure
  });
  assert.equal(unsupported.status, 422);
  assert.equal((await unsupported.json()).error.code, 'UNSUPPORTED_PUBLIC_CATEGORY');
  const past = await request('/availability', {
    parkingAreaId: publicAreaId, categoryCode, arrivalLocal: '2020-05-10T09:00', departureLocal: '2020-05-11T09:00'
  });
  assert.equal(past.status, 422);
  assert.equal((await past.json()).error.code, 'BOOKING_START_TOO_SOON');
  const tooLong = await request('/availability', {
    parkingAreaId: publicAreaId, categoryCode, arrivalLocal: '2031-05-10T09:00', departureLocal: '2032-06-11T09:00'
  });
  assert.equal(tooLong.status, 422);
  assert.equal((await tooLong.json()).error.code, 'BOOKING_STAY_TOO_LONG');
});

legacyCapacityTest('legacy configured-capacity fixture: closures and reductions affect availability', async () => {
  const closureStart = '2031-05-09T00:00:00.000Z';
  const closureEnd = '2031-05-12T00:00:00.000Z';
  await pool.query(`INSERT INTO parking_closures(location_id,closure_type,starts_at,ends_at,reason)
    VALUES($1,'FULL_CLOSURE',$2,$3,'Location maintenance')`, [locationId, closureStart, closureEnd]);
  const locationClosure = await available();
  assert.equal(locationClosure[0].available, false);
  assert.equal(locationClosure[0].remainingCapacity, 0);
  await pool.query('DELETE FROM parking_closures');

  await pool.query(`INSERT INTO parking_closures(zone_id,closure_type,starts_at,ends_at,reason)
    VALUES($1,'FULL_CLOSURE',$2,$3,'Zone maintenance')`, [zoneId, closureStart, closureEnd]);
  assert.equal((await available())[0].available, false);
  await pool.query('DELETE FROM parking_closures');

  await pool.query(`INSERT INTO parking_closures(category_id,closure_type,starts_at,ends_at,reason)
    VALUES($1,'FULL_CLOSURE',$2,$3,'Category maintenance')`, [categoryId, closureStart, closureEnd]);
  assert.equal((await available())[0].available, false);
  await pool.query('DELETE FROM parking_closures');

  await setCapacity(1);
  await pool.query(`INSERT INTO parking_closures(inventory_id,closure_type,capacity_reduction,starts_at,ends_at,reason)
    VALUES($1,'CAPACITY_REDUCTION',1,$2,$3,'Reduced capacity')`, [inventoryId, closureStart, closureEnd]);
  assert.equal((await available())[0].available, false);
  await pool.query('DELETE FROM parking_closures');

  await pool.query('UPDATE parking_categories SET active=false WHERE id=$1', [categoryId]);
  assert.deepEqual(await available(), []);
  const quote = await request('/quotes', { parkingAreaId: publicAreaId, categoryCode, arrivalLocal: arrival, departureLocal: departure });
  assert.equal(quote.status, 409);
  assert.equal((await quote.json()).error.code, 'PARKING_NOT_AVAILABLE');
  const invalid = await request('/availability', { parkingAreaId: publicAreaId, categoryCode, arrivalLocal: arrival, departureLocal: arrival });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_BOOKING_INTERVAL');
});

legacyCapacityTest('legacy configured-capacity fixture: confirmation policies', async () => {
  let response = await request('/bookings', payload(1), 'auto-confirm-xxxxxxxxxxxxxxxx');
  let body = await response.json();
  assert.equal(body.booking.status, 'CONFIRMED');
  await clearBookings();
  await pool.query("UPDATE parking_locations SET booking_approval_mode='MANUAL_CONFIRM' WHERE id=$1", [locationId]);
  response = await request('/bookings', payload(2), 'manual-confirm-xxxxxxxxxxxxxx');
  body = await response.json();
  assert.equal(body.booking.status, 'PENDING');
});

legacyCapacityTest('legacy configured-capacity fixture: opaque identifiers and pending expiry', async () => {
  const locations = await fetch(`${base}/api/public/parking/v1/locations`);
  assert.equal(locations.status, 200);
  const listed = (await locations.json()).locations;
  const publicLocation = listed.find(item => item.id === publicLocationId);
  assert.ok(publicLocation);
  assert.match(publicLocation.id, /^pl_[a-f0-9]{32}$/);

  const rejectedTerms = await request('/bookings', payload(1, { termsAccepted: 'false', cancellationTermsAccepted: 'false' }), 'terms-string-rejected-xxxxxxxx');
  assert.equal(rejectedTerms.status, 400);
  assert.equal((await rejectedTerms.json()).error.code, 'TERMS_REQUIRED');

  const quote = await request('/quotes', { parkingAreaId: publicAreaId, categoryCode, arrivalLocal: arrival, departureLocal: departure });
  assert.equal(quote.status, 200);
  assert.equal(Object.hasOwn((await quote.json()).quote, 'rateRuleId'), false);

  await setCapacity(1);
  await pool.query("UPDATE parking_locations SET booking_approval_mode='MANUAL_CONFIRM' WHERE id=$1", [locationId]);
  const pendingResponse = await request('/bookings', payload(2), 'pending-expiry-xxxxxxxxxxxxxxxx');
  assert.equal(pendingResponse.status, 201);
  const pendingBooking = (await pendingResponse.json()).booking;
  await pool.query("UPDATE parking_bookings SET pending_expires_at=now()-interval '1 minute' WHERE reservation_number=$1", [pendingBooking.reservationNumber]);
  const afterExpiry = await available();
  assert.equal(afterExpiry[0].available, true);
  assert.equal((await bookingRow(pendingBooking.reservationNumber)).status, 'EXPIRED');
});

legacyCapacityTest('legacy configured-capacity fixture: public area boundaries', async () => {
  const response = await fetch(`${base}/api/public/parking/v1/parking-areas`);
  assert.equal(response.status, 200);
  const areas = (await response.json()).parkingAreas.filter(item => item.location_id === publicLocationId);
  const north = areas.find(item => item.name === 'North Zone');
  const south = areas.find(item => item.name === 'South Zone');
  assert.ok(north && south, 'the seeded public North and South areas must both be listed');
  assert.match(north.id, /^pa_[a-f0-9]{32}$/);
  assert.match(south.id, /^pa_[a-f0-9]{32}$/);
  assert.notEqual(north.id, south.id);
  assert.equal(new Set(areas.map(item => item.id)).size, areas.length, 'areas are deduplicated by database-backed public ID');

  const northResults = await request('/availability', { parkingAreaId: north.id, categoryCode, arrivalLocal: arrival, departureLocal: departure });
  assert.equal(northResults.status, 200);
  const northBody = await northResults.json();
  assert.deepEqual(northBody.results.map(item => item.zone), ['North Zone']);
  assert.equal(northBody.results[0].available, true);

  const legacyResults = await request('/availability', { locationId: publicLocationId, categoryCode, arrivalLocal: arrival, departureLocal: departure });
  assert.equal(legacyResults.status, 200);
  assert.deepEqual((await legacyResults.json()).results.map(item => item.zone), ['North Zone', 'South Zone'], 'legacy location requests remain available during frontend rollout');

  const southResults = await request('/availability', { parkingAreaId: south.id, categoryCode, arrivalLocal: arrival, departureLocal: departure });
  assert.equal(southResults.status, 200);
  const southBody = await southResults.json();
  assert.deepEqual(southBody.results.map(item => item.zone), ['South Zone']);
  assert.equal(southBody.results[0].available, false, 'South has Bobtail capacity but no Tractor + Trailer capacity');

  const rejected = await request('/bookings', payload(99, { parkingAreaId: south.id }), 'south-unavailable-zone-booking-xxxxxxxx');
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'PARKING_NOT_AVAILABLE');
});

test('public parking area IDs survive migration replay and are assigned to new areas', async () => {
  const original = (await pool.query('SELECT public_id FROM parking_zones WHERE id=$1', [zoneId])).rows[0].public_id;
  assert.equal(original, publicAreaId);
  const created = await pool.query(`INSERT INTO parking_zones(location_id,name,active,public_visible)
    VALUES($1,'Migration Public ID Test Area',false,false) RETURNING id,public_id`, [locationId]);
  assert.match(created.rows[0].public_id, /^pa_[a-f0-9]{32}$/);
  assert.notEqual(created.rows[0].public_id, publicAreaId);
  await pool.query('DELETE FROM parking_zones WHERE id=$1', [created.rows[0].id]);
  assert.equal((await pool.query('SELECT public_id FROM parking_zones WHERE id=$1', [zoneId])).rows[0].public_id, original);
});

legacyCapacityTest('legacy configured-capacity fixture: inventory configuration lock', async () => {
  const configOwner = await loginAs('parking-test-owner-config');
  const inventory = (await pool.query('SELECT * FROM parking_inventory WHERE id=$1', [inventoryId])).rows[0];
  const changed = await adminRequest(`/api/admin/parking/v1/inventory/${inventoryId}`, configOwner, {
    method: 'PATCH',
    body: {
      version: inventory.version,
      capacity: 41,
      zone_id: inventory.zone_id,
      category_id: inventory.category_id,
      public_description: 'Updated customer parking description',
      restrictions: 'No oversized loads',
      public_remaining_capacity: false,
      active: true
    }
  });
  assert.equal(changed.status, 200);
  const persisted = (await pool.query('SELECT * FROM parking_inventory WHERE id=$1', [inventoryId])).rows[0];
  assert.equal(persisted.capacity, 41);
  assert.equal(persisted.public_description, 'Updated customer parking description');
  assert.equal(persisted.restrictions, 'No oversized loads');
  assert.equal(persisted.public_remaining_capacity, false);

  await setCapacity(1);
  const booking = await request('/bookings', payload(3), 'inventory-guard-booking-xxxxxx');
  assert.equal(booking.status, 201);
  const guarded = await adminRequest(`/api/admin/parking/v1/inventory/${inventoryId}`, configOwner, {
    method: 'PATCH', body: { version: persisted.version, capacity: 0 }
  });
  assert.equal(guarded.status, 409);
  assert.equal((await guarded.json()).error.code, 'CAPACITY_BELOW_RESERVED');
});

legacyCapacityTest('legacy configured-capacity fixture: lookup and cancellation serialization', async () => {
  const created = await request('/bookings', payload(1), 'lookup-cancel-xxxxxxxxxxxxxxx');
  assert.equal(created.status, 201);
  const booking = (await created.json()).booking;
  const unknown = await request('/bookings/lookup', { reservationNumber: booking.reservationNumber, lookupCredential: 'wrong-credential' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'BOOKING_NOT_FOUND');
  const lookup = await request('/bookings/lookup', { reservationNumber: booking.reservationNumber, lookupCredential: booking.lookupCredential });
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).booking.reservationNumber, booking.reservationNumber);
  const secondCreated = await request('/bookings', payload(22, { arrivalLocal: '2031-05-12T09:00', departureLocal: '2031-05-13T09:00' }), 'lookup-other-reservation-xxxxxx');
  assert.equal(secondCreated.status, 201);
  const secondBooking = (await secondCreated.json()).booking;
  const crossLookup = await request('/bookings/lookup', { reservationNumber: booking.reservationNumber, lookupCredential: secondBooking.lookupCredential });
  assert.equal(crossLookup.status, 404, 'Reservation B credentials cannot retrieve Reservation A');

  const cancellations = await Promise.all([...Array(2)].map(() => request(`/bookings/${booking.publicToken}/cancel`, {
    lookupCredential: booking.lookupCredential,
    reason: 'Plans changed'
  })));
  const cancellationResults = await Promise.all(cancellations.map(async response => ({ status: response.status, body: await response.json() })));
  assert.equal(cancellationResults.filter(result => result.status === 200).length, 2);
  assert.equal(cancellationResults.filter(result => result.body.idempotent === true).length, 1);
  const row = await bookingRow(booking.reservationNumber);
  const history = await pool.query("SELECT * FROM parking_booking_status_history WHERE booking_id=$1 AND new_status='CANCELLED'", [row.id]);
  assert.equal(history.rowCount, 1);

  await pool.query('UPDATE parking_locations SET cancellation_cutoff_hours=100000 WHERE id=$1', [locationId]);
  const ineligibleCreated = await request('/bookings', payload(2), 'ineligible-cancel-xxxxxxxxxxx');
  assert.equal(ineligibleCreated.status, 201);
  const ineligible = (await ineligibleCreated.json()).booking;
  const ineligibleCancel = await request(`/bookings/${ineligible.publicToken}/cancel`, { lookupCredential: ineligible.lookupCredential });
  assert.equal(ineligibleCancel.status, 409);
  assert.equal((await ineligibleCancel.json()).error.code, 'CANCELLATION_NOT_ELIGIBLE');
});

legacyCapacityTest('legacy configured-capacity fixture: immutable price and status history', async () => {
  const created = await request('/bookings', payload(1), 'immutable-booking-xxxxxxxxxxxx');
  assert.equal(created.status, 201);
  const booking = (await created.json()).booking;
  const row = await bookingRow(booking.reservationNumber);
  const snapshotResult = await pool.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1', [row.id]);
  const originalSnapshot = snapshotResult.rows[0].snapshot;
  await pool.query('UPDATE parking_rate_rules SET daily_rate_cents=daily_rate_cents+999 WHERE location_id=$1 AND category_id=$2', [locationId, categoryId]);
  const lookup = await request('/bookings/lookup', { reservationNumber: booking.reservationNumber, lookupCredential: booking.lookupCredential });
  assert.equal(lookup.status, 200);
  const lookupBody = await lookup.json();
  const { rateRuleId: _internalRateRuleId, rateRuleVersion: _internalRateRuleVersion, ...publicSnapshot } = originalSnapshot;
  const { quoteId: _quoteId, ...publicLookupSnapshot } = lookupBody.booking.price;
  assert.deepEqual(publicLookupSnapshot, publicSnapshot);
  assert.equal(Object.hasOwn(lookupBody.booking.price, 'rateRuleId'), false);
  await assert.rejects(pool.query("UPDATE parking_booking_price_snapshots SET snapshot='{}'::jsonb WHERE booking_id=$1", [row.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE parking_booking_status_history SET reason='tamper' WHERE booking_id=$1", [row.id]), /immutable/);
  await assert.rejects(pool.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,version)
    VALUES($1,'NOT_A_STATUS','SYSTEM',2)`, [row.id]), /parking_status_history_new_status_check/);
  await assert.rejects(pool.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,version)
    VALUES($1,'CONFIRMED','SYSTEM',1)`, [row.id]), /parking_status_history_version_unique/);
  await assert.rejects(pool.query("UPDATE parking_bookings SET status='CANCELLED',version=version+1 WHERE id=$1", [row.id]), /requires matching immutable history/);
});

test('admin sessions use secure cookie attributes, enforce CSRF and roles, and reject disabled or expired users', async () => {
  const passwordRow = await pool.query('SELECT password_hash FROM parking_admin_users WHERE username=$1', ['parking-test-owner']);
  assert.notEqual(passwordRow.rows[0].password_hash, testPassword);
  assert.match(passwordRow.rows[0].password_hash, /^\$2[aby]\$/);

  const badLogin = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'parking-test-owner', password: 'incorrect-password' })
  });
  assert.equal(badLogin.status, 401);
  const disabledLogin = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'parking-test-disabled', password: testPassword })
  });
  assert.equal(disabledLogin.status, 401);

  let owner = await loginAs('parking-test-owner');
  const setCookie = owner.response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const session = await adminRequest('/api/admin/auth/session', owner);
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.role, 'OWNER');

  const missingCsrf = await adminRequest('/api/admin/auth/logout', owner, { method: 'POST', body: {}, csrfToken: null });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'CSRF_REJECTED');
  const logout = await adminRequest('/api/admin/auth/logout', owner, { method: 'POST', body: {} });
  assert.equal(logout.status, 204);
  const afterLogout = await adminRequest('/api/admin/auth/session', owner);
  assert.equal(afterLogout.status, 401);

  const staff = await loginAs('parking-test-staff');
  const staffConfig = await adminRequest('/api/admin/parking/v1/locations', staff);
  assert.equal(staffConfig.status, 403);
  assert.equal((await staffConfig.json()).error.code, 'PERMISSION_DENIED');
  for (const [path, body] of [
    ['/api/admin/parking/v1/locations', { name: 'Unauthorized location' }],
    ['/api/admin/parking/v1/zones', { locationId, name: 'Unauthorized zone' }],
    [`/api/admin/parking/v1/inventory/${inventoryId}`, { version: 1, capacity: 1 }],
    ['/api/admin/parking/v1/rates', { locationId, name: 'Unauthorized rate' }],
    ['/api/admin/parking/v1/closures', { locationId, startsAt: '2031-01-10T10:00:00Z', endsAt: '2031-01-10T11:00:00Z' }],
    ['/api/admin/parking/v1/admin-users', { username: 'unauthorized-user', password: testPassword, role: 'STAFF' }],
    ['/api/admin/parking/v1/admin-users/1', { active: false }]
  ]) {
    const denied = await adminRequest(path, staff, { method: path.includes(`/inventory/${inventoryId}`) || path.endsWith('/1') ? 'PATCH' : 'POST', body });
    assert.equal(denied.status, 403, path);
    assert.equal((await denied.json()).error.code, 'PERMISSION_DENIED');
  }
  const configOwner = await loginAs('parking-test-owner-config');
  const ownerConfig = await adminRequest('/api/admin/parking/v1/locations', configOwner);
  assert.equal(ownerConfig.status, 200);

  owner = await loginAs('parking-test-owner');
  const rawToken = decodeURIComponent(owner.cookie.slice(owner.cookie.indexOf('=') + 1));
  await pool.query("UPDATE parking_admin_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1", [digest(`${rawToken}:${process.env.PARKING_SESSION_TOKEN_PEPPER || ''}`)]);
  const expired = await adminRequest('/api/admin/auth/session', owner);
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, 'AUTHENTICATION_REQUIRED');
});

test('owner user management is audited, rejects stale writes, and preserves a final active owner', async () => {
  const owner = await loginAs('parking-test-owner-config');
  const staff = await loginAs('parking-test-staff');
  const staffRead = await adminRequest('/api/admin/parking/v1/admin-users', staff);
  assert.equal(staffRead.status, 403);
  assert.equal((await staffRead.json()).error.code, 'PERMISSION_DENIED');

  const username = `access-test-${Date.now()}`;
  const createdResponse = await adminRequest('/api/admin/parking/v1/admin-users', owner, {
    method: 'POST', body: { username, password: 'Access-management-test-2031', role: 'STAFF' }
  });
  const createdBody = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(createdBody));
  assert.equal(createdBody.item.role, 'STAFF');
  assert.equal(createdBody.item.active, true);
  assert.equal(Number(createdBody.item.version), 1);
  assert.equal(Object.hasOwn(createdBody.item, 'password_hash'), false);

  const stale = await adminRequest(`/api/admin/parking/v1/admin-users/${createdBody.item.id}`, owner, {
    method: 'PATCH', body: { version: 0, role: 'OWNER' }
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'ADMIN_USER_VERSION_CONFLICT');

  const promotedResponse = await adminRequest(`/api/admin/parking/v1/admin-users/${createdBody.item.id}`, owner, {
    method: 'PATCH', body: { version: createdBody.item.version, role: 'OWNER' }
  });
  const promotedBody = await promotedResponse.json();
  assert.equal(promotedResponse.status, 200, JSON.stringify(promotedBody));
  assert.equal(promotedBody.item.role, 'OWNER');
  assert.equal(Number(promotedBody.item.version), 2);
  const reset = await adminRequest(`/api/admin/parking/v1/admin-users/${createdBody.item.id}`, owner, {
    method: 'PATCH', body: { version: promotedBody.item.version, password: 'Access-management-reset-2031' }
  });
  assert.equal(reset.status, 200, JSON.stringify(await reset.json()));

  // Isolate one active owner to exercise the server-side invariant. The next
  // test resets the established test accounts in beforeEach.
  await pool.query('UPDATE parking_admin_users SET active=false WHERE username<>$1', ['parking-test-owner-config']);
  const protectedOwner = (await adminRequest('/api/admin/parking/v1/admin-users', owner)).json();
  const protectedItems = (await protectedOwner).items;
  const onlyOwner = protectedItems.find(item => item.username === 'parking-test-owner-config');
  const demote = await adminRequest(`/api/admin/parking/v1/admin-users/${onlyOwner.id}`, owner, {
    method: 'PATCH', body: { version: onlyOwner.version, role: 'STAFF' }
  });
  assert.equal(demote.status, 409);
  assert.equal((await demote.json()).error.code, 'LAST_ACTIVE_OWNER_REQUIRED');

  const audits = await pool.query(`SELECT id,action,metadata FROM parking_audit_events
    WHERE entity_type='admin_user' AND entity_id=$1 ORDER BY id`, [String(createdBody.item.id)]);
  assert.deepEqual(audits.rows.map(row => row.action), ['CREATE_ADMIN_USER', 'CHANGE_ADMIN_USER_ROLE', 'RESET_ADMIN_USER_CREDENTIALS']);
  assert.ok(audits.rows.every(row => !JSON.stringify(row.metadata).includes('Access-management')));
  await assert.rejects(pool.query('UPDATE parking_audit_events SET action=$1 WHERE id=$2', ['TAMPERED', audits.rows[0].id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM parking_audit_events WHERE id=$1', [audits.rows[0].id]), /immutable/);
});

test('owner configuration keeps property fields separate and validates rate and closure writes', async () => {
  const owner = await loginAs('parking-test-owner-config');
  const location = (await pool.query('SELECT id,version FROM parking_locations WHERE id=$1', [locationId])).rows[0];
  const savedSettings = await adminRequest(`/api/admin/parking/v1/locations/${locationId}`, owner, {
    method: 'PATCH', body: { version: location.version, business_hours: 'Mon–Fri, 8:00 AM–5:00 PM' }
  });
  assert.equal(savedSettings.status, 200);
  const savedLocation = (await savedSettings.json()).item;
  assert.equal(savedLocation.business_hours, 'Mon–Fri, 8:00 AM–5:00 PM');
  const staleSettings = await adminRequest(`/api/admin/parking/v1/locations/${locationId}`, owner, {
    method: 'PATCH', body: { version: location.version, business_hours: 'Stale update' }
  });
  assert.equal(staleSettings.status, 409);
  assert.equal((await staleSettings.json()).error.code, 'BOOKING_VERSION_CONFLICT');

  const rateTestSuffix = Date.now();
  const category = (await pool.query(`INSERT INTO parking_categories(code,name,active)
    VALUES($1,$2,true) RETURNING id`, [`RATE_TEST_${rateTestSuffix}`, `Rate validation test ${rateTestSuffix}`])).rows[0];
  const ratePayload = {
    location_id: locationId, zone_id: null, category_id: category.id,
    daily_rate_cents: null, weekly_rate_cents: null, monthly_rate_cents: 125000,
    fee_cents: 0, tax_basis_points: 825, starts_at: null, ends_at: null, priority: 0, active: true
  };
  const monthlyOnly = await adminRequest('/api/admin/parking/v1/rates', owner, { method: 'POST', body: ratePayload });
  assert.equal(monthlyOnly.status, 201);
  assert.equal((await monthlyOnly.json()).item.monthly_rate_cents, 125000);
  const duplicate = await adminRequest('/api/admin/parking/v1/rates', owner, { method: 'POST', body: { ...ratePayload, weekly_rate_cents: 55000 } });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'RATE_RULE_OVERLAP');
  for (const body of [
    { ...ratePayload, daily_rate_cents: -1, active: false },
    { ...ratePayload, tax_basis_points: 10001, active: false },
    { ...ratePayload, monthly_rate_cents: null, starts_at: '2031-06-02T10:00:00Z', ends_at: '2031-06-01T10:00:00Z', active: false },
    { ...ratePayload, monthly_rate_cents: null, active: false }
  ]) {
    const invalid = await adminRequest('/api/admin/parking/v1/rates', owner, { method: 'POST', body });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'VALIDATION_ERROR');
  }

  const closure = await adminRequest('/api/admin/parking/v1/closures', owner, {
    method: 'POST', body: {
      location_id: locationId, zone_id: null, inventory_id: null, category_id: null,
      closure_type: 'FULL_CLOSURE', capacity_reduction: 0,
      starts_at: '2034-01-10T10:00:00Z', ends_at: '2034-01-10T12:00:00Z',
      reason: 'Configuration verification', internal_note: 'Disposable test record', customer_message: 'Lot temporarily closed', active: true
    }
  });
  assert.equal(closure.status, 201);
  assert.equal((await closure.json()).item.location_id, String(locationId));
});

legacyCapacityTest('legacy configured-capacity fixture: Admin workflow history', async () => {
  const created = await request('/bookings', payload(1), 'admin-workflow-xxxxxxxxxxxxxxx');
  assert.equal(created.status, 201);
  const publicBooking = (await created.json()).booking;
  let booking = await bookingRow(publicBooking.reservationNumber);
  const owner = await loginAs('parking-test-owner');

  const invalid = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/complete`, owner, {
    method: 'POST',
    body: { version: booking.version }
  });
  assert.equal(invalid.status, 409);
  assert.equal((await invalid.json()).error.code, 'BOOKING_TRANSITION_NOT_ALLOWED');

  const exactFieldsRejected = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/check-in`, owner, {
    method: 'POST',
    body: { version: booking.version, assignedZoneId: zoneId, note: 'Verified at gate', policyAcknowledged: true, conditionNote: 'No visible damage at arrival' }
  });
  assert.equal(exactFieldsRejected.status, 409);
  assert.equal((await exactFieldsRejected.json()).error.code, 'AREA_CAPACITY_HAS_NO_EXACT_SPOT');
  const checkedIn = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/check-in`, owner, {
    method: 'POST',
    body: { version: booking.version, note: 'Verified at gate', policyAcknowledged: true, conditionNote: 'No visible damage at arrival' }
  });
  assert.equal(checkedIn.status, 200);
  booking = await bookingRow(publicBooking.reservationNumber);
  assert.ok(booking.check_in_policy_acknowledged_at);
  assert.equal(booking.check_in_condition_note, 'No visible damage at arrival');
  const stale = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/check-out`, owner, {
    method: 'POST',
    body: { version: booking.version - 1 }
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'BOOKING_VERSION_CONFLICT');
  const checkedOut = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/check-out`, owner, {
    method: 'POST',
    body: { version: booking.version, note: 'Vehicle departed gate' }
  });
  assert.equal(checkedOut.status, 200);
  booking = await bookingRow(publicBooking.reservationNumber);
  const completed = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/complete`, owner, {
    method: 'POST',
    body: { version: booking.version, note: 'Parking stay completed' }
  });
  assert.equal(completed.status, 200);
  const history = await pool.query('SELECT previous_status,new_status,version FROM parking_booking_status_history WHERE booking_id=$1 ORDER BY version', [booking.id]);
  assert.deepEqual(history.rows.map(item => item.new_status), ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED']);
  assert.deepEqual(history.rows.map(item => Number(item.version)), [1, 2, 3, 4]);
  assert.equal(history.rows[1].previous_status, 'CONFIRMED');
});

legacyCapacityTest('legacy configured-capacity fixture: immutable adjustments', async () => {
  const created = await request('/bookings', payload(8), 'price-adjustment-xxxxxxxxxxxx');
  assert.equal(created.status, 201);
  const booking = await bookingRow((await created.json()).booking.reservationNumber);
  const configOwner = await loginAs('parking-test-owner-config');
  const missingReason = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/adjustments`, configOwner, {
    method: 'POST', body: { version: booking.version, adjustmentType: 'DISCOUNT', amountCents: 500 }
  });
  assert.equal(missingReason.status, 400);
  const discount = await adminRequest(`/api/admin/parking/v1/bookings/${booking.id}/adjustments`, configOwner, {
    method: 'POST', body: { version: booking.version, adjustmentType: 'DISCOUNT', amountCents: 500, reason: 'Gate promotion' }
  });
  assert.equal(discount.status, 201);
  const adjustment = (await pool.query('SELECT * FROM parking_booking_price_adjustments WHERE booking_id=$1', [booking.id])).rows[0];
  assert.equal(adjustment.adjustment_type, 'DISCOUNT');
  assert.equal(adjustment.amount_cents, -500);
  await assert.rejects(pool.query('UPDATE parking_booking_price_adjustments SET amount_cents=1 WHERE id=$1', [adjustment.id]), /immutable/);
});
