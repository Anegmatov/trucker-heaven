const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing lifecycle PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

const password = 'ParkingOps-lifecycle-test-2034';
const runNonce = `${process.pid}-${Date.now()}`;
let server;
let base;
let owner;
let staff;
let locationId;
let bobtailAreaId;
let generalAreaId;
let bobtailInventoryId;
let generalInventoryId;
let bobtailSpotIds;
let premiumBobtailRatePlanId;

function localInput(date, zone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

async function createAdmin(username, role) {
  const result = await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,$3,true,0,NULL)
    ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,
      active=true,failed_login_count=0,locked_until=NULL RETURNING id`, [username, await bcrypt.hash(password, 4), role]);
  return result.rows[0].id;
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
    method: 'POST', headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': `${idempotencyKey}-${runNonce}` } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function parkingRequest(index, { categoryCode = 'BOBTAIL', arrivalLocal, departureLocal } = {}) {
  const general = categoryCode === 'TRACTOR_TRAILER';
  return {
    parkingAreaId: general ? generalAreaId : bobtailAreaId,
    categoryCode,
    arrivalLocal,
    departureLocal,
    firstName: 'Lifecycle', lastName: `Driver${index}`,
    mobilePhone: `+1615555${String(2000 + index).slice(-4)}`,
    email: `lifecycle.driver.${index}@example.test`, companyName: 'Lifecycle Test',
    tractorUnitNumber: `LC-${index}`, licensePlate: `LC${index}`, licensePlateState: 'TN',
    trailerNumber: general ? `TRL-${index}` : '', specialInstructions: '',
    termsAccepted: true, cancellationTermsAccepted: true
  };
}

async function publicAvailability(categoryCode, arrivalLocal, departureLocal, duration) {
  const result = await publicRequest('/availability', {
    parkingAreaId: categoryCode === 'TRACTOR_TRAILER' ? generalAreaId : bobtailAreaId,
    categoryCode, arrivalLocal, departureLocal, ...(duration ? { duration } : {})
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.results;
}

async function configureSpace(label, configuration) {
  const current = await adminRequest(`/locations/${locationId}/layout`, owner);
  const body = await current.json();
  assert.equal(current.status, 200, JSON.stringify(body));
  const element = body.draft.elements.find(item => item.label === label);
  assert.ok(element, `Draft must include ${label}`);
  const saved = await adminRequest(`/layouts/${body.draft.id}/spaces/${element.id}`, owner, {
    method: 'PATCH', body: { layoutVersion: body.draft.version, version: element.version, ...configuration }
  });
  assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
}

test.before(async () => {
  const categories = (await pool.query("SELECT id,code FROM parking_categories WHERE code IN ('BOBTAIL','TRACTOR_TRAILER')")).rows;
  const bobtail = categories.find(item => item.code === 'BOBTAIL');
  const general = categories.find(item => item.code === 'TRACTOR_TRAILER');
  assert.ok(bobtail && general, 'the disposable seed must provide Bobtail and General Truck categories');
  const ownerId = await createAdmin('lifecycle-test-owner', 'OWNER');
  await createAdmin('lifecycle-test-staff', 'STAFF');
  const location = await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,road_directions_url,payment_instructions,assignment_mode,self_service_enabled,
      check_in_early_minutes,check_in_late_minutes,turnaround_buffer_minutes)
    VALUES('Operational Lifecycle Integration Lot ${Date.now()}','Disposable lifecycle fixture','22 Lifecycle Way','America/Chicago','+16155550220',
      'Use the marked entrance.','Use the marked exit.','https://maps.example.test/lifecycle','Pay at the office.','EXACT_SPOT',true,120,240,0)
    RETURNING id`);
  locationId = location.rows[0].id;
  const bobtailZone = await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'Lifecycle Bobtail','Bobtail customer parking','Use the Bobtail lane.','Leave through the south exit.',10) RETURNING id,public_id`, [locationId]);
  const generalZone = await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'Lifecycle General','General Truck customer parking','Use the General lane.','Leave through the south exit.',20) RETURNING id,public_id`, [locationId]);
  bobtailAreaId = bobtailZone.rows[0].public_id;
  generalAreaId = generalZone.rows[0].public_id;
  const bobtailInventory = await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,0,'Exact Bobtail parking',true) RETURNING id`, [bobtailZone.rows[0].id, bobtail.id]);
  const generalInventory = await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,0,'Exact General Truck parking',true) RETURNING id`, [generalZone.rows[0].id, general.id]);
  bobtailInventoryId = bobtailInventory.rows[0].id;
  generalInventoryId = generalInventory.rows[0].id;
  await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,fee_cents,tax_basis_points,starts_at,ends_at,priority,active)
    VALUES($1,$2,$3,3200,21000,70000,500,825,NULL,NULL,0,true),($1,$4,$5,5500,28500,98000,500,825,NULL,NULL,0,true),
      ($1,$2,$3,99999,NULL,NULL,0,0,'2030-01-01T00:00:00.000Z','2031-01-01T00:00:00.000Z',100,true)`,
    [locationId, bobtailZone.rows[0].id, bobtail.id, generalZone.rows[0].id, general.id]);
  premiumBobtailRatePlanId = (await pool.query(`INSERT INTO parking_rate_rules(
      location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,fee_cents,tax_basis_points,priority,active)
    VALUES($1,$2,$3,'Premium Bobtail',4200,21000,500,825,-10,true) RETURNING id`,
  [locationId, bobtailZone.rows[0].id, bobtail.id])).rows[0].id;

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await loginAs('lifecycle-test-owner');
  staff = await loginAs('lifecycle-test-staff');

  const createdLayout = await adminRequest(`/locations/${locationId}/layout`, owner, { method: 'POST', body: { name: 'Lifecycle fixture layout' } });
  const layout = await createdLayout.json();
  assert.equal(createdLayout.status, 201, JSON.stringify(layout));
  let layoutVersion = layout.draft.version;
  const mapElements = [];
  for (const element of [
    { element_type: 'ENTRANCE', label: 'Lifecycle Entrance', x: 3, y: 3, width: 12, height: 6, layer_order: 1 },
    { element_type: 'EXIT', label: 'Lifecycle Exit', x: 83, y: 90, width: 12, height: 6, layer_order: 2 },
    { element_type: 'DRIVE_LANE', label: 'Lifecycle Drive', x: 5, y: 17, width: 90, height: 6, layer_order: 3 }
  ]) {
    const response = await adminRequest(`/layouts/${layout.draft.id}/elements`, owner, {
      method: 'POST', body: { ...element, rotation: 0, public_visible: true, active: true, layout_version: layoutVersion }
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    layoutVersion = body.layoutVersion;
    mapElements.push(body.item);
  }
  for (const zone of [bobtailZone.rows[0], generalZone.rows[0]]) {
    const version = (await pool.query('SELECT version FROM parking_zones WHERE id=$1', [zone.id])).rows[0].version;
    const response = await adminRequest(`/locations/${locationId}/areas/${zone.id}/directions`, owner, { method: 'PATCH', body: {
      version, arrivalDirections: 'Follow marked customer signs.', exitDirections: 'Follow the marked south exit.',
      entranceElementKey: mapElements[0].element_key, exitElementKey: mapElements[1].element_key,
      arrivalRouteElementKeys: [mapElements[0].element_key, mapElements[2].element_key],
      exitRouteElementKeys: [mapElements[2].element_key, mapElements[1].element_key]
    } });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  for (const specification of [
    { zoneId: bobtailZone.rows[0].id, inventoryId: bobtailInventoryId, labelPrefix: 'B-', quantity: 2, x: 12, y: 32, groupName: 'Lifecycle Bobtail' },
    { zoneId: generalZone.rows[0].id, inventoryId: generalInventoryId, labelPrefix: 'G-', quantity: 4, x: 52, y: 32, groupName: 'Lifecycle General' }
  ]) {
    const response = await adminRequest(`/locations/${locationId}/spots/bulk`, owner, { method: 'POST', body: {
      ...specification, startingNumber: 1, numberPadding: 2, rows: 1, spacesPerRow: specification.quantity,
      orientation: 'HORIZONTAL', rowDirection: 'FORWARD', spacing: 2, width: 7, height: 9, layoutVersion
    } });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    layoutVersion = body.layoutVersion;
  }
  await configureSpace('B-01', { parkingPurpose: 'CUSTOMER', dailyEligible: true, weeklyEligible: true, monthlyEligible: false, publiclyBookable: true, active: true, internalNote: '' });
  await configureSpace('B-02', { parkingPurpose: 'CUSTOMER', dailyEligible: true, weeklyEligible: true, monthlyEligible: false, publiclyBookable: true, active: true, internalNote: '', ratePlanId: premiumBobtailRatePlanId });
  await configureSpace('G-01', { parkingPurpose: 'CUSTOMER', dailyEligible: false, weeklyEligible: true, monthlyEligible: true, publiclyBookable: true, active: true, internalNote: '' });
  await configureSpace('G-02', { parkingPurpose: 'CUSTOMER', dailyEligible: false, weeklyEligible: true, monthlyEligible: true, publiclyBookable: true, active: true, internalNote: '' });
  await configureSpace('G-03', { parkingPurpose: 'SHOP', dailyEligible: false, weeklyEligible: false, monthlyEligible: false, publiclyBookable: false, active: true, internalNote: 'Internal shop bay' });
  await configureSpace('G-04', { parkingPurpose: 'UNRESOLVED', dailyEligible: false, weeklyEligible: false, monthlyEligible: false, publiclyBookable: false, active: true, internalNote: 'Awaiting classification' });
  const readyLayout = await adminRequest(`/locations/${locationId}/layout`, owner);
  const ready = await readyLayout.json();
  const published = await adminRequest(`/layouts/${ready.draft.id}/publish`, owner, { method: 'POST', body: { version: ready.draft.version, physicalConfirmation: true } });
  assert.equal(published.status, 200, JSON.stringify(await published.json()));
  bobtailSpotIds = (await pool.query("SELECT id,public_label FROM parking_spots WHERE location_id=$1 AND public_label LIKE 'B-%' ORDER BY public_label", [locationId])).rows;
  assert.equal(bobtailSpotIds.length, 2);
  assert.equal(ownerId > 0, true);
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test.skip('legacy automatic exact-space operational lifecycle is superseded by the Daily area and Monthly customer-selected lifecycle suites', async () => {
  const bobtailDay = { arrivalLocal: '2034-05-10T09:00', departureLocal: '2034-05-11T09:00' };
  const generalWeek = { arrivalLocal: '2034-06-10T09:00', departureLocal: '2034-06-17T09:00' };
  const monthly = { arrivalLocal: localInput(new Date(Date.now() + 30 * 60000)), departureLocal: localInput(new Date(Date.now() + 29 * 86400000)) };

  const bobtailQuote = await publicRequest('/quotes', { parkingAreaId: bobtailAreaId, categoryCode: 'BOBTAIL', ...bobtailDay });
  assert.equal(bobtailQuote.response.status, 200, JSON.stringify(bobtailQuote.body));
  assert.equal(bobtailQuote.body.quote.duration, 'DAILY');
  assert.equal(bobtailQuote.body.quote.baseParkingCents, 3200, 'expired higher-priority rate must be ignored');
  const legacyWeeklyOnlyQuote = await publicRequest('/quotes', { parkingAreaId: generalAreaId, categoryCode: 'TRACTOR_TRAILER', ...generalWeek });
  assert.equal(legacyWeeklyOnlyQuote.response.status, 409, JSON.stringify(legacyWeeklyOnlyQuote.body));
  assert.equal(legacyWeeklyOnlyQuote.body.error.code, 'RATE_NOT_CONFIGURED');
  const monthlyQuote = await publicRequest('/quotes', { parkingAreaId: generalAreaId, categoryCode: 'TRACTOR_TRAILER', ...monthly });
  assert.equal(monthlyQuote.response.status, 200, JSON.stringify(monthlyQuote.body));
  assert.equal(monthlyQuote.body.quote.duration, 'MONTHLY');
  assert.equal(monthlyQuote.body.quote.baseParkingCents, 98000);

  const premiumInterval = { arrivalLocal: '2034-12-10T09:00', departureLocal: '2034-12-11T09:00' };
  const premiumBlock = await adminRequest(`/spots/${bobtailSpotIds[0].id}/block`, owner, { method: 'POST', body: {
    startsAt: '2034-12-10T15:00:00.000Z', endsAt: '2034-12-11T15:00:00.000Z', reason: 'Per-space pricing verification'
  } });
  assert.equal(premiumBlock.status, 201, JSON.stringify(await premiumBlock.json()));
  const premiumQuote = await publicRequest('/quotes', { parkingAreaId: bobtailAreaId, categoryCode: 'BOBTAIL', ...premiumInterval });
  assert.equal(premiumQuote.response.status, 200, JSON.stringify(premiumQuote.body));
  assert.equal(premiumQuote.body.quote.baseParkingCents, 4200, 'the quote must use the remaining exact space\'s assigned plan');
  assert.equal(premiumQuote.body.quote.ratePlanName, 'Premium Bobtail');
  const premiumUnblock = await adminRequest(`/spots/${bobtailSpotIds[0].id}/unblock`, owner, { method: 'POST', body: {} });
  assert.equal(premiumUnblock.status, 200, JSON.stringify(await premiumUnblock.json()));

  const bobtailAvailability = await publicAvailability('BOBTAIL', bobtailDay.arrivalLocal, bobtailDay.departureLocal);
  assert.equal(bobtailAvailability[0].numberedSpacesAvailable, 2);
  assert.equal(bobtailAvailability[0].pricingAvailable, true);
  assert.ok(bobtailAvailability[0].offeredDurations.some(item => item.code === 'DAILY'));
  const bobtailGuidance = await publicRequest('/availability', {
    parkingAreaId: bobtailAreaId, categoryCode: 'BOBTAIL', ...bobtailDay
  });
  assert.equal(bobtailGuidance.response.status, 200, JSON.stringify(bobtailGuidance.body));
  const guidedSpaces = bobtailGuidance.body.layout.elements.filter(item => item.elementType === 'PARKING_SPOT');
  assert.deepEqual(guidedSpaces.map(item => item.space.number).sort(), ['B-01', 'B-02', 'G-01', 'G-02'], 'customer map must exclude internal and unresolved spaces');
  assert.ok(guidedSpaces.filter(item => item.space.number.startsWith('B-')).every(item => item.space.matchesSelection && item.space.available));
  assert.ok(guidedSpaces.filter(item => item.space.number.startsWith('G-')).every(item => !item.space.matchesSelection && !item.space.available));
  const generalDaily = await publicAvailability('TRACTOR_TRAILER', bobtailDay.arrivalLocal, bobtailDay.departureLocal);
  assert.equal(generalDaily[0].numberedSpacesAvailable, 0, 'Monthly-base and internal spaces must not fill a Daily request');
  assert.ok(generalDaily[0].offeredDurations.some(item => item.code === 'WEEKLY'));
  const bobtailSevenDay = await publicAvailability('BOBTAIL', generalWeek.arrivalLocal, generalWeek.departureLocal);
  assert.equal(bobtailSevenDay[0].numberedSpacesAvailable, 2, 'a seven-day stay remains a multi-unit Daily product');

  const weeklyAvailability = await publicAvailability('TRACTOR_TRAILER', generalWeek.arrivalLocal, generalWeek.departureLocal, 'WEEKLY');
  assert.equal(weeklyAvailability[0].numberedSpacesAvailable, 2);
  const weeklyQuote = await publicRequest('/quotes', { parkingAreaId: generalAreaId, categoryCode: 'TRACTOR_TRAILER', duration: 'WEEKLY', ...generalWeek });
  assert.equal(weeklyQuote.response.status, 200, JSON.stringify(weeklyQuote.body));
  assert.equal(weeklyQuote.body.quote.duration, 'WEEKLY');
  assert.equal(weeklyQuote.body.quote.baseParkingCents, 28500);
  const weeklyBooking = await publicRequest('/bookings', {
    ...parkingRequest(1, { categoryCode: 'TRACTOR_TRAILER', ...generalWeek }), duration: 'WEEKLY'
  }, 'lifecycle-weekly-capacity-0001');
  assert.equal(weeklyBooking.response.status, 201, JSON.stringify(weeklyBooking.body));
  assert.equal(weeklyBooking.body.booking.assignedSpotLabel, null);
  assert.equal(weeklyBooking.body.booking.price.totalCents, weeklyQuote.body.quote.totalCents);

  const bobtailBooking = await publicRequest('/bookings', parkingRequest(2, { ...bobtailDay }), 'lifecycle-bobtail-daily-00002');
  assert.equal(bobtailBooking.response.status, 201, JSON.stringify(bobtailBooking.body));
  assert.equal(bobtailBooking.body.booking.assignedSpotLabel, 'B-01');
  assert.equal(bobtailBooking.body.booking.price.totalCents, bobtailQuote.body.quote.totalCents);
  assert.ok(bobtailBooking.body.booking.map.elements.some(item => item.assigned && item.space?.number === 'B-01'), 'confirmation map must highlight the assigned space');
  assert.equal(bobtailBooking.body.booking.status, 'CONFIRMED');
  const monthlyBooking = await publicRequest('/bookings', parkingRequest(4, { categoryCode: 'TRACTOR_TRAILER', ...monthly }), 'lifecycle-general-month-00004');
  assert.equal(monthlyBooking.response.status, 201, JSON.stringify(monthlyBooking.body));
  assert.equal(monthlyBooking.body.booking.assignedSpotLabel, 'G-02');

  const monthlyRow = (await pool.query('SELECT id FROM parking_bookings WHERE reservation_number=$1', [monthlyBooking.body.booking.reservationNumber])).rows[0];
  const monthlyList = await adminRequest(`/bookings?q=${encodeURIComponent(monthlyBooking.body.booking.reservationNumber)}`, staff);
  const monthlyListBody = await monthlyList.json();
  assert.equal(monthlyList.status, 200, JSON.stringify(monthlyListBody));
  assert.equal(monthlyListBody.bookings[0].snapshot.duration, 'MONTHLY');
  assert.equal(monthlyListBody.bookings[0].email, 'lifecycle.driver.4@example.test');
  assert.equal(monthlyListBody.bookings[0].company_name, 'Lifecycle Test');
  assert.equal(monthlyListBody.bookings[0].trailer_number, 'TRL-4');
  const monthlyDetail = await adminRequest(`/bookings/${monthlyRow.id}`, staff);
  const monthlyDetailBody = await monthlyDetail.json();
  assert.equal(monthlyDetail.status, 200, JSON.stringify(monthlyDetailBody));
  assert.equal(monthlyDetailBody.assignments[0].public_label, 'G-02');
  const dashboard = await adminRequest('/dashboard', staff);
  const dashboardBody = await dashboard.json();
  assert.ok(dashboardBody.summary.monthly_spaces >= 1);
  assert.ok(dashboardBody.summary.upcoming >= 1, 'future monthly reservations remain visible without allowing a past start');
  const monthlyLive = await adminRequest(`/locations/${locationId}/live-lot/snapshot?at=${encodeURIComponent(new Date().toISOString())}`, staff);
  const monthlyLiveBody = await monthlyLive.json();
  assert.equal(monthlyLive.status, 200, JSON.stringify(monthlyLiveBody));
  const monthlySpace = monthlyLiveBody.spaces.find(space => space.number === 'G-02');
  assert.equal(monthlySpace.monthlyEligible, true);
  assert.equal(monthlySpace.operationalStatus, 'AVAILABLE', 'a future reservation must not occupy the space before its interval');
  assert.equal(monthlySpace.nextReservation.reservationNumber, monthlyBooking.body.booking.reservationNumber);

  const currentInterval = { arrivalLocal: localInput(new Date(Date.now() + 30 * 60000)), departureLocal: localInput(new Date(Date.now() + 2 * 3600000)) };
  const currentBooking = await publicRequest('/bookings', parkingRequest(5, currentInterval), 'lifecycle-self-service-000005');
  assert.equal(currentBooking.response.status, 201, JSON.stringify(currentBooking.body));
  const checkedIn = await publicRequest(`/bookings/${currentBooking.body.booking.publicToken}/check-in`, { lookupCredential: currentBooking.body.booking.lookupCredential });
  assert.equal(checkedIn.response.status, 200, JSON.stringify(checkedIn.body));
  const occupied = await adminRequest(`/locations/${locationId}/live-lot`, staff);
  assert.ok((await occupied.json()).summary.OCCUPIED >= 1);
  const checkedOut = await publicRequest(`/bookings/${currentBooking.body.booking.publicToken}/check-out`, { lookupCredential: currentBooking.body.booking.lookupCredential });
  assert.equal(checkedOut.response.status, 200, JSON.stringify(checkedOut.body));
  const repeatCheckout = await publicRequest(`/bookings/${currentBooking.body.booking.publicToken}/check-out`, { lookupCredential: currentBooking.body.booking.lookupCredential });
  assert.equal(repeatCheckout.response.status, 200);
  assert.equal(repeatCheckout.body.idempotent, true);
  const currentRow = (await pool.query('SELECT id FROM parking_bookings WHERE reservation_number=$1', [currentBooking.body.booking.reservationNumber])).rows[0];
  const released = await pool.query('SELECT actual_check_in_at,actual_check_out_at,released_at FROM reservation_spot_assignments WHERE booking_id=$1', [currentRow.id]);
  assert.ok(released.rows[0].actual_check_in_at && released.rows[0].actual_check_out_at && released.rows[0].released_at);
  const replacement = await publicRequest('/bookings', parkingRequest(6, currentInterval), 'lifecycle-released-space-00006');
  assert.equal(replacement.response.status, 201, JSON.stringify(replacement.body));
  assert.equal(replacement.body.booking.assignedSpotLabel, currentBooking.body.booking.assignedSpotLabel, 'check-out must make the exact space assignable again');

  await pool.query("UPDATE parking_locations SET booking_approval_mode='MANUAL_CONFIRM' WHERE id=$1", [locationId]);
  const pendingInterval = { arrivalLocal: '2036-02-10T09:00', departureLocal: '2036-02-11T09:00' };
  const pendingBooking = await publicRequest('/bookings', parkingRequest(12, pendingInterval), 'lifecycle-manual-pending-00012');
  assert.equal(pendingBooking.response.status, 201, JSON.stringify(pendingBooking.body));
  assert.equal(pendingBooking.body.booking.status, 'PENDING', 'manual-confirm policy must remain visible to customer confirmation');
  await pool.query("UPDATE parking_locations SET booking_approval_mode='AUTO_CONFIRM' WHERE id=$1", [locationId]);

  const reassignInterval = { arrivalLocal: '2034-08-10T09:00', departureLocal: '2034-08-11T09:00' };
  const reassignable = await publicRequest('/bookings', parkingRequest(7, reassignInterval), 'lifecycle-reassign-000000007');
  assert.equal(reassignable.response.status, 201, JSON.stringify(reassignable.body));
  const reassignRow = (await pool.query('SELECT id,version FROM parking_bookings WHERE reservation_number=$1', [reassignable.body.booking.reservationNumber])).rows[0];
  const alternatives = await adminRequest(`/bookings/${reassignRow.id}/spot-alternatives`, staff);
  const alternativesBody = await alternatives.json();
  assert.equal(alternatives.status, 200, JSON.stringify(alternativesBody));
  assert.equal(alternativesBody.alternatives.length, 1);
  const reassigned = await adminRequest(`/bookings/${reassignRow.id}/reassign-spot`, staff, { method: 'POST', body: { spotId: alternativesBody.alternatives[0].id, reason: 'Lifecycle move', version: reassignRow.version } });
  assert.equal(reassigned.status, 200, JSON.stringify(await reassigned.json()));
  const reassignmentHistory = await pool.query('SELECT released_at,previous_assignment_id FROM reservation_spot_assignments WHERE booking_id=$1 ORDER BY id', [reassignRow.id]);
  assert.equal(reassignmentHistory.rowCount, 2);
  assert.ok(reassignmentHistory.rows[0].released_at);
  assert.equal(String(reassignmentHistory.rows[1].previous_assignment_id), String((await pool.query('SELECT id FROM reservation_spot_assignments WHERE booking_id=$1 ORDER BY id LIMIT 1', [reassignRow.id])).rows[0].id));
  const cancelled = await publicRequest(`/bookings/${reassignable.body.booking.publicToken}/cancel`, { lookupCredential: reassignable.body.booking.lookupCredential, reason: 'Lifecycle cancellation' });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  const cancellationAssignment = await pool.query('SELECT count(*)::int active FROM reservation_spot_assignments WHERE booking_id=$1 AND released_at IS NULL', [reassignRow.id]);
  assert.equal(cancellationAssignment.rows[0].active, 0);

  const closureInterval = { arrivalLocal: '2034-09-10T09:00', departureLocal: '2034-09-11T09:00' };
  const closure = await adminRequest('/closures', owner, { method: 'POST', body: {
    location_id: null, zone_id: null, inventory_id: bobtailInventoryId, category_id: null,
    closure_type: 'FULL_CLOSURE', capacity_reduction: 0,
    starts_at: '2034-09-10T14:00:00.000Z', ends_at: '2034-09-11T14:00:00.000Z',
    reason: 'Lifecycle closure', internal_note: 'Disposable fixture', customer_message: 'Temporarily unavailable', active: true
  } });
  assert.equal(closure.status, 201, JSON.stringify(await closure.json()));
  const closedAvailability = await publicAvailability('BOBTAIL', closureInterval.arrivalLocal, closureInterval.departureLocal);
  assert.equal(closedAvailability[0].available, false);
  assert.equal(closedAvailability[0].numberedSpacesAvailable, 0);
  const closedBooking = await publicRequest('/bookings', parkingRequest(8, closureInterval), 'lifecycle-closed-00000000008');
  assert.equal(closedBooking.response.status, 409);
  assert.equal(closedBooking.body.error.code, 'NO_EXACT_SPOT_AVAILABLE');

  const block = await adminRequest(`/spots/${bobtailSpotIds[1].id}/block`, owner, { method: 'POST', body: {
    startsAt: '2034-10-10T14:00:00.000Z', endsAt: '2034-10-11T14:00:00.000Z', reason: 'Concurrency fixture'
  } });
  assert.equal(block.status, 201, JSON.stringify(await block.json()));
  const concurrentInterval = { arrivalLocal: '2034-10-10T09:00', departureLocal: '2034-10-11T09:00' };
  const [first, second] = await Promise.all([
    publicRequest('/bookings', parkingRequest(9, concurrentInterval), 'lifecycle-concurrent-00000009'),
    publicRequest('/bookings', parkingRequest(10, concurrentInterval), 'lifecycle-concurrent-00000010')
  ]);
  assert.equal([first, second].filter(item => item.response.status === 201).length, 1);
  assert.equal([first, second].filter(item => item.body.error?.code === 'NO_EXACT_SPOT_AVAILABLE').length, 1);
  const idempotencyInterval = { arrivalLocal: '2034-11-10T09:00', departureLocal: '2034-11-11T09:00' };
  const identical = await Promise.all([...Array(3)].map(() => publicRequest('/bookings', parkingRequest(11, idempotencyInterval), 'lifecycle-idempotent-00000011')));
  assert.equal(identical.filter(item => item.body.booking).length, 3);
  assert.equal((await pool.query("SELECT count(*)::int count FROM parking_bookings WHERE location_id=$1 AND email='lifecycle.driver.11@example.test'", [locationId])).rows[0].count, 1);

  await pool.query('UPDATE parking_rate_rules SET active=false WHERE location_id=$1 AND category_id=(SELECT id FROM parking_categories WHERE code=$2)', [locationId, 'BOBTAIL']);
  const availableWithoutPrice = await publicRequest('/availability', { parkingAreaId: bobtailAreaId, categoryCode: 'BOBTAIL', arrivalLocal: '2035-01-10T09:00', departureLocal: '2035-01-11T09:00' });
  assert.equal(availableWithoutPrice.response.status, 200, JSON.stringify(availableWithoutPrice.body));
  assert.equal(availableWithoutPrice.body.results[0].available, false, 'a space without its required active plan must not be offered');
  assert.equal(availableWithoutPrice.body.results[0].pricingAvailable, false, 'missing pricing must be explicit rather than shown as free');
  const noRate = await publicRequest('/quotes', { parkingAreaId: bobtailAreaId, categoryCode: 'BOBTAIL', arrivalLocal: '2035-01-10T09:00', departureLocal: '2035-01-11T09:00' });
  assert.equal(noRate.response.status, 409);
  assert.equal(noRate.body.error.code, 'RATE_NOT_CONFIGURED');

  const deniedUsers = await adminRequest('/admin-users', staff);
  assert.equal(deniedUsers.status, 403);
  const unauthenticated = await fetch(`${base}/api/admin/parking/v1/bookings`);
  assert.equal(unauthenticated.status, 401);
});
