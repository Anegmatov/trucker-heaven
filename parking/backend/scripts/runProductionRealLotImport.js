/*
 * Render Shell production runner. It never writes credentials to disk or to a
 * subprocess command line. The recovery copy is intentionally kept in the
 * database until an operator performs a guarded rollback.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const importer = require('./importTruckerHeavenRealLot');
const { classifyPostgresHost, parsePostgresUrl, createDatabasePoolConfig } = require('../databaseConnection');

const RECOVERY_SCHEMA = 'parkingops_real_lot_recovery';
const LOCK_KEY = 734920184; // ParkingOps canonical physical-lot import.
const CANONICAL_PREFIX = 'Trucker Heaven physical lot ·';
const GENERIC_PATTERN = '^[NS]-[0-9]+$';
const FINGERPRINT_MIGRATIONS = ['001_parking_ops.sql', '010_operational_adjustments.sql', '012_parking_lot_layouts.sql', '013_exact_space_parking.sql', '016_immutable_layout_publication.sql', '019_fix_historical_element_immutability.sql', '020_draft_space_configuration.sql'];
const FINGERPRINT_TABLES = ['schema_migrations', 'parking_locations', 'parking_zones', 'parking_categories', 'parking_inventory', 'parking_admin_users', 'parking_bookings', 'parking_booking_price_snapshots', 'parking_booking_price_adjustments', 'parking_booking_status_history', 'parking_lot_layouts', 'parking_layout_elements', 'parking_spots', 'parking_spot_blocks', 'reservation_spot_assignments', 'parking_area_directions'];
const FINGERPRINT_COLUMNS = {
  parking_admin_users: ['username', 'password_hash', 'role', 'active'],
  parking_bookings: ['reservation_number', 'location_id', 'inventory_id', 'category_id', 'status', 'assigned_zone_id', 'assigned_spot_label'],
  parking_booking_price_snapshots: ['booking_id', 'snapshot'],
  parking_booking_price_adjustments: ['booking_id', 'adjustment_type', 'amount_cents'],
  parking_lot_layouts: ['location_id', 'status', 'version', 'published_at', 'superseded_by_layout_id'],
  parking_layout_elements: ['layout_id', 'element_key', 'parking_spot_id', 'x', 'y', 'width', 'height', 'parking_purpose', 'daily_eligible', 'weekly_eligible', 'monthly_eligible', 'space_public_bookable'],
  parking_spots: ['location_id', 'zone_id', 'inventory_id', 'public_label', 'visual_element_key', 'active'],
  reservation_spot_assignments: ['booking_id', 'parking_spot_id', 'reserved_arrival_at', 'reserved_departure_at', 'released_at']
};
const SNAPSHOTS = {
  location: 'SELECT * FROM parking_locations WHERE id=$1',
  zones: 'SELECT * FROM parking_zones WHERE location_id=$1 ORDER BY id',
  inventory: `SELECT i.* FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id WHERE z.location_id=$1 ORDER BY i.id`,
  layouts: 'SELECT * FROM parking_lot_layouts WHERE location_id=$1 ORDER BY id',
  elements: `SELECT e.* FROM parking_layout_elements e JOIN parking_lot_layouts l ON l.id=e.layout_id WHERE l.location_id=$1 ORDER BY e.id`,
  spots: 'SELECT * FROM parking_spots WHERE location_id=$1 ORDER BY id',
  directions: 'SELECT * FROM parking_area_directions WHERE location_id=$1 ORDER BY id',
  blocks: `SELECT b.id,b.parking_spot_id,b.starts_at,b.ends_at,b.released_at,b.reason FROM parking_spot_blocks b JOIN parking_spots s ON s.id=b.parking_spot_id WHERE s.location_id=$1 ORDER BY b.id`,
  assignments: `SELECT a.id,a.booking_id,a.parking_spot_id,a.reserved_arrival_at,a.reserved_departure_at,a.released_at FROM reservation_spot_assignments a JOIN parking_spots s ON s.id=a.parking_spot_id WHERE s.location_id=$1 ORDER BY a.id`,
  booking_refs: 'SELECT id,reservation_number,location_id,assigned_spot_label,status,arrival_at,departure_at FROM parking_bookings WHERE location_id=$1 ORDER BY id',
  price_snapshots: `SELECT p.id,p.booking_id,p.created_at FROM parking_booking_price_snapshots p JOIN parking_bookings b ON b.id=p.booking_id WHERE b.location_id=$1 ORDER BY p.id`,
  price_adjustments: `SELECT p.id,p.booking_id,p.adjustment_type,p.amount_cents,p.reason,p.created_at FROM parking_booking_price_adjustments p JOIN parking_bookings b ON b.id=p.booking_id WHERE b.location_id=$1 ORDER BY p.id`
};
const MUTABLE = ['location', 'zones', 'inventory', 'layouts', 'spots', 'directions'];
const PRESERVATION = ['blocks', 'assignments', 'booking_refs'];
const EXPECTED_COUNTS = Object.freeze({ total: 185, publicEligible: 153, bobtail: 58, generalTruck: 95, shop: 23, company: 9, unresolved: 0, tractorOnly: 0, trailerOnly: 0 });

const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const checksum = rows => crypto.createHash('sha256').update(JSON.stringify(stable(rows))).digest('hex');
const sourceCommit = () => {
  for (const key of ['RENDER_GIT_COMMIT', 'GIT_COMMIT', 'COMMIT_SHA']) if (process.env[key]) return String(process.env[key]);
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) { return 'unavailable'; }
};
const canonicalChecksum = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'data', 'trucker-heaven-real-lot-layout.v1.json'))).digest('hex');

function classifyHost(value) {
  return classifyPostgresHost(value);
}

function parseConnection(url = process.env.PARKING_DATABASE_URL) {
  if (!url) throw new Error('PARKING_DATABASE_URL is required in the Render Shell.');
  let parsed; try { parsed = parsePostgresUrl(url); } catch (error) { throw new Error(error.message === 'PARKING_DATABASE_URL is required.' ? 'PARKING_DATABASE_URL is required in the Render Shell.' : error.message); }
  const { database, hostClassification } = parsed;
  if (!database || /(?:ifta_db|parkingops_test|trucker_heaven_postgres|(?:^|[_-])(?:test|dev|development)(?:[_-]|$))/i.test(database)) throw new Error('Refusing a non-production ParkingOps database.');
  if (hostClassification === 'local-or-service-alias') throw new Error('Refusing a localhost or local service database host.');
  return { connectionString: url, database, hostClassification };
}

function assertMaintenanceOff() {
  if (/^(?:1|true|yes)$/i.test(String(process.env.PARKING_CANONICAL_LAYOUT_MAINTENANCE || ''))) {
    throw new Error('Refusing import while PARKING_CANONICAL_LAYOUT_MAINTENANCE is enabled.');
  }
}

async function schemaCheck(client) {
  const required = [...importer.REQUIRED_PRODUCTION_TABLES, 'parking_inventory', 'parking_spot_blocks', 'reservation_spot_assignments', 'parking_area_directions', 'parking_bookings', 'parking_booking_price_snapshots', 'parking_booking_price_adjustments'];
  const result = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, [required]);
  const found = new Set(result.rows.map(row => row.table_name));
  const missing = required.filter(table => !found.has(table));
  if (missing.length) throw new Error(`Refusing import: required ParkingOps schema tables are missing (${missing.join(', ')}).`);
}

async function schemaFingerprint(client) {
  const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, [FINGERPRINT_TABLES]);
  const tableNames = new Set(tables.rows.map(row => row.table_name));
  const missingTables = FINGERPRINT_TABLES.filter(name => !tableNames.has(name));
  if (missingTables.length) throw new Error('Refusing import: ParkingOps migration/schema fingerprint is incomplete.');
  const [migrations, columns] = await Promise.all([
    client.query(`SELECT name FROM schema_migrations WHERE name=ANY($1::text[])`, [FINGERPRINT_MIGRATIONS]),
    client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.keys(FINGERPRINT_COLUMNS)])
  ]);
  const migrationNames = new Set(migrations.rows.map(row => row.name));
  const columnNames = new Map();
  for (const row of columns.rows) {
    if (!columnNames.has(row.table_name)) columnNames.set(row.table_name, new Set());
    columnNames.get(row.table_name).add(row.column_name);
  }
  const missingMigrations = FINGERPRINT_MIGRATIONS.filter(name => !migrationNames.has(name));
  const missingColumns = Object.entries(FINGERPRINT_COLUMNS).flatMap(([table, names]) => names.filter(name => !columnNames.get(table)?.has(name)).map(name => `${table}.${name}`));
  if (missingMigrations.length || missingColumns.length) throw new Error('Refusing import: ParkingOps migration/schema fingerprint is incomplete.');
  return 'verified';
}

async function state(client, locationId) {
  const output = {};
  for (const [name, sql] of Object.entries(SNAPSHOTS)) {
    const rows = (await client.query(sql, [locationId])).rows;
    output[name] = { count: rows.length, checksum: checksum(rows) };
  }
  return output;
}

async function createRecoveryMetadata(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(RECOVERY_SCHEMA)}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${quote(RECOVERY_SCHEMA)}.real_lot_migrations (
    migration_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    rolled_back_at timestamptz, status text NOT NULL CHECK(status IN ('SNAPSHOTTED','COMMITTED','ROLLED_BACK')),
    database_name text NOT NULL, source_commit text NOT NULL, canonical_json_sha256 text NOT NULL,
    location_id bigint NOT NULL, previous_layout jsonb NOT NULL, table_names jsonb NOT NULL,
    before_state jsonb NOT NULL, after_state jsonb, report jsonb NOT NULL DEFAULT '{}'::jsonb
  )`);
}

function snapshotTableName(migrationId, name) {
  return `rli_${migrationId.replace(/[^a-z0-9]/gi, '').slice(-22)}_${name}`.toLowerCase();
}

async function createSnapshot(client, { migrationId, connection, baseline, locationId }) {
  await createRecoveryMetadata(client);
  const tableNames = {};
  const before = await state(client, locationId);
  await client.query('BEGIN');
  try {
    for (const [name, sql] of Object.entries(SNAPSHOTS)) {
      const table = snapshotTableName(migrationId, name);
      tableNames[name] = table;
      await client.query(`CREATE TABLE ${quote(RECOVERY_SCHEMA)}.${quote(table)} AS ${sql}`, [locationId]);
    }
    await client.query(`INSERT INTO ${quote(RECOVERY_SCHEMA)}.real_lot_migrations
      (migration_id,status,database_name,source_commit,canonical_json_sha256,location_id,previous_layout,table_names,before_state)
      VALUES($1,'SNAPSHOTTED',$2,$3,$4,$5,$6,$7,$8)`, [migrationId, connection.database, sourceCommit(), canonicalChecksum(), locationId,
      JSON.stringify({ id: Number(baseline.target.layout.id), name: baseline.target.layout.name, version: Number(baseline.target.layout.version) }),
      JSON.stringify(tableNames), JSON.stringify(before)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  return { tableNames, before };
}

async function canonicalVerification(client, locationId) {
  const layout = (await client.query(`SELECT id,name,version FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'`, [locationId])).rows;
  if (layout.length !== 1 || !String(layout[0].name).startsWith(CANONICAL_PREFIX)) throw new Error('Post-import verification failed: canonical published layout is missing.');
  const spots = (await client.query(`SELECT s.id,s.public_label,s.physical_section,s.parking_use,s.public_bookable,s.classification_state,c.code category_code,e.x,e.y,e.width,e.height,
      e.daily_eligible,e.weekly_eligible,e.monthly_eligible,e.space_public_bookable
    FROM parking_spots s JOIN parking_inventory i ON i.id=s.inventory_id JOIN parking_categories c ON c.id=i.category_id
    LEFT JOIN parking_layout_elements e ON e.parking_spot_id=s.id AND e.layout_id=$2
    WHERE s.location_id=$1 AND s.active ORDER BY s.public_label`, [locationId, layout[0].id])).rows;
  if (spots.length !== EXPECTED_COUNTS.total) throw new Error(`Post-import verification failed: expected ${EXPECTED_COUNTS.total} active spaces, found ${spots.length}.`);
  const labels = new Set(spots.map(space => space.public_label));
  for (const number of [...Array.from({ length: 81 }, (_, i) => i + 10), ...Array.from({ length: 96 }, (_, i) => i + 101), ...Array.from({ length: 8 }, (_, i) => i + 197)]) if (!labels.has(String(number))) throw new Error(`Post-import verification failed: missing physical space ${number}.`);
  for (let number = 91; number <= 100; number += 1) if (labels.has(String(number))) throw new Error(`Post-import verification failed: prohibited space ${number}.`);
  if (labels.size !== spots.length) throw new Error('Post-import verification failed: duplicate physical labels.');
  const expectedByNumber = new Map(importer.spaces.map(space => [String(space.number), space]));
  for (const spot of spots) {
    const expected = expectedByNumber.get(spot.public_label);
    const eligibility = expected && importer.bookingEligibility(expected);
    if (!expected || spot.physical_section !== expected.key || spot.parking_use !== expected.use || Boolean(spot.public_bookable) !== Boolean(expected.publicBookable)
      || spot.classification_state !== (expected.classificationState || 'COMPLETE') || spot.category_code !== expected.category
      || Boolean(spot.daily_eligible) !== eligibility.daily || Boolean(spot.weekly_eligible) !== eligibility.weekly
      || Boolean(spot.monthly_eligible) !== eligibility.monthly || Boolean(spot.space_public_bookable) !== eligibility.customerEligible) {
      throw new Error(`Post-import verification failed: unexpected classification for physical space ${spot.public_label}.`);
    }
  }
  const count = use => spots.filter(space => space.parking_use === use).length;
  const generalTruck = count('CUSTOMER');
  const bobtail = count('CUSTOMER_BOBTAIL');
  const unresolved = count('NEEDS_CLASSIFICATION');
  const tractorOnly = spots.filter(space => space.category_code === 'TRACTOR_ONLY').length;
  const trailerOnly = spots.filter(space => space.category_code === 'TRAILER_ONLY').length;
  if (generalTruck !== EXPECTED_COUNTS.generalTruck || bobtail !== EXPECTED_COUNTS.bobtail || count('SHOP') !== EXPECTED_COUNTS.shop || count('COMPANY') !== EXPECTED_COUNTS.company
    || unresolved !== EXPECTED_COUNTS.unresolved || tractorOnly !== 0 || trailerOnly !== 0) throw new Error('Post-import verification failed: unexpected classification counts.');
  const eligible = spots.filter(space => space.public_bookable && space.classification_state === 'COMPLETE').length;
  if (eligible !== EXPECTED_COUNTS.publicEligible) throw new Error(`Post-import verification failed: expected ${EXPECTED_COUNTS.publicEligible} public spaces, found ${eligible}.`);
  if (spots.some(space => ['SHOP', 'COMPANY'].includes(space.parking_use) && space.public_bookable)) throw new Error('Post-import verification failed: internal space is public.');
  const generic = await client.query(`SELECT count(*)::int count FROM parking_spots WHERE location_id=$1 AND active AND public_label ~ $2`, [locationId, GENERIC_PATTERN]);
  if (Number(generic.rows[0].count)) throw new Error('Post-import verification failed: active generic spaces remain.');
  for (const spot of spots) {
    for (const value of ['x', 'y', 'width', 'height']) if (!Number.isFinite(Number(spot[value]))) throw new Error(`Post-import verification failed: missing geometry for ${spot.public_label}.`);
    if (Number(spot.x) < 0 || Number(spot.y) < 0 || Number(spot.width) <= 0 || Number(spot.height) <= 0 || Number(spot.x) + Number(spot.width) > 100 || Number(spot.y) + Number(spot.height) > 100) throw new Error(`Post-import verification failed: invalid geometry for ${spot.public_label}.`);
  }
  for (let index = 0; index < spots.length; index += 1) for (let other = index + 1; other < spots.length; other += 1) {
    const a = spots[index], b = spots[other];
    if (Number(a.x) < Number(b.x) + Number(b.width) && Number(a.x) + Number(a.width) > Number(b.x) && Number(a.y) < Number(b.y) + Number(b.height) && Number(a.y) + Number(a.height) > Number(b.y)) throw new Error(`Post-import verification failed: overlap ${a.public_label}/${b.public_label}.`);
  }
  return { layout: { id: Number(layout[0].id), name: layout[0].name, version: Number(layout[0].version) }, activeSpaces: spots.length,
    classifications: { generalTruck, bobtail, shop: count('SHOP'), company: count('COMPANY'), unresolved, tractorOnly, trailerOnly }, publicEligible: eligible };
}

async function canonicalBaseline(client, canonicalLayoutId) {
  const result = await client.query(`SELECT l.id layout_id,l.name layout_name,l.version,l.location_id,loc.name location_name,
      (SELECT count(*)::int FROM parking_spots s WHERE s.location_id=l.location_id AND s.active AND s.public_label ~ '^[0-9]+$') numeric_spaces,
      (SELECT count(*)::int FROM parking_spots s WHERE s.location_id=l.location_id AND s.active AND s.public_label ~ $2) active_generic_spaces,
      (SELECT count(DISTINCT e.parking_spot_id)::int FROM parking_layout_elements e WHERE e.layout_id=l.id AND e.element_type='PARKING_SPOT' AND e.active) mapped_spaces
    FROM parking_lot_layouts l JOIN parking_locations loc ON loc.id=l.location_id
    WHERE l.id=$1 AND l.status='PUBLISHED'`, [canonicalLayoutId, GENERIC_PATTERN]);
  if (!result.rowCount) throw new Error('Refusing production classification update: canonical published layout disappeared during preflight.');
  const target = result.rows[0];
  const labels = (await client.query(`SELECT public_label FROM parking_spots WHERE location_id=$1 AND active AND public_label ~ '^[0-9]+$' ORDER BY public_label`, [target.location_id])).rows.map(row => row.public_label);
  const expected = new Set(importer.spaces.map(space => String(space.number)));
  if (Number(target.numeric_spaces) !== EXPECTED_COUNTS.total || Number(target.active_generic_spaces) !== 0 || Number(target.mapped_spaces) !== EXPECTED_COUNTS.total
    || labels.length !== expected.size || labels.some(label => !expected.has(label))) {
    throw new Error('Refusing production classification update: active canonical inventory or geometry baseline is not the audited 185-space lot.');
  }
  return { tables: importer.REQUIRED_PRODUCTION_TABLES, target: { kind: 'canonical', location: { id: Number(target.location_id), name: target.location_name }, layout: { id: Number(target.layout_id), name: target.layout_name, version: Number(target.version) } } };
}

async function audit(client, connection) {
  assertMaintenanceOff(); await schemaCheck(client); const fingerprint = await schemaFingerprint(client); importer.assertLayout();
  const identity = (await client.query('SELECT current_database() database')).rows[0];
  if (identity.database !== connection.database) throw new Error('Connected database name does not match DATABASE_URL.');
  if (/^ifta_db$/i.test(identity.database)) throw new Error('Refusing the local IFTA database.');
  const canonical = await client.query(`SELECT id FROM parking_lot_layouts WHERE name LIKE $1 AND status='PUBLISHED'`, [`${CANONICAL_PREFIX}%`]);
  if (canonical.rowCount > 1) throw new Error('Refusing import: multiple canonical published layouts are ambiguous.');
  if (canonical.rowCount) {
    const baseline = await canonicalBaseline(client, canonical.rows[0].id);
    importer.validateConnectedTarget(identity, { expectedDatabase: connection.database, productionTarget: true }, baseline);
    try {
      return { mode: 'NO_OP', database: connection.database, connectedDatabase: identity.database, fingerprint, canonical: await canonicalVerification(client, baseline.target.location.id) };
    } catch (error) {
      return { mode: 'RECLASSIFY', database: connection.database, connectedDatabase: identity.database, fingerprint, baseline, locationId: baseline.target.location.id, previousLayout: baseline.target.layout, reason: importer.redactSecrets(error.message) };
    }
  }
  const baseline = await importer.readProductionBaseline(client);
  importer.validateConnectedTarget(identity, { expectedDatabase: connection.database, productionTarget: true }, baseline);
  const locationId = baseline.target.location.id;
  const generic = await client.query(`SELECT public_label FROM parking_spots WHERE location_id=$1 AND active AND public_label ~ $2 ORDER BY public_label`, [locationId, GENERIC_PATTERN]);
  if (generic.rowCount !== 25 || !importer.hasExpectedGenericLabels(generic.rows)) throw new Error('Refusing import: active generic-space baseline is not the audited 25-space map.');
  return { mode: 'IMPORT', database: connection.database, connectedDatabase: identity.database, fingerprint, baseline, locationId: Number(locationId), activeGeneric: generic.rows.map(row => row.public_label) };
}

function targetDiagnostic(connection, auditResult) {
  return { database: connection.database, connectedDatabase: auditResult.connectedDatabase || connection.database, hostname: connection.hostClassification, schemaFingerprint: auditResult.fingerprint || 'verified' };
}

function testConnection(options) {
  if (!options || !options.connection) return null;
  if (options.testOnly !== true || process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || options.connection.database !== 'parkingops_test') {
    throw new Error('Connection overrides are test-only and require the parkingops_test guard.');
  }
  return options.connection;
}

function poolConfigFor(connection, isTest) {
  return createDatabasePoolConfig(connection.connectionString, { allowLocal: Boolean(isTest) });
}

function poolFor(connection, isTest) {
  return new Pool(poolConfigFor(connection, isTest));
}

async function runImport(options = {}) {
  const override = testConnection(options); const connection = override || parseConnection(); assertMaintenanceOff();
  const pool = poolFor(connection, Boolean(override));
  const client = await pool.connect();
  try {
    if (!(await client.query('SELECT pg_try_advisory_lock($1) locked', [LOCK_KEY])).rows[0].locked) throw new Error('Another real-lot import is already running.');
    const preflight = await audit(client, connection);
    if (preflight.mode === 'NO_OP') return { success: true, noOp: true, target: targetDiagnostic(connection, preflight), ...preflight.canonical };
    const migrationId = `rli_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${crypto.randomBytes(5).toString('hex')}`;
    const recovery = await createSnapshot(client, { migrationId, connection, baseline: preflight.baseline, locationId: preflight.locationId });
    // A dry-run is the same strict baseline audit that the standalone importer uses; no write has occurred after the recovery commit.
    const dryRun = { physicalSpaces: importer.spaces.length, publicEligibleBeforeOperations: EXPECTED_COUNTS.publicEligible, classifications: EXPECTED_COUNTS, genericSpaces: preflight.activeGeneric || [], previousLayout: preflight.baseline.target.layout.name };
    const categories = await client.query('SELECT id,code FROM parking_categories WHERE active');
    const categoryByCode = new Map(categories.rows.map(row => [row.code, row.id]));
    const owner = (await client.query("SELECT id FROM parking_admin_users WHERE role='OWNER' AND active ORDER BY id LIMIT 1")).rows[0];
    if (!owner) throw new Error('Refusing import: an active OWNER is required.');
    const report = { migrationId, dryRun, genericDeactivated: [] };
    await client.query('BEGIN');
    try {
      await importer.applyRealLotTransaction(client, { location: preflight.baseline.target.location, owner, categoryByCode, productionTarget: true, baseline: preflight.baseline, report });
      const verification = await canonicalVerification(client, preflight.locationId);
      const after = await state(client, preflight.locationId);
      await client.query(`UPDATE ${quote(RECOVERY_SCHEMA)}.real_lot_migrations SET status='COMMITTED',completed_at=now(),after_state=$2,report=$3 WHERE migration_id=$1`, [migrationId, JSON.stringify(after), JSON.stringify({ dryRun, verification, importer: report })]);
      await client.query('COMMIT');
      return { success: true, migrationId, target: targetDiagnostic(connection, preflight), previousLayout: preflight.baseline.target.layout, previousState: recovery.before, dryRun, ...verification, rollback: `npm run production:rollback-real-lot -- --migration-id ${migrationId}` };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } finally { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) {} client.release(); await pool.end(); }
}

async function runAudit(options = {}) {
  const override = testConnection(options); const connection = override || parseConnection();
  const pool = poolFor(connection, Boolean(override));
  const client = await pool.connect();
  try {
    if (!(await client.query('SELECT pg_try_advisory_lock($1) locked', [LOCK_KEY])).rows[0].locked) throw new Error('Another real-lot import is already running.');
    const result = await audit(client, connection);
    return result.mode === 'NO_OP' ? { success: true, noOp: true, target: targetDiagnostic(connection, result), ...result.canonical } : { success: true, dryRun: true, target: targetDiagnostic(connection, result), previousLayout: result.baseline.target.layout, activeGeneric: result.activeGeneric || [], canonicalSpaces: importer.spaces.length, expectedCounts: EXPECTED_COUNTS, publicEligibleBeforeOperations: EXPECTED_COUNTS.publicEligible };
  } finally { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) {} client.release(); await pool.end(); }
}

async function columns(client, table) {
  return (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map(row => row.column_name);
}
async function restoreRows(client, table, backup, { locationId, key = 'id', filter = null } = {}) {
  const names = (await columns(client, table)).filter(name => name !== key);
  const assignments = names.map(name => `${quote(name)}=b.${quote(name)}`).join(',');
  await client.query(`UPDATE ${quote(table)} t SET ${assignments} FROM ${quote(RECOVERY_SCHEMA)}.${quote(backup)} b WHERE t.${quote(key)}=b.${quote(key)}`);
  if (filter) await client.query(filter.deleteSql, [locationId]);
}
async function rollback(migrationId, options = {}) {
  if (!migrationId) throw new Error('--migration-id is required.');
  const override = testConnection(options); const connection = override || parseConnection(); assertMaintenanceOff();
  const pool = poolFor(connection, Boolean(override)); const client = await pool.connect();
  try {
    if (!(await client.query('SELECT pg_try_advisory_lock($1) locked', [LOCK_KEY])).rows[0].locked) throw new Error('Another real-lot import is already running.');
    await createRecoveryMetadata(client);
    const record = (await client.query(`SELECT * FROM ${quote(RECOVERY_SCHEMA)}.real_lot_migrations WHERE migration_id=$1 FOR UPDATE`, [migrationId])).rows[0];
    if (!record || record.status !== 'COMMITTED' || record.database_name !== connection.database) throw new Error('Rollback migration is unavailable for this database.');
    const live = await state(client, record.location_id);
    if (checksum(live) !== checksum(record.after_state)) throw new Error('Refusing rollback: later operational or structural changes were detected.');
    const names = record.table_names;
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('parking.layout_publication','on',true)");
      // A guarded rollback has already verified the database identity, the
      // durable recovery snapshot, and that no later changes occurred. This
      // transaction-local flag lets the canonical area-only trigger restore
      // the pre-import location row before the imported layout is removed.
      await client.query("SELECT set_config('parking.real_lot_rollback','on',true)");
      await client.query(`DELETE FROM parking_layout_elements e USING parking_lot_layouts l WHERE e.layout_id=l.id AND l.location_id=$1`, [record.location_id]);
      await restoreRows(client, 'parking_locations', names.location);
      await restoreRows(client, 'parking_zones', names.zones);
      await restoreRows(client, 'parking_inventory', names.inventory);
      // The new published snapshot must be removed before restoring the old
      // published row, otherwise the one-published-layout partial index would
      // reject the rollback midway through its transaction.
      await client.query(`UPDATE parking_lot_layouts
        SET superseded_by_layout_id=id
        WHERE location_id=$1 AND status='SUPERSEDED'`, [record.location_id]);
      await client.query(`DELETE FROM parking_lot_layouts l WHERE l.location_id=$1 AND NOT EXISTS (SELECT 1 FROM ${quote(RECOVERY_SCHEMA)}.${quote(names.layouts)} b WHERE b.id=l.id)`, [record.location_id]);
      await restoreRows(client, 'parking_lot_layouts', names.layouts);
      await client.query(`DELETE FROM parking_spots s WHERE s.location_id=$1 AND NOT EXISTS (SELECT 1 FROM ${quote(RECOVERY_SCHEMA)}.${quote(names.spots)} b WHERE b.id=s.id)`, [record.location_id]);
      await restoreRows(client, 'parking_spots', names.spots);
      await client.query(`DELETE FROM parking_inventory i USING parking_zones z WHERE i.zone_id=z.id AND z.location_id=$1 AND NOT EXISTS (SELECT 1 FROM ${quote(RECOVERY_SCHEMA)}.${quote(names.inventory)} b WHERE b.id=i.id)`, [record.location_id]);
      await client.query(`DELETE FROM parking_zones z WHERE z.location_id=$1 AND NOT EXISTS (SELECT 1 FROM ${quote(RECOVERY_SCHEMA)}.${quote(names.zones)} b WHERE b.id=z.id)`, [record.location_id]);
      await restoreRows(client, 'parking_area_directions', names.directions);
      await client.query(`DELETE FROM parking_area_directions d WHERE d.location_id=$1 AND NOT EXISTS (SELECT 1 FROM ${quote(RECOVERY_SCHEMA)}.${quote(names.directions)} b WHERE b.id=d.id)`, [record.location_id]);
      await client.query(`INSERT INTO parking_layout_elements SELECT * FROM ${quote(RECOVERY_SCHEMA)}.${quote(names.elements)} ORDER BY id`);
      const restored = await state(client, record.location_id);
      if (checksum(restored) !== checksum(record.before_state)) throw new Error('Rollback verification failed: restored state differs from the recovery snapshot.');
      await client.query(`UPDATE ${quote(RECOVERY_SCHEMA)}.real_lot_migrations SET status='ROLLED_BACK',rolled_back_at=now() WHERE migration_id=$1`, [migrationId]);
      await client.query('COMMIT'); return { success: true, migrationId, target: { database: connection.database, hostname: connection.hostClassification }, restored: true };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } finally { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) {} client.release(); await pool.end(); }
}

function sanitized(result) { return JSON.stringify(result, null, 2); }
async function main(argv = process.argv.slice(2)) {
  const rollbackIndex = argv.indexOf('--rollback'); const migrationIndex = argv.indexOf('--migration-id');
  const result = rollbackIndex >= 0 ? await rollback(migrationIndex >= 0 ? argv[migrationIndex + 1] : null) : argv.includes('--audit') ? await runAudit() : await runImport();
  console.log(sanitized(result));
}
module.exports = { classifyHost, parseConnection, poolConfigFor, assertMaintenanceOff, schemaCheck, schemaFingerprint, state, audit, createSnapshot, canonicalVerification, canonicalBaseline, runAudit, runImport, rollback, EXPECTED_COUNTS };
if (require.main === module) main().catch(error => { console.error(`Production real-lot runner failed: ${importer.redactSecrets(error.message)}`); process.exitCode = 1; });
