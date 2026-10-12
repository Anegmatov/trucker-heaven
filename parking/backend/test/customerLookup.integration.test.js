process.env.NODE_ENV = 'test';
process.env.PARKING_TRUST_PROXY_HOPS = '1';
process.env.PARKING_GENERAL_RATE_LIMIT_MAX = '1000';
process.env.PARKING_CUSTOMER_LOOKUP_RATE_LIMIT_MAX = '4';
process.env.PARKING_NOTIFICATION_EMAIL_PROVIDER = '';
process.env.PARKING_NOTIFICATION_SMS_PROVIDER = '';
process.env.PARKING_RESEND_API_KEY = '';
process.env.PARKING_TWILIO_ACCOUNT_SID = '';
process.env.PARKING_TWILIO_AUTH_TOKEN = '';
process.env.PARKING_TWILIO_FROM_NUMBER = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const storage = require('../services/privateDocumentStorage');
const customerDocuments = require('../services/customerDocuments');
const notifications = require('../services/customerNotifications');
const { token, digest, reservationNumber } = require('../utils');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing customer-lookup tests: use parkingops_test only.');
}

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
storage.setTestAdapter({
  bucket: 'parkingops-test-private',
  async signedUpload({ key, mimeType, sizeBytes }) {
    storedDocuments.set(key, { mimeType, sizeBytes, bytes: testFileBytes(mimeType, sizeBytes) });
    return { url: `https://private-upload.test/${encodeURIComponent(key)}`, method: 'PUT', headers: { 'Content-Type': mimeType }, expiresInSeconds: 600 };
  },
  async inspect({ key }) { return storedDocuments.get(key); },
  async readObject() { throw new Error('Customer lookup must never read document bytes.'); },
  async signedRead() { throw new Error('Customer lookup must never create document read URLs.'); }
});

const app = require('../app');
let server;
let base;
let inventory;
let customerA;
let customerB;
let customerC;
let bookingA;
let bookingB;
let bookingC;
const run = Date.now();
let ipCounter = 20;

function uniquePhone(index) { return `+1615${String(run % 900).padStart(3, '0')}${String(7000 + index).padStart(4, '0')}`; }
function cookieFrom(response) { return response.headers.get('set-cookie')?.split(';')[0] || ''; }
async function parsed(response) { return { response, body: response.status === 204 ? {} : await response.json() }; }
function customerCall(path, { method = 'GET', body, cookie = '', csrf = '', ip, userAgent = 'ParkingLookupIntegration/1.0' } = {}) {
  const headers = {
    'user-agent': userAgent,
    'x-forwarded-for': ip || `198.51.100.${ipCounter++}`,
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    ...(body ? { 'content-type': 'application/json' } : {})
  };
  return fetch(`${base}/api/customer/parking/v1${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}

async function createCustomer(index, firstName, lastName) {
  return (await pool.query(`INSERT INTO parking_customers(
      public_id,first_name,last_name,normalized_phone,display_phone,normalized_email,display_email,status)
    VALUES($1,$2,$3,$4,$4,$5,$5,'ACTIVE') RETURNING *`, [
    `cust_${token(24)}`, firstName, lastName, uniquePhone(index), `lookup.${index}.${run}@example.test`
  ])).rows[0];
}

async function createBooking(customer, index, { customerId = customer.id, paymentStatus = 'PAID', status = 'CONFIRMED', plate = `LOOK${index}` } = {}) {
  const credential = `lookup-credential-${run}-${index}`;
  const row = (await pool.query(`INSERT INTO parking_bookings(
      reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
      arrival_at,departure_at,first_name,last_name,mobile_phone,email,tractor_unit_number,
      license_plate,license_plate_state,terms_accepted_at,cancellation_terms_accepted_at,
      assignment_mode_snapshot,parking_product,payment_status,payment_confirmed_at,customer_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()-interval '1 hour',now()+interval '2 days',
      $8,$9,$10,$11,$12,$13,'TN',now(),now(),'ZONE_CAPACITY','DAILY',$14,
      CASE WHEN $14='PAID' THEN now() ELSE NULL END,$15) RETURNING *`, [
    reservationNumber(), token(), await bcrypt.hash(credential, 4), inventory.inventory_id, inventory.location_id,
    inventory.category_id, status, customer.first_name, customer.last_name, customer.normalized_phone,
    customer.normalized_email, `UNIT-${index}`, plate, paymentStatus, customerId
  ])).rows[0];
  return row;
}

function identityFor(customer, booking, overrides = {}) {
  return {
    name: `${customer.first_name} ${customer.last_name}`,
    email: customer.normalized_email,
    phone: customer.normalized_phone,
    licensePlate: booking.license_plate,
    ...overrides
  };
}

async function openLookup(customer, booking, { documentType, ip } = {}) {
  const body = identityFor(customer, booking, documentType ? { documentType } : {});
  const result = await parsed(await customerCall('/lookup', { method: 'POST', body, ip }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return {
    ...result.body,
    cookie: cookieFrom(result.response),
    responseCacheControl: result.response.headers.get('cache-control') || ''
  };
}

async function startDocument(grant, type, body = {}) {
  return parsed(await customerCall(`/lookup/documents/${type}/upload`, {
    method: 'POST', cookie: grant.cookie, csrf: grant.csrfToken,
    body: { filename: `${type.toLowerCase()}.pdf`, mimeType: 'application/pdf', sizeBytes: 256, ...body }
  }));
}

test.before(async () => {
  inventory = (await pool.query(`SELECT location.id location_id,inventory.id inventory_id,category.id category_id
    FROM parking_locations location JOIN parking_zones zone ON zone.location_id=location.id
    JOIN parking_inventory inventory ON inventory.zone_id=zone.id
    JOIN parking_categories category ON category.id=inventory.category_id
    WHERE category.code='TRACTOR_TRAILER' ORDER BY location.id LIMIT 1`)).rows[0];
  assert.ok(inventory);
  customerA = await createCustomer(61, 'Alex', 'Smith');
  customerB = await createCustomer(62, 'Alex', 'Smith');
  customerC = await createCustomer(64, 'Different', 'Name');
  bookingA = await createBooking(customerA, 61, { plate: 'MATCH-61' });
  bookingB = await createBooking(customerB, 62, { plate: 'MATCH-62' });
  bookingC = await createBooking(customerC, 64, { plate: 'O0I1-64' });
  await pool.query(`INSERT INTO parking_customer_payments(
      public_id,customer_id,booking_id,processor_payment_id,parking_product,amount_cents,currency,status,receipt_url,paid_at)
    VALUES($1,$2,$3,$4,'DAILY',5700,'usd','PAID','https://receipt.private.test/secret',now())`, [
    `pay_${token(24)}`, customerA.id, bookingA.id, `pi_lookup_${run}`
  ]);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  storage.clearTestAdapter();
  await pool.end();
});

test('correct exact identity opens a short-lived safe summary without OTP or notification providers', async () => {
  assert.equal(notifications.emailConfigured(), false);
  assert.equal(notifications.smsConfigured(), false);
  const before = Number((await pool.query('SELECT count(*) FROM parking_customer_auth_challenges')).rows[0].count);
  const grant = await openLookup(customerA, bookingA);
  const after = Number((await pool.query('SELECT count(*) FROM parking_customer_auth_challenges')).rows[0].count);
  assert.equal(after, before);
  assert.match(grant.cookie, /^parking_customer_lookup=/);
  assert.equal(grant.summary.readOnly, true);
  assert.equal(grant.documentType, null);
  assert.match(grant.responseCacheControl, /private.*no-store/i);
  assert.equal(grant.summary.reservations.current[0].reservationNumber, bookingA.reservation_number);
  assert.equal(grant.summary.payments[0].amountCents, 5700);
  const serialized = JSON.stringify(grant.summary);
  for (const forbidden of ['receipt.private.test', 'receiptUrl', 'stripe', 'customerId', 'bookingId', 'publicId', 'storageKey', 'url']) assert.equal(serialized.includes(forbidden), false);
});

test('same-name customers and deliberate identity collisions never cross-resolve', async () => {
  // Email and mobile phone must both match the reservation.
  const attempts = [
    identityFor(customerA, bookingA, { email: customerB.normalized_email }),
    identityFor(customerA, bookingA, { phone: customerB.normalized_phone }),
    identityFor(customerB, bookingB, { email: customerA.normalized_email }),
    identityFor(customerA, bookingA, { email: `wrong.${run}@example.test` }),
    identityFor(customerA, bookingA, { phone: '+16155550000' }),
    { email: customerA.normalized_email }
  ];
  const failures = [];
  for (const body of attempts) failures.push(await parsed(await customerCall('/lookup', { method: 'POST', body })));
  for (const failure of failures) {
    assert.equal(failure.response.status, 404);
    assert.deepEqual(failure.body, { error: { code: 'PARKING_RECORD_NOT_FOUND', message: 'We could not find a matching parking record.' } });
  }
});

test('lookup normalization tolerates formatting only while retaining exact multi-field matching', async () => {
  const formatted = identityFor(customerA, bookingA, {
    name: `\u2003${customerA.first_name.toUpperCase()}   ${customerA.last_name.toUpperCase()}\u00a0`,
    email: customerA.normalized_email.toUpperCase(),
    phone: `(${customerA.normalized_phone.slice(2,5)}) ${customerA.normalized_phone.slice(5,8)}-${customerA.normalized_phone.slice(8)}`,
    licensePlate: 'match 61'
  });
  const result = await parsed(await customerCall('/lookup', { method: 'POST', body: formatted }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
});

test('concurrent lookups and separate sessions preserve customer isolation', async () => {
  const [a, b] = await Promise.all([
    parsed(await customerCall('/lookup', { method: 'POST', ip: '198.51.100.141', body: identityFor(customerA, bookingA) })),
    parsed(await customerCall('/lookup', { method: 'POST', ip: '198.51.100.142', body: identityFor(customerB, bookingB) }))
  ]);
  assert.equal(a.response.status, 200, JSON.stringify(a.body));
  assert.equal(b.response.status, 200, JSON.stringify(b.body));
  const serializedA = JSON.stringify(a.body.summary);
  const serializedB = JSON.stringify(b.body.summary);
  assert.equal(serializedA.includes(bookingB.reservation_number), false);
  assert.equal(serializedB.includes(bookingA.reservation_number), false);
  assert.notEqual(cookieFrom(a.response), cookieFrom(b.response));
});

test('lookup cookies are tamper-evident, user-agent bound, replayable only within their short-lived session, and CSRF rotates', async () => {
  const grant = await openLookup(customerA, bookingA);
  const copiedSameAgent = await parsed(await customerCall('/lookup/summary', { cookie: grant.cookie }));
  assert.equal(copiedSameAgent.response.status, 200, JSON.stringify(copiedSameAgent.body));
  const copiedOtherAgent = await parsed(await customerCall('/lookup/summary', {
    cookie: grant.cookie, userAgent: 'DifferentBrowser/9.9'
  }));
  assert.equal(copiedOtherAgent.response.status, 401);
  const tampered = `${grant.cookie.slice(0, -1)}${grant.cookie.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await customerCall('/lookup/summary', { cookie: tampered })).status, 401);
  const staleCsrf = await customerCall('/lookup/logout', {
    method: 'POST', cookie: grant.cookie, csrf: grant.csrfToken
  });
  assert.equal(staleCsrf.status, 403);
  const logout = await customerCall('/lookup/logout', {
    method: 'POST', cookie: grant.cookie, csrf: copiedSameAgent.body.csrfToken
  });
  assert.equal(logout.status, 204);
  assert.equal((await customerCall('/lookup/summary', { cookie: grant.cookie })).status, 401);
});

test('lookup summary cannot read document bytes or invoke legacy customer mutations', async () => {
  const grant = await openLookup(customerA, bookingA);
  const byteAttempt = await customerCall('/documents/doc_not_real/read', { cookie: grant.cookie });
  assert.equal(byteAttempt.status, 401);
  const mutation = await customerCall('/profile', {
    method: 'PATCH', cookie: grant.cookie, csrf: grant.csrfToken, body: { firstName: 'Changed', lastName: 'Name' }
  });
  assert.equal(mutation.status, 401);
  const unchanged = (await pool.query('SELECT first_name,last_name FROM parking_customers WHERE id=$1', [customerA.id])).rows[0];
  assert.deepEqual(unchanged, { first_name: 'Alex', last_name: 'Smith' });
});

test('document authorization is fixed to the server-resolved reservation and one exact document type', async () => {
  const licenseGrant = await openLookup(customerA, bookingA, { documentType: 'DRIVER_LICENSE' });
  const wrongType = await startDocument(licenseGrant, 'INSURANCE');
  assert.equal(wrongType.response.status, 403);
  const started = await startDocument(licenseGrant, 'DRIVER_LICENSE', {
    reservationNumber: bookingB.reservation_number, bookingId: bookingB.id, customerId: customerB.id
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.document, { type: 'DRIVER_LICENSE', uploadStatus: 'PENDING_UPLOAD', status: 'RECEIVED' });
  assert.equal(Object.hasOwn(started.body.document, 'id'), false);
  const pending = (await pool.query(`SELECT booking_id,document_type FROM parking_customer_documents
    WHERE upload_token_hash=$1`, [digest(started.body.upload.token)])).rows[0];
  assert.equal(Number(pending.booking_id), Number(bookingA.id));
  assert.equal(pending.document_type, 'DRIVER_LICENSE');
  const completed = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: licenseGrant.cookie, csrf: licenseGrant.csrfToken, body: { uploadToken: started.body.upload.token }
  }));
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.deepEqual(completed.body.document, { type: 'DRIVER_LICENSE', uploadStatus: 'UPLOADED', status: 'RECEIVED' });
});

test('Driver License and Insurance uploads work, while another customer upload token is rejected', async () => {
  const insuranceA = await openLookup(customerA, bookingA, { documentType: 'INSURANCE' });
  const startedA = await startDocument(insuranceA, 'INSURANCE');
  assert.equal(startedA.response.status, 201, JSON.stringify(startedA.body));
  const insuranceB = await openLookup(customerB, bookingB, { documentType: 'INSURANCE' });
  const startedB = await startDocument(insuranceB, 'INSURANCE');
  assert.equal(startedB.response.status, 201, JSON.stringify(startedB.body));
  const crossCustomer = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: insuranceA.cookie, csrf: insuranceA.csrfToken, body: { uploadToken: startedB.body.upload.token }
  }));
  assert.equal(crossCustomer.response.status, 404);
  assert.deepEqual(crossCustomer.body, { error: { code: 'PARKING_RECORD_NOT_FOUND', message: 'We could not find a matching parking record.' } });
  const completedA = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: insuranceA.cookie, csrf: insuranceA.csrfToken, body: { uploadToken: startedA.body.upload.token }
  }));
  assert.equal(completedA.response.status, 200, JSON.stringify(completedA.body));
});

test('concurrent document starts issue one authorization and do not silently invalidate it', async () => {
  const grant = await openLookup(customerB, bookingB, { documentType: 'DRIVER_LICENSE' });
  const [first, second] = await Promise.all([
    startDocument(grant, 'DRIVER_LICENSE'),
    startDocument(grant, 'DRIVER_LICENSE')
  ]);
  const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409]);
  const pending = await pool.query(`SELECT id FROM parking_customer_documents
    WHERE booking_id=$1 AND document_type='DRIVER_LICENSE' AND upload_status='PENDING_UPLOAD'`, [bookingB.id]);
  assert.equal(pending.rowCount, 1);
});

test('file validation rejects empty, oversized, mismatched, and malformed content while keeping object keys server-generated', async () => {
  const grant = await openLookup(customerC, bookingC, { documentType: 'DRIVER_LICENSE' });
  for (const body of [
    { filename: 'empty.pdf', mimeType: 'application/pdf', sizeBytes: 0 },
    { filename: 'large.pdf', mimeType: 'application/pdf', sizeBytes: 15728641 },
    { filename: 'script.svg', mimeType: 'image/svg+xml', sizeBytes: 128 },
    { filename: 'renamed.pdf', mimeType: 'text/html', sizeBytes: 128 },
    { filename: 'photo.jpg', mimeType: 'image/png', sizeBytes: 128 }
  ]) {
    const denied = await startDocument(grant, 'DRIVER_LICENSE', body);
    assert.ok([400,415].includes(denied.response.status), JSON.stringify(denied.body));
  }
  const started = await startDocument(grant, 'DRIVER_LICENSE', {
    filename: '../unicode-\u00e9vidence.pdf', mimeType: 'application/pdf', sizeBytes: 256
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const row = (await pool.query(`SELECT storage_key FROM parking_customer_documents
    WHERE upload_token_hash=$1`, [digest(started.body.upload.token)])).rows[0];
  assert.match(row.storage_key, /^driver-license\/[A-Za-z0-9_-]+\.pdf$/);
  assert.equal(row.storage_key.includes('unicode'), false);
  const object = storedDocuments.get(row.storage_key);
  object.bytes = Buffer.alloc(object.sizeBytes, 0x3c);
  const rejected = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: grant.cookie, csrf: grant.csrfToken,
    body: { uploadToken: started.body.upload.token }
  }));
  assert.equal(rejected.response.status, 415, JSON.stringify(rejected.body));
  assert.equal((await pool.query('SELECT upload_status FROM parking_customer_documents WHERE storage_key=$1', [row.storage_key])).rows[0].upload_status, 'FAILED');
});

test('document completion survives database rollback and storage absence without losing the prior valid revision', async () => {
  const firstGrant = await openLookup(customerC, bookingC, { documentType: 'INSURANCE' });
  const first = await startDocument(firstGrant, 'INSURANCE');
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  const firstRow = (await pool.query(`SELECT storage_key FROM parking_customer_documents
    WHERE upload_token_hash=$1`, [digest(first.body.upload.token)])).rows[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const completedInsideFailedTransaction = await customerDocuments.completeUpload(client, {
      bookingId: bookingC.id,
      uploadToken: first.body.upload.token
    });
    assert.equal(completedInsideFailedTransaction.document.upload_status, 'UPLOADED');
    await client.query('ROLLBACK');
  } finally { client.release(); }
  assert.equal((await pool.query('SELECT upload_status FROM parking_customer_documents WHERE storage_key=$1', [firstRow.storage_key])).rows[0].upload_status, 'PENDING_UPLOAD');
  const retry = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: firstGrant.cookie, csrf: firstGrant.csrfToken,
    body: { uploadToken: first.body.upload.token }
  }));
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));

  const replacementGrant = await openLookup(customerC, bookingC, { documentType: 'INSURANCE' });
  const replacement = await startDocument(replacementGrant, 'INSURANCE');
  assert.equal(replacement.response.status, 201, JSON.stringify(replacement.body));
  const replacementRow = (await pool.query(`SELECT storage_key FROM parking_customer_documents
    WHERE upload_token_hash=$1`, [digest(replacement.body.upload.token)])).rows[0];
  const durableObject = storedDocuments.get(replacementRow.storage_key);
  storedDocuments.delete(replacementRow.storage_key);
  const unavailable = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: replacementGrant.cookie, csrf: replacementGrant.csrfToken,
    body: { uploadToken: replacement.body.upload.token }
  }));
  assert.equal(unavailable.response.status, 503, JSON.stringify(unavailable.body));
  assert.equal((await pool.query('SELECT upload_status FROM parking_customer_documents WHERE storage_key=$1', [replacementRow.storage_key])).rows[0].upload_status, 'PENDING_UPLOAD');
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_documents
    WHERE booking_id=$1 AND document_type='INSURANCE' AND upload_status='UPLOADED' AND superseded_at IS NULL`, [bookingC.id])).rows[0].count), 1);
  storedDocuments.set(replacementRow.storage_key, durableObject);
  const recovered = await parsed(await customerCall('/lookup/documents/complete', {
    method: 'POST', cookie: replacementGrant.cookie, csrf: replacementGrant.csrfToken,
    body: { uploadToken: replacement.body.upload.token }
  }));
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
});

test('private customer responses explicitly prohibit shared or browser caching', async () => {
  const grant = await openLookup(customerA, bookingA);
  const summary = await customerCall('/lookup/summary', { cookie: grant.cookie });
  assert.match(summary.headers.get('cache-control') || '', /private.*no-store/i);
  assert.equal(summary.headers.get('pragma'), 'no-cache');
  const failure = await customerCall('/lookup', {
    method: 'POST', body: identityFor(customerA, bookingA, { licensePlate: 'NOPE' })
  });
  assert.match(failure.headers.get('cache-control') || '', /private.*no-store/i);

  const malformed = await fetch(`${base}/api/customer/parking/v1/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('cache-control') || '', /private.*no-store/i);
  assert.equal(malformed.headers.get('pragma'), 'no-cache');
  assert.deepEqual(await malformed.json(), {
    error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }
  });
});

test('confirmed in-person NOT_REQUIRED parking is eligible without creating an account or Stripe payment', async () => {
  const source = await createCustomer(63, 'In Person', 'Driver');
  const inPerson = await createBooking(source, 63, { customerId: null, paymentStatus: 'NOT_REQUIRED', plate: 'CASH-63' });
  await pool.query('DELETE FROM parking_customers WHERE id=$1', [source.id]);
  const countBefore = Number((await pool.query('SELECT count(*) FROM parking_customers WHERE normalized_email=$1', [source.normalized_email])).rows[0].count);
  const result = await parsed(await customerCall('/lookup', { method: 'POST', body: identityFor(source, inPerson) }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.summary.reservations.current[0].paymentStatus, 'NOT_REQUIRED');
  assert.equal(result.body.summary.payments.length, 0);
  const countAfter = Number((await pool.query('SELECT count(*) FROM parking_customers WHERE normalized_email=$1', [source.normalized_email])).rows[0].count);
  assert.equal(countAfter, countBefore);
});

test('expired grants and invalid CSRF fail closed with the same generic lookup response', async () => {
  const grant = await openLookup(customerA, bookingA, { documentType: 'DRIVER_LICENSE' });
  const csrfFailure = await parsed(await customerCall('/lookup/documents/DRIVER_LICENSE/upload', {
    method: 'POST', cookie: grant.cookie, csrf: 'wrong', body: { filename: 'license.pdf', mimeType: 'application/pdf', sizeBytes: 128 }
  }));
  assert.equal(csrfFailure.response.status, 403);
  const rawGrant = decodeURIComponent(grant.cookie.slice(grant.cookie.indexOf('=') + 1));
  await pool.query(`UPDATE parking_customer_lookup_grants
    SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'
    WHERE token_hash=$1`, [digest(rawGrant)]);
  const expired = await parsed(await customerCall('/lookup/summary', { cookie: grant.cookie }));
  assert.equal(expired.response.status, 401);
  assert.equal(expired.body.error.message, 'We could not find a matching parking record.');
});

test('failed lookup attempts are rate limited per requester without exposing which field failed', async () => {
  const ip = '203.0.113.91';
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await parsed(await customerCall('/lookup', { method: 'POST', ip, body: { name: 'No Match', email: `none.${run}@example.test`, phone: '+16155550199', licensePlate: 'NONE' } }));
  }
  assert.equal(last.response.status, 429);
  assert.deepEqual(last.body, { error: { code: 'PARKING_RECORD_NOT_FOUND', message: 'We could not find a matching parking record.' } });
});
