const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

let database;

async function accepts(product, departure) {
  const arrival = '2026-09-01T14:00:00.000Z';
  const values = departure === null ? [product, arrival] : [product, arrival, departure];
  const placeholders = departure === null ? '$1,$2,NULL' : '$1,$2,$3';
  await database.query(`INSERT INTO parking_bookings(parking_product,arrival_at,departure_at)
    VALUES(${placeholders})`, values);
}

test.before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  database = new PGlite();
  await database.exec(`CREATE TABLE parking_bookings (
    id bigserial PRIMARY KEY,
    parking_product text NOT NULL,
    arrival_at timestamptz NOT NULL,
    departure_at timestamptz,
    CONSTRAINT parking_bookings_departure_at_check CHECK (
      (parking_product='MONTHLY' AND (departure_at IS NULL OR departure_at>arrival_at))
      OR (parking_product<>'MONTHLY' AND departure_at IS NOT NULL AND departure_at>arrival_at)
    )
  );`);
  const migration = await fs.readFile(path.join(__dirname, '..', 'migrations', '053_open_ended_weekly_interval.sql'), 'utf8');
  await database.exec(migration);
});

test.after(async () => { await database?.close(); });

test('Daily still requires a valid finite departure', async () => {
  await assert.rejects(accepts('DAILY', null));
  await accepts('DAILY', '2026-09-02T14:00:00.000Z');
  await assert.rejects(accepts('DAILY', '2026-09-01T14:00:00.000Z'));
});

test('Weekly accepts open-ended and historical finite intervals but rejects invalid intervals', async () => {
  await accepts('WEEKLY', null);
  await accepts('WEEKLY', '2026-09-08T14:00:00.000Z');
  await assert.rejects(accepts('WEEKLY', '2026-08-31T14:00:00.000Z'));
});

test('Monthly retains its existing open-ended and finite compatibility', async () => {
  await accepts('MONTHLY', null);
  await accepts('MONTHLY', '2026-10-01T14:00:00.000Z');
  await assert.rejects(accepts('MONTHLY', '2026-09-01T14:00:00.000Z'));
});

test('other parking products retain migration 050 finite-departure behavior', async () => {
  await assert.rejects(accepts('LEGACY', null));
  await accepts('LEGACY', '2026-09-02T14:00:00.000Z');
  await assert.rejects(accepts('LEGACY', '2026-09-01T14:00:00.000Z'));
});
