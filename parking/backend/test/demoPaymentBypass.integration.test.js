process.env.NODE_ENV = 'test';
process.env.PARKING_DEMO_PAYMENT_BYPASS_ENABLED = 'true';
process.env.PARKING_DEMO_PAYMENT_BYPASS_TTL_SECONDS = '300';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { DateTime } = require('luxon');
const pool = require('../db');
const { apiError, digest } = require('../utils');
const stripeGateway = require('../services/stripeGateway');
const storage = require('../services/privateDocumentStorage');
const { publishDraftSnapshot } = require('../services/layoutPublication');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test'
    || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing demo-bypass PostgreSQL tests: use parkingops_test only.');
}

const unique = Date.now();
const liveMonthlyStart = DateTime.now().setZone('America/Chicago').plus({ months: 2 }).startOf('month').set({ hour: 9 });
const liveMonthlyLocal = {
  arrival: liveMonthlyStart.toFormat("yyyy-MM-dd'T'HH:mm"),
  departure: undefined,
  midpointUtc: liveMonthlyStart.plus({ days: 15 }).toUTC().toISO()
};
const ownerName = `demo-owner-${unique}`;
const staffName = `demo-staff-${unique}`;
const password = 'ParkingOps-demo-bypass-test-2038';
const checkoutCalls = [];
const testObjects = new Map();

stripeGateway.setTestAdapter({
  checkout: { sessions: { create: async payload => {
    checkoutCalls.push(payload);
    return { id: `cs_should_not_exist_${unique}`, url: 'https://checkout.stripe.test/should-not-exist' };
  } } },
  constructWebhookEvent() { throw apiError('STRIPE_SIGNATURE_INVALID', 'Not used by demo tests', 400); }
});
storage.setTestAdapter({
  bucket: 'parkingops-demo-private',
  async signedUpload({ key, mimeType, sizeBytes }) {
    const bytes = Buffer.alloc(sizeBytes);
    Buffer.from('%PDF-1.7\n').copy(bytes);
    Buffer.from('\n%%EOF\n').copy(bytes, sizeBytes - 7);
    testObjects.set(key, { mimeType, sizeBytes, bytes });
    return { url: `https://private-upload.test/${encodeURIComponent(key)}`, method: 'PUT',
      headers: { 'Content-Type': mimeType }, expiresInSeconds: 600 };
  },
  async inspect({ key }) {
    const item = testObjects.get(key);
    return item ? { mimeType: item.mimeType, sizeBytes: item.sizeBytes, bytes: item.bytes } : null;
  },
  async readObject({ key }) {
    const item = testObjects.get(key);
    if (!item) throw apiError('DOCUMENT_OBJECT_MISSING', 'Object missing', 404);
    return { body: item.bytes, sizeBytes: item.sizeBytes };
  }
});

const app = require('../app');
let server;
let base;
let owner;
let staff;
let location;
let zone;
let inventory;
let category;
let rate;
let spots;
let generalZone;
let generalInventory;
let generalCategory;
let generalRate;
let generalSpots;
let firstDaily;
let monthlyMissing;
let monthlyDocumented;

const idempotencyKey = label => `${label}-${crypto.randomBytes(18).toString('hex')}`;
const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;

async function jsonRequest(url, { method = 'POST', body = {}, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  return { response, body: payload };
}

async function publicPost(path, body, key = '') {
  return jsonRequest(`${base}/api/public/parking/v1${path}`, {
    body, headers: key ? { 'idempotency-key': key } : {}
  });
}

async function adminRequest(path, { session = owner, method = 'POST', body = {} } = {}) {
  return jsonRequest(`${base}/api/admin/parking/v1${path}`, {
    method, body, headers: { cookie: session.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrfToken }) }
  });
}

async function login(username) {
  const result = await jsonRequest(`${base}/api/admin/auth/login`, { body: { username, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return { cookie: result.response.headers.get('set-cookie').split(';')[0], csrfToken: result.body.csrfToken };
}

function customer(index, overrides = {}) {
  return {
    firstName: 'Demo', lastName: `Driver ${index}`,
    mobilePhone: `+1615${String((unique + index) % 10000000).padStart(7, '0')}`,
    email: `demo.driver.${index}.${unique}@example.test`, companyName: 'Demo QA Carrier',
    usdotNumber: '1234567', tractorUnitNumber: `DEMO-${index}`,
    licensePlate: `D${unique.toString().slice(-4)}${index}`, licensePlateState: 'TN',
    termsAccepted: true, cancellationTermsAccepted: true, ...overrides
  };
}

function bookingPayload(index, duration, arrivalLocal, departureLocal, overrides = {}) {
  return {
    parkingAreaId: zone.public_id, categoryCode: category.code, duration,
    arrivalLocal, departureLocal, ...customer(index), ...overrides
  };
}

async function createAttempt(body) {
  const quote = await publicPost('/quotes', body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  const attempt = await publicPost('/booking-attempts', {
    ...body, quoteToken: quote.body.quoteToken, termsVersion: quote.body.terms.version
  }, idempotencyKey('demo-attempt'));
  assert.equal(attempt.response.status, 201, JSON.stringify(attempt.body));
  const access = {
    publicToken: attempt.body.bookingAttempt.publicToken,
    lookupCredential: attempt.body.bookingAttempt.lookupCredential
  };
  const persisted = (await pool.query(`SELECT booking.id,booking.customer_id,booking.status,booking.payment_status,
      snapshot.snapshot FROM parking_bookings booking
      JOIN parking_booking_price_snapshots snapshot ON snapshot.booking_id=booking.id
      WHERE booking.public_token=$1`, [access.publicToken])).rows[0];
  return { body, quote, attempt, access, persisted };
}

async function issueDemo(created, session = owner) {
  const issued = await adminRequest(`/reservation-desk/reservations/${created.persisted.id}/demo-payment-authorization`, { session });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.body));
  assert.match(issued.body.demoAuthorization.url, /#demo-payment\?token=/);
  return issued.body.demoAuthorization;
}

async function confirmDemo(token, additions = {}) {
  return publicPost('/payments/demo/confirm', { token, ...additions });
}

async function uploadBeforeConfirmation(created, filename = 'insurance.pdf') {
  const started = await publicPost(`/bookings/${created.access.publicToken}/documents/insurance/upload`, {
    lookupCredential: created.access.lookupCredential, filename, mimeType: 'application/pdf', sizeBytes: 2048
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const completed = await publicPost(`/bookings/${created.access.publicToken}/documents/complete`, {
    lookupCredential: created.access.lookupCredential, uploadToken: started.body.upload.token
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  return completed.body.document;
}

test.before(async () => {
  category = (await pool.query("SELECT id,code FROM parking_categories WHERE code='BOBTAIL'")).rows[0];
  generalCategory = (await pool.query("SELECT id,code FROM parking_categories WHERE code='TRACTOR_TRAILER'")).rows[0];
  assert.ok(category && generalCategory, 'load the development seed before demo-bypass tests');
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$3,'OWNER',true),($2,$3,'STAFF',true)`, [ownerName, staffName, await bcrypt.hash(password, 4)]);
  const admins = await pool.query('SELECT id,username FROM parking_admin_users WHERE username=ANY($1)', [[ownerName, staffName]]);
  const ownerId = admins.rows.find(row => row.username === ownerName).id;
  location = (await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,payment_instructions,booking_approval_mode,cancellation_cutoff_hours,
      assignment_mode,exact_mode_active,self_service_enabled,turnaround_buffer_minutes)
    VALUES($1,'Synthetic demo bypass lot','48 Demo Way','America/Chicago','+16155550348',
      'Enter at QA gate.','Exit at QA gate.','','AUTO_CONFIRM',0,'ZONE_CAPACITY',false,true,0) RETURNING *`,
  [`Demo bypass integration ${unique}`])).rows[0];
  zone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,display_order)
    VALUES($1,'Demo Bobtail Parking','Synthetic QA capacity','Follow QA signs.',10) RETURNING *`, [location.id])).rows[0];
  inventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_remaining_capacity)
    VALUES($1,$2,4,true) RETURNING *`, [zone.id, category.id])).rows[0];
  rate = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,
      daily_rate_cents,weekly_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Demo authoritative pricing',1900,10000,25000,true) RETURNING *`,
  [location.id, zone.id, category.id])).rows[0];
  generalZone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,display_order)
    VALUES($1,'Demo Truck and Trailer Parking','Synthetic QA capacity','Follow QA signs.',20) RETURNING *`, [location.id])).rows[0];
  generalInventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_remaining_capacity)
    VALUES($1,$2,4,true) RETURNING *`, [generalZone.id, generalCategory.id])).rows[0];
  generalRate = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,
      daily_rate_cents,weekly_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Demo authoritative truck and trailer pricing',1900,10000,25000,true) RETURNING *`,
  [location.id, generalZone.id, generalCategory.id])).rows[0];
  const draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,
      created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,'Demo bypass fixture','DRAFT',$2,$2) RETURNING *`, [location.id, ownerId])).rows[0];
  await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active)
    VALUES($1,'ENTRANCE',$2,'QA Entrance',2,44,8,8,1,true,true)`, [draft.id, elementKey()]);
  spots = {};
  for (const [index, label] of ['301','302','303','304'].entries()) {
    const key = elementKey();
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,
        visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,true,'TEST','NEEDS_CLASSIFICATION',false,'NEEDS_CLASSIFICATION') RETURNING *`,
    [location.id, zone.id, inventory.id, label, index + 1, key])).rows[0];
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,
        parking_spot_id,x,y,width,height,layer_order,public_visible,active,parking_purpose,daily_eligible,
        weekly_eligible,monthly_eligible,space_public_bookable,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,20,10,6,$8,true,true,'CUSTOMER',true,true,true,true,$9)`,
    [draft.id, key, label, zone.id, inventory.id, spot.id, 15 + index * 18, 10 + index, rate.id]);
    spots[label] = spot;
  }
  generalSpots = {};
  for (const [index, label] of ['401','402','403','404'].entries()) {
    const key = elementKey();
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,
        visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,true,'TEST','NEEDS_CLASSIFICATION',false,'NEEDS_CLASSIFICATION') RETURNING *`,
    [location.id, generalZone.id, generalInventory.id, label, index + 1, key])).rows[0];
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,
        parking_spot_id,x,y,width,height,layer_order,public_visible,active,parking_purpose,daily_eligible,
        weekly_eligible,monthly_eligible,space_public_bookable,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,45,10,6,$8,true,true,'CUSTOMER',true,true,true,true,$9)`,
    [draft.id, key, label, generalZone.id, generalInventory.id, spot.id, 15 + index * 18, 20 + index, generalRate.id]);
    generalSpots[label] = spot;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await publishDraftSnapshot(client, { layoutId: draft.id, actorId: ownerId });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login(ownerName);
  staff = await login(staffName);
});

test.after(async () => {
  stripeGateway.clearTestAdapter();
  storage.clearTestAdapter();
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('missing and invalid demo tokens are denied and the public payment configuration does not advertise bypass', async () => {
  for (const token of ['', 'browser-parameter-cannot-enable-demo-bypass', crypto.randomBytes(32).toString('base64url')]) {
    const result = await publicPost('/payments/demo/authorization', { token, enabled: true, customerId: 1, reservationId: 1 });
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error.code, 'DEMO_AUTHORIZATION_INVALID');
  }
  const configuration = await fetch(`${base}/api/public/parking/v1/payments/configuration`).then(response => response.json());
  assert.equal(Object.hasOwn(configuration, 'demoPayment'), false);
  assert.equal(Object.hasOwn(configuration, 'demoPaymentBypass'), false);
});

test('only an Owner can mint a short-lived reservation-bound token and expired tokens are denied', async () => {
  const created = await createAttempt(bookingPayload(1, 'DAILY', '2035-01-10T09:00', '2035-01-10T12:00'));
  const denied = await adminRequest(`/reservation-desk/reservations/${created.persisted.id}/demo-payment-authorization`, { session: staff });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  const authorization = await issueDemo(created);
  await assert.rejects(
    pool.query(`UPDATE parking_demo_payment_grants SET price_snapshot='{}'::jsonb WHERE public_id=$1`, [authorization.grant.id]),
    error => error.code === '23514'
  );
  assert.ok(new Date(authorization.grant.expiresAt).getTime() - Date.now() <= 300000);
  await pool.query(`UPDATE parking_demo_payment_grants SET invalidated_at=now() WHERE public_id=$1`, [authorization.grant.id]);
  const expiredToken = crypto.randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO parking_demo_payment_grants(
      public_id,token_hash,booking_id,customer_id,initiator,price_snapshot,created_at,expires_at)
    VALUES($1,$2,$3,$4,'CLI',$5,now()-interval '10 minutes',now()-interval '1 second')`, [
    `demo_${crypto.randomBytes(18).toString('base64url')}`, digest(expiredToken), created.persisted.id,
    created.persisted.customer_id, JSON.stringify(created.persisted.snapshot)
  ]);
  const expired = await publicPost('/payments/demo/authorization', { token: expiredToken });
  assert.equal(expired.response.status, 410);
  assert.equal(expired.body.error.code, 'DEMO_AUTHORIZATION_EXPIRED');
});

test('browser IDs cannot override token binding, replay is denied, and Daily creates zero Stripe/payment effects', async () => {
  firstDaily = await createAttempt(bookingPayload(2, 'DAILY', '2035-02-10T09:00', '2035-02-10T12:00'));
  const other = await createAttempt(bookingPayload(3, 'DAILY', '2035-02-11T09:00', '2035-02-11T12:00'));
  assert.equal(firstDaily.persisted.snapshot.totalCents, 1900);
  const authorization = await issueDemo(firstDaily);
  const status = await publicPost('/payments/demo/authorization', {
    token: authorization.token, reservationId: other.persisted.id, customerId: other.persisted.customer_id,
    publicToken: other.access.publicToken
  });
  assert.equal(status.response.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.demoAuthorization.reservationNumber, firstDaily.attempt.body.bookingAttempt.reservationNumber);
  const confirmed = await confirmDemo(authorization.token, {
    reservationId: other.persisted.id, customerId: other.persisted.customer_id, publicToken: other.access.publicToken
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.reservation.paymentStatus, 'DEMO_BYPASSED');
  assert.equal(confirmed.body.reservation.financiallyPaid, false);
  const replay = await confirmDemo(authorization.token);
  assert.equal(replay.response.status, 409);
  assert.equal(replay.body.error.code, 'DEMO_AUTHORIZATION_USED');
  const rows = await pool.query(`SELECT booking.id,booking.status,booking.payment_status,
      booking.payment_confirmed_at,booking.stripe_checkout_session_id,booking.stripe_payment_intent_id,
      booking.stripe_subscription_id,customer.status customer_status,
      (SELECT count(*) FROM parking_customer_payments p WHERE p.booking_id=booking.id)::int payment_rows,
      (SELECT count(*) FROM parking_stripe_events e WHERE e.booking_id=booking.id)::int stripe_events,
      (SELECT count(*) FROM parking_customer_notification_outbox notification
        WHERE notification.booking_id=booking.id AND notification.event_type='DEMO_RESERVATION_CONFIRMED')::int demo_notifications,
      (SELECT count(*) FROM parking_customer_notification_outbox notification
        WHERE notification.booking_id=booking.id AND notification.event_type='RESERVATION_CONFIRMED')::int paid_notifications,
      (SELECT count(*) FROM reservation_spot_assignments a WHERE a.booking_id=booking.id)::int assignments
    FROM parking_bookings booking JOIN parking_customers customer ON customer.id=booking.customer_id
    WHERE booking.id=ANY($1::bigint[]) ORDER BY booking.id`, [[firstDaily.persisted.id, other.persisted.id]]);
  const winner = rows.rows.find(row => Number(row.id) === Number(firstDaily.persisted.id));
  const untouched = rows.rows.find(row => Number(row.id) === Number(other.persisted.id));
  assert.deepEqual({ status: winner.status, payment: winner.payment_status, paidAt: winner.payment_confirmed_at,
    checkout: winner.stripe_checkout_session_id, intent: winner.stripe_payment_intent_id,
    subscription: winner.stripe_subscription_id, payments: winner.payment_rows, events: winner.stripe_events,
    demoNotifications: winner.demo_notifications, paidNotifications: winner.paid_notifications,
    assignments: winner.assignments, customer: winner.customer_status },
  { status: 'CONFIRMED', payment: 'DEMO_BYPASSED', paidAt: null, checkout: null, intent: null,
    subscription: null, payments: 0, events: 0, demoNotifications: 1, paidNotifications: 0,
    assignments: 0, customer: 'ACTIVE' });
  assert.deepEqual({ status: untouched.status, payment: untouched.payment_status }, { status: 'PENDING', payment: 'DRAFT' });
  const capacity = await publicPost('/availability', firstDaily.body);
  assert.equal(capacity.response.status, 200, JSON.stringify(capacity.body));
  assert.equal(capacity.body.results.find(item => item.categoryCode === 'BOBTAIL').remainingCapacity, 3);
  const adminList = await adminRequest(`/bookings?q=${encodeURIComponent(firstDaily.attempt.body.bookingAttempt.reservationNumber)}`, { method: 'GET' });
  assert.equal(adminList.response.status, 200, JSON.stringify(adminList.body));
  assert.equal(adminList.body.bookings.length, 1);
  assert.equal(adminList.body.bookings[0].payment_status, 'DEMO_BYPASSED');
  const adminDetail = await adminRequest(`/bookings/${firstDaily.persisted.id}`, { method: 'GET' });
  assert.equal(adminDetail.response.status, 200, JSON.stringify(adminDetail.body));
  assert.equal(adminDetail.body.customerAccount.paidPaymentCount, 0);
  const adminCustomer = await adminRequest(`/customers?q=${encodeURIComponent(firstDaily.body.licensePlate)}`, { method: 'GET' });
  assert.equal(adminCustomer.response.status, 200, JSON.stringify(adminCustomer.body));
  assert.ok(adminCustomer.body.customers.some(item => item.publicId === adminDetail.body.customerAccount.publicId));
  assert.equal(checkoutCalls.length, 0);
});

test('existing customer and vehicle are reused, while a new truck attaches to the same customer', async () => {
  const identity = customer(2);
  const existingVehicle = await createAttempt(bookingPayload(20, 'DAILY', '2035-02-12T09:00', '2035-02-12T12:00', identity));
  const existingAuthorization = await issueDemo(existingVehicle);
  assert.equal((await confirmDemo(existingAuthorization.token)).response.status, 200);
  const newVehicle = await createAttempt(bookingPayload(21, 'DAILY', '2035-02-13T09:00', '2035-02-13T12:00', {
    ...identity, tractorUnitNumber: 'DEMO-NEW-UNIT', licensePlate: `NEW${unique.toString().slice(-5)}`
  }));
  const newAuthorization = await issueDemo(newVehicle);
  assert.equal((await confirmDemo(newAuthorization.token)).response.status, 200);
  const identityCounts = (await pool.query(`SELECT
      count(DISTINCT customer.id)::int customers,
      count(DISTINCT vehicle.id)::int vehicles,
      count(DISTINCT booking.id)::int bookings
    FROM parking_customers customer
    LEFT JOIN parking_customer_vehicles vehicle ON vehicle.customer_id=customer.id
    LEFT JOIN parking_bookings booking ON booking.customer_id=customer.id
    WHERE customer.id=$1`, [existingVehicle.persisted.customer_id])).rows[0];
  assert.deepEqual(identityCounts, { customers: 1, vehicles: 2, bookings: 3 });
});

test('Weekly retains the authoritative $100 snapshot and confirms without Stripe', async () => {
  const weekly = await createAttempt(bookingPayload(4, 'WEEKLY', '2035-03-01T09:00', '2035-03-08T09:00'));
  assert.equal(weekly.quote.body.quote.unitRateCents, 10000);
  assert.equal(weekly.quote.body.quote.totalCents, 10000);
  assert.equal(weekly.persisted.snapshot.totalCents, 10000);
  const authorization = await issueDemo(weekly);
  const result = await confirmDemo(authorization.token);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.reservation.price.amountCents, 10000);
  assert.equal(checkoutCalls.length, 0);
});

test('Truck and Trailer bypass preserves Daily $19, Weekly $100, and Monthly $250', async () => {
  const cases = [
    { index: 40, duration: 'DAILY', arrival: '2035-03-10T09:00', departure: '2035-03-10T12:00', cents: 1900 },
    { index: 41, duration: 'WEEKLY', arrival: '2035-03-11T09:00', departure: '2035-03-18T09:00', cents: 10000 },
    { index: 42, duration: 'MONTHLY', arrival: '2035-03-01T09:00', departure: undefined, cents: 25000,
      selectedSpotId: generalSpots['401'].id }
  ];
  for (const item of cases) {
    const created = await createAttempt(bookingPayload(item.index, item.duration, item.arrival, item.departure, {
      parkingAreaId: generalZone.public_id,
      categoryCode: generalCategory.code,
      ...(item.selectedSpotId ? { selectedSpotId: item.selectedSpotId } : {})
    }));
    assert.equal(created.quote.body.quote.unitRateCents, item.cents);
    assert.equal(created.quote.body.quote.totalCents, item.cents);
    assert.equal(created.persisted.snapshot.totalCents, item.cents);
    const authorization = await issueDemo(created);
    const result = await confirmDemo(authorization.token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.reservation.price.amountCents, item.cents);
    assert.equal(result.body.reservation.paymentStatus, 'DEMO_BYPASSED');
    assert.equal(result.body.reservation.financiallyPaid, false);
    if (item.duration !== 'MONTHLY') {
      const capacity = await publicPost('/availability', created.body);
      assert.equal(capacity.response.status, 200, JSON.stringify(capacity.body));
      assert.equal(capacity.body.results.find(resultItem => resultItem.categoryCode === 'TRACTOR_TRAILER').remainingCapacity, 3);
    }
  }
  assert.equal(checkoutCalls.length, 0);
});

test('simultaneous confirmation consumes a one-time token exactly once', async () => {
  const created = await createAttempt(bookingPayload(43, 'DAILY', '2035-03-25T09:00', '2035-03-25T12:00'));
  const authorization = await issueDemo(created);
  const results = await Promise.all([confirmDemo(authorization.token), confirmDemo(authorization.token)]);
  assert.deepEqual(results.map(result => result.response.status).sort((a, b) => a - b), [200, 409]);
  assert.equal(results.find(result => result.response.status === 409).body.error.code, 'DEMO_AUTHORIZATION_USED');
  const state = (await pool.query(`SELECT booking.status,booking.payment_status,
      (SELECT count(*) FROM parking_demo_payment_grants demo_grant
        WHERE demo_grant.booking_id=booking.id AND demo_grant.used_at IS NOT NULL)::int consumed_grants,
      (SELECT count(*) FROM parking_customer_payments payment WHERE payment.booking_id=booking.id)::int payments
    FROM parking_bookings booking WHERE booking.id=$1`, [created.persisted.id])).rows[0];
  assert.deepEqual(state, { status: 'CONFIRMED', payment_status: 'DEMO_BYPASSED', consumed_grants: 1, payments: 0 });
  assert.equal(checkoutCalls.length, 0);
});

test('Demo confirmation never exceeds Daily capacity and cancellation restores one unit', async () => {
  const payloads = [70, 71, 72, 73].map(index => bookingPayload(
    index, 'DAILY', '2035-09-10T09:00', '2035-09-10T12:00'
  ));
  const created = [];
  for (const payload of payloads) created.push(await createAttempt(payload));
  const stillAvailable = await publicPost('/quotes', bookingPayload(74, 'DAILY', '2035-09-10T09:00', '2035-09-10T12:00'));
  assert.equal(stillAvailable.response.status, 200, JSON.stringify(stillAvailable.body));
  const authorizations = [];
  for (const item of created) authorizations.push(await issueDemo(item));
  const confirmations = [];
  for (const authorization of authorizations) confirmations.push(await confirmDemo(authorization.token));
  assert.ok(confirmations.every(item => item.response.status === 200), JSON.stringify(confirmations.map(item => item.body)));
  const confirmed = Number((await pool.query(`SELECT count(*) FROM parking_bookings
    WHERE id=ANY($1::bigint[]) AND status='CONFIRMED' AND payment_status='DEMO_BYPASSED'`,
  [created.map(item => item.persisted.id)])).rows[0].count);
  assert.equal(confirmed, 4);
  const first = (await pool.query('SELECT version FROM parking_bookings WHERE id=$1', [created[0].persisted.id])).rows[0];
  const cancelled = await adminRequest(`/bookings/${created[0].persisted.id}/cancel`, {
    body: { version: Number(first.version), reason: 'Demo QA capacity release', note: 'Synthetic test cancellation' }
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  const restored = await publicPost('/availability', payloads[0]);
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.results.find(item => item.categoryCode === 'BOBTAIL').remainingCapacity, 1);
  assert.equal(checkoutCalls.length, 0);
  // Free the lot again: later open-ended Monthly tests overlap this date, and
  // area bookings that fill the lot correctly block new Monthly spaces.
  for (const item of created.slice(1)) {
    const current = (await pool.query('SELECT version FROM parking_bookings WHERE id=$1', [item.persisted.id])).rows[0];
    const released = await adminRequest(`/bookings/${item.persisted.id}/cancel`, {
      body: { version: Number(current.version), reason: 'Demo QA cleanup', note: 'Synthetic test cleanup' }
    });
    assert.equal(released.response.status, 200, JSON.stringify(released.body));
  }
});

test('open-ended Monthly without a document stays one $250 unit and occupies only the selected space', async () => {
  monthlyMissing = await createAttempt(bookingPayload(5, 'MONTHLY', liveMonthlyLocal.arrival, liveMonthlyLocal.departure, {
    selectedSpotId: spots['301'].id
  }));
  assert.equal(monthlyMissing.quote.body.quote.units, 1);
  assert.equal(monthlyMissing.quote.body.quote.unitRateCents, 25000);
  assert.equal(monthlyMissing.quote.body.quote.totalCents, 25000);
  assert.equal(monthlyMissing.persisted.snapshot.totalCents, 25000);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_customer_documents WHERE booking_id=$1', [monthlyMissing.persisted.id])).rows[0].count), 0);
  const authorization = await issueDemo(monthlyMissing);
  const result = await confirmDemo(authorization.token);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const state = (await pool.query(`SELECT booking.status,booking.payment_status,booking.payment_confirmed_at,
      booking.subscription_status,assignment.parking_spot_id,assignment.released_at,quote.hold_status
    FROM parking_bookings booking
    JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
    JOIN parking_public_quotes quote ON quote.checkout_booking_id=booking.id WHERE booking.id=$1`,
  [monthlyMissing.persisted.id])).rows[0];
  assert.deepEqual({ status: state.status, payment: state.payment_status, paidAt: state.payment_confirmed_at,
    subscription: state.subscription_status, spot: Number(state.parking_spot_id), released: state.released_at,
    hold: state.hold_status },
  { status: 'CONFIRMED', payment: 'DEMO_BYPASSED', paidAt: null, subscription: 'DEMO_QA',
    spot: Number(spots['301'].id), released: null, hold: 'CONSUMED' });
  const unavailable = await publicPost('/monthly-positions', bookingPayload(50, 'MONTHLY', liveMonthlyLocal.arrival, liveMonthlyLocal.departure));
  assert.equal(unavailable.response.status, 200);
  assert.equal(unavailable.body.positions.find(item => Number(item.parkingSpotId) === Number(spots['301'].id)).available, false);
  const duplicateQuote = await publicPost('/quotes', bookingPayload(51, 'MONTHLY', liveMonthlyLocal.arrival, liveMonthlyLocal.departure, {
    selectedSpotId: spots['301'].id
  }));
  assert.equal(duplicateQuote.response.status, 409);
  assert.equal(duplicateQuote.body.error.code, 'MONTHLY_POSITION_UNAVAILABLE');
  const live = await adminRequest(`/locations/${location.id}/live-lot/snapshot?at=${encodeURIComponent(liveMonthlyLocal.midpointUtc)}`, { method: 'GET' });
  assert.equal(live.response.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.spaces.find(item => Number(item.id) === Number(spots['301'].id)).operationalStatus, 'RESERVED');
});

test('an optional document can be uploaded before demo confirmation and remains pending review', async () => {
  monthlyDocumented = await createAttempt(bookingPayload(6, 'MONTHLY', '2035-06-01T09:00', '2035-07-01T09:00', {
    selectedSpotId: spots['302'].id
  }));
  const document = await uploadBeforeConfirmation(monthlyDocumented);
  assert.equal(document.status, 'RECEIVED');
  const authorization = await issueDemo(monthlyDocumented);
  assert.equal((await confirmDemo(authorization.token)).response.status, 200);
  const row = (await pool.query(`SELECT document.public_id,document.upload_status,document.verification_status,
      document.sha256_hex FROM parking_customer_documents document WHERE document.booking_id=$1`,
  [monthlyDocumented.persisted.id])).rows[0];
  assert.equal(row.upload_status, 'UPLOADED');
  assert.equal(row.verification_status, 'PENDING_REVIEW');
  assert.match(row.sha256_hex, /^[a-f0-9]{64}$/);
});

test('exact identity can upload later; one wrong or mixed field is denied', async () => {
  const identity = monthlyMissing.body;
  const exact = await jsonRequest(`${base}/api/customer/parking/v1/lookup`, { body: {
    name: `${identity.firstName} ${identity.lastName}`, email: identity.email,
    phone: identity.mobilePhone, licensePlate: identity.licensePlate, documentType: 'INSURANCE'
  } });
  assert.equal(exact.response.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.summary.uploadReservation.paymentStatus, 'DEMO_BYPASSED');
  assert.equal(exact.body.summary.uploadReservation.financiallyPaid, false);
  assert.equal(exact.body.summary.uploadReservation.documents.INSURANCE.status, 'MISSING');
  assert.deepEqual(exact.body.summary.payments, []);
  const cookie = exact.response.headers.get('set-cookie').split(';')[0];
  const wrong = await jsonRequest(`${base}/api/customer/parking/v1/lookup`, { body: {
    name: `${identity.firstName} ${identity.lastName}`, email: identity.email,
    phone: '+16155559999', licensePlate: identity.licensePlate, documentType: 'INSURANCE'
  } });
  assert.equal(wrong.response.status, 404);
  const mixed = await jsonRequest(`${base}/api/customer/parking/v1/lookup`, { body: {
    name: `${identity.firstName} ${identity.lastName}`, email: firstDaily.body.email,
    phone: identity.mobilePhone, licensePlate: identity.licensePlate, documentType: 'INSURANCE'
  } });
  assert.equal(mixed.response.status, 404);
  const started = await jsonRequest(`${base}/api/customer/parking/v1/lookup/documents/INSURANCE/upload`, {
    body: { filename: 'later-insurance.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
    headers: { cookie, 'x-csrf-token': exact.body.csrfToken }
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const completed = await jsonRequest(`${base}/api/customer/parking/v1/lookup/documents/complete`, {
    body: { uploadToken: started.body.upload.token }, headers: { cookie, 'x-csrf-token': exact.body.csrfToken }
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.document.status, 'RECEIVED');
});

test('Admin can securely view, download, and review a demo reservation document', async () => {
  const document = (await pool.query(`SELECT public_id FROM parking_customer_documents
    WHERE booking_id=$1 ORDER BY id DESC LIMIT 1`, [monthlyDocumented.persisted.id])).rows[0];
  const access = await adminRequest(`/documents/${document.public_id}/access`, { body: { disposition: 'INLINE' } });
  assert.equal(access.response.status, 200, JSON.stringify(access.body));
  assert.equal(access.body.access.oneTime, true);
  const accessCookie = access.response.headers.get('set-cookie').split(';')[0];
  const content = await fetch(`${base}${access.body.access.path}`, {
    headers: { cookie: `${owner.cookie}; ${accessCookie}` }
  });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'application/pdf');
  assert.equal((await content.arrayBuffer()).byteLength, 2048);
  const replay = await fetch(`${base}${access.body.access.path}`, {
    headers: { cookie: `${owner.cookie}; ${accessCookie}` }
  });
  assert.equal(replay.status, 404);
  const reviewed = await adminRequest(`/documents/${document.public_id}/review`, {
    method: 'PATCH', body: { status: 'APPROVED', note: 'Demo QA review' }
  });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.document.verificationStatus, 'APPROVED');
});

test('demo cancellation releases the exact space, retains audit history, and creates no refund or revenue', async () => {
  const before = (await pool.query('SELECT version FROM parking_bookings WHERE id=$1', [monthlyMissing.persisted.id])).rows[0];
  const cancelled = await adminRequest(`/bookings/${monthlyMissing.persisted.id}/cancel`, {
    body: { version: Number(before.version), reason: 'Demo QA complete', note: 'Release synthetic space' }
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  const row = (await pool.query(`SELECT booking.status,booking.payment_status,assignment.released_at,
      (SELECT count(*) FROM parking_customer_payments p WHERE p.booking_id=booking.id)::int payments,
      (SELECT count(*) FROM parking_stripe_events e WHERE e.booking_id=booking.id)::int stripe_events
    FROM parking_bookings booking
    JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
    WHERE booking.id=$1`, [monthlyMissing.persisted.id])).rows[0];
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.payment_status, 'DEMO_BYPASSED');
  assert.ok(row.released_at);
  assert.equal(row.payments, 0);
  assert.equal(row.stripe_events, 0);
  assert.ok(Number((await pool.query(`SELECT count(*) FROM parking_audit_events
    WHERE entity_type='booking' AND entity_id=$1 AND action='DEMO_PAYMENT_BYPASS_COMPLETED'`,
  [String(monthlyMissing.persisted.id)])).rows[0].count) >= 1);
  assert.equal(checkoutCalls.length, 0);
});

test('Owner can invalidate all unused authorizations before disabling QA mode', async () => {
  const created = await createAttempt(bookingPayload(60, 'DAILY', '2035-08-01T09:00', '2035-08-01T12:00'));
  const authorization = await issueDemo(created);
  const denied = await adminRequest('/reservation-desk/demo-payment-authorizations/revoke-unused', { session: staff });
  assert.equal(denied.response.status, 403);
  const revoked = await adminRequest('/reservation-desk/demo-payment-authorizations/revoke-unused');
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
  assert.ok(revoked.body.invalidated >= 1);
  const confirm = await confirmDemo(authorization.token);
  assert.equal(confirm.response.status, 404);
  assert.equal(confirm.body.error.code, 'DEMO_AUTHORIZATION_INVALID');
});
