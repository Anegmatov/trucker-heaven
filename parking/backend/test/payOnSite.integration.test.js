process.env.NODE_ENV = 'test';
process.env.PARKING_PAYMENT_MODE = 'PAY_ON_SITE';
// Documents are kept on local disk for this suite (no S3).
process.env.PARKING_DOCUMENT_STORAGE_PROVIDER = 'LOCAL';
process.env.PARKING_DOCUMENT_STORAGE_DIR = require('node:path').join(require('node:os').tmpdir(), `parking-docs-${process.pid}`);

// Pay-on-site relaunch: bookings confirm without any online payment and staff
// collect payment at Trucker Heaven. Runs against parkingops_test only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const stripeGateway = require('../services/stripeGateway');
const app = require('../app');
const { publishDraftSnapshot } = require('../services/layoutPublication');

stripeGateway.setTestAdapter({
  checkout: { sessions: { create: async () => { throw new Error('Pay-on-site must never create Stripe Checkout sessions.'); } } }
});

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing pay-on-site PostgreSQL tests: use parkingops_test only.');
}

const password = 'ParkingOps-pay-on-site-test-2036';
const ownerName = `pay-on-site-owner-${Date.now()}`;
const dailyInterval = { arrivalLocal: '2036-03-10T09:00', departureLocal: '2036-03-11T09:00' };
const monthlyInterval = { arrivalLocal: '2036-04-01T09:00' };
const manualInterval = { arrivalLocal: '2036-06-01T09:00' };
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

const idKey = label => `${label}-${crypto.randomBytes(18).toString('hex')}`;
const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;

async function request(path, body, key = '') {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { response, body: await response.json() };
}

async function adminPost(path, body) {
  const response = await fetch(`${base}/api/admin/parking/v1${path}`, {
    method: 'POST',
    headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function payload(index, duration, interval, selectedSpotId, overrides = {}) {
  return {
    parkingAreaId: zone.public_id,
    categoryCode: category.code,
    duration,
    ...interval,
    firstName: 'Onsite',
    lastName: `Driver ${index}`,
    mobilePhone: `+1615556${String(1000 + index).padStart(4, '0')}`,
    email: `onsite.driver.${index}.${Date.now()}@example.test`,
    companyName: 'Onsite Freight LLC',
    usdotNumber: '7654321',
    tractorUnitNumber: `ONS-${index}`,
    licensePlate: `ON${index}${Date.now() % 1000}`,
    licensePlateState: 'TN',
    termsAccepted: true,
    cancellationTermsAccepted: true,
    ...(selectedSpotId ? { selectedSpotId } : {}),
    ...overrides
  };
}

async function book(body) {
  const quote = await request('/quotes', body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  const booking = await request('/bookings', { ...body, quoteToken: quote.body.quoteToken, termsVersion: quote.body.terms.version }, idKey('onsite'));
  return { quote, booking };
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
      'Enter at the blue gate.','Exit through the south lane.','Pay at the office when you leave.','AUTO_CONFIRM',0,
      'ZONE_CAPACITY',false,true,120,240,0) RETURNING *`, [`Pay on site integration ${Date.now()}`])).rows[0];
  zone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'General Truck Parking','Synthetic mixed-term area','Follow General Truck Parking signs.',
      'Use the signed exit.',10) RETURNING *`, [location.id])).rows[0];
  inventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,99,'Published positions are authoritative.',true) RETURNING *`, [zone.id, category.id])).rows[0];
  ratePlan = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Mixed term rate',2500,45000,true) RETURNING *`, [location.id, zone.id, category.id])).rows[0];
  draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,'Pay on site physical fixture','DRAFT',$2,$2) RETURNING *`, [location.id, ownerId])).rows[0];
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
    { label: '149', daily: true, monthly: true, purpose: 'CUSTOMER', publicBookable: true },
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

test('payment configuration reports pay-on-site with no online payment', async () => {
  const response = await fetch(`${base}/api/public/parking/v1/payments/configuration`);
  const body = await response.json();
  assert.equal(body.paymentMode, 'PAY_ON_SITE');
  assert.equal(body.onlinePayment, false);
});

test('online booking attempts are refused in pay-on-site mode', async () => {
  const result = await request('/booking-attempts', payload(1, 'DAILY', dailyInterval), idKey('attempt'));
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, 'ONLINE_PAYMENT_DISABLED');
});

test('Daily booking is confirmed immediately with payment due on site', async () => {
  const body = payload(2, 'DAILY', dailyInterval);
  const { booking } = await book(body);
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  const created = booking.body.booking;
  assert.equal(created.status, 'CONFIRMED');
  assert.equal(created.paymentStatus, 'NOT_REQUIRED');
  assert.equal(created.price.totalCents, 2500);
  assert.match(created.paymentInstructions, /when you leave/);
  assert.match(created.arrivalLocal, /2036/);
  assert.ok(created.lookupCredential, 'customer receives a lookup credential');
  const row = (await pool.query('SELECT * FROM parking_bookings WHERE reservation_number=$1', [created.reservationNumber])).rows[0];
  assert.ok(row.customer_id, 'booking is linked to a customer record');
  assert.equal(row.usdot_number, '7654321');
  const customer = (await pool.query('SELECT status FROM parking_customers WHERE id=$1', [row.customer_id])).rows[0];
  assert.equal(customer.status, 'ACTIVE');
  const outbox = (await pool.query("SELECT event_type FROM parking_customer_notification_outbox WHERE booking_id=$1", [row.id])).rows;
  assert.deepEqual(outbox.map(item => item.event_type), ['RESERVATION_CONFIRMED']);
  const lookup = await request('/bookings/lookup', { reservationNumber: created.reservationNumber, lookupCredential: created.lookupCredential });
  assert.equal(lookup.response.status, 200, JSON.stringify(lookup.body));
  assert.equal(lookup.body.booking.status, 'CONFIRMED');
});

test('Monthly booking is confirmed open-ended with the selected space assigned', async () => {
  const body = payload(3, 'MONTHLY', monthlyInterval, spots['145'].id);
  const { booking } = await book(body);
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  const created = booking.body.booking;
  assert.equal(created.status, 'CONFIRMED');
  assert.equal(created.paymentStatus, 'NOT_REQUIRED');
  assert.equal(created.departure, null, 'Monthly parking is open-ended');
  assert.equal(created.assignedSpotLabel, '145');
  const assignment = (await pool.query(`SELECT a.* FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id
    WHERE b.reservation_number=$1 AND a.released_at IS NULL`, [created.reservationNumber])).rows;
  assert.equal(assignment.length, 1);
  assert.equal(Number(assignment[0].parking_spot_id), Number(spots['145'].id));
  const taken = await request('/quotes', payload(4, 'MONTHLY', monthlyInterval, spots['145'].id));
  assert.equal(taken.response.status, 409, 'the assigned space cannot be quoted again');
});

test('manual-approval bookings stay pending until staff confirm, then get their space', async () => {
  const current = (await pool.query('SELECT * FROM parking_locations WHERE id=$1', [location.id])).rows[0];
  await pool.query("UPDATE parking_locations SET booking_approval_mode='MANUAL_CONFIRM' WHERE id=$1", [location.id]);
  try {
    const { booking } = await book(payload(5, 'MONTHLY', manualInterval, spots['147'].id));
    assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
    assert.equal(booking.body.booking.status, 'PENDING');
    const row = (await pool.query('SELECT * FROM parking_bookings WHERE reservation_number=$1', [booking.body.booking.reservationNumber])).rows[0];
    assert.equal(row.payment_status, 'NOT_REQUIRED');
    const confirmed = await adminPost(`/bookings/${row.id}/confirm`, { version: Number(row.version), reason: 'Approved at desk' });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.status, 'CONFIRMED');
    const after = (await pool.query('SELECT status,assigned_spot_label FROM parking_bookings WHERE id=$1', [row.id])).rows[0];
    assert.equal(after.status, 'CONFIRMED');
    assert.equal(after.assigned_spot_label, '147');
    const outbox = (await pool.query("SELECT event_type FROM parking_customer_notification_outbox WHERE booking_id=$1", [row.id])).rows;
    assert.ok(outbox.some(item => item.event_type === 'RESERVATION_CONFIRMED'));
  } finally {
    await pool.query('UPDATE parking_locations SET booking_approval_mode=$2 WHERE id=$1', [location.id, current.booking_approval_mode]);
  }
});

test('staff cannot confirm a booking that was started with online payment', async () => {
  const { confirmOnSiteBooking } = require('../services/onSiteBooking');
  await assert.rejects(() => confirmOnSiteBooking(pool, { id: 0, status: 'PENDING', payment_status: 'DRAFT' }),
    error => error.code === 'PAYMENT_FINALIZATION_REQUIRED');
  await assert.rejects(() => confirmOnSiteBooking(pool, { id: 0, status: 'CONFIRMED', payment_status: 'NOT_REQUIRED' }),
    error => error.code === 'BOOKING_TRANSITION_NOT_ALLOWED');
});

// ---- on-site charges in the customer ledger ----
async function adminJson(method, path, body) {
  const response = await fetch(`${base}/api/admin/parking/v1${path}`, {
    method,
    headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrfToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { response, body: await response.json() };
}
const periodsFor = async reservationNumber => (await pool.query(`SELECT balance.*,period.source source_raw FROM parking_customer_billing_period_balances balance
  JOIN parking_customer_billing_periods period ON period.id=balance.id
  JOIN parking_bookings booking ON booking.id=balance.booking_id
  WHERE booking.reservation_number=$1 ORDER BY balance.period_start`, [reservationNumber])).rows;

test('a confirmed Daily booking owes its total on the departure date and can be paid at the office', async () => {
  const interval = { arrivalLocal: '2036-07-10T18:00', departureLocal: '2036-07-12T08:00' };
  const { booking } = await book(payload(6, 'DAILY', interval));
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  const created = booking.body.booking;
  const outbox = (await pool.query(`SELECT outbox.event_type,outbox.payload FROM parking_customer_notification_outbox outbox
    JOIN parking_bookings booking ON booking.id=outbox.booking_id WHERE booking.reservation_number=$1`, [created.reservationNumber])).rows[0];
  assert.equal(outbox.event_type, 'RESERVATION_CONFIRMED');
  assert.ok(outbox.payload.manageUrl.endsWith(`#r=${created.reservationNumber}&c=${encodeURIComponent(created.lookupCredential)}`), 'confirmation links to the reservation');
  const message = require('../services/customerNotifications').eventMessage('RESERVATION_CONFIRMED', outbox.payload);
  assert.match(message.text, /View or cancel: http/);
  const [period] = await periodsFor(created.reservationNumber);
  assert.equal(period.source, 'ON_SITE');
  assert.equal(Number(period.amount_due_cents), created.price.totalCents);
  assert.equal(String(period.period_start.toISOString?.() || period.period_start).slice(0, 7), '2036-07');
  assert.equal(period.status, 'DUE');
  const customer = (await pool.query(`SELECT customer.public_id FROM parking_customers customer
    JOIN parking_bookings booking ON booking.customer_id=customer.id WHERE booking.reservation_number=$1`, [created.reservationNumber])).rows[0];
  const paid = await adminJson('POST', `/customers/${customer.public_id}/payments`, {
    period: '2036-07', amountCents: created.price.totalCents, paymentDate: '2036-07-12', method: 'CASH'
  });
  assert.equal(paid.response.status, 201, JSON.stringify(paid.body));
  assert.equal(paid.body.balance.status, 'PAID');
  const payment = (await pool.query('SELECT parking_product,payment_source FROM parking_customer_payments WHERE public_id=$1', [paid.body.payment.publicId])).rows[0];
  assert.deepEqual(payment, { parking_product: 'DAILY', payment_source: 'ADMIN_MANUAL' });
});

test('a cancelled pay-on-site booking owes nothing', async () => {
  const interval = { arrivalLocal: '2036-08-10T18:00', departureLocal: '2036-08-11T18:00' };
  const { booking } = await book(payload(7, 'DAILY', interval));
  const created = booking.body.booking;
  assert.equal((await periodsFor(created.reservationNumber))[0].status, 'DUE');
  const cancelled = await request(`/bookings/${created.publicToken}/cancel`, { lookupCredential: created.lookupCredential, reason: 'Plans changed' });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  const [period] = await periodsFor(created.reservationNumber);
  assert.equal(Number(period.amount_due_cents), 0);
  assert.equal(period.status, 'NOT_DUE');
});

test('Monthly parking owes the prorated first month on arrival, then the full rate on the 1st', async () => {
  const { booking } = await book(payload(8, 'MONTHLY', { arrivalLocal: '2036-09-20T09:00' }, spots['148'].id));
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  const created = booking.body.booking;
  const [first] = await periodsFor(created.reservationNumber);
  assert.equal(Number(first.amount_due_cents), created.price.totalCents);
  const snapshot = (await pool.query(`SELECT price.snapshot FROM parking_booking_price_snapshots price
    JOIN parking_bookings booking ON booking.id=price.booking_id WHERE booking.reservation_number=$1`, [created.reservationNumber])).rows[0].snapshot;
  const { ensureOnSiteMonthlyPeriods } = require('../services/onSiteBooking');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureOnSiteMonthlyPeriods(client, new Date('2036-10-15T12:00:00Z'));
    await ensureOnSiteMonthlyPeriods(client, new Date('2036-10-16T12:00:00Z')); // idempotent
    await client.query('COMMIT');
  } finally { client.release(); }
  const periods = await periodsFor(created.reservationNumber);
  assert.equal(periods.length, 2);
  assert.equal(Number(periods[1].amount_due_cents), Number(snapshot.recurringUnitRateCents ?? snapshot.unitRateCents));
  const due = periods[1].due_date instanceof Date ? periods[1].due_date.toISOString().slice(0, 10) : String(periods[1].due_date);
  assert.ok(due.startsWith('2036-10-01') || due.startsWith('2036-09-30'), `due ${due}`);
});

test('an office payment for a month goes to the charge that is still owed, or to the exact charge picked', async () => {
  const same = { mobilePhone: '+16155569901', email: `same.customer.${Date.now()}@example.test` };
  const first = (await book(payload(9, 'DAILY', { arrivalLocal: '2036-08-03T09:00', departureLocal: '2036-08-04T09:00' }, undefined, same))).booking.body.booking;
  await request(`/bookings/${first.publicToken}/cancel`, { lookupCredential: first.lookupCredential, reason: 'Plans changed' });
  const second = (await book(payload(10, 'DAILY', { arrivalLocal: '2036-08-15T09:00', departureLocal: '2036-08-16T09:00' }, undefined, same))).booking.body.booking;
  const third = (await book(payload(11, 'DAILY', { arrivalLocal: '2036-08-20T09:00', departureLocal: '2036-08-21T09:00' }, undefined, same))).booking.body.booking;
  const customer = (await pool.query(`SELECT customer.public_id FROM parking_customers customer
    JOIN parking_bookings booking ON booking.customer_id=customer.id WHERE booking.reservation_number=$1`, [second.reservationNumber])).rows[0];
  const byMonth = await adminJson('POST', `/customers/${customer.public_id}/payments`, { period: '2036-08', amountCents: second.price.totalCents, paymentDate: '2036-08-16', method: 'CASH' });
  assert.equal(byMonth.response.status, 201, JSON.stringify(byMonth.body));
  assert.equal((await periodsFor(first.reservationNumber))[0].status, 'NOT_DUE', 'the cancelled booking takes no money');
  assert.equal((await periodsFor(second.reservationNumber))[0].status, 'PAID');
  const [thirdPeriod] = await periodsFor(third.reservationNumber);
  const exact = await adminJson('POST', `/customers/${customer.public_id}/payments`, { billingPeriodId: thirdPeriod.public_id, amountCents: third.price.totalCents, paymentDate: '2036-08-21', method: 'CARD' });
  assert.equal(exact.response.status, 201, JSON.stringify(exact.body));
  assert.equal((await periodsFor(third.reservationNumber))[0].status, 'PAID');
});

test('a Monthly price change sets the first month only; later months stay at the monthly rate', async () => {
  const { booking } = await book(payload(12, 'MONTHLY', { arrivalLocal: '2036-07-20T09:00' }, spots['149'].id));
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  const created = booking.body.booking;
  const row = (await pool.query('SELECT * FROM parking_bookings WHERE reservation_number=$1', [created.reservationNumber])).rows[0];
  await pool.query(`INSERT INTO parking_booking_price_overrides(booking_id,standard_price_cents,final_price_cents,difference_cents,reason,admin_user_id)
    VALUES($1,$2,5000,$3,'Test discount',$4)`, [row.id, created.price.totalCents, 5000 - created.price.totalCents, ownerId]);
  const { ensureOnSiteCharges, ensureOnSiteMonthlyPeriods } = require('../services/onSiteBooking');
  const client = await pool.connect();
  try { await client.query('BEGIN'); await ensureOnSiteCharges(client, row); await ensureOnSiteMonthlyPeriods(client, new Date('2036-08-10T12:00:00Z')); await client.query('COMMIT'); } finally { client.release(); }
  const periods = await periodsFor(created.reservationNumber);
  assert.equal(Number(periods[0].amount_due_cents), 5000);
  const snapshot = (await pool.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1', [row.id])).rows[0].snapshot;
  assert.equal(Number(periods[1].amount_due_cents), Number(snapshot.recurringUnitRateCents ?? snapshot.unitRateCents));
});

test('changing the dates of a pay-on-site booking re-prices what is owed', async () => {
  const created = (await book(payload(13, 'DAILY', { arrivalLocal: '2036-07-02T09:00', departureLocal: '2036-07-03T09:00' }))).booking.body.booking;
  const row = (await pool.query('SELECT id,version FROM parking_bookings WHERE reservation_number=$1', [created.reservationNumber])).rows[0];
  const changed = await adminJson('PATCH', `/reservation-desk/reservations/${row.id}`, { version: Number(row.version), confirmed: true, changes: { departureLocal: '2036-07-05T09:00' } });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  const [period] = await periodsFor(created.reservationNumber);
  assert.equal(Number(period.amount_due_cents), created.price.totalCents * 3, 'three days are owed after the extension');
  assert.equal(String(period.due_date.toISOString?.() || period.due_date).slice(0, 10), '2036-07-05');
});

test('picked spaces leave room for staff area bookings, using spaces the term cannot sell first', async () => {
  const { availability } = require('../services/parkingService');
  // 2036-08-04 09:00 to 2036-08-05 09:00 Chicago time; nothing else is booked then.
  const window = { arrival: '2036-08-04T14:00:00.000Z', departure: '2036-08-05T14:00:00.000Z' };
  const openSpaces = async duration => {
    const client = await pool.connect();
    try {
      const [slot] = await availability(client, {
        locationId: location.id, zoneId: zone.id, categoryCode: category.code, duration, ...window,
        customerAssignmentMode: 'CUSTOMER_SELECTED_SPOT'
      });
      return Number(slot.available_spots);
    } finally { client.release(); }
  };
  const dailyBefore = await openSpaces('DAILY');
  const monthlyBefore = await openSpaces('MONTHLY');
  // Two area bookings (no numbered space) for the same day, as staff or older clients create them.
  for (const index of [90, 91]) {
    const { booking } = await book(payload(index, 'DAILY', { arrivalLocal: '2036-08-04T09:00', departureLocal: '2036-08-05T09:00' }));
    assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
    assert.equal(booking.body.booking.assignmentMode, 'ZONE_CAPACITY');
  }
  // Every Daily space can host them, so Daily picks drop by two.
  assert.equal(await openSpaces('DAILY'), dailyBefore - 2);
  // Space 146 is Daily-only: it takes one of them, so Monthly picks drop by one.
  assert.equal(await openSpaces('MONTHLY'), monthlyBefore - 1);
});

test('drivers add a driver license from their reservation page, stored on local disk', async () => {
  const { booking } = await book(payload(95, 'DAILY', { arrivalLocal: '2036-08-11T09:00', departureLocal: '2036-08-12T09:00' }));
  assert.equal(booking.response.status, 201, JSON.stringify(booking.body));
  const { publicToken, lookupCredential } = booking.body.booking;
  // A tiny valid PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const started = await request(`/bookings/${publicToken}/documents/driver-license/upload`,
    { lookupCredential, filename: 'license.png', mimeType: 'image/png', sizeBytes: png.length });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const tampered = await fetch(`${base}${started.body.upload.url}x`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(tampered.status, 403, 'a changed upload link is refused');
  const put = await fetch(`${base}${started.body.upload.url}`, { method: 'PUT', headers: started.body.upload.headers, body: png });
  assert.equal(put.status, 204);
  const completed = await request(`/bookings/${publicToken}/documents/complete`, { lookupCredential, uploadToken: started.body.upload.token });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.document.type, 'DRIVER_LICENSE');
  const status = await request(`/bookings/${publicToken}/documents/status`, { lookupCredential });
  assert.ok(status.body.documents.some(item => item.type === 'DRIVER_LICENSE'), JSON.stringify(status.body));
  const wrongType = await request(`/bookings/${publicToken}/documents/passport/upload`, { lookupCredential, filename: 'a.png', mimeType: 'image/png', sizeBytes: 10 });
  assert.equal(wrongType.response.status, 404);
});
