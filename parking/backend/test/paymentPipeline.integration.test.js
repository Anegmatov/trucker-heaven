process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { apiError } = require('../utils');
const stripeGateway = require('../services/stripeGateway');
const storage = require('../services/privateDocumentStorage');
const { releaseEndedSubscriptions } = require('../services/paymentLifecycle');
const { publishDraftSnapshot } = require('../services/layoutPublication');
const { areaCapacityMetrics } = require('../services/parkingService');
const liveLotReadModel = require('../services/liveLotReadModel');
const testRun = Date.now();
const monthlySubscriptionId = `sub_monthly_${testRun}`;
const dailyDuplicateEventId = `evt_daily_duplicate_${testRun}`;

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing payment-pipeline PostgreSQL tests: use parkingops_test only.');
}

const checkoutRequests = [];
const portalRequests = [];
const testObjects = new Map();
function testFileBytes(mimeType, sizeBytes) {
  const bytes = Buffer.alloc(sizeBytes);
  if (mimeType === 'application/pdf') {
    Buffer.from('%PDF-1.7\n').copy(bytes);
    Buffer.from('\n%%EOF\n').copy(bytes, sizeBytes - 7);
  } else if (mimeType === 'image/png') {
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes);
    Buffer.from('IEND').copy(bytes, sizeBytes - 8);
  } else {
    Buffer.from([0xff,0xd8,0xff,0xe0]).copy(bytes);
    Buffer.from([0xff,0xd9]).copy(bytes, sizeBytes - 2);
  }
  return bytes;
}
let sessionSequence = 0;
stripeGateway.setTestAdapter({
  checkout: { sessions: { create: async (payload, options) => {
    checkoutRequests.push({ payload, options });
    sessionSequence += 1;
    return { id: `cs_test_${testRun}_${sessionSequence}`, url: `https://checkout.stripe.test/session/${testRun}/${sessionSequence}` };
  } } },
  billingPortal: { sessions: { create: async payload => {
    portalRequests.push(payload);
    return { id: `bps_test_${testRun}_${portalRequests.length}`, url: `https://billing.stripe.test/session/${testRun}/${portalRequests.length}` };
  } } },
  constructWebhookEvent(rawBody, signature) {
    if (signature !== 'valid-test-signature') throw apiError('STRIPE_SIGNATURE_INVALID', 'Stripe webhook signature is invalid', 400);
    return JSON.parse(Buffer.from(rawBody).toString('utf8'));
  }
});
storage.setTestAdapter({
  bucket: 'parkingops-test-private',
  async signedUpload({ key, mimeType, sizeBytes }) {
    testObjects.set(key, { mimeType, sizeBytes, bytes: testFileBytes(mimeType, sizeBytes) });
    return { url: `https://private-upload.test/${encodeURIComponent(key)}`, method: 'PUT', headers: { 'Content-Type': mimeType }, expiresInSeconds: 600 };
  },
  async inspect({ key }) { return testObjects.get(key); },
  async signedRead({ key }) { return { url: `https://private-read.test/${encodeURIComponent(key)}?expires=300`, expiresInSeconds: 300 }; }
});

const app = require('../app');

const unique = testRun;
const password = 'ParkingOps-payment-test-2037';
const ownerName = `payment-owner-${unique}`;
const dailyInterval = { arrivalLocal: '2035-03-10T09:00', departureLocal: '2035-03-10T12:00' };
const weeklyInterval = { arrivalLocal: '2035-03-12T09:00', departureLocal: '2035-03-19T09:00' };
const monthlyInterval = { arrivalLocal: '2035-04-01T09:00' };
const failedMonthlyInterval = { arrivalLocal: '2035-06-01T09:00' };
let server;
let base;
let owner;
let location;
let zone;
let category;
let inventory;
let rate;
let spots;
let daily;
let integrityDaily;
let monthly;
let documentedMonthly;

const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;
const idKey = label => `${label}-${crypto.randomBytes(18).toString('hex')}`;

async function publicPost(path, body, key = '') {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

async function webhook(event, signature = 'valid-test-signature') {
  const response = await fetch(`${base}/api/payments/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(event)
  });
  return { response, body: await response.json() };
}

function payload(index, duration, interval, selectedSpotId = null) {
  return {
    parkingAreaId: zone.public_id,
    categoryCode: category.code,
    duration,
    ...interval,
    firstName: 'Payment',
    lastName: `Customer ${index}`,
    mobilePhone: `+1615555${String(6000 + index).padStart(4, '0')}`,
    email: `payment.customer.${index}.${unique}@example.test`,
    companyName: duration === 'MONTHLY' ? 'Verified Carrier LLC' : '',
    usdotNumber: duration === 'MONTHLY' ? '1234567' : '',
    tractorUnitNumber: `PAY-${index}`,
    licensePlate: `PAY${index}`,
    licensePlateState: 'TN',
    termsAccepted: true,
    cancellationTermsAccepted: true,
    ...(selectedSpotId ? { selectedSpotId } : {})
  };
}

async function quoteAttemptCheckout(body, { uploadInsurance = false } = {}) {
  const quote = await publicPost('/quotes', body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  const attempt = await publicPost('/booking-attempts', {
    ...body,
    quoteToken: quote.body.quoteToken,
    termsVersion: quote.body.terms.version
  }, idKey('attempt'));
  assert.equal(attempt.response.status, 201, JSON.stringify(attempt.body));
  const access = {
    publicToken: attempt.body.bookingAttempt.publicToken,
    lookupCredential: attempt.body.bookingAttempt.lookupCredential
  };
  let document = null;
  if (uploadInsurance) {
    const start = await publicPost(`/bookings/${access.publicToken}/documents/insurance/upload`, {
      lookupCredential: access.lookupCredential,
      filename: 'insurance.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048
    });
    assert.equal(start.response.status, 201, JSON.stringify(start.body));
    document = start.body;
    const complete = await publicPost(`/bookings/${access.publicToken}/documents/complete`, {
      lookupCredential: access.lookupCredential,
      uploadToken: document.upload.token
    });
    assert.equal(complete.response.status, 200, JSON.stringify(complete.body));
  }
  const checkout = await publicPost('/payments/stripe/checkout-sessions', {
    ...access,
    amount: 1,
    currency: 'cad'
  }, idKey('checkout'));
  assert.equal(checkout.response.status, 201, JSON.stringify(checkout.body));
  return { body, quote, attempt, access, document, checkout, stripeRequest: checkoutRequests.at(-1).payload };
}

function event(type, object, id = `evt_${crypto.randomBytes(8).toString('hex')}`) {
  return { id, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } };
}

test.before(async () => {
  category = (await pool.query("SELECT id,code FROM parking_categories WHERE code='BOBTAIL'")).rows[0];
  assert.ok(category, 'load the development seed before the payment suite');
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'OWNER',true)`, [ownerName, await bcrypt.hash(password, 4)]);
  owner = (await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [ownerName])).rows[0];
  location = (await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,
      arrival_instructions,exit_instructions,payment_instructions,booking_approval_mode,cancellation_cutoff_hours,
      assignment_mode,exact_mode_active,self_service_enabled,turnaround_buffer_minutes)
    VALUES($1,'Synthetic payment test lot','31 Payment Way','America/Chicago','+16155550301',
      'Enter at the test gate.','Exit south.','','AUTO_CONFIRM',0,'ZONE_CAPACITY',false,true,0) RETURNING *`,
  [`Payment pipeline integration ${unique}`])).rows[0];
  zone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,display_order)
    VALUES($1,'Payment Test Parking','Synthetic','Follow signs.',10) RETURNING *`, [location.id])).rows[0];
  inventory = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_remaining_capacity)
    VALUES($1,$2,3,true) RETURNING *`, [zone.id, category.id])).rows[0];
  rate = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,active)
    VALUES($1,$2,$3,'Authoritative payment rate',1900,10000,25000,true) RETURNING *`, [location.id, zone.id, category.id])).rows[0];
  const draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,'Payment fixture','DRAFT',$2,$2) RETURNING *`, [location.id, owner.id])).rows[0];
  await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active)
    VALUES($1,'ENTRANCE',$2,'Entrance',2,44,8,8,1,true,true)`, [draft.id, elementKey()]);
  spots = {};
  for (const [index, label] of ['201', '202', '203'].entries()) {
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await publishDraftSnapshot(client, { layoutId: draft.id, actorId: owner.id });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  stripeGateway.clearTestAdapter();
  storage.clearTestAdapter();
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('server price cannot be altered and Daily creates a one-time Checkout Session', async () => {
  daily = await quoteAttemptCheckout(payload(1, 'DAILY', dailyInterval));
  assert.equal(daily.quote.body.quote.unitRateCents, 1900);
  assert.equal(daily.quote.body.quote.totalCents, 1900);
  assert.equal(daily.stripeRequest.mode, 'payment');
  assert.equal(checkoutRequests.at(-1).options.idempotencyKey,
    `parkingops-checkout:${(await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [daily.access.publicToken])).rows[0].id}`);
  assert.equal(daily.stripeRequest.line_items[0].price_data.unit_amount, daily.quote.body.quote.totalCents);
  const snapshot = (await pool.query(`SELECT snapshot.snapshot FROM parking_bookings booking
    JOIN parking_booking_price_snapshots snapshot ON snapshot.booking_id=booking.id
    WHERE booking.public_token=$1`, [daily.access.publicToken])).rows[0].snapshot;
  assert.equal(snapshot.unitRateCents, 1900);
  assert.equal(snapshot.totalCents, 1900);
  assert.equal(daily.stripeRequest.line_items[0].price_data.currency, 'usd');
  assert.equal(daily.stripeRequest.line_items[0].price_data.recurring, undefined);
  await assert.rejects(
    pool.query('UPDATE parking_bookings SET departure_at=NULL WHERE public_token=$1', [daily.access.publicToken]),
    error => error.code === '23514'
  );
  assert.equal(daily.stripeRequest.metadata.parking_product, 'DAILY');
  assert.ok(Number.isSafeInteger(daily.stripeRequest.expires_at));
  assert.ok(daily.stripeRequest.expires_at >= Math.floor(Date.now() / 1000) + 1700);
  const expiry = (await pool.query(`SELECT booking.stripe_checkout_expires_at,booking.pending_expires_at,quote.checkout_hold_expires_at
    FROM parking_bookings booking JOIN parking_public_quotes quote ON quote.checkout_booking_id=booking.id
    WHERE booking.public_token=$1`, [daily.access.publicToken])).rows[0];
  assert.equal(new Date(expiry.stripe_checkout_expires_at).getTime(), daily.stripeRequest.expires_at * 1000);
  assert.ok(new Date(expiry.pending_expires_at).getTime() >= new Date(expiry.stripe_checkout_expires_at).getTime() + 60000);
  assert.equal(new Date(expiry.pending_expires_at).getTime(), new Date(expiry.checkout_hold_expires_at).getTime());
});

test('Weekly availability, quote, immutable snapshot, and one-time Checkout all retain $100', async () => {
  const body = payload(9, 'WEEKLY', weeklyInterval);
  const availability = await publicPost('/availability', body);
  assert.equal(availability.response.status, 200, JSON.stringify(availability.body));
  const available = availability.body.results.find(item => item.available);
  assert.ok(available);
  const selectedOffer = available.offeredDurations.find(item => item.code === 'WEEKLY');
  assert.equal(selectedOffer.unitRateCents, 10000);
  const weekly = await quoteAttemptCheckout(body);
  assert.equal(weekly.quote.body.quote.duration, 'WEEKLY');
  assert.equal(weekly.quote.body.quote.unitRateCents, 10000);
  assert.equal(weekly.quote.body.quote.totalCents, 10000);
  const persisted = (await pool.query(`SELECT booking.parking_product,booking.assignment_mode_snapshot,snapshot.snapshot
    FROM parking_bookings booking JOIN parking_booking_price_snapshots snapshot ON snapshot.booking_id=booking.id
    WHERE booking.public_token=$1`, [weekly.access.publicToken])).rows[0];
  assert.equal(persisted.parking_product, 'WEEKLY');
  assert.equal(persisted.assignment_mode_snapshot, 'ZONE_CAPACITY');
  assert.equal(persisted.snapshot.duration, 'WEEKLY');
  assert.equal(persisted.snapshot.totalCents, 10000);
  assert.equal(weekly.stripeRequest.mode, 'payment');
  assert.equal(weekly.stripeRequest.metadata.parking_product, 'WEEKLY');
  assert.equal(weekly.stripeRequest.line_items[0].price_data.unit_amount, 10000);
  assert.equal(weekly.stripeRequest.line_items[0].price_data.product_data.name, 'Weekly Parking');
});

test('browser success/cancel navigation cannot mark a booking paid', async () => {
  const state = await publicPost('/payments/status', daily.access);
  assert.equal(state.response.status, 200);
  assert.equal(state.body.booking.paymentStatus, 'CHECKOUT_PENDING');
  assert.equal(state.body.booking.confirmed, false);
  assert.equal((await pool.query('SELECT status,payment_status FROM parking_bookings WHERE public_token=$1', [daily.access.publicToken])).rows[0].status, 'PENDING');
  const availability = await publicPost('/availability', payload(90, 'DAILY', dailyInterval));
  assert.equal(availability.response.status, 200, JSON.stringify(availability.body));
  assert.equal(availability.body.results.find(item => item.available)?.remainingCapacity, 3,
    'an unpaid Checkout attempt must not consume any of the three physical spaces');
  const metrics = await areaCapacityMetrics(pool, { locationId: location.id, at: '2035-03-10T16:00:00Z' });
  assert.deepEqual(metrics.find(item => Number(item.inventoryId) === Number(inventory.id)).reservedCapacity, 0,
    'Admin capacity metrics must not count an unpaid Checkout attempt as reserved');
  const liveLot = await liveLotReadModel.snapshot(pool, location.id, '2035-03-10T16:00:00Z');
  assert.deepEqual({ reserved: liveLot.summary.reserved, occupied: liveLot.summary.occupied }, { reserved: 0, occupied: 0 },
    'Live Lot must not display an unpaid Checkout attempt as reserved or occupied');
});

test('invalid Stripe signature is rejected', async () => {
  const result = await webhook(event('checkout.session.completed', {}), 'invalid');
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, 'STRIPE_SIGNATURE_INVALID');
});

test('a signed live-mode event is rejected by a test-mode Stripe configuration', async () => {
  const result = await webhook({ ...event('checkout.session.completed', {}), livemode: true });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, 'STRIPE_MODE_MISMATCH');
});

test('valid Daily webhook confirms payment without assigning an exact space', async () => {
  const result = await webhook(event('checkout.session.completed', {
    object: 'checkout.session',
    id: daily.checkout.body.checkout.id,
    payment_status: 'paid',
    amount_total: daily.quote.body.quote.totalCents,
    currency: 'usd',
    customer: 'cus_daily',
    payment_intent: 'pi_daily',
    metadata: { parking_booking_id: String((await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [daily.access.publicToken])).rows[0].id) }
  }), 'valid-test-signature');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = (await pool.query(`SELECT booking.status,booking.payment_status,booking.customer_id,
      customer.status customer_status,customer.stripe_customer_id,count(assignment.id)::int assignments
    FROM parking_bookings booking LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
    JOIN parking_customers customer ON customer.id=booking.customer_id
    WHERE booking.public_token=$1 GROUP BY booking.id,customer.id`, [daily.access.publicToken])).rows[0];
  assert.equal(row.status, 'CONFIRMED');
  assert.equal(row.payment_status, 'PAID');
  assert.equal(row.assignments, 0);
  assert.ok(row.customer_id);
  assert.equal(row.customer_status, 'ACTIVE');
  assert.equal(row.stripe_customer_id, 'cus_daily');
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_payments
    WHERE customer_id=$1 AND processor_payment_id='pi_daily' AND status='PAID'`, [row.customer_id])).rows[0].count), 1);
});

test('duplicate Stripe event is idempotent', async () => {
  const booking = (await pool.query('SELECT id,stripe_checkout_session_id FROM parking_bookings WHERE public_token=$1', [daily.access.publicToken])).rows[0];
  const stripeEvent = event('checkout.session.completed', {
    object: 'checkout.session', id: booking.stripe_checkout_session_id, payment_status: 'paid',
    amount_total: daily.quote.body.quote.totalCents, currency: 'usd', customer: 'cus_daily', payment_intent: 'pi_daily',
    metadata: { parking_booking_id: String(booking.id) }
  }, dailyDuplicateEventId);
  assert.equal((await webhook(stripeEvent)).response.status, 200);
  const duplicate = await webhook(stripeEvent);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_stripe_events WHERE stripe_event_id=$1', [dailyDuplicateEventId])).rows[0].count), 1);
});

test('wrong amounts, wrong currency, and conflicting durable references cannot attach payment to another reservation', async () => {
  integrityDaily = await quoteAttemptCheckout(payload(5, 'DAILY', dailyInterval));
  const target = (await pool.query(`SELECT id,stripe_checkout_session_id,status,payment_status
    FROM parking_bookings WHERE public_token=$1`, [integrityDaily.access.publicToken])).rows[0];
  const paid = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [daily.access.publicToken])).rows[0];
  const baseObject = {
    object: 'checkout.session', id: target.stripe_checkout_session_id, payment_status: 'paid',
    amount_total: integrityDaily.quote.body.quote.totalCents, currency: 'usd',
    customer: 'cus_integrity', payment_intent: `pi_integrity_${testRun}`,
    metadata: { parking_booking_id: String(target.id) }
  };
  const wrongAmount = await webhook(event('checkout.session.completed', {
    ...baseObject, amount_total: baseObject.amount_total + 1
  }));
  assert.equal(wrongAmount.response.status, 409);
  assert.equal(wrongAmount.body.error.code, 'STRIPE_AMOUNT_MISMATCH');
  const wrongCurrency = await webhook(event('checkout.session.completed', {
    ...baseObject, currency: 'cad'
  }));
  assert.equal(wrongCurrency.response.status, 409);
  assert.equal(wrongCurrency.body.error.code, 'STRIPE_AMOUNT_MISMATCH');
  const conflictEventId = `evt_binding_conflict_${testRun}`;
  const conflict = await webhook(event('checkout.session.completed', {
    ...baseObject, metadata: { parking_booking_id: String(paid.id) }
  }, conflictEventId));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'STRIPE_BINDING_MISMATCH');
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_stripe_events WHERE stripe_event_id=$1', [conflictEventId])).rows[0].count), 0);
  const unchanged = (await pool.query('SELECT status,payment_status FROM parking_bookings WHERE id=$1', [target.id])).rows[0];
  assert.deepEqual(unchanged, { status: 'PENDING', payment_status: 'CHECKOUT_PENDING' });
  const retry = await webhook(event('checkout.session.completed', baseObject));
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.deepEqual((await pool.query('SELECT status,payment_status FROM parking_bookings WHERE id=$1', [target.id])).rows[0],
    { status: 'CONFIRMED', payment_status: 'PAID' });
});

test('Monthly with no document creates subscription Checkout and leaves insurance missing', async () => {
  const body = payload(2, 'MONTHLY', monthlyInterval, spots['201'].id);
  const availability = await publicPost('/availability', body);
  assert.equal(availability.response.status, 200, JSON.stringify(availability.body));
  const available = availability.body.results.find(item => item.available);
  assert.ok(available);
  const selectedOffer = available.offeredDurations.find(item => item.code === 'MONTHLY');
  assert.equal(selectedOffer.unitRateCents, 25000);
  const quote = await publicPost('/quotes', body);
  assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.quote.duration, 'MONTHLY');
  assert.equal(quote.body.quote.unitRateCents, 25000);
  assert.equal(quote.body.quote.units, 1);
  assert.equal(quote.body.quote.totalCents, 25000);
  assert.notEqual(quote.body.quote.totalCents, 30000);
  const attempt = await publicPost('/booking-attempts', { ...body, quoteToken: quote.body.quoteToken, termsVersion: quote.body.terms.version }, idKey('monthly-attempt'));
  assert.equal(attempt.response.status, 201, JSON.stringify(attempt.body));
  assert.equal(attempt.body.insuranceRequired, false);
  assert.equal(attempt.body.documentUploadOptional, true);
  const pendingPositions = await publicPost('/monthly-positions', body);
  assert.equal(pendingPositions.response.status, 200, JSON.stringify(pendingPositions.body));
  const pendingPosition = pendingPositions.body.positions.find(item => Number(item.parkingSpotId) === Number(spots['201'].id));
  assert.equal(pendingPosition?.state, 'HELD', 'the requested position is held (not yet reserved) until payment is verified');
  assert.equal(pendingPosition?.available, false, 'other drivers see a held position as taken');
  const access = { publicToken: attempt.body.bookingAttempt.publicToken, lookupCredential: attempt.body.bookingAttempt.lookupCredential };
  const unauthorized = await publicPost(`/bookings/${access.publicToken}/documents/insurance/upload`, {
    lookupCredential: 'unrelated-customer', filename: 'insurance.pdf', mimeType: 'application/pdf', sizeBytes: 2048
  });
  assert.equal(unauthorized.response.status, 403);
  const checkout = await publicPost('/payments/stripe/checkout-sessions', access, idKey('monthly-no-document'));
  assert.equal(checkout.response.status, 201, JSON.stringify(checkout.body));
  const stripeRequest = checkoutRequests.at(-1).payload;
  assert.equal(stripeRequest.mode, 'subscription');
  assert.equal(stripeRequest.line_items.length, 1);
  assert.deepEqual(stripeRequest.line_items[0].price_data.recurring, { interval: 'month' });
  assert.equal(stripeRequest.line_items[0].price_data.unit_amount, 25000);
  assert.equal(stripeRequest.subscription_data.billing_cycle_anchor,
    Math.floor(Date.parse('2035-05-01T05:00:00.000Z') / 1000));
  assert.equal(stripeRequest.subscription_data.proration_behavior, undefined);
  assert.equal(stripeRequest.discounts, undefined);
  const booking = (await pool.query(`SELECT booking.id,snapshot.snapshot FROM parking_bookings booking
    JOIN parking_booking_price_snapshots snapshot ON snapshot.booking_id=booking.id WHERE booking.public_token=$1`, [access.publicToken])).rows[0];
  assert.equal(booking.snapshot.duration, 'MONTHLY');
  assert.equal(booking.snapshot.totalCents, 25000);
  assert.equal((await pool.query('SELECT departure_at FROM parking_bookings WHERE id=$1', [booking.id])).rows[0].departure_at, null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_customer_documents WHERE booking_id=$1', [booking.id])).rows[0].count), 0);
  monthly = { body, quote, attempt, access, checkout, document: null, stripeRequest };
});

test('mid-month Monthly Checkout charges the prorated first month once and renews at $250', async () => {
  const result = await quoteAttemptCheckout(payload(6, 'MONTHLY', { arrivalLocal: '2035-09-15T09:00' }, spots['203'].id));
  assert.equal(result.quote.body.quote.totalCents, 13333);
  assert.equal(result.quote.body.quote.recurringUnitRateCents, 25000);
  assert.equal(result.quote.body.quote.nextBillingAt, '2035-10-01T05:00:00.000Z');
  assert.equal(result.stripeRequest.line_items.length, 1);
  assert.equal(result.stripeRequest.line_items[0].price_data.unit_amount, 25000);
  assert.deepEqual(result.stripeRequest.line_items[0].price_data.recurring, { interval: 'month' });
  assert.equal(result.stripeRequest.subscription_data.billing_cycle_anchor,
    Math.floor(Date.parse(result.quote.body.quote.nextBillingAt) / 1000));
  assert.equal(result.stripeRequest.subscription_data.proration_behavior, undefined);
  assert.equal(result.stripeRequest.discounts, undefined);
});

test('successful first Monthly payment without a document confirms and assigns only the selected space', async () => {
  const booking = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [monthly.access.publicToken])).rows[0];
  const result = await webhook(event('checkout.session.completed', {
    object: 'checkout.session', id: monthly.checkout.body.checkout.id, payment_status: 'paid',
    amount_total: monthly.quote.body.quote.totalCents, currency: 'usd', customer: 'cus_monthly',
    subscription: monthlySubscriptionId, invoice: `in_monthly_first_${testRun}`,
    metadata: { parking_booking_id: String(booking.id), selected_space_id: String(spots['201'].id) }
  }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = (await pool.query(`SELECT booking.status,booking.payment_status,booking.stripe_subscription_id,
      booking.customer_id,customer.status customer_status,customer.stripe_customer_id,
      assignment.parking_spot_id,quote.hold_status
    FROM parking_bookings booking JOIN parking_public_quotes quote ON quote.checkout_booking_id=booking.id
    JOIN parking_customers customer ON customer.id=booking.customer_id
    JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
    WHERE booking.id=$1`, [booking.id])).rows[0];
  assert.equal(row.status, 'CONFIRMED');
  assert.equal(row.payment_status, 'PAID');
  assert.equal(row.stripe_subscription_id, monthlySubscriptionId);
  assert.equal(Number(row.parking_spot_id), Number(spots['201'].id));
  assert.equal(row.hold_status, 'CONSUMED');
  assert.equal(row.customer_status, 'ACTIVE');
  assert.equal(row.stripe_customer_id, 'cus_monthly');
  const paidFutureLiveLot = await liveLotReadModel.snapshot(pool, location.id, new Date().toISOString());
  const paidFutureSpace = paidFutureLiveLot.spaces.find(space => Number(space.id) === Number(spots['201'].id));
  assert.equal(paidFutureSpace.operationalStatus, 'RESERVED');
  assert.equal(Number(paidFutureSpace.currentReservation?.id), Number(booking.id));
  assert.equal(paidFutureSpace.currentReservation?.paymentStatus, 'PAID');
  assert.ok(new Date(paidFutureSpace.currentReservation?.startsAt).getTime() > Date.now());
  const protectedPositions = await publicPost('/monthly-positions', payload(3, 'MONTHLY', monthlyInterval));
  assert.equal(protectedPositions.response.status, 200, JSON.stringify(protectedPositions.body));
  assert.equal(protectedPositions.body.positions.find(position => Number(position.parkingSpotId) === Number(spots['201'].id))?.available, false);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_customer_documents WHERE booking_id=$1', [booking.id])).rows[0].count), 0);
});

test('first Monthly invoice is recorded without a false renewal and later invoices notify renewal', async () => {
  const booking = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [monthly.access.publicToken])).rows[0];
  const firstInvoiceId = `in_monthly_initial_${testRun}`;
  // Stripe's one-time initial line is not authoritative for our calendar-month
  // ledger boundaries; those come from the immutable booking snapshot.
  const firstPeriodStart = Math.floor(new Date('2035-06-15T00:00:00Z').getTime() / 1000);
  const firstInvoiceEvent = event('invoice.paid', {
    object: 'invoice', id: firstInvoiceId, customer: 'cus_monthly', subscription: monthlySubscriptionId,
    amount_paid: monthly.quote.body.quote.totalCents, currency: 'usd', hosted_invoice_url: 'https://invoice.stripe.test/first',
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, metadata: { parking_booking_id: String(booking.id) },
    lines: { data: [{ period: { start: firstPeriodStart, end: firstPeriodStart + 2592000 } }] }
  }, `evt_monthly_initial_${testRun}`);
  const first = await webhook(firstInvoiceEvent);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_payments
    WHERE booking_id=$1 AND processor_payment_id=$2 AND status='PAID'`, [booking.id, firstInvoiceId])).rows[0].count), 1);
  const firstBalance = (await pool.query(`SELECT status,amount_due_cents,paid_cents,balance_cents
    FROM parking_customer_billing_period_balances WHERE booking_id=$1 AND period_start='2035-04-01'`, [booking.id])).rows[0];
  assert.deepEqual({ status: firstBalance.status, due: Number(firstBalance.amount_due_cents),
    paid: Number(firstBalance.paid_cents), balance: Number(firstBalance.balance_cents) },
  { status: 'PAID', due: monthly.quote.body.quote.totalCents, paid: monthly.quote.body.quote.totalCents, balance: 0 });
  assert.equal((await pool.query('SELECT billing_period_end_at FROM parking_bookings WHERE id=$1', [booking.id]))
    .rows[0].billing_period_end_at.toISOString(), monthly.quote.body.quote.nextBillingAt);
  const replay = await webhook(firstInvoiceEvent);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_payments
    WHERE booking_id=$1 AND processor_payment_id=$2`, [booking.id, firstInvoiceId])).rows[0].count), 1);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_notification_outbox
    WHERE booking_id=$1 AND event_type='MONTHLY_RENEWED'`, [booking.id])).rows[0].count), 0);

  const renewalInvoiceId = `in_monthly_renewal_${testRun}`;
  const renewalPeriodStart = Math.floor(new Date('2035-05-01T00:00:00Z').getTime() / 1000);
  const renewal = await webhook(event('invoice.paid', {
    object: 'invoice', id: renewalInvoiceId, customer: 'cus_monthly', subscription: monthlySubscriptionId,
    amount_paid: monthly.quote.body.quote.totalCents, currency: 'usd', hosted_invoice_url: 'https://invoice.stripe.test/renewal',
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, metadata: { parking_booking_id: String(booking.id) },
    lines: { data: [{ period: { start: renewalPeriodStart, end: renewalPeriodStart + 2678400 } }] }
  }));
  assert.equal(renewal.response.status, 200, JSON.stringify(renewal.body));
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_billing_period_balances
    WHERE booking_id=$1 AND status='PAID'`, [booking.id])).rows[0].count), 2);
  assert.ok(Number((await pool.query(`SELECT count(*) FROM parking_customer_notification_outbox
    WHERE booking_id=$1 AND event_type='MONTHLY_RENEWED'`, [booking.id])).rows[0].count) >= 1);
});

test('paid selected Monthly space is unavailable to another customer', async () => {
  const result = await publicPost('/monthly-positions', payload(3, 'MONTHLY', monthlyInterval));
  assert.equal(result.response.status, 200);
  const selected = result.body.positions.find(position => Number(position.parkingSpotId) === Number(spots['201'].id));
  assert.equal(selected.available, false);
  assert.equal(selected.state, 'RESERVED');
});

test('Monthly with a valid optional document reaches Checkout and expiration releases its hold', async () => {
  const failed = await quoteAttemptCheckout(payload(4, 'MONTHLY', failedMonthlyInterval, spots['202'].id), { uploadInsurance: true });
  documentedMonthly = failed;
  assert.ok(failed.document);
  assert.equal(failed.checkout.response.status, 201);
  const booking = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [failed.access.publicToken])).rows[0];
  const result = await webhook(event('checkout.session.expired', {
    object: 'checkout.session', id: failed.checkout.body.checkout.id, customer: 'cus_expired',
    metadata: { parking_booking_id: String(booking.id) }
  }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = (await pool.query(`SELECT booking.status,booking.payment_status,quote.hold_status,
      count(assignment.id)::int assignments FROM parking_bookings booking
    JOIN parking_public_quotes quote ON quote.checkout_booking_id=booking.id
    LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
    WHERE booking.id=$1 GROUP BY booking.id,quote.id`, [booking.id])).rows[0];
  assert.equal(row.status, 'EXPIRED');
  assert.equal(row.payment_status, 'EXPIRED');
  assert.equal(row.hold_status, 'EXPIRED');
  assert.equal(row.assignments, 0);
});

test('recurring invoice failure marks Monthly past due and preserves its space', async () => {
  const booking = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [monthly.access.publicToken])).rows[0];
  const result = await webhook(event('invoice.payment_failed', {
    object: 'invoice', id: `in_monthly_failed_${testRun}`, customer: 'cus_monthly', subscription: monthlySubscriptionId,
    metadata: { parking_booking_id: String(booking.id) }
  }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const row = (await pool.query(`SELECT booking.payment_status,booking.payment_grace_ends_at,assignment.released_at
    FROM parking_bookings booking JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
    WHERE booking.id=$1`, [booking.id])).rows[0];
  assert.equal(row.payment_status, 'PAST_DUE');
  assert.ok(row.payment_grace_ends_at);
  assert.equal(row.released_at, null);
});

test('subscription deletion respects paid-through date and later releases assignment', async () => {
  const booking = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [monthly.access.publicToken])).rows[0];
  const future = Math.floor(Date.now() / 1000) + 86400;
  const result = await webhook(event('customer.subscription.deleted', {
    object: 'subscription', id: monthlySubscriptionId, customer: 'cus_monthly', current_period_end: future,
    metadata: { parking_booking_id: String(booking.id) }
  }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal((await pool.query('SELECT released_at FROM reservation_spot_assignments WHERE booking_id=$1', [booking.id])).rows[0].released_at, null);
  await pool.query(`UPDATE parking_bookings SET billing_period_end_at=now()-interval '1 minute',payment_grace_ends_at=NULL WHERE id=$1`, [booking.id]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await releaseEndedSubscriptions(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const ended = (await pool.query(`SELECT booking.status,booking.payment_status,assignment.released_at
    FROM parking_bookings booking JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
    WHERE booking.id=$1`, [booking.id])).rows[0];
  assert.equal(ended.status, 'CANCELLED');
  assert.equal(ended.payment_status, 'CANCELLED');
  assert.ok(ended.released_at);
});

test('Customer Portal is created server-side for a paid Monthly customer', async () => {
  const row = (await pool.query('SELECT id FROM parking_bookings WHERE public_token=$1', [monthly.access.publicToken])).rows[0];
  await pool.query(`UPDATE parking_bookings SET payment_status='PAID',payment_confirmed_at=now(),stripe_customer_id='cus_monthly' WHERE id=$1`, [row.id]);
  const result = await publicPost('/payments/stripe/portal-sessions', monthly.access);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.match(result.body.portal.url, /^https:\/\/billing\.stripe\.test\//);
  assert.equal(portalRequests.at(-1).customer, 'cus_monthly');
});

test('document bytes and permanent object URLs are never stored in PostgreSQL', async () => {
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_name='parking_customer_documents' ORDER BY column_name`)).rows.map(row => row.column_name);
  assert.equal(columns.includes('file_bytes'), false);
  assert.equal(columns.includes('public_url'), false);
  const document = (await pool.query(`SELECT document.storage_provider,document.storage_key,
      document.detected_mime_type,document.upload_status,document.sha256_hex
    FROM parking_customer_documents document
    JOIN parking_bookings booking ON booking.id=document.booking_id
    WHERE booking.public_token=$1
      AND document.document_type IN ('INSURANCE','VEHICLE_CARRIER_INSURANCE')
      AND document.superseded_at IS NULL
    ORDER BY document.id DESC LIMIT 1`, [documentedMonthly.access.publicToken])).rows[0];
  assert.equal(document.storage_provider, 'TEST');
  assert.equal(document.detected_mime_type, 'application/pdf');
  assert.equal(document.upload_status, 'UPLOADED');
  assert.match(document.sha256_hex, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(document.storage_key, /insurance\.pdf/i);
});

test('Bobtail Monthly Checkout lets Stripe charge the $150 prorated first month once', async () => {
  await pool.query('UPDATE parking_rate_rules SET monthly_rate_cents=15000 WHERE id=$1', [rate.id]);
  const result = await quoteAttemptCheckout(payload(7, 'MONTHLY', { arrivalLocal: '2035-09-15T09:00' }, spots['201'].id));
  assert.match(result.checkout.body.checkout.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(result.quote.body.quote.totalCents, 8000);
  assert.equal(result.quote.body.quote.recurringUnitRateCents, 15000);
  assert.equal(result.stripeRequest.line_items.length, 1);
  assert.equal(result.stripeRequest.line_items[0].price_data.unit_amount, 15000);
  assert.deepEqual(result.stripeRequest.line_items[0].price_data.recurring, { interval: 'month' });
  assert.equal(result.stripeRequest.subscription_data.billing_cycle_anchor,
    Math.floor(Date.parse(result.quote.body.quote.nextBillingAt) / 1000));
  assert.equal(result.stripeRequest.subscription_data.proration_behavior, undefined);
});
