process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const stripeGateway = require('../services/stripeGateway');
const storage = require('../services/privateDocumentStorage');
const notifications = require('../services/customerNotifications');
const { publishDraftSnapshot } = require('../services/layoutPublication');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing Reservation Desk tests: use parkingops_test only.');
}

const run = Date.now();
const runMarker = String(run).slice(-6);
const fixtureMc = index => `8${runMarker}${index}`;
const fixturePlate = index => `D${runMarker}${index}`;
const fixtureUnit = index => `DESK-${runMarker}-${index}`;
const password = 'ParkingOps-reservation-desk-2040';
const ownerName = `desk-owner-${run}`;
const staffName = `desk-staff-${run}`;
const checkoutRequests = [];
const objects = new Map();
let server;
let base;
let owner;
let staff;
let location;
let zone;
let inventory;
let rate;
let positions;
let daily;
let weekly;
let monthly;

stripeGateway.setTestAdapter({
  checkout: { sessions: { create: async (payload, options) => {
    checkoutRequests.push({ payload, options });
    return { id: `cs_desk_${run}_${checkoutRequests.length}`, url: `https://checkout.stripe.test/desk/${run}/${checkoutRequests.length}` };
  } } }
});

function pdf(sizeBytes) {
  const bytes = Buffer.alloc(sizeBytes);
  Buffer.from('%PDF-1.7\n').copy(bytes);
  Buffer.from('\n%%EOF\n').copy(bytes, sizeBytes - 7);
  return bytes;
}

storage.setTestAdapter({
  bucket: 'parkingops-test-private',
  async signedUpload({ key, mimeType, sizeBytes }) {
    objects.set(key, { mimeType, sizeBytes, bytes: pdf(sizeBytes) });
    return { url: `https://private-upload.test/${encodeURIComponent(key)}`, method: 'PUT', headers: { 'Content-Type': mimeType }, expiresInSeconds: 600 };
  },
  async inspect({ key }) { return objects.get(key); },
  async signedRead({ key }) { return { url: `https://private-read.test/${encodeURIComponent(key)}`, expiresInSeconds: 300 }; }
});

notifications.setTestAdapter({ send: async () => ({ id: `notice_${run}` }) });

const app = require('../app');
const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;
const idKey = label => `${label}-${crypto.randomBytes(20).toString('hex')}`;

function adminRequest(path, { method = 'GET', body, auth = owner, idempotencyKey = '' } = {}) {
  const headers = { cookie: auth.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = auth.csrfToken;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  return fetch(`${base}/api/admin/parking/v1${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function jsonRequest(path, options) {
  const response = await adminRequest(path, options);
  return { response, body: await response.json() };
}

function parking(duration, interval, option, selectedSpotId = null) {
  return {
    locationId: location.id,
    duration,
    categoryCode: 'TRACTOR_TRAILER',
    arrivalLocal: interval.arrivalLocal,
    departureLocal: interval.departureLocal,
    inventoryId: option.inventoryId,
    ...(selectedSpotId ? { selectedSpotId } : {})
  };
}

function reservationPayload(index, parkingRequest, price = { override: false }) {
  return {
    customer: {
      firstName: 'Desk', lastName: `Customer ${index}`,
      mobilePhone: `+1615${runMarker}${index}`,
      email: `desk.customer.${index}.${run}@example.test`,
      companyName: 'Desk Carrier LLC', usdotNumber: '1234567', mcNumber: fixtureMc(index)
    },
    vehicle: {
      unitNumber: fixtureUnit(index), licensePlate: fixturePlate(index),
      licensePlateState: 'TN', trailerNumber: `TRL-${index}`
    },
    parking: parkingRequest,
    price,
    customerNotes: 'Call on arrival.',
    internalNotes: 'Created by integration test.'
  };
}

async function login(username) {
  const response = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken, user: body.user };
}

test.before(async () => {
  const category = (await pool.query("SELECT id FROM parking_categories WHERE code='TRACTOR_TRAILER'")).rows[0];
  assert.ok(category, 'load the development seed before the Reservation Desk suite');
  const passwordHash = await bcrypt.hash(password, 4);
  const ownerRow = (await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'OWNER',true) RETURNING id`, [ownerName, passwordHash])).rows[0];
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'STAFF',true)`, [staffName, passwordHash]);
  location = (await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,payment_instructions,booking_approval_mode,cancellation_cutoff_hours,
      assignment_mode,exact_mode_active,self_service_enabled,check_in_early_minutes,check_in_late_minutes,turnaround_buffer_minutes)
    VALUES($1,'Synthetic Reservation Desk lot','41 Desk Way','America/Chicago','+16155550304',
      'Enter at the desk gate.','Exit south.','','AUTO_CONFIRM',0,'ZONE_CAPACITY',false,true,120,240,0) RETURNING *`,
  [`Reservation Desk integration ${run}`])).rows[0];
  zone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order)
    VALUES($1,'General Truck Parking','Synthetic Reservation Desk area','Follow the blue signs.','Use the signed exit.',10) RETURNING *`,
  [location.id])).rows[0];
  inventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity)
    VALUES($1,$2,2,'Published positions are authoritative.',true) RETURNING *`, [zone.id, category.id])).rows[0];
  rate = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Reservation Desk standard rate',3000,10000,25000,true) RETURNING *`, [location.id, zone.id, category.id])).rows[0];
  const draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,'Reservation Desk fixture','DRAFT',$2,$2) RETURNING *`, [location.id, ownerRow.id])).rows[0];
  await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active)
    VALUES($1,'ENTRANCE',$2,'Entrance',2,44,8,8,1,true,true)`, [draft.id, elementKey()]);
  positions = [];
  for (const [index, label] of ['D-01', 'D-02'].entries()) {
    const key = elementKey();
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,
        visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,true,'DESK','NEEDS_CLASSIFICATION',false,'NEEDS_CLASSIFICATION') RETURNING *`,
    [location.id, zone.id, inventory.id, label, index + 1, key])).rows[0];
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,
        parking_spot_id,x,y,width,height,layer_order,public_visible,active,parking_purpose,daily_eligible,
        weekly_eligible,monthly_eligible,space_public_bookable,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,20,10,6,$8,true,true,'CUSTOMER',true,true,true,true,$9)`,
    [draft.id, key, label, zone.id, inventory.id, spot.id, 15 + index * 18, 10 + index, rate.id]);
    positions.push(spot);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await publishDraftSnapshot(client, { layoutId: draft.id, actorId: ownerRow.id });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login(ownerName);
  staff = await login(staffName);
});

test.after(async () => {
  stripeGateway.clearTestAdapter();
  storage.clearTestAdapter();
  notifications.clearTestAdapter();
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('Staff saves a new Reservation Desk customer immediately and it remains searchable', async () => {
  const customer = reservationPayload(8, {}).customer;
  const saved = await jsonRequest('/reservation-desk/customers', { method: 'POST', auth: staff, body: customer });
  assert.equal(saved.response.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.created, true);
  assert.ok(saved.body.customer.publicId);
  const search = await jsonRequest(`/reservation-desk/customers?q=${encodeURIComponent(fixtureMc(8))}`, { auth: staff });
  assert.equal(search.response.status, 200, JSON.stringify(search.body));
  assert.equal(search.body.customers.find(item => item.publicId === saved.body.customer.publicId)?.email, customer.email);
  const audit = await pool.query(`SELECT metadata FROM parking_audit_events
    WHERE action='RESERVATION_DESK_CUSTOMER_SAVED' AND entity_id=(SELECT id::text FROM parking_customers WHERE public_id=$1)`, [saved.body.customer.publicId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].metadata.created, true);
});

test('Staff creates a standard-price Daily reservation without changing global rates', async () => {
  assert.ok(staff.user.permissions.includes('reservation.create'));
  assert.ok(!staff.user.permissions.includes('reservation.price_override'));
  const interval = { arrivalLocal: '2034-02-10T09:00', departureLocal: '2034-02-10T18:00' };
  const available = await jsonRequest('/reservation-desk/availability', { method: 'POST', auth: staff,
    body: { locationId: location.id, duration: 'DAILY', categoryCode: 'TRACTOR_TRAILER', ...interval } });
  assert.equal(available.response.status, 200, JSON.stringify(available.body));
  const option = available.body.options.find(item => item.available);
  assert.equal(option.standardPriceCents, 3000);
  const created = await jsonRequest('/reservation-desk/reservations', { method: 'POST', auth: staff,
    idempotencyKey: idKey('daily'), body: reservationPayload(1, parking('DAILY', interval, option)) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  daily = created.body;
  assert.equal(daily.reservation.source, 'ADMIN_DESK');
  assert.equal(daily.reservation.status, 'PENDING');
  assert.equal(daily.reservation.paymentStatus, 'DRAFT');
  assert.equal(daily.reservation.standardPriceCents, 3000);
  assert.equal(daily.reservation.finalPriceCents, 3000);
  assert.equal(daily.priceOverrides.length, 0);
  assert.equal((await pool.query('SELECT daily_rate_cents FROM parking_rate_rules WHERE id=$1', [rate.id])).rows[0].daily_rate_cents, 3000);
  for (const query of [fixtureMc(1), fixturePlate(1), fixtureUnit(1)]) {
    const search = await jsonRequest(`/reservation-desk/customers?q=${encodeURIComponent(query)}`, { auth: staff });
    assert.equal(search.response.status, 200, JSON.stringify(search.body));
    assert.equal(search.body.customers[0].mcNumber, fixtureMc(1));
    assert.equal(search.body.customers[0].vehicles[0].licensePlate, fixturePlate(1));
  }
  const notice = await jsonRequest(`/reservation-desk/reservations/${daily.reservation.id}/notification`, {
    method: 'POST', auth: staff, body: { kind: 'CONFIRMATION' }
  });
  assert.equal(notice.response.status, 202, JSON.stringify(notice.body));
  assert.equal(notice.body.channel, 'EMAIL');
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_notification_outbox
    WHERE booking_id=$1 AND event_type='ADMIN_RESERVATION_CREATED'`, [daily.reservation.id])).rows[0].count), 1);
});

test('Staff cannot override price and OWNER overrides are immutable and fully audited', async () => {
  const denied = await jsonRequest(`/reservation-desk/reservations/${daily.reservation.id}/price-override`, {
    method: 'POST', auth: staff, body: { version: daily.reservation.version, finalPriceCents: 2500, reason: 'Contract rate' }
  });
  assert.equal(denied.response.status, 403);
  const first = await jsonRequest(`/reservation-desk/reservations/${daily.reservation.id}/price-override`, {
    method: 'POST', auth: owner, body: { version: daily.reservation.version, finalPriceCents: 2500, reason: 'Contract rate' }
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  const second = await jsonRequest(`/reservation-desk/reservations/${daily.reservation.id}/price-override`, {
    method: 'POST', auth: owner, body: { version: first.body.reservation.version, finalPriceCents: 2400, reason: 'Manager adjustment' }
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  daily = second.body;
  assert.equal(daily.reservation.standardPriceCents, 3000);
  assert.equal(daily.reservation.finalPriceCents, 2400);
  assert.equal(daily.priceOverrides.length, 2);
  assert.equal(Number(daily.priceOverrides[0].previous_override_id), Number(daily.priceOverrides[1].id));
  await assert.rejects(pool.query('UPDATE parking_booking_price_overrides SET reason=$1 WHERE id=$2', ['Hidden rewrite', daily.priceOverrides[0].id]));
  const audit = await pool.query(`SELECT metadata FROM parking_audit_events WHERE entity_type='booking' AND entity_id=$1 AND action='RESERVATION_PRICE_OVERRIDE' ORDER BY id`, [String(daily.reservation.id)]);
  assert.equal(audit.rowCount, 2);
  assert.deepEqual(audit.rows.map(row => Number(row.metadata.standardPriceCents)), [3000, 3000]);
});

test('Staff creates open-ended Weekly capacity parking and Stripe anchors one $100 first period', async () => {
  const interval = { arrivalLocal: '2034-02-12T09:00' };
  const available = await jsonRequest('/reservation-desk/availability', { method: 'POST', auth: staff,
    body: { locationId: location.id, duration: 'WEEKLY', categoryCode: 'TRACTOR_TRAILER', ...interval } });
  assert.equal(available.response.status, 200, JSON.stringify(available.body));
  const option = available.body.options.find(item => item.available);
  assert.ok(option);
  assert.equal(option.standardPriceCents, 10000);
  assert.ok(Array.isArray(option.positions), 'Weekly may offer optional spaces for staff placement; without one it stays area capacity');
  const created = await jsonRequest('/reservation-desk/reservations', { method: 'POST', auth: staff,
    idempotencyKey: idKey('weekly'), body: reservationPayload(3, parking('WEEKLY', interval, option)) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  weekly = created.body;
  assert.equal(weekly.reservation.product, 'WEEKLY');
  assert.equal(weekly.reservation.standardPriceCents, 10000);
  assert.equal(weekly.reservation.finalPriceCents, 10000);
  assert.equal(weekly.reservation.selectedPosition, null);
  assert.equal(weekly.reservation.departureAt, null);
  const snapshot = (await pool.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1',
    [weekly.reservation.id])).rows[0].snapshot;
  assert.equal(snapshot.duration, 'WEEKLY');
  assert.equal(snapshot.unitRateCents, 10000);
  assert.equal(snapshot.totalCents, 10000);
  assert.equal(snapshot.openEnded, true);
  assert.equal(snapshot.recurringUnitRateCents, 10000);
  const payment = await jsonRequest(`/reservation-desk/reservations/${weekly.reservation.id}/payment-link`, {
    method: 'POST', auth: staff, body: {}
  });
  assert.equal(payment.response.status, 201, JSON.stringify(payment.body));
  const checkoutRequest = checkoutRequests.at(-1).payload;
  const initial = checkoutRequest.line_items.filter(item => !item.price_data.recurring);
  const recurring = checkoutRequest.line_items.filter(item => item.price_data.recurring);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].price_data.unit_amount, 10000);
  assert.equal(recurring.length, 1);
  assert.equal(recurring[0].price_data.unit_amount, 10000);
  assert.deepEqual(recurring[0].price_data.recurring, { interval: 'week' });
  assert.equal(checkoutRequest.subscription_data.trial_end, Math.floor(Date.parse(snapshot.nextBillingAt) / 1000));
  assert.equal(checkoutRequest.mode, 'subscription');
});

test('Confirmed edits record before and after values', async () => {
  const unconfirmed = await jsonRequest(`/reservation-desk/reservations/${daily.reservation.id}`, {
    method: 'PATCH', auth: staff, body: { version: daily.reservation.version, changes: { unitNumber: 'DESK-EDITED' } }
  });
  assert.equal(unconfirmed.response.status, 409);
  const updated = await jsonRequest(`/reservation-desk/reservations/${daily.reservation.id}`, {
    method: 'PATCH', auth: staff, body: { version: daily.reservation.version, confirmed: true,
      changes: { unitNumber: 'DESK-EDITED', departureLocal: '2034-02-10T19:00' } }
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  daily = updated.body;
  assert.equal(daily.reservation.unitNumber, 'DESK-EDITED');
  assert.equal(daily.reservation.departureLocal, '2034-02-10T19:00');
  const event = daily.audit.find(item => item.action === 'ADMIN_RESERVATION_UPDATED');
  assert.equal(event.metadata.before.unitNumber, fixtureUnit(1));
  assert.equal(event.metadata.after.unitNumber, 'DESK-EDITED');
  assert.equal(event.metadata.before.departureLocal, '2034-02-10T18:00');
  assert.equal(event.metadata.after.departureLocal, '2034-02-10T19:00');
});

test('Monthly requires a position but allows Stripe link creation before optional insurance upload', async () => {
  const interval = { arrivalLocal: '2034-03-01T09:00' };
  const available = await jsonRequest('/reservation-desk/availability', { method: 'POST', auth: owner,
    body: { locationId: location.id, duration: 'MONTHLY', categoryCode: 'TRACTOR_TRAILER', ...interval } });
  assert.equal(available.response.status, 200, JSON.stringify(available.body));
  const option = available.body.options.find(item => item.available && item.positions.length);
  assert.ok(option);
  const position = option.positions[0];
  const created = await jsonRequest('/reservation-desk/reservations', { method: 'POST', auth: owner,
    idempotencyKey: idKey('monthly'), body: reservationPayload(2, parking('MONTHLY', interval, option, position.id),
      { override: true, finalPriceCents: 22500, reason: 'Existing customer' }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  monthly = created.body;
  assert.equal(monthly.reservation.selectedPosition, position.label);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_customer_documents WHERE booking_id=$1', [monthly.reservation.id])).rows[0].count), 0);
  const payment = await jsonRequest(`/reservation-desk/reservations/${monthly.reservation.id}/payment-link`, { method: 'POST', auth: owner, body: {} });
  assert.equal(payment.response.status, 201, JSON.stringify(payment.body));
  const checkoutRequest = checkoutRequests.at(-1).payload;
  assert.equal(checkoutRequest.line_items.length, 1);
  assert.equal(checkoutRequest.line_items[0].price_data.unit_amount, 25000);
  assert.deepEqual(checkoutRequest.line_items[0].price_data.recurring, { interval: 'month' });
  const snapshot = (await pool.query('SELECT snapshot FROM parking_booking_price_snapshots WHERE booking_id=$1',
    [monthly.reservation.id])).rows[0].snapshot;
  assert.equal(checkoutRequest.subscription_data.billing_cycle_anchor,
    Math.floor(Date.parse(snapshot.nextBillingAt) / 1000));
  assert.equal(checkoutRequest.subscription_data.proration_behavior, undefined);
  assert.equal(checkoutRequest.discounts, undefined);
  assert.equal(checkoutRequest.mode, 'subscription');
  const start = await jsonRequest(`/reservation-desk/reservations/${monthly.reservation.id}/documents/insurance/upload`, {
    method: 'POST', auth: owner, body: { filename: 'insurance.pdf', mimeType: 'application/pdf', sizeBytes: 2048 }
  });
  assert.equal(start.response.status, 201, JSON.stringify(start.body));
  const complete = await jsonRequest(`/reservation-desk/reservations/${monthly.reservation.id}/documents/complete`, {
    method: 'POST', auth: owner, body: { uploadToken: start.body.uploadToken, documentId: start.body.document.id }
  });
  assert.equal(complete.response.status, 200, JSON.stringify(complete.body));
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_documents
    WHERE booking_id=$1 AND upload_status='UPLOADED' AND superseded_at IS NULL`, [monthly.reservation.id])).rows[0].count), 1);
  const sentLink = await jsonRequest(`/reservation-desk/reservations/${monthly.reservation.id}/notification`, {
    method: 'POST', auth: owner, body: { kind: 'PAYMENT_LINK' }
  });
  assert.equal(sentLink.response.status, 202, JSON.stringify(sentLink.body));
  const queuedLink = (await pool.query(`SELECT payload FROM parking_customer_notification_outbox
    WHERE booking_id=$1 AND event_type='ADMIN_PAYMENT_LINK_CREATED' ORDER BY id DESC LIMIT 1`, [monthly.reservation.id])).rows[0];
  assert.equal(queuedLink.payload.checkoutUrl, payment.body.checkout.url);
  const persisted = (await pool.query('SELECT payment_status,status FROM parking_bookings WHERE id=$1', [monthly.reservation.id])).rows[0];
  assert.deepEqual(persisted, { payment_status: 'CHECKOUT_PENDING', status: 'PENDING' });
});

test('Cancellation of an unpaid Monthly desk reservation releases no parking capacity', async () => {
  const detail = await jsonRequest(`/reservation-desk/reservations/${monthly.reservation.id}`, { auth: owner });
  const cancelled = await jsonRequest(`/bookings/${monthly.reservation.id}/cancel`, { method: 'POST', auth: owner,
    body: { version: detail.body.reservation.version, reason: 'Synthetic test cancellation', note: 'No money collected' } });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  const row = (await pool.query('SELECT status,payment_status FROM parking_bookings WHERE id=$1', [monthly.reservation.id])).rows[0];
  assert.equal(row.status, 'CANCELLED');
  assert.notEqual(row.payment_status, 'PAID');
  const assignment = await pool.query('SELECT 1 FROM reservation_spot_assignments WHERE booking_id=$1 AND released_at IS NULL', [monthly.reservation.id]);
  assert.equal(assignment.rowCount, 0);
});
