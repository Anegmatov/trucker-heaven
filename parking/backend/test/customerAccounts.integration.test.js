process.env.NODE_ENV = 'test';
process.env.PARKING_CUSTOMER_AUTH_REQUEST_RATE_LIMIT_MAX = '1000';
process.env.PARKING_CUSTOMER_AUTH_VERIFY_RATE_LIMIT_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const notifications = require('../services/customerNotifications');
const stripeGateway = require('../services/stripeGateway');
const storage = require('../services/privateDocumentStorage');
const { resolveOrCreateCustomer } = require('../services/customerIdentity');
const { token, digest, reservationNumber } = require('../utils');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing customer-account tests: use parkingops_test only.');
}

const delivered = [];
const scheduledCancellations = [];
const storedDocuments = new Map();
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
notifications.setTestAdapter({ async send(message) { delivered.push(message); return { accepted: true }; } });
storage.setTestAdapter({
  bucket: 'parkingops-test-private',
  async signedUpload({ key, mimeType, sizeBytes }) {
    const body = testFileBytes(mimeType, sizeBytes);
    storedDocuments.set(key, { mimeType, sizeBytes, bytes: body, body });
    return { url: `https://private-upload.test/${encodeURIComponent(key)}`, method: 'PUT', headers: { 'Content-Type': mimeType }, expiresInSeconds: 600 };
  },
  async inspect({ key }) { return storedDocuments.get(key); },
  async readObject({ key }) { return storedDocuments.get(key); },
  async signedRead() { throw new Error('Signed document reads must not be used by customer or admin routes.'); }
});
stripeGateway.setTestAdapter({
  subscriptions: { async update(subscriptionId, payload) {
    scheduledCancellations.push({ subscriptionId, payload });
    return { id: subscriptionId, current_period_end: Math.floor(Date.now() / 1000) + 2592000, cancel_at_period_end: true };
  } }
});
const app = require('../app');
let server;
let base;
let fixture;
let ownerSession;
const run = Date.now();

function uniquePhone(index) {
  return `+1615${String(run % 900).padStart(3, '0')}${String(7000 + index).padStart(4, '0')}`;
}

function parseCode(message) { return String(message.text).match(/\b(\d{6})\b/)?.[1]; }
function cookieFrom(response) { return response.headers.get('set-cookie')?.split(';')[0] || ''; }
async function json(response) { return { response, body: response.status === 204 ? {} : await response.json() }; }
function account(path, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  return fetch(`${base}/api/customer/parking/v1${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function admin(path, { method = 'GET', body, session = ownerSession } = {}) {
  const headers = { cookie: session?.cookie || '', ...(body ? { 'content-type': 'application/json' } : {}),
    ...(!['GET','HEAD'].includes(method) ? { 'x-csrf-token': session?.csrfToken || '' } : {}) };
  return fetch(`${base}/api/admin/parking/v1${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}

async function createCustomer(index, overrides = {}) {
  const result = await pool.query(`INSERT INTO parking_customers(
      public_id,first_name,last_name,normalized_phone,display_phone,normalized_email,display_email,status)
    VALUES($1,$2,$3,$4,$4,$5,$5,'ACTIVE') RETURNING *`, [
    `cust_${token(24)}`, 'Portal', `Customer ${index}`, uniquePhone(index),
    `portal.customer.${index}.${run}@example.test`, ...Object.values(overrides)
  ]);
  return result.rows[0];
}

async function signIn(identifier) {
  delivered.length = 0;
  const requested = await json(await account('/auth/request-code', { method: 'POST', body: { identifier } }));
  assert.equal(requested.response.status, 202, JSON.stringify(requested.body));
  assert.equal(delivered.length, 1);
  const verified = await json(await account('/auth/verify-code', { method: 'POST', body: {
    challengeId: requested.body.challengeId, code: parseCode(delivered[0])
  } }));
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  return { ...verified.body, cookie: cookieFrom(verified.response) };
}

async function uploadCustomerDocument(session, booking, type, filename, mimeType = 'application/pdf', sizeBytes = 256) {
  const started = await json(await account(`/reservations/${booking.reservation_number}/documents/${type}/upload`, {
    method: 'POST', cookie: session.cookie, csrf: session.csrfToken, body: { filename, mimeType, sizeBytes }
  }));
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  assert.equal(Object.hasOwn(started.body.document, 'id'), false);
  const completed = await json(await account('/documents/complete', {
    method: 'POST', cookie: session.cookie, csrf: session.csrfToken, body: { uploadToken: started.body.upload.token }
  }));
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  return completed.body.document;
}

async function createBooking(customer, index, {
  customerId = customer.id, product = 'DAILY', status = 'CONFIRMED', paymentStatus = 'PAID'
} = {}) {
  const credential = `lookup-${run}-${index}`;
  const result = await pool.query(`INSERT INTO parking_bookings(
      reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
      arrival_at,departure_at,first_name,last_name,mobile_phone,email,tractor_unit_number,
      license_plate,license_plate_state,terms_accepted_at,cancellation_terms_accepted_at,
      assignment_mode_snapshot,parking_product,payment_status,customer_id)
    VALUES($1,$2,$3,$4,$5,$6,$17,'2036-08-14T12:00:00Z','2036-08-17T12:00:00Z',
      $7,$8,$9,$10,$11,$12,$13,now(),now(),$15,$16,$18,$14) RETURNING *`, [
    reservationNumber(), token(), await bcrypt.hash(credential, 4), fixture.inventory_id, fixture.location_id,
    fixture.category_id, customer.first_name, customer.last_name, customer.normalized_phone,
    customer.normalized_email, `UNIT-${index}`, `PORTAL${index}`, 'TN', customerId,
    product === 'MONTHLY' ? 'CUSTOMER_SELECTED_SPOT' : 'ZONE_CAPACITY', product, status, paymentStatus
  ]);
  await pool.query(`INSERT INTO parking_booking_price_snapshots(booking_id,snapshot)
    VALUES($1,$2)`, [result.rows[0].id, { duration: 'DAILY', totalCents: 5700, unitRateCents: 1900 }]);
  return { booking: result.rows[0], credential };
}

test.before(async () => {
  const username = `customer-recovery-owner-${run}`;
  const password = 'ParkingOps-customer-recovery-2036';
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'OWNER',true)`, [username, await bcrypt.hash(password, 4)]);
  fixture = (await pool.query(`SELECT l.id location_id,i.id inventory_id,c.id category_id
    FROM parking_locations l JOIN parking_zones z ON z.location_id=l.id
    JOIN parking_inventory i ON i.zone_id=z.id JOIN parking_categories c ON c.id=i.category_id
    WHERE c.code='TRACTOR_TRAILER' ORDER BY l.id LIMIT 1`)).rows[0];
  assert.ok(fixture);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await json(await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) }));
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  ownerSession = { cookie: cookieFrom(login.response), csrfToken: login.body.csrfToken };
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  notifications.clearTestAdapter();
  stripeGateway.clearTestAdapter();
  storage.clearTestAdapter();
  await pool.end();
});

test('booking identity creation reuses normalized phone or email and refuses cross-account merges', async () => {
  const create = async customer => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await resolveOrCreateCustomer(client, customer); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const identityPhone = uniquePhone(801);
  const secondPhone = uniquePhone(802);
  const original = await create({ firstName: 'Identity', lastName: 'One', mobilePhone: identityPhone, email: `Identity.One.${run}@Example.Test` });
  assert.equal(original.created, true);
  const byPhone = await create({ firstName: 'Identity', lastName: 'One', mobilePhone: identityPhone, email: `identity.one.${run}@example.test` });
  assert.equal(byPhone.created, false); assert.equal(Number(byPhone.customer.id), Number(original.customer.id));
  const byPhoneOnly = await create({ firstName: 'Identity', lastName: 'One', mobilePhone: identityPhone.replace('+1', ''), email: `new-address.${run}@example.test` });
  assert.equal(byPhoneOnly.created, false); assert.equal(Number(byPhoneOnly.customer.id), Number(original.customer.id));
  const byEmailOnly = await create({ firstName: 'Identity', lastName: 'One', mobilePhone: uniquePhone(899), email: `IDENTITY.ONE.${run}@EXAMPLE.TEST` });
  assert.equal(byEmailOnly.created, false); assert.equal(Number(byEmailOnly.customer.id), Number(original.customer.id));
  const second = await create({ firstName: 'Identity', lastName: 'Two', mobilePhone: secondPhone, email: `identity.two.${run}@example.test` });
  const conflict = await create({ firstName: 'Conflict', lastName: 'Attempt', mobilePhone: identityPhone, email: second.customer.normalized_email });
  assert.equal(conflict.conflict, true);
  const rows = await pool.query(`SELECT count(*)::int count FROM parking_customers
    WHERE normalized_phone IN ($1,$2)`, [identityPhone, secondPhone]);
  assert.equal(rows.rows[0].count, 2);
});

test('phone and email passwordless login normalize identifiers and create secure sessions', async () => {
  const customer = await createCustomer(1);
  const digits = customer.normalized_phone.slice(2);
  const phoneSession = await signIn(`(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`);
  assert.equal(phoneSession.customer.id, customer.public_id);
  assert.match(phoneSession.cookie, /^parking_customer_session=/);
  const phoneOverview = await account('/overview', { cookie: phoneSession.cookie });
  assert.equal(phoneOverview.status, 200);
  const emailSession = await signIn(customer.normalized_email.toUpperCase());
  assert.equal(emailSession.customer.id, customer.public_id);
  const row = (await pool.query('SELECT phone_verified_at,email_verified_at FROM parking_customers WHERE id=$1', [customer.id])).rows[0];
  assert.ok(row.phone_verified_at); assert.ok(row.email_verified_at);
});

test('Name, Email, and Phone activate a legitimate in-person record without inventing Stripe payment', async () => {
  const source = await createCustomer(20);
  const inPerson = await createBooking(source, 20, { customerId: null });
  await pool.query(`UPDATE parking_bookings SET payment_status='NOT_REQUIRED' WHERE id=$1`, [inPerson.booking.id]);
  await pool.query('DELETE FROM parking_customers WHERE id=$1', [source.id]);
  delivered.length = 0;
  const started = await json(await account('/auth/start', { method: 'POST', body: {
    name: `${source.first_name} ${source.last_name}`, email: source.normalized_email, phone: source.normalized_phone
  } }));
  assert.equal(started.response.status, 202, JSON.stringify(started.body));
  assert.equal(delivered.length, 1);
  const verified = await json(await account('/auth/verify-code', { method: 'POST', body: {
    challengeId: started.body.challengeId, code: parseCode(delivered[0])
  } }));
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  const linked = (await pool.query(`SELECT booking.payment_status,booking.customer_id,customer.status
    FROM parking_bookings booking JOIN parking_customers customer ON customer.id=booking.customer_id
    WHERE booking.id=$1`, [inPerson.booking.id])).rows[0];
  assert.equal(linked.payment_status, 'NOT_REQUIRED');
  assert.equal(linked.status, 'ACTIVE');
  const overview = await (await account('/overview', { cookie: cookieFrom(verified.response) })).json();
  assert.equal(JSON.stringify(overview).includes(inPerson.booking.reservation_number), true);
  const before = Number((await pool.query('SELECT count(*) FROM parking_customers WHERE normalized_email=$1', [source.normalized_email])).rows[0].count);
  await account('/auth/start', { method: 'POST', body: {
    name: `${source.first_name} ${source.last_name}`, email: source.normalized_email.toUpperCase(), phone: source.normalized_phone.slice(2)
  } });
  const after = Number((await pool.query('SELECT count(*) FROM parking_customers WHERE normalized_email=$1', [source.normalized_email])).rows[0].count);
  assert.equal(before, 1); assert.equal(after, 1);
});

test('typed details alone do not activate or expose an unpaid booking attempt', async () => {
  const source = await createCustomer(21);
  const draft = await createBooking(source, 21, { customerId: null, status: 'PENDING', paymentStatus: 'DRAFT' });
  await pool.query('DELETE FROM parking_customers WHERE id=$1', [source.id]);
  delivered.length = 0;
  const started = await json(await account('/auth/start', { method: 'POST', body: {
    name: `${source.first_name} ${source.last_name}`, email: source.normalized_email, phone: source.normalized_phone
  } }));
  assert.equal(started.response.status, 202);
  assert.equal(delivered.length, 0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_customers WHERE normalized_email=$1', [source.normalized_email])).rows[0].count), 0);
  assert.equal((await pool.query('SELECT customer_id,payment_status FROM parking_bookings WHERE id=$1', [draft.booking.id])).rows[0].customer_id, null);
});

test('unknown identifier uses the same response without delivery or account enumeration', async () => {
  delivered.length = 0;
  const response = await json(await account('/auth/request-code', { method: 'POST', body: { identifier: `unknown.${run}@example.test` } }));
  assert.equal(response.response.status, 202);
  assert.match(response.body.message, /If the information is eligible/);
  assert.equal(delivered.length, 0);
});

test('OTP is single use, expires, and locks after bounded invalid attempts', async () => {
  const customer = await createCustomer(2);
  delivered.length = 0;
  const requested = await json(await account('/auth/request-code', { method: 'POST', body: { identifier: customer.normalized_email } }));
  const code = parseCode(delivered[0]);
  const first = await account('/auth/verify-code', { method: 'POST', body: { challengeId: requested.body.challengeId, code } });
  assert.equal(first.status, 200);
  const replay = await account('/auth/verify-code', { method: 'POST', body: { challengeId: requested.body.challengeId, code } });
  assert.equal(replay.status, 401);

  delivered.length = 0;
  const locked = await json(await account('/auth/request-code', { method: 'POST', body: { identifier: customer.normalized_email } }));
  for (let index = 0; index < 5; index += 1) {
    const invalid = await account('/auth/verify-code', { method: 'POST', body: { challengeId: locked.body.challengeId, code: '000000' } });
    assert.equal(invalid.status, 401);
  }
  const realAfterLock = await account('/auth/verify-code', { method: 'POST', body: { challengeId: locked.body.challengeId, code: parseCode(delivered[0]) } });
  assert.equal(realAfterLock.status, 401);

  delivered.length = 0;
  const expired = await json(await account('/auth/request-code', { method: 'POST', body: { identifier: customer.normalized_phone } }));
  await pool.query('UPDATE parking_customer_auth_challenges SET expires_at=now()-interval \'1 second\' WHERE public_id=$1', [expired.body.challengeId]);
  const expiredVerify = await account('/auth/verify-code', { method: 'POST', body: { challengeId: expired.body.challengeId, code: parseCode(delivered[0]) } });
  assert.equal(expiredVerify.status, 401);
});

test('logout revokes the HTTP-only session and CSRF protects mutations', async () => {
  const customer = await createCustomer(3);
  const session = await signIn(customer.normalized_email);
  const missingCsrf = await account('/profile', { method: 'PATCH', cookie: session.cookie, body: { firstName: 'New', lastName: 'Name' } });
  assert.equal(missingCsrf.status, 403);
  const updated = await account('/profile', { method: 'PATCH', cookie: session.cookie, csrf: session.csrfToken, body: { firstName: 'New', lastName: 'Name' } });
  assert.equal(updated.status, 200);
  const logout = await account('/logout', { method: 'POST', cookie: session.cookie, csrf: session.csrfToken });
  assert.equal(logout.status, 204);
  const after = await account('/overview', { cookie: session.cookie });
  assert.equal(after.status, 401);
});

test('customer sessions expire server-side and cannot be replayed', async () => {
  const customer = await createCustomer(7);
  const session = await signIn(customer.normalized_email);
  await pool.query(`UPDATE parking_customer_sessions SET idle_expires_at=now()-interval '1 second'
    WHERE customer_id=$1 AND revoked_at IS NULL`, [customer.id]);
  assert.equal((await account('/overview', { cookie: session.cookie })).status, 401);
});

test('OTP requests are rate limited per normalized identifier', async () => {
  const customer = await createCustomer(8);
  for (let index = 0; index < 3; index += 1) {
    const response = await account('/auth/request-code', { method: 'POST', body: { identifier: customer.normalized_phone } });
    assert.equal(response.status, 202);
  }
  const limited = await json(await account('/auth/request-code', { method: 'POST', body: { identifier: customer.normalized_phone.replace('+1', '') } }));
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error.code, 'AUTH_REQUEST_RATE_LIMITED');
});

test('Customer A cannot access Customer B reservations, payments, vehicles, or documents', async () => {
  const customerA = await createCustomer(4);
  const customerB = await createCustomer(5);
  const sessionA = await signIn(customerA.normalized_email);
  const bookingB = await createBooking(customerB, 5);
  const vehicleB = (await pool.query(`INSERT INTO parking_customer_vehicles(
      public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification)
    VALUES($1,$2,'B-UNIT','BPLATE','TN','GENERAL') RETURNING *`, [`veh_${token(24)}`, customerB.id])).rows[0];
  const paymentB = (await pool.query(`INSERT INTO parking_customer_payments(
      public_id,customer_id,booking_id,processor_payment_id,parking_product,amount_cents,currency,status)
    VALUES($1,$2,$3,$4,'DAILY',1900,'usd','PAID') RETURNING *`, [
    `pay_${token(24)}`, customerB.id, bookingB.booking.id, `pi_cross_${run}`,
  ])).rows[0];
  const documentB = (await pool.query(`INSERT INTO parking_customer_documents(
      public_id,booking_id,document_type,original_filename,declared_mime_type,size_bytes,
      storage_provider,storage_bucket,storage_key,upload_token_hash,upload_expires_at,upload_status,uploaded_at)
    VALUES($1,$2,'VEHICLE_CARRIER_INSURANCE','b.pdf','application/pdf',100,'TEST','private',$3,$4,now()+interval '1 hour','UPLOADED',now()) RETURNING *`, [
    `doc_${token(24)}`, bookingB.booking.id, `insurance/cross/${run}`, digest(`upload-${run}`)
  ])).rows[0];
  assert.equal((await account(`/payments/${paymentB.public_id}/receipt`, { method: 'POST', cookie: sessionA.cookie, csrf: sessionA.csrfToken })).status, 404);
  assert.equal((await account(`/documents/${documentB.public_id}/read`, { method: 'POST', cookie: sessionA.cookie, csrf: sessionA.csrfToken })).status, 404);
  assert.equal((await account(`/vehicles/${vehicleB.public_id}`, { method: 'PATCH', cookie: sessionA.cookie, csrf: sessionA.csrfToken,
    body: { unitNumber: 'TAKEOVER', licensePlate: 'TAKE', licensePlateState: 'TN', classification: 'GENERAL' } })).status, 404);
  const claim = await account('/claims', { method: 'POST', cookie: sessionA.cookie, csrf: sessionA.csrfToken,
    body: { reservationNumber: bookingB.booking.reservation_number, lookupCredential: bookingB.credential } });
  assert.equal(claim.status, 409);
  const overviewA = await (await account('/overview', { cookie: sessionA.cookie })).json();
  assert.equal(JSON.stringify(overviewA).includes(bookingB.booking.reservation_number), false);
});

test('paid confirmed Monthly parking keeps missing documents explicit and permits authorized upload later', async () => {
  const customer = await createCustomer(29);
  const booking = await createBooking(customer, 29, { product: 'MONTHLY', status: 'CONFIRMED', paymentStatus: 'PAID' });
  const session = await signIn(customer.normalized_email);
  const before = await (await account('/overview', { cookie: session.cookie })).json();
  const reservation = [...before.reservations.current, ...before.reservations.upcoming, ...before.reservations.past]
    .find(item => item.reservationNumber === booking.booking.reservation_number);
  assert.ok(reservation);
  assert.equal(reservation.documents.DRIVER_LICENSE, null);
  assert.equal(reservation.documents.INSURANCE, null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_customer_documents WHERE booking_id=$1', [booking.booking.id])).rows[0].count), 0);

  const uploaded = await uploadCustomerDocument(session, booking.booking, 'INSURANCE', 'later-insurance.pdf');
  assert.equal(uploaded.status, 'RECEIVED');
  const after = await (await account('/overview', { cookie: session.cookie })).json();
  assert.equal(after.documents.find(item => item.type === 'INSURANCE'
    && item.reservationNumber === booking.booking.reservation_number).status, 'RECEIVED');
});

test('Driver License and Insurance uploads are revisioned, customer-safe, admin-only, reviewable, and audited', async () => {
  const customerA = await createCustomer(30);
  const customerB = await createCustomer(31);
  const bookingA = await createBooking(customerA, 30);
  const bookingB = await createBooking(customerB, 31);
  const sessionA = await signIn(customerA.normalized_email);
  const sessionB = await signIn(customerB.normalized_email);

  await uploadCustomerDocument(sessionA, bookingA.booking, 'DRIVER_LICENSE', 'license.pdf');
  await uploadCustomerDocument(sessionA, bookingA.booking, 'INSURANCE', 'insurance.png', 'image/png', 512);
  await uploadCustomerDocument(sessionA, bookingA.booking, 'DRIVER_LICENSE', 'replacement-license.jpg', 'image/jpeg', 384);
  await uploadCustomerDocument(sessionB, bookingB.booking, 'DRIVER_LICENSE', 'license-b.pdf', 'application/pdf', 640);
  const crossCustomer = await account(`/reservations/${bookingA.booking.reservation_number}/documents/INSURANCE/upload`, {
    method: 'POST', cookie: sessionB.cookie, csrf: sessionB.csrfToken,
    body: { filename: 'cross.pdf', mimeType: 'application/pdf', sizeBytes: 128 }
  });
  assert.equal(crossCustomer.status, 404);

  const revisions = await pool.query(`SELECT document_type,revision,superseded_at,upload_status
    FROM parking_customer_documents WHERE booking_id=$1 ORDER BY document_type,revision`, [bookingA.booking.id]);
  const licenses = revisions.rows.filter(row => row.document_type === 'DRIVER_LICENSE');
  assert.deepEqual(licenses.map(row => Number(row.revision)), [1, 2]);
  assert.ok(licenses[0].superseded_at); assert.equal(licenses[1].superseded_at, null);

  const overview = await (await account('/overview', { cookie: sessionA.cookie })).json();
  const safeDocuments = overview.documents.filter(item => item.reservationNumber === bookingA.booking.reservation_number);
  assert.deepEqual(new Set(safeDocuments.map(item => item.type)), new Set(['DRIVER_LICENSE','INSURANCE']));
  assert.ok(safeDocuments.every(item => item.status === 'RECEIVED'));
  assert.ok(safeDocuments.every(item => !Object.hasOwn(item, 'id') && !Object.hasOwn(item, 'filename')));
  assert.equal(JSON.stringify(overview).includes('replacement-license.jpg'), false);
  assert.equal((await account('/documents/anything/read', { method: 'POST', cookie: sessionA.cookie, csrf: sessionA.csrfToken })).status, 404);

  const detail = await json(await admin(`/bookings/${bookingA.booking.id}`));
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.documents.length, 2);
  const license = detail.body.documents.find(item => item.document_type === 'DRIVER_LICENSE');
  const insurance = detail.body.documents.find(item => item.document_type === 'INSURANCE');
  assert.equal(Number(license.revision), 2);

  const viewGrant = await json(await admin(`/documents/${license.public_id}/access`, {
    method: 'POST', body: { disposition: 'INLINE' }
  }));
  assert.equal(viewGrant.response.status, 200, JSON.stringify(viewGrant.body));
  assert.equal(JSON.stringify(viewGrant.body).includes('private-upload.test'), false);
  const viewAccessCookie = cookieFrom(viewGrant.response);
  assert.match(viewAccessCookie, /^parking_document_access=/);
  assert.equal((await fetch(`${base}${viewGrant.body.access.path}`, { headers: { cookie: viewAccessCookie } })).status, 401);
  const viewed = await fetch(`${base}${viewGrant.body.access.path}`, { headers: { cookie: `${ownerSession.cookie}; ${viewAccessCookie}` } });
  assert.equal(viewed.status, 200); assert.equal(viewed.headers.get('content-type'), 'image/jpeg');
  assert.equal((await viewed.arrayBuffer()).byteLength, 384);
  assert.equal((await fetch(`${base}${viewGrant.body.access.path}`, { headers: { cookie: `${ownerSession.cookie}; ${viewAccessCookie}` } })).status, 404);

  const downloadGrant = await json(await admin(`/documents/${insurance.public_id}/access`, {
    method: 'POST', body: { disposition: 'ATTACHMENT' }
  }));
  const downloadAccessCookie = cookieFrom(downloadGrant.response);
  const downloaded = await fetch(`${base}${downloadGrant.body.access.path}`, { headers: { cookie: `${ownerSession.cookie}; ${downloadAccessCookie}` } });
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
  await downloaded.arrayBuffer();

  const approved = await json(await admin(`/documents/${license.public_id}/review`, {
    method: 'PATCH', body: { status: 'APPROVED', note: 'Identity is legible.' }
  }));
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  const replacement = await json(await admin(`/documents/${insurance.public_id}/review`, {
    method: 'PATCH', body: { status: 'REPLACEMENT_REQUESTED', note: 'Policy page is incomplete.' }
  }));
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
  const refreshed = await (await account('/overview', { cookie: sessionA.cookie })).json();
  assert.equal(refreshed.documents.find(item => item.type === 'DRIVER_LICENSE' && item.reservationNumber === bookingA.booking.reservation_number).status, 'APPROVED');
  assert.equal(refreshed.documents.find(item => item.type === 'INSURANCE' && item.reservationNumber === bookingA.booking.reservation_number).status, 'REPLACEMENT_REQUESTED');
  const audit = await pool.query(`SELECT audit.action,count(*)::int count FROM parking_document_access_audit audit
    JOIN parking_customer_documents document ON document.id=audit.document_id
    WHERE document.public_id=ANY($1::text[]) GROUP BY audit.action`, [[license.public_id, insurance.public_id]]);
  const counts = Object.fromEntries(audit.rows.map(row => [row.action, Number(row.count)]));
  assert.equal(counts.VIEWED, 1); assert.equal(counts.DOWNLOADED, 1);
  assert.equal(counts.APPROVED, 1); assert.equal(counts.REPLACEMENT_REQUESTED, 1);

  const customerDetail = await json(await admin(`/customers/${customerA.public_id}`));
  assert.equal(customerDetail.response.status, 200, JSON.stringify(customerDetail.body));
  const customerLicense = customerDetail.body.documents.find(item => item.public_id === license.public_id);
  assert.equal(customerLicense.original_filename, 'replacement-license.jpg');
  assert.equal(customerLicense.detected_mime_type, 'image/jpeg');
  assert.equal(Number(customerLicense.size_bytes), 384);
  assert.equal(customerLicense.reservation_number, bookingA.booking.reservation_number);
  assert.equal(customerLicense.license_plate, bookingA.booking.license_plate);

  const scopedPath = (customer, document) => `/customers/${customer.public_id}/documents/${document.public_id}`;
  const unauthenticated = await fetch(`${base}/api/admin/parking/v1${scopedPath(customerA, license)}/access`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'INLINE' })
  });
  assert.equal(unauthenticated.status, 401);
  const customerSessionDenied = await fetch(`${base}/api/admin/parking/v1${scopedPath(customerA, license)}/access`, {
    method: 'POST', headers: { cookie: sessionA.cookie, 'x-csrf-token': sessionA.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ disposition: 'INLINE' })
  });
  assert.equal(customerSessionDenied.status, 401);
  assert.equal((await admin(`${scopedPath(customerB, license)}/access`, {
    method: 'POST', body: { disposition: 'INLINE' }
  })).status, 404);
  assert.equal((await admin(`${scopedPath(customerB, license)}/review`, {
    method: 'PATCH', body: { status: 'REJECTED', note: 'Wrong customer scope must never mutate.' }
  })).status, 404);

  const pdfDocument = (await pool.query(`SELECT public_id,storage_key FROM parking_customer_documents
    WHERE booking_id=$1 AND document_type='DRIVER_LICENSE' AND superseded_at IS NULL`, [bookingB.booking.id])).rows[0];
  async function readScoped(customer, document, disposition, expectedMime, expectedSize) {
    const grant = await json(await admin(`${scopedPath(customer, document)}/access`, {
      method: 'POST', body: { disposition }
    }));
    assert.equal(grant.response.status, 200, JSON.stringify(grant.body));
    assert.equal(JSON.stringify(grant.body).includes('private-upload.test'), false);
    const accessCookie = cookieFrom(grant.response);
    const response = await fetch(`${base}${grant.body.access.path}`, {
      headers: { cookie: `${ownerSession.cookie}; ${accessCookie}` }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), expectedMime);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await response.arrayBuffer()).byteLength, expectedSize);
  }
  await readScoped(customerA, license, 'INLINE', 'image/jpeg', 384);
  await readScoped(customerA, insurance, 'ATTACHMENT', 'image/png', 512);
  await readScoped(customerB, pdfDocument, 'INLINE', 'application/pdf', 640);

  const expiredGrant = await json(await admin(`${scopedPath(customerB, pdfDocument)}/access`, {
    method: 'POST', body: { disposition: 'INLINE' }
  }));
  const expiredCookie = cookieFrom(expiredGrant.response);
  const expiredToken = decodeURIComponent(expiredCookie.slice(expiredCookie.indexOf('=') + 1));
  await pool.query(`UPDATE parking_document_access_grants
    SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 second'
    WHERE token_hash=$1`, [digest(expiredToken)]);
  assert.equal((await fetch(`${base}${expiredGrant.body.access.path}`, {
    headers: { cookie: `${ownerSession.cookie}; ${expiredCookie}` }
  })).status, 404);

  const missingObjectGrant = await json(await admin(`${scopedPath(customerB, pdfDocument)}/access`, {
    method: 'POST', body: { disposition: 'INLINE' }
  }));
  const missingObjectCookie = cookieFrom(missingObjectGrant.response);
  const savedObject = storedDocuments.get(pdfDocument.storage_key);
  storedDocuments.delete(pdfDocument.storage_key);
  const missingObject = await json(await fetch(`${base}${missingObjectGrant.body.access.path}`, {
    headers: { cookie: `${ownerSession.cookie}; ${missingObjectCookie}` }
  }));
  storedDocuments.set(pdfDocument.storage_key, savedObject);
  assert.equal(missingObject.response.status, 503);
  assert.equal(missingObject.body.error.code, 'DOCUMENT_STORAGE_READ_UNAVAILABLE');
  assert.equal(JSON.stringify(missingObject.body).includes(pdfDocument.storage_key), false);

  const rejected = await json(await admin(`${scopedPath(customerA, license)}/review`, {
    method: 'PATCH', body: { status: 'REJECTED', note: 'Image is not sufficiently legible.' }
  }));
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.document.verificationStatus, 'REJECTED');
  assert.equal((await pool.query(`SELECT count(*)::int count FROM parking_document_access_audit audit
    JOIN parking_customer_documents document ON document.id=audit.document_id
    WHERE document.public_id=$1 AND audit.action='REJECTED'`, [license.public_id])).rows[0].count, 1);
});

test('legacy reservation claim requires lookup secret and matching verified identity', async () => {
  const customer = await createCustomer(6);
  const legacy = await createBooking(customer, 6, { customerId: null });
  const session = await signIn(customer.normalized_email);
  const wrong = await account('/claims', { method: 'POST', cookie: session.cookie, csrf: session.csrfToken,
    body: { reservationNumber: legacy.booking.reservation_number, lookupCredential: 'wrong' } });
  assert.equal(wrong.status, 404);
  const claimed = await account('/claims', { method: 'POST', cookie: session.cookie, csrf: session.csrfToken,
    body: { reservationNumber: legacy.booking.reservation_number, lookupCredential: legacy.credential } });
  assert.equal(claimed.status, 200);
  assert.equal(Number((await pool.query('SELECT customer_id FROM parking_bookings WHERE id=$1', [legacy.booking.id])).rows[0].customer_id), Number(customer.id));
});

test('admin account visibility and verified recovery are scoped, audited, and conflict-safe', async () => {
  const customer = await createCustomer(9);
  const conflicting = await createCustomer(10);
  const booking = await createBooking(customer, 9);
  const customerSession = await signIn(customer.normalized_email);
  const detail = await json(await fetch(`${base}/api/admin/parking/v1/bookings/${booking.booking.id}`, {
    headers: { cookie: ownerSession.cookie }
  }));
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.customerAccount.publicId, customer.public_id);
  assert.equal(detail.body.customerAccount.reservationCount >= 1, true);
  assert.equal(Object.hasOwn(detail.body.customerAccount, 'stripeCustomerId'), false);

  const recover = identifier => fetch(`${base}/api/admin/parking/v1/customer-accounts/${customer.public_id}/recovery`, {
    method: 'PATCH', headers: { cookie: ownerSession.cookie, 'x-csrf-token': ownerSession.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ contactType: 'PHONE', identifier, verifiedOwnership: true,
      verificationReference: `support-${run}`, reason: 'Customer completed offline identity verification.' })
  });
  const conflict = await json(await recover(conflicting.normalized_phone));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'CUSTOMER_IDENTITY_CONFLICT');
  assert.equal((await pool.query('SELECT normalized_phone FROM parking_customers WHERE id=$1', [customer.id])).rows[0].normalized_phone, customer.normalized_phone);

  const replacement = uniquePhone(199);
  const changed = await json(await recover(replacement));
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  assert.equal((await pool.query('SELECT normalized_phone FROM parking_customers WHERE id=$1', [customer.id])).rows[0].normalized_phone, replacement);
  assert.equal((await account('/overview', { cookie: customerSession.cookie })).status, 401);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_audit_events
    WHERE entity_id=$1 AND action IN ('CUSTOMER_RECOVERY_CONFLICT','CUSTOMER_LOGIN_IDENTITY_RECOVERED')`, [customer.public_id])).rows[0].count), 2);
});

test('Monthly cancellation is account-scoped and schedules end-of-term release through ParkingOps', async () => {
  const customerA = await createCustomer(11);
  const customerB = await createCustomer(12);
  const monthly = await createBooking(customerA, 11, { product: 'MONTHLY' });
  await pool.query(`UPDATE parking_bookings SET stripe_subscription_id=$2,
    stripe_customer_id=$3,billing_period_end_at=now()+interval '30 days' WHERE id=$1`,
  [monthly.booking.id, `sub_account_${run}`, `cus_account_${run}`]);
  const sessionB = await signIn(customerB.normalized_email);
  assert.equal((await account(`/reservations/${monthly.booking.reservation_number}/cancel-monthly`, {
    method: 'POST', cookie: sessionB.cookie, csrf: sessionB.csrfToken, body: {}
  })).status, 404);
  const sessionA = await signIn(customerA.normalized_email);
  const canceled = await json(await account(`/reservations/${monthly.booking.reservation_number}/cancel-monthly`, {
    method: 'POST', cookie: sessionA.cookie, csrf: sessionA.csrfToken, body: {}
  }));
  assert.equal(canceled.response.status, 200, JSON.stringify(canceled.body));
  assert.equal(canceled.body.cancelAtPeriodEnd, true);
  assert.equal(scheduledCancellations.at(-1).subscriptionId, `sub_account_${run}`);
  const row = (await pool.query(`SELECT subscription_cancel_at_period_end,status,payment_status
    FROM parking_bookings WHERE id=$1`, [monthly.booking.id])).rows[0];
  assert.equal(row.subscription_cancel_at_period_end, true);
  assert.equal(row.status, 'CONFIRMED');
  assert.equal(row.payment_status, 'PAID');
  const repeat = await json(await account(`/reservations/${monthly.booking.reservation_number}/cancel-monthly`, {
    method: 'POST', cookie: sessionA.cookie, csrf: sessionA.csrfToken, body: {}
  }));
  assert.equal(repeat.response.status, 200);
  assert.equal(repeat.body.idempotent, true);
});
