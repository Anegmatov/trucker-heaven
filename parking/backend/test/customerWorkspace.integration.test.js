process.env.NODE_ENV = 'test';
process.env.PARKING_ADMIN_LOGIN_RATE_LIMIT_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcrypt');

let database;
let pool;
let app;
let server;
let base;
let owner;
let staff;

function token(prefix, character) { return `${prefix}_${character.repeat(24)}`; }

async function migrate() {
  const { PGlite } = await import('@electric-sql/pglite');
  database = new PGlite();
  const migrationDirectory = path.join(__dirname, '..', 'migrations');
  const migrations = (await fs.readdir(migrationDirectory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of migrations) {
    let sql = await fs.readFile(path.join(migrationDirectory, name), 'utf8');
    // The in-process compatibility runtime does not bundle btree_gist. These
    // established production exclusions are tested by the PostgreSQL suites;
    // only those two statements are omitted here so migration 042 and the real
    // authenticated customer routes can run in every unit-test environment.
    sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS btree_gist;\s*/g, '');
    sql = sql.replace(/,\s*EXCLUDE USING gist \(parking_spot_id WITH =, reserved_period WITH &&\)\s*WHERE \(released_at IS NULL\)/g, '');
    sql = sql.replace(/ALTER TABLE parking_public_quotes\s+ADD CONSTRAINT parking_public_quotes_selected_spot_hold_exclusion\s+EXCLUDE USING gist[\s\S]*?\n\s*\);/g, '');
    await database.exec(sql);
  }
}

function databaseAdapter() {
  const adapter = {
    async query(sql, parameters = []) {
      const result = await database.query(sql, parameters);
      return { ...result, rowCount: Math.max(Number(result.affectedRows || 0), result.rows.length) };
    },
    async connect() {
      return { ...adapter, release() {} };
    },
    async end() {}
  };
  return adapter;
}

async function login(username, password) {
  const response = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken };
}

async function request(url, session, { method = 'GET', body, csrf = true } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = session.csrfToken;
  const response = await fetch(`${base}/api/admin/parking/v1${url}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let payload = null;
  if ((response.headers.get('content-type') || '').includes('json')) payload = await response.json();
  return { response, body: payload };
}

test.before(async () => {
  await migrate();
  pool = databaseAdapter();
  const dbPath = require.resolve('../db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool, children: [], paths: [] };
  app = require('../app');

  const passwordHash = await bcrypt.hash('ParkingOps-ledger-test-2026', 4);
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES('ledger-owner',$1,'OWNER',true),('ledger-staff',$1,'STAFF',true)`, [passwordHash]);
  await pool.query(`INSERT INTO parking_customers(public_id,first_name,last_name,display_name,normalized_phone,display_phone,
      normalized_email,display_email,status,lifecycle_status,record_source)
    VALUES
      ($1,'Alex','Smith','Alex Smith','+16155550101','(615) 555-0101','alex.one@example.test','alex.one@example.test','ACTIVE','ACTIVE','PARKINGOPS'),
      ($2,'Alex','Smith','Alex Smith','+16155550102','(615) 555-0102','alex.two@example.test','alex.two@example.test','ACTIVE','ACTIVE','PARKINGOPS')`,
  [token('cust', 'a'), token('cust', 'b')]);
  await pool.query(`INSERT INTO parking_customer_vehicles(public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification)
    VALUES($1,1,'UNIT-A','A-ONE','TN','GENERAL'),($2,2,'UNIT-B','B-TWO','TN','GENERAL')`,
  [token('veh', 'a'), token('veh', 'b')]);
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  await pool.query(`INSERT INTO parking_customer_billing_periods(
      public_id,customer_id,period_start,amount_due_cents,due_date,currency,source)
    VALUES($1,1,$3,15000,$4,'usd','ADMIN'),($2,2,$3,15000,$3,'usd','ADMIN')`,
  [token('bill', 'a'), token('bill', 'b'), period, lastDay]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('ledger-owner', 'ParkingOps-ledger-test-2026');
  staff = await login('ledger-staff', 'ParkingOps-ledger-test-2026');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await database.close();
});

test('canonical list search keeps same-name customers isolated and exposes computed overdue state', async () => {
  const ready = await fetch(`${base}/ready`);
  const readyBody = await ready.json();
  assert.equal(ready.status, 200, JSON.stringify(readyBody));
  assert.equal(readyBody.dependencies.customerLedger, true);
  const sameName = await request('/customers?q=Alex%20Smith', staff);
  assert.equal(sameName.response.status, 200, JSON.stringify(sameName.body));
  assert.equal(sameName.body.customers.length, 2);
  assert.equal(new Set(sameName.body.customers.map(customer => customer.publicId)).size, 2);

  const phone = await request('/customers?q=6155550101', staff);
  assert.deepEqual(phone.body.customers.map(customer => customer.publicId), [token('cust', 'a')]);
  const plate = await request('/customers?q=AONE', staff);
  assert.deepEqual(plate.body.customers.map(customer => customer.publicId), [token('cust', 'a')]);
  const overdue = await request('/customers?payment=OVERDUE', staff);
  assert.deepEqual(overdue.body.customers.map(customer => customer.publicId), [token('cust', 'b')]);
});

test('manual Cash and Clover payments compute partial, paid, and overpayment states without Stripe provenance', async () => {
  const period = new Date().toISOString().slice(0, 7);
  const paymentDate = new Date().toISOString().slice(0, 10);
  const first = await request(`/customers/${token('cust', 'a')}/payments`, staff, {
    method: 'POST', body: { period, amountCents: 7500, paymentDate, method: 'CASH', reference: 'drawer-1', note: 'First half' }
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.balance.status, 'PARTIAL');
  assert.equal(Number(first.body.balance.balance_cents), 7500);

  const second = await request(`/customers/${token('cust', 'a')}/payments`, staff, {
    method: 'POST', body: { period, amountCents: 7500, paymentDate, method: 'CLOVER', reference: 'clover-2', note: '' }
  });
  assert.equal(second.body.balance.status, 'PAID');
  assert.equal(Number(second.body.balance.balance_cents), 0);

  const extra = await request(`/customers/${token('cust', 'a')}/payments`, staff, {
    method: 'POST', body: { period, amountCents: 5000, paymentDate, method: 'CHECK', reference: '', note: 'Overpayment retained' }
  });
  assert.equal(extra.body.balance.status, 'PAID');
  assert.equal(Number(extra.body.balance.credit_cents), 5000);
  const stored = await pool.query(`SELECT payment_source,payment_method,processor,processor_payment_id,created_by_admin_user_id
    FROM parking_customer_payments WHERE public_id=$1`, [extra.body.payment.publicId]);
  assert.deepEqual(stored.rows[0], {
    payment_source: 'ADMIN_MANUAL', payment_method: 'CHECK', processor: null,
    processor_payment_id: null, created_by_admin_user_id: 2
  });
});

test('only Owner can post immutable corrections and a reversal must be negative', async () => {
  const payment = (await pool.query(`SELECT public_id FROM parking_customer_payments
    WHERE customer_id=1 AND payment_method='CHECK' ORDER BY id DESC LIMIT 1`)).rows[0];
  const forbidden = await request(`/payments/${payment.public_id}/corrections`, staff, {
    method: 'POST', body: { amountCents: -5000, type: 'REVERSAL', reason: 'Owner approval required' }
  });
  assert.equal(forbidden.response.status, 403);
  const invalid = await request(`/payments/${payment.public_id}/corrections`, owner, {
    method: 'POST', body: { amountCents: 5000, type: 'REVERSAL', reason: 'Wrong direction' }
  });
  assert.equal(invalid.response.status, 400);
  const corrected = await request(`/payments/${payment.public_id}/corrections`, owner, {
    method: 'POST', body: { amountCents: -5000, type: 'REVERSAL', reason: 'Check was returned' }
  });
  assert.equal(corrected.response.status, 201, JSON.stringify(corrected.body));
  assert.equal(Number(corrected.body.balance.credit_cents), 0);
  const adjustment = (await pool.query('SELECT id FROM parking_customer_payment_adjustments LIMIT 1')).rows[0];
  await assert.rejects(pool.query('DELETE FROM parking_customer_payment_adjustments WHERE id=$1', [adjustment.id]), /immutable/i);
});

test('customer detail, matrix, notes, status, and CSRF preserve account boundaries and auditability', async () => {
  const detail = await request(`/customers/${token('cust', 'a')}`, staff);
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body.vehicles.map(vehicle => vehicle.license_plate), ['A-ONE']);
  assert.ok(detail.body.payments.every(payment => payment.payment_source === 'ADMIN_MANUAL'));
  assert.equal(JSON.stringify(detail.body).includes('B-TWO'), false);

  const year = new Date().getUTCFullYear();
  const matrix = await request(`/customers/payment-matrix?year=${year}`, staff);
  assert.equal(matrix.response.status, 200, JSON.stringify(matrix.body));
  assert.equal(matrix.body.customers.length, 2);
  assert.equal(matrix.body.customers.find(customer => customer.publicId === token('cust', 'a')).periods[0].status, 'PAID');

  const noCsrf = await request(`/customers/${token('cust', 'a')}/notes`, staff, {
    method: 'POST', csrf: false, body: { note: 'Must be rejected' }
  });
  assert.equal(noCsrf.response.status, 403);
  const note = await request(`/customers/${token('cust', 'a')}/notes`, staff, {
    method: 'POST', body: { note: 'Call before month end', followUpDate: null }
  });
  assert.equal(note.response.status, 201, JSON.stringify(note.body));
  assert.equal((await request(`/customer-notes/${note.body.note.publicId}/resolve`, staff, {
    method: 'PATCH', body: {}
  })).response.status, 200);

  const former = await request(`/customers/${token('cust', 'a')}/status`, owner, {
    method: 'PATCH', body: { status: 'FORMER', reason: 'Parking agreement ended' }
  });
  assert.equal(former.response.status, 200, JSON.stringify(former.body));
  assert.equal(former.body.lifecycleStatus, 'FORMER');
  assert.ok(Number((await pool.query(`SELECT count(*) FROM parking_audit_events
    WHERE action IN ('CUSTOMER_PAYMENT_RECORDED','CUSTOMER_PAYMENT_CORRECTED','CUSTOMER_NOTE_ADDED',
      'CUSTOMER_NOTE_RESOLVED','CUSTOMER_STATUS_CHANGED')`)).rows[0].count) >= 7);
});

test('the same workbook hash and sheet cannot create a second import batch', async () => {
  const hash = 'a'.repeat(64);
  await pool.query(`INSERT INTO parking_customer_import_batches(
      public_id,source_filename,source_sha256,source_sheet,status,initiated_by_admin_user_id,initiated_by,rows_considered)
    VALUES($1,'fixture.xlsx',$2,'PARKING PAYMENT MANAGEMENT','COMPLETED',1,'ledger-owner',10)`,
  [token('imp', 'a'), hash]);
  await assert.rejects(pool.query(`INSERT INTO parking_customer_import_batches(
      public_id,source_filename,source_sha256,source_sheet,status,initiated_by_admin_user_id,initiated_by,rows_considered)
    VALUES($1,'fixture-copy.xlsx',$2,'PARKING PAYMENT MANAGEMENT','RUNNING',1,'ledger-owner',10)`,
  [token('imp', 'b'), hash]), /unique|duplicate/i);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM parking_customer_import_batches
    WHERE source_sha256=$1 AND source_sheet='PARKING PAYMENT MANAGEMENT'`, [hash])).rows[0].count), 1);
});

test('multiple legacy space obligations aggregate by customer/month and anomaly-only months stay neutral', async () => {
  const hash = 'b'.repeat(64);
  const batch = (await pool.query(`INSERT INTO parking_customer_import_batches(
      public_id,source_filename,source_sha256,source_sheet,status,initiated_by_admin_user_id,initiated_by,rows_considered)
    VALUES($1,'multi-space.xlsx',$2,'PARKING PAYMENT MANAGEMENT','COMPLETED',1,'ledger-owner',2) RETURNING id`,
  [token('imp', 'c'), hash])).rows[0];
  for (const [sourceRow, amount] of [[10, 10000], [11, 15000]]) {
    await pool.query(`INSERT INTO parking_customer_billing_periods(
        public_id,customer_id,period_start,amount_due_cents,due_date,source,legacy_confidence,
        legacy_import_batch_id,legacy_source_ref,legacy_source_row)
      VALUES($1,1,'2024-01-01',$2,'2024-01-01','LEGACY_EXCEL_IMPORT','EXACT_STATUS_ONLY',$3,$4,$5)`,
    [token('bill', String(sourceRow)), amount, batch.id, `PARKING PAYMENT MANAGEMENT!M${sourceRow}`, sourceRow]);
  }
  await pool.query(`INSERT INTO parking_customer_legacy_anomalies(
      public_id,customer_id,import_batch_id,source_row,source_ref,period_start,classification,
      anomaly_type,raw_value,financial_effect)
    VALUES($1,1,$2,10,'PARKING PAYMENT MANAGEMENT!O10','2024-02-01','NON_FINANCIAL_LEGACY_ANOMALY',
      'LEGACY_NO_RELIABLE_EVIDENCE','Missing',false)`, [token('lan', 'a'), batch.id]);

  const matrix = await request('/customers/payment-matrix?year=2024', staff);
  assert.equal(matrix.response.status, 200, JSON.stringify(matrix.body));
  const customer = matrix.body.customers.find(row => row.publicId === token('cust', 'a'));
  const january = customer.periods.find(period => period.period === '2024-01');
  const february = customer.periods.find(period => period.period === '2024-02');
  assert.equal(january.amountDueCents, 25000);
  assert.equal(january.balanceCents, 25000);
  assert.equal(february.status, 'LEGACY_DATA_MISSING');
  assert.equal(february.amountDueCents, 0);
  assert.equal(february.legacyAnomalyCount, 1);
});
