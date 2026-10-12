const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../scripts/runProductionRealLotImport');
const importer = require('../scripts/importTruckerHeavenRealLot');

const fingerprintColumns = {
  parking_admin_users: ['username', 'password_hash', 'role', 'active'],
  parking_bookings: ['reservation_number', 'location_id', 'inventory_id', 'category_id', 'status', 'assigned_zone_id', 'assigned_spot_label'],
  parking_booking_price_snapshots: ['booking_id', 'snapshot'],
  parking_booking_price_adjustments: ['booking_id', 'adjustment_type', 'amount_cents'],
  parking_lot_layouts: ['location_id', 'status', 'version', 'published_at', 'superseded_by_layout_id'],
  parking_layout_elements: ['layout_id', 'element_key', 'parking_spot_id', 'x', 'y', 'width', 'height', 'parking_purpose', 'daily_eligible', 'weekly_eligible', 'monthly_eligible', 'space_public_bookable'],
  parking_spots: ['location_id', 'zone_id', 'inventory_id', 'public_label', 'visual_element_key', 'active'],
  reservation_spot_assignments: ['booking_id', 'parking_spot_id', 'reserved_arrival_at', 'reserved_departure_at', 'released_at']
};

function fingerprintClient({ valid = true } = {}) {
  return { query: async (sql, values = []) => {
    if (sql.includes('information_schema.tables')) return { rows: valid ? values[0].map(table_name => ({ table_name })) : [] };
    if (sql.includes('FROM schema_migrations')) return { rows: valid ? values[0].map(name => ({ name })) : [] };
    if (sql.includes('information_schema.columns')) return { rows: valid ? Object.entries(fingerprintColumns).flatMap(([table_name, columns]) => columns.map(column_name => ({ table_name, column_name }))) : [] };
    throw new Error('Unexpected fingerprint query');
  } };
}

test('production runner classifies supported Render PostgreSQL hosts without treating a hostname as proof', () => {
  assert.equal(runner.classifyHost('dpg-cv123abc'), 'render-internal');
  assert.equal(runner.classifyHost('dpg-cv123abc-a.oregon-postgres.render.com'), 'render-external');
  assert.equal(runner.classifyHost('dpg-cv123abc-pooler-a.oregon-postgres.render.com'), 'render-external-pooler');
  assert.equal(runner.classifyHost('remote.example'), 'unknown-remote');
  for (const url of [
    'postgresql://user:secret@dpg-cv123abc:5432/parkingops_prod',
    'postgresql://user:secret@dpg-cv123abc-a.oregon-postgres.render.com:5432/parkingops_prod',
    'postgresql://user:secret@dpg-cv123abc-pooler-a.oregon-postgres.render.com:5432/parkingops_prod'
  ]) assert.equal(runner.parseConnection(url).database, 'parkingops_prod');
});

test('production runner refuses local, IFTA, test, development, SQLite, and malformed URLs without exposing credentials', () => {
  assert.throws(() => runner.parseConnection(''), /DATABASE_URL is required/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@localhost:5432/parkingops_prod'), /localhost or local service/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@127.0.0.1:5432/parkingops_prod'), /localhost or local service/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@[::1]:5432/parkingops_prod'), /localhost or local service/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@host.docker.internal:5432/parkingops_prod'), /localhost or local service/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@db.example/ifta_db'), /non-production/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@db.example/parkingops_test'), /non-production/);
  assert.throws(() => runner.parseConnection('postgresql://user:secret@db.example/parkingops_dev'), /non-production/);
  assert.throws(() => runner.parseConnection('sqlite:///tmp/parkingops_prod.sqlite'), /PostgreSQL scheme/);
  let error;
  try { runner.parseConnection('postgresql://user:secret@localhost:5432/parkingops_prod'); } catch (caught) { error = caught; }
  assert.ok(error);
  assert.doesNotMatch(error.message, /secret|user|postgresql:\/\//i);
  const sanitized = importer.redactSecrets('password authentication failed for user app_user via postgresql://app_user:secret@db.example/parkingops_prod');
  assert.doesNotMatch(sanitized, /app_user|secret|postgresql:\/\//i);
});

test('production runner accepts a complete ParkingOps migration/schema fingerprint and rejects unknown or wrong schemas', async () => {
  await assert.doesNotReject(() => runner.schemaFingerprint(fingerprintClient()));
  assert.equal(runner.parseConnection('postgresql://user:secret@unknown.example:5432/parkingops_prod').hostClassification, 'unknown-remote');
  assert.equal(runner.parseConnection('postgresql://user:secret@dpg-cv123abc:5432/parkingops_prod').hostClassification, 'render-internal');
  await assert.rejects(() => runner.schemaFingerprint(fingerprintClient({ valid: false })), /migration\/schema fingerprint is incomplete/);
});

test('production runner refuses canonical maintenance mode', () => {
  const before = process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE;
  process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE = 'true';
  try { assert.throws(() => runner.assertMaintenanceOff(), /MAINTENANCE is enabled/); }
  finally { if (before === undefined) delete process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE; else process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE = before; }
});
