const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing admin view tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

const username = 'admin-views-scale-owner';
const password = 'ParkingOps-admin-views-2031';
const prefix = 'TH-SCALE-';
let server;
let base;
let session;
let location;

function adminGet(path) {
  return fetch(`${base}/api/admin/parking/v1${path}`, { headers: { cookie: session.cookie } });
}

async function collect(path, field) {
  const rows = [];
  let cursor = '';
  do {
    const response = await adminGet(`${path}${path.includes('?') ? '&' : '?'}limit=37${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    rows.push(...body[field]);
    cursor = body.pagination.nextCursor || '';
  } while (cursor);
  return rows;
}

test.before(async () => {
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
    VALUES($1,$2,'OWNER',true) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,active=true`,
  [username, await bcrypt.hash(password, 4)]);
  location = (await pool.query(`SELECT l.id,l.timezone,i.id inventory_id,i.category_id,z.id zone_id
    FROM parking_locations l JOIN parking_zones z ON z.location_id=l.id
    JOIN parking_inventory i ON i.zone_id=z.id WHERE l.name='Trucker Heaven Main Lot' ORDER BY i.id LIMIT 1`)).rows[0];
  assert.ok(location);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < 260; index += 1) {
      const arrival = index === 0 ? '2031-03-09T05:30:00Z' : index === 1 ? '2031-11-02T05:30:00Z'
        : new Date(Date.UTC(2032, 0, 1, 12, 0) + index * 86400000).toISOString();
      const departure = index === 0 ? '2031-03-09T08:30:00Z' : index === 1 ? '2031-11-02T08:30:00Z'
        : new Date(new Date(arrival).getTime() + (index % 5 + 1) * 3600000).toISOString();
      const customer = index;
      const status = index % 7 === 0 ? 'CANCELLED' : 'CONFIRMED';
      const canonicalCustomer = (await client.query(`INSERT INTO parking_customers(
          public_id,first_name,last_name,display_name,normalized_phone,display_phone,
          normalized_email,display_email,status,lifecycle_status,record_source)
        VALUES($1,'Scale',$2,$3,$4,$4,$5,$5,'ACTIVE','ACTIVE','PARKINGOPS') RETURNING id`, [
        `cust_scale_${String(index).padStart(24, '0')}`, `Customer ${customer}`, `Scale Customer ${customer}`,
        `+1615555${String(1000 + customer)}`, `scale.customer.${customer}@example.test`
      ])).rows[0];
      const booking = (await client.query(`INSERT INTO parking_bookings(
          reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
          arrival_at,departure_at,first_name,last_name,mobile_phone,email,company_name,tractor_unit_number,
          license_plate,license_plate_state,terms_accepted_at,cancellation_terms_accepted_at,customer_id)
        VALUES($1,$2,'scale-hash',$3,$4,$5,$6,$7,$8,'Scale',$9,$10,$11,'Scale Fleet',$12,$13,'TN',now(),now(),$14) RETURNING id`,
      [`${prefix}${String(index).padStart(4, '0')}`, `scale-token-${index}`, location.inventory_id, location.id, location.category_id,
        status, arrival, departure, `Customer ${customer}`, `+1615555${String(1000 + customer)}`,
        `scale.customer.${customer}@example.test`, `SCALE-${index}`, `SC${index}`, canonicalCustomer.id])).rows[0];
      await client.query(`INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)`,
        [booking.id, JSON.stringify({ duration: 'DAILY', totalCents: 1000 + index })]);
      await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
        VALUES($1,$2,'SYSTEM','Synthetic scale fixture',1)`, [booking.id, status]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) });
  const body = await login.json();
  assert.equal(login.status, 200, JSON.stringify(body));
  session = { cookie: login.headers.get('set-cookie').split(';')[0] };
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test('booking cursor pagination returns all 260 rows without duplicates or omissions', async () => {
  const rows = await collect(`/bookings?q=${encodeURIComponent(prefix)}`, 'bookings');
  assert.equal(rows.length, 260);
  assert.equal(new Set(rows.map(row => row.id)).size, 260);
  const direct = await pool.query("SELECT count(*)::int count FROM parking_bookings WHERE reservation_number LIKE 'TH-SCALE-%'");
  assert.equal(rows.length, direct.rows[0].count);
});

test('customer pages and totals match direct SQL regardless of page size', async () => {
  const rows = await collect('/customers?q=Scale', 'customers');
  assert.equal(rows.length, 260);
  assert.equal(new Set(rows.map(row => row.publicId)).size, 260);
  const first = await adminGet('/customers?q=Scale&limit=7');
  const body = await first.json();
  assert.equal(first.status, 200, JSON.stringify(body));
  const direct = await pool.query("SELECT count(*)::int customers FROM parking_customers WHERE display_name LIKE 'Scale Customer %'");
  assert.deepEqual(body.totals, { customers: direct.rows[0].customers });
  assert.ok(rows.every(row => row.reservationCount === 1));
});

test('calendar groups UTC-midnight and DST events by authoritative America/Chicago local dates', async () => {
  const march8 = await adminGet(`/calendar?locationId=${location.id}&startDate=2031-03-08&endDate=2031-03-09`);
  const march8Body = await march8.json();
  assert.equal(march8.status, 200, JSON.stringify(march8Body));
  assert.equal(march8Body.timezone, 'America/Chicago');
  assert.ok(march8Body.events.some(event => event.reservationNumber === `${prefix}0000` && event.type === 'ARRIVAL' && event.localDate === '2031-03-08'));

  const march9 = await adminGet(`/calendar?locationId=${location.id}&startDate=2031-03-09&endDate=2031-03-10`);
  const march9Body = await march9.json();
  assert.ok(march9Body.events.some(event => event.reservationNumber === `${prefix}0000` && event.type === 'DEPARTURE' && event.localDate === '2031-03-09'));

  const november2 = await adminGet(`/calendar?locationId=${location.id}&startDate=2031-11-02&endDate=2031-11-03`);
  const novemberBody = await november2.json();
  assert.deepEqual(novemberBody.events.filter(event => event.reservationNumber === `${prefix}0001`).map(event => event.type).sort(), ['ARRIVAL', 'DEPARTURE']);
  assert.ok(novemberBody.events.filter(event => event.reservationNumber === `${prefix}0001`).every(event => event.localDate === '2031-11-02'));
});
