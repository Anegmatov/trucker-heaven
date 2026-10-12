process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const stripeGateway = require('../services/stripeGateway');
const app = require('../app');
const { publishDraftSnapshot, protectAssignedSpaces } = require('../services/layoutPublication');
const { reassignSpot } = require('../services/exactSpaceService');

stripeGateway.setTestAdapter({
  checkout: { sessions: { create: async () => { throw new Error('This suite must not create Stripe Checkout sessions.'); } } }
});

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing monthly customer-selected PostgreSQL tests: use parkingops_test only.');
}

const password = 'ParkingOps-monthly-selected-test-2035';
const ownerName = `monthly-selected-owner-${Date.now()}`;
const dailyInterval = { arrivalLocal: '2035-03-10T09:00', departureLocal: '2035-03-10T12:00' };
const monthlyInterval = { arrivalLocal: '2035-04-01T09:00', departureLocal: '2035-05-01T09:00' };
const occupiedInterval = { arrivalLocal: '2035-06-01T09:00', departureLocal: '2035-07-01T09:00' };
const concurrencyInterval = { arrivalLocal: '2035-08-01T09:00', departureLocal: '2035-09-01T09:00' };
const capacityInterval = { arrivalLocal: '2035-01-01T09:00', departureLocal: '2035-02-01T09:00' };
const capacityDailyInterval = { arrivalLocal: '2035-01-10T09:00', departureLocal: '2035-01-10T12:00' };
let server;
let base;
let ownerSession;
let ownerId;
let location;
let zone;
let inventory;
let category;
let ratePlan;
let draft;
let spots;
let dailyQuote;
let dailyBooking;
let boundQuote;
let occupiedBooking;
let concurrencyWinnerQuote;
let concurrencyBooking;
let capacityMonthlyBooking;
let capacityDailyBooking;

const idKey = label => `${label}-${crypto.randomBytes(18).toString('hex')}`;
const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function localInput(date, timezone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

async function request(path, body, key = '') {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

async function adminRequest(path) {
  const response = await fetch(`${base}/api/admin/parking/v1${path}`, {
    headers: { cookie: ownerSession.cookie }
  });
  return { response, body: await response.json() };
}

function payload(index, duration, interval, selectedSpotId, overrides = {}) {
  return {
    parkingAreaId: zone.public_id,
    categoryCode: category.code,
    duration,
    ...interval,
    firstName: 'Monthly',
    lastName: `Driver ${index}`,
    mobilePhone: `+1615555${String(5000 + index).padStart(4, '0')}`,
    email: `monthly.driver.${index}.${Date.now()}@example.test`,
    companyName: '  Preview   Logistics   LLC  ',
    tractorUnitNumber: `MONTH-${index}`,
    licensePlate: `MS${index}`,
    licensePlateState: 'TN',
    termsAccepted: true,
    cancellationTermsAccepted: true,
    ...(selectedSpotId ? { selectedSpotId } : {}),
    ...overrides
  };
}

async function quoteFor(body) {
  return request('/quotes', body);
}

async function bookFromQuote(body, quote, key = idKey('monthly-booking')) {
  return request('/bookings', {
    ...body,
    quoteToken: quote.body.quoteToken,
    termsVersion: quote.body.terms.version
  }, key);
}

async function createMonthly(index, spotId, interval) {
  const body = payload(index, 'MONTHLY', interval, spotId);
  const quote = await quoteFor(body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  const booking = await bookFromQuote(body, quote);
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  return { body, quote, booking };
}

async function cancelMonthly(created, reason) {
  const booking = created.booking.body.booking;
  const cancelled = await request(`/bookings/${booking.publicToken}/cancel`, {
    lookupCredential: booking.lookupCredential,
    reason
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
}

async function available(duration, interval) {
  const result = await request('/availability', {
    parkingAreaId: zone.public_id, categoryCode: category.code, duration, ...interval
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.results[0];
}

test.before(async () => {
  category = (await pool.query("SELECT id,code FROM parking_categories WHERE code='TRACTOR_TRAILER'")).rows[0];
  assert.ok(category, 'load the development seed before this integration suite');
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,'OWNER',true,0,NULL)`, [ownerName, await bcrypt.hash(password, 4)]);
  ownerId = (await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [ownerName])).rows[0].id;
  location = (await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,payment_instructions,booking_approval_mode,cancellation_cutoff_hours,
      assignment_mode,exact_mode_active,self_service_enabled,check_in_early_minutes,check_in_late_minutes,turnaround_buffer_minutes)
    VALUES($1,'Synthetic mixed-term test lot','30 Selected Way','America/Chicago','+16155550300',
      'Enter at the blue gate.','Exit through the south lane.','Pay at the office.','AUTO_CONFIRM',0,
      'ZONE_CAPACITY',false,true,120,240,0) RETURNING *`, [`Monthly selected integration ${Date.now()}`])).rows[0];
  zone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'General Truck Parking','Synthetic mixed-term area','Follow General Truck Parking signs.',
      'Use the signed exit.',10) RETURNING *`, [location.id])).rows[0];
  inventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,99,'Published positions are authoritative.',true) RETURNING *`, [zone.id, category.id])).rows[0];
  ratePlan = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Mixed term rate',2500,45000,true) RETURNING *`, [location.id, zone.id, category.id])).rows[0];
  draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,'Monthly selected physical fixture','DRAFT',$2,$2) RETURNING *`, [location.id, ownerId])).rows[0];
  const entrance = elementKey();
  const lane = elementKey();
  for (const element of [
    ['ENTRANCE', entrance, 'Main Entrance', 2, 44, 8, 8, 1],
    ['DRIVE_LANE', lane, 'Main circulation lane', 11, 46, 75, 6, 2],
    ['BUILDING', elementKey(), 'Shop', 72, 7, 18, 18, 3],
    ['ISLAND', elementKey(), 'Safety island', 44, 43, 8, 12, 4],
    ['EXIT', elementKey(), 'Exit', 89, 44, 8, 8, 5]
  ]) {
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true)`, [draft.id, ...element]);
  }
  spots = {};
  const definitions = [
    { label: '145', daily: true, monthly: true, purpose: 'CUSTOMER', publicBookable: true },
    { label: '146', daily: true, monthly: false, purpose: 'CUSTOMER', publicBookable: true },
    { label: '147', daily: true, monthly: true, purpose: 'CUSTOMER', publicBookable: true },
    { label: '148', daily: true, monthly: true, purpose: 'CUSTOMER', publicBookable: true },
    { label: 'SHOP-1', daily: false, monthly: false, purpose: 'SHOP', publicBookable: false }
  ];
  for (const [index, definition] of definitions.entries()) {
    const key = elementKey();
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,
        visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,true,'TEST','NEEDS_CLASSIFICATION',false,'NEEDS_CLASSIFICATION') RETURNING *`,
    [location.id, zone.id, inventory.id, definition.label, index + 1, key])).rows[0];
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,
        parking_spot_id,x,y,width,height,layer_order,public_visible,active,parking_purpose,daily_eligible,
        monthly_eligible,space_public_bookable,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,10,6,$9,true,true,$10,$11,$12,$13,$14)`, [
      draft.id, key, definition.label, zone.id, inventory.id, spot.id,
      16 + (index % 3) * 20, 18 + Math.floor(index / 3) * 20, 10 + index,
      definition.purpose, definition.daily, definition.monthly, definition.publicBookable,
      definition.purpose === 'CUSTOMER' ? ratePlan.id : null
    ]);
    spots[definition.label] = spot;
  }
  await pool.query(`INSERT INTO parking_area_directions(location_id,zone_id,entrance_element_key,arrival_route_element_keys,updated_by_admin_user_id)
    VALUES($1,$2,$3,$4,$5)`, [location.id, zone.id, entrance, [entrance, lane], ownerId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await publishDraftSnapshot(client, { layoutId: draft.id, actorId: ownerId });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ownerName, password })
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  ownerSession = { cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: loginBody.csrfToken };
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  stripeGateway.clearTestAdapter();
  await pool.end();
});

test('1. New Daily quote is ZONE_CAPACITY', async () => {
  const body = payload(1, 'DAILY', dailyInterval);
  dailyQuote = await quoteFor(body);
  assert.equal(dailyQuote.response.status, 200, JSON.stringify(dailyQuote.body));
  assert.equal(dailyQuote.body.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(dailyQuote.body.selectedMonthlyPosition, undefined);
});

test('2. New Daily booking creates no assignment row', async () => {
  const body = payload(1, 'DAILY', dailyInterval);
  dailyBooking = await bookFromQuote(body, dailyQuote, idKey('daily-no-assignment'));
  assert.equal(dailyBooking.response.status, 201, JSON.stringify(dailyBooking.body));
  assert.equal(dailyBooking.body.booking.assignmentMode, 'ZONE_CAPACITY');
  assert.equal(dailyBooking.body.booking.assignedSpace, null);
  const count = await pool.query(`SELECT count(*)::int count FROM reservation_spot_assignments assignment
    JOIN parking_bookings booking ON booking.id=assignment.booking_id WHERE booking.reservation_number=$1`,
  [dailyBooking.body.booking.reservationNumber]);
  assert.equal(count.rows[0].count, 0);
});

test('3. New Monthly quote requires customer-selected position', async () => {
  const result = await quoteFor(payload(3, 'MONTHLY', monthlyInterval));
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'MONTHLY_POSITION_REQUIRED');
});

test('4. Monthly booking without selected position is rejected', async () => {
  const body = payload(4, 'MONTHLY', monthlyInterval, spots['145'].id);
  const quote = await quoteFor(body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  const booking = await bookFromQuote({ ...body, selectedSpotId: undefined }, quote, idKey('monthly-missing-position'));
  assert.equal(booking.response.status, 400, JSON.stringify(booking.body));
  assert.equal(booking.body.error.code, 'MONTHLY_POSITION_REQUIRED');
  await request('/quotes/release', { quoteToken: quote.body.quoteToken });
});

test('5. Monthly customer can select an eligible position', async () => {
  const result = await request('/monthly-positions', {
    parkingAreaId: zone.public_id, categoryCode: category.code, duration: 'MONTHLY', ...monthlyInterval
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.assignmentMode, 'CUSTOMER_SELECTED_SPOT');
  assert.equal(result.body.positions.find(item => item.parkingSpotId === Number(spots['145'].id)).state, 'AVAILABLE');
  const body = payload(5, 'MONTHLY', monthlyInterval, spots['145'].id);
  boundQuote = await quoteFor(body);
  assert.equal(boundQuote.response.status, 200, JSON.stringify(boundQuote.body));
  assert.deepEqual(boundQuote.body.selectedMonthlyPosition, { id: Number(spots['145'].id), label: '145' });
  assert.ok(boundQuote.body.hold.expiresAt);
});

test('6. Ineligible monthly position is rejected', async () => {
  const result = await quoteFor(payload(6, 'MONTHLY', monthlyInterval, spots['146'].id));
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'MONTHLY_POSITION_UNAVAILABLE');
});

test('7. Blocked position is rejected', async () => {
  await pool.query(`INSERT INTO parking_spot_blocks(parking_spot_id,starts_at,ends_at,reason,created_by_admin_user_id)
    VALUES($1,'2035-04-01T00:00:00Z','2035-05-02T00:00:00Z','Synthetic monthly block',$2)`, [spots['147'].id, ownerId]);
  const result = await quoteFor(payload(7, 'MONTHLY', monthlyInterval, spots['147'].id));
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'MONTHLY_POSITION_UNAVAILABLE');
  await pool.query("UPDATE parking_spot_blocks SET released_at=now(),released_by_admin_user_id=$2 WHERE parking_spot_id=$1 AND reason='Synthetic monthly block'", [spots['147'].id, ownerId]);
});

test('8. Occupied or reserved overlapping position is rejected', async () => {
  occupiedBooking = await createMonthly(8, spots['147'].id, occupiedInterval);
  const rejected = await quoteFor(payload(80, 'MONTHLY', occupiedInterval, spots['147'].id));
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, 'MONTHLY_POSITION_UNAVAILABLE');
  await cancelMonthly(occupiedBooking, 'Synthetic overlap proof complete');
});

test('9. Selected position is bound to quote', async () => {
  const row = (await pool.query(`SELECT assignment_mode,parking_spot_id,request_hash,rate_basis_hash,hold_released_at
    FROM parking_public_quotes WHERE token_hash=$1`, [digest(boundQuote.body.quoteToken)])).rows[0];
  assert.equal(row.assignment_mode, 'CUSTOMER_SELECTED_SPOT');
  assert.equal(String(row.parking_spot_id), String(spots['145'].id));
  assert.ok(row.request_hash && row.rate_basis_hash);
  assert.equal(row.hold_released_at, null);
});

test('10. Expired hold and quote are rejected', async () => {
  await request('/quotes/release', { quoteToken: boundQuote.body.quoteToken });
  const expiredToken = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO parking_public_quotes(token_hash,request_hash,location_id,inventory_id,parking_spot_id,
      assignment_mode,rate_rule_id,arrival_at,departure_at,protected_until_at,pricing_snapshot,rate_basis_hash,expires_at)
    SELECT $1,request_hash,location_id,inventory_id,parking_spot_id,assignment_mode,rate_rule_id,arrival_at,departure_at,
      protected_until_at,pricing_snapshot,rate_basis_hash,now()-interval '1 minute'
    FROM parking_public_quotes WHERE token_hash=$2`, [digest(expiredToken), digest(boundQuote.body.quoteToken)]);
  const result = await request('/bookings', {
    ...payload(10, 'MONTHLY', monthlyInterval, spots['145'].id),
    quoteToken: expiredToken,
    termsVersion: boundQuote.body.terms.version
  }, idKey('expired-monthly-quote'));
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'QUOTE_EXPIRED');
});

test('11. Pending Monthly requests do not block the same position before payment', async () => {
  const first = payload(11, 'MONTHLY', concurrencyInterval, spots['148'].id);
  const second = payload(12, 'MONTHLY', concurrencyInterval, spots['148'].id);
  const results = await Promise.all([quoteFor(first), quoteFor(second)]);
  assert.equal(results.filter(item => item.response.status === 200).length, 2);
  concurrencyWinnerQuote = results[0];
  concurrencyWinnerQuote.requestBody = first;
  concurrencyWinnerQuote.competingQuote = results[1];
  concurrencyWinnerQuote.competingRequestBody = second;
});

test('12. Only one exact-space finalization can win; the loser is not reassigned automatically', async () => {
  const activeHolds = await pool.query(`SELECT parking_spot_id FROM parking_public_quotes
    WHERE assignment_mode='CUSTOMER_SELECTED_SPOT' AND consumed_booking_id IS NULL AND hold_released_at IS NULL
      AND expires_at>now() AND arrival_at<'2035-09-01T14:00:00Z' AND protected_until_at>'2035-08-01T14:00:00Z'`);
  assert.equal(activeHolds.rows.filter(row => String(row.parking_spot_id) === String(spots['148'].id)).length, 2);
  const results = await Promise.all([
    bookFromQuote(concurrencyWinnerQuote.requestBody, concurrencyWinnerQuote, idKey('monthly-concurrency-first')),
    bookFromQuote(concurrencyWinnerQuote.competingRequestBody, concurrencyWinnerQuote.competingQuote, idKey('monthly-concurrency-second'))
  ]);
  assert.equal(results.filter(item => item.response.status === 201).length, 1);
  assert.equal(results.filter(item => item.body.error?.code === 'MONTHLY_POSITION_UNAVAILABLE').length, 1);
  concurrencyBooking = results.find(item => item.response.status === 201);
  assert.equal(concurrencyBooking.body.booking.assignedSpotLabel, '148');
  const assignments = await pool.query(`SELECT spot.public_label FROM reservation_spot_assignments assignment
    JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
    JOIN parking_bookings booking ON booking.id=assignment.booking_id
    WHERE booking.arrival_at='2035-08-01T14:00:00Z' AND booking.location_id=$1`, [location.id]);
  assert.deepEqual(assignments.rows.map(row => row.public_label), ['148']);
});

test('13. Monthly assignment reduces daily area capacity', async () => {
  const baseline = await available('DAILY', capacityDailyInterval);
  assert.equal(baseline.remainingCapacity, 4);
  capacityMonthlyBooking = await createMonthly(13, spots['145'].id, capacityInterval);
  const after = await available('DAILY', capacityDailyInterval);
  assert.equal(after.remainingCapacity, 3);
});

test('14. Daily area commitment and monthly assignment are not double-counted', async () => {
  const body = payload(14, 'DAILY', capacityDailyInterval);
  const quote = await quoteFor(body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  capacityDailyBooking = await bookFromQuote(body, quote, idKey('daily-with-monthly'));
  assert.equal(capacityDailyBooking.response.status, 201, JSON.stringify(capacityDailyBooking.body));
  const after = await available('DAILY', capacityDailyInterval);
  assert.equal(after.remainingCapacity, 2, 'one monthly booking plus one daily booking consume two of four positions');
});

test('15. Cancellation releases selected monthly position', async () => {
  const booking = capacityMonthlyBooking.booking.body.booking;
  const cancelled = await request(`/bookings/${booking.publicToken}/cancel`, {
    lookupCredential: booking.lookupCredential, reason: 'Synthetic cancellation release proof'
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  const assignment = (await pool.query(`SELECT released_at FROM reservation_spot_assignments assignment
    JOIN parking_bookings booking ON booking.id=assignment.booking_id WHERE booking.reservation_number=$1`,
  [booking.reservationNumber])).rows[0];
  assert.ok(assignment.released_at);
  assert.equal((await available('DAILY', capacityDailyInterval)).remainingCapacity, 3);
});

test('16. Check-out releases selected monthly position according to lifecycle', async () => {
  const arrival = new Date(Date.now() + 30 * 60000);
  const interval = { arrivalLocal: localInput(arrival), departureLocal: localInput(new Date(arrival.getTime() + 29 * 86400000)) };
  const created = await createMonthly(16, spots['145'].id, interval);
  const booking = created.booking.body.booking;
  const checkedIn = await request(`/bookings/${booking.publicToken}/check-in`, { lookupCredential: booking.lookupCredential });
  assert.equal(checkedIn.response.status, 200, JSON.stringify(checkedIn.body));
  const checkedOut = await request(`/bookings/${booking.publicToken}/check-out`, { lookupCredential: booking.lookupCredential });
  assert.equal(checkedOut.response.status, 200, JSON.stringify(checkedOut.body));
  const assignment = (await pool.query(`SELECT released_at,actual_check_out_at FROM reservation_spot_assignments assignment
    JOIN parking_bookings booking ON booking.id=assignment.booking_id WHERE booking.reservation_number=$1`,
  [booking.reservationNumber])).rows[0];
  assert.ok(assignment.actual_check_out_at);
  assert.ok(assignment.released_at);
});

test('17. Historical exact records still work', async () => {
  const credential = 'Historical-selected-suite-credential';
  const legacy = (await pool.query(`INSERT INTO parking_bookings(
      reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
      assignment_mode_snapshot,arrival_at,departure_at,first_name,last_name,mobile_phone,email,company_name,
      tractor_unit_number,license_plate,license_plate_state,terms_accepted_at,cancellation_terms_accepted_at,
      parking_product,payment_status)
    VALUES($1,$2,$3,$4,$5,$6,'CONFIRMED','EXACT_SPOT','2036-01-01T15:00:00Z','2036-01-02T15:00:00Z',
      'Historical','Driver','+16155550017','historical17@example.test','Historical Preview Carrier',
      'HIST-17','HIST17','TN',now(),now(),'LEGACY','NOT_REQUIRED') RETURNING *`, [
    `HIST-${Date.now()}`, `historical-token-${Date.now()}`, await bcrypt.hash(credential, 4), inventory.id, location.id, category.id
  ])).rows[0];
  await pool.query(`INSERT INTO reservation_spot_assignments(booking_id,parking_spot_id,reserved_arrival_at,
      reserved_departure_at,protected_until_at,assignment_source,assignment_reason)
    VALUES($1,$2,$3,$4,$4,'SYSTEM','Historical automatic compatibility fixture')`,
  [legacy.id, spots['147'].id, legacy.arrival_at, legacy.departure_at]);
  await pool.query(`INSERT INTO parking_booking_price_snapshots(booking_id,snapshot)
    VALUES($1,$2)`, [legacy.id, JSON.stringify({ duration: 'DAILY', totalCents: 2500 })]);
  await pool.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
    VALUES($1,'CONFIRMED','SYSTEM','Historical compatibility fixture',1)`, [legacy.id]);
  const lookup = await request('/bookings/lookup', { reservationNumber: legacy.reservation_number, lookupCredential: credential });
  assert.equal(lookup.response.status, 200, JSON.stringify(lookup.body));
  assert.equal(lookup.body.booking.assignmentMode, 'EXACT_SPOT');
  assert.equal(lookup.body.booking.assignedSpotLabel, '147');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const moved = await reassignSpot(client, { bookingId: legacy.id, replacementSpotId: spots['145'].id,
      adminUserId: ownerId, reason: 'Historical exact compatibility proof', bookingVersion: legacy.version });
    await client.query('COMMIT');
    assert.equal(moved.spot.public_label, '145');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const refreshed = await request('/bookings/lookup', { reservationNumber: legacy.reservation_number, lookupCredential: credential });
  assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.booking.assignedSpotLabel, '145');
});

test('18. Publication cannot invalidate monthly selected assignments', async () => {
  const currentDraft = (await pool.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT'", [location.id])).rows[0];
  const target = (await pool.query(`SELECT * FROM parking_layout_elements WHERE layout_id=$1 AND parking_spot_id=$2`,
  [currentDraft.id, spots['148'].id])).rows[0];
  await pool.query(`UPDATE parking_layout_elements SET parking_purpose='SHOP',space_public_bookable=false,
    daily_eligible=false,monthly_eligible=false,rate_plan_id=NULL WHERE id=$1`, [target.id]);
  await assert.rejects(protectAssignedSpaces(pool, currentDraft), error => error.code === 'ACTIVE_ASSIGNMENT_CONFLICT');
  await pool.query(`UPDATE parking_layout_elements SET parking_purpose='CUSTOMER',space_public_bookable=true,
    daily_eligible=true,monthly_eligible=true,rate_plan_id=$2 WHERE id=$1`, [target.id, ratePlan.id]);
  await cancelMonthly({ booking: concurrencyBooking }, 'Synthetic publication protection proof complete');
});

test('19. Publication cannot reduce area capacity below Daily commitments', async () => {
  const currentDraft = (await pool.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT'", [location.id])).rows[0];
  await pool.query(`UPDATE parking_layout_elements SET daily_eligible=false
    WHERE layout_id=$1 AND parking_spot_id IS NOT NULL`, [currentDraft.id]);
  await assert.rejects(protectAssignedSpaces(pool, currentDraft), error => error.code === 'AREA_CAPACITY_COMMITMENT_CONFLICT');
  await pool.query(`UPDATE parking_layout_elements SET daily_eligible=true
    WHERE layout_id=$1 AND parking_spot_id IN ($2,$3,$4,$5)`,
  [currentDraft.id, spots['145'].id, spots['146'].id, spots['147'].id, spots['148'].id]);
});

test('20. Company and carrier name persists and is searchable', async () => {
  const booking = dailyBooking.body.booking;
  const stored = (await pool.query('SELECT company_name FROM parking_bookings WHERE reservation_number=$1', [booking.reservationNumber])).rows[0];
  assert.equal(stored.company_name, 'Preview Logistics LLC');
  assert.equal(booking.companyName, 'Preview Logistics LLC');
  const reservations = await adminRequest('/bookings?q=Preview%20Logistics');
  assert.equal(reservations.response.status, 200, JSON.stringify(reservations.body));
  assert.ok(reservations.body.bookings.some(item => item.reservation_number === booking.reservationNumber));
  const identityBody = payload(20, 'DAILY', { arrivalLocal: '2036-02-10T09:00', departureLocal: '2036-02-10T12:00' });
  const identityQuote = await quoteFor(identityBody);
  assert.equal(identityQuote.response.status, 200, JSON.stringify(identityQuote.body));
  const identityAttempt = await request('/booking-attempts', {
    ...identityBody,
    quoteToken: identityQuote.body.quoteToken,
    termsVersion: identityQuote.body.terms.version
  }, idKey('company-customer-identity'));
  assert.equal(identityAttempt.response.status, 201, JSON.stringify(identityAttempt.body));
  const customers = await adminRequest('/customers?q=Preview%20Logistics');
  assert.equal(customers.response.status, 200, JSON.stringify(customers.body));
  assert.ok(customers.body.customers.some(item => item.companyName === 'Preview Logistics LLC'));
});
