/*
 * Read-only parking-model audit and guarded rollback for migration 032.
 * The default action is an audit.  Rollback restores only rows captured by
 * 032 and never deletes reservations, assignments, audit events, or geometry.
 */
const fs = require('fs');
const { Pool } = require('pg');
const { parsePostgresUrl, createDatabasePoolConfig } = require('../databaseConnection');

require('dotenv').config();

const MIGRATION_KEY = '032_daily_monthly_model';
const ROLLBACK_CONFIRMATION = 'ROLLBACK_032_PARKING_MODEL';

function optionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function options(argv = process.argv.slice(2), env = process.env) {
  const parsed = { rollback: false, production: false, expectedDatabase: null, databaseUrlFile: null, confirmation: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--audit') continue;
    if (arg === '--rollback') { parsed.rollback = true; continue; }
    if (arg === '--production') { parsed.production = true; continue; }
    if (arg === '--expected-database') { parsed.expectedDatabase = optionValue(argv, index, arg); index += 1; continue; }
    if (arg === '--database-url-file') { parsed.databaseUrlFile = optionValue(argv, index, arg); index += 1; continue; }
    if (arg === '--confirm-rollback') { parsed.confirmation = optionValue(argv, index, arg); index += 1; continue; }
    throw new Error('Usage: node scripts/auditParkingManagementModel.js [--audit|--rollback] [--expected-database name] [--database-url-file path] [--production] [--confirm-rollback ROLLBACK_032_PARKING_MODEL]');
  }
  let connectionString = String(env.DATABASE_URL || '').trim();
  if (parsed.databaseUrlFile) connectionString = fs.readFileSync(parsed.databaseUrlFile, 'utf8').trim();
  const identity = parsePostgresUrl(connectionString);
  parsed.expectedDatabase ||= identity.database;
  if (identity.database !== parsed.expectedDatabase) throw new Error('Connected database name does not match --expected-database.');
  if (parsed.production && identity.hostClassification === 'local-or-service-alias') throw new Error('Production audit requires a remote PostgreSQL target.');
  if (parsed.production && !parsed.databaseUrlFile) throw new Error('Production audit requires --database-url-file.');
  if (parsed.rollback && parsed.production && parsed.confirmation !== ROLLBACK_CONFIRMATION) throw new Error('Production rollback requires the exact --confirm-rollback value.');
  if (parsed.rollback && !parsed.production && parsed.confirmation && parsed.confirmation !== ROLLBACK_CONFIRMATION) throw new Error('Rollback confirmation value is invalid.');
  return { ...parsed, connectionString, hostClassification: identity.hostClassification };
}

async function canonicalLocation(client) {
  const result = await client.query(`SELECT DISTINCT location.id,location.name
    FROM parking_locations location
    JOIN parking_lot_layouts layout ON layout.location_id=location.id
    WHERE layout.name LIKE 'Trucker Heaven physical lot%'
    ORDER BY location.id`);
  if (result.rowCount !== 1) throw new Error(`Expected one canonical Trucker Heaven location; found ${result.rowCount}.`);
  return result.rows[0];
}

async function audit(client) {
  const location = await canonicalLocation(client);
  const [migration, counts, terms, access, vehicle, reservations, duplicates, invalid, orphans, conflicts, entrance] = await Promise.all([
    client.query('SELECT name,applied_at FROM schema_migrations WHERE name=$1', ['032_parking_management_model.sql']),
    client.query(`SELECT count(*)::int total,
        count(*) FILTER (WHERE active)::int active,
        count(*) FILTER (WHERE active AND public_bookable)::int active_customer,
        count(*) FILTER (WHERE active AND public_bookable AND public_label ~ '^[0-9]+$'
          AND public_label::int BETWEEN 110 AND 148)::int daily_number_range
      FROM parking_spots WHERE location_id=$1`, [location.id]),
    client.query(`SELECT
        count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.daily_eligible)::int daily,
        count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.monthly_eligible)::int monthly,
        count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.daily_eligible AND element.monthly_eligible)::int both,
        count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND NOT element.daily_eligible AND NOT element.monthly_eligible)::int neither,
        count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.daily_eligible
          AND NOT (spot.public_label ~ '^[0-9]+$' AND spot.public_label::int BETWEEN 110 AND 148))::int daily_outside_range,
        count(*) FILTER (WHERE element.active AND element.parking_purpose='CUSTOMER' AND element.monthly_eligible
          AND spot.public_label ~ '^[0-9]+$' AND spot.public_label::int BETWEEN 110 AND 148)::int monthly_inside_range
      FROM parking_lot_layouts layout
      JOIN parking_layout_elements element ON element.layout_id=layout.id
      JOIN parking_spots spot ON spot.id=element.parking_spot_id
      WHERE layout.location_id=$1 AND layout.status='PUBLISHED'`, [location.id]),
    client.query(`SELECT COALESCE(element.parking_purpose,'UNSET') access,count(*)::int count
      FROM parking_lot_layouts layout JOIN parking_layout_elements element ON element.layout_id=layout.id
      WHERE layout.location_id=$1 AND layout.status='PUBLISHED' AND element.parking_spot_id IS NOT NULL
      GROUP BY COALESCE(element.parking_purpose,'UNSET') ORDER BY access`, [location.id]),
    client.query(`SELECT category.code vehicle_type,count(*)::int count
      FROM parking_lot_layouts layout JOIN parking_layout_elements element ON element.layout_id=layout.id
      JOIN parking_inventory inventory ON inventory.id=element.inventory_id
      JOIN parking_categories category ON category.id=inventory.category_id
      WHERE layout.location_id=$1 AND layout.status='PUBLISHED' AND element.parking_spot_id IS NOT NULL
      GROUP BY category.code ORDER BY category.code`, [location.id]),
    client.query(`SELECT count(*)::int total,
        count(*) FILTER (WHERE status IN ('CONFIRMED','CHECKED_IN'))::int active_or_future,
        count(*) FILTER (WHERE parking_product='DAILY')::int daily,
        count(*) FILTER (WHERE parking_product='MONTHLY')::int monthly,
        count(*) FILTER (WHERE parking_product='LEGACY')::int legacy,
        count(assignment.id)::int assignment_relationships
      FROM parking_bookings booking
      LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id
      WHERE booking.location_id=$1`, [location.id]),
    client.query(`SELECT lower(trim(public_label)) label,count(*)::int count
      FROM parking_spots WHERE location_id=$1 GROUP BY lower(trim(public_label)) HAVING count(*)>1`, [location.id]),
    client.query(`SELECT id,public_label FROM parking_spots WHERE location_id=$1 AND active
      AND (trim(public_label)='' OR public_label !~ '^[0-9]+$') ORDER BY id`, [location.id]),
    client.query(`SELECT assignment.id FROM reservation_spot_assignments assignment
      LEFT JOIN parking_bookings booking ON booking.id=assignment.booking_id
      LEFT JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
      WHERE booking.id IS NULL OR spot.id IS NULL`),
    client.query(`SELECT id,parking_spot_id,booking_id,conflict_code,details,detected_at
      FROM parking_configuration_conflicts WHERE migration_key=$1 AND location_id=$2 AND status='OPEN'
      ORDER BY detected_at,id`, [MIGRATION_KEY,location.id]),
    client.query(`WITH published AS (
        SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'
      ), gap AS (
        SELECT min(x) x,max(y+height) FILTER (WHERE spot.public_label='143') upper_edge,
          min(y) FILTER (WHERE spot.public_label='142') lower_edge
        FROM parking_layout_elements element JOIN parking_spots spot ON spot.id=element.parking_spot_id
        WHERE element.layout_id=(SELECT id FROM published) AND spot.public_label IN ('142','143')
      ), access AS (
        SELECT x,y,width,height,label FROM parking_layout_elements
        WHERE layout_id=(SELECT id FROM published) AND element_type IN ('ENTRANCE','EXIT') AND active
        ORDER BY CASE element_type WHEN 'ENTRANCE' THEN 0 ELSE 1 END,id LIMIT 1
      ) SELECT access.*,gap.upper_edge,gap.lower_edge,
        (access.y>=gap.upper_edge AND access.y+access.height<=gap.lower_edge) between_143_142
      FROM access CROSS JOIN gap`, [location.id])
  ]);
  return {
    location: { id: Number(location.id), name: location.name },
    migration: migration.rows[0] || null,
    counts: counts.rows[0], bookingTerms: terms.rows[0], access: access.rows, vehicleTypes: vehicle.rows,
    reservations: reservations.rows[0], duplicateLabels: duplicates.rows, invalidLabels: invalid.rows,
    orphanedAssignments: orphans.rows, conflicts: conflicts.rows, sharedAccessPoint: entrance.rows[0] || null
  };
}

async function rollback(client) {
  const location = await canonicalLocation(client);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [location.id]);
    await client.query("SELECT set_config('parking.layout_publication','on',true)");
    await client.query('SET CONSTRAINTS parking_spots_location_id_public_label_key DEFERRED');
    const restoredElements = await client.query(`UPDATE parking_layout_elements current SET
        label=s.before_state->>'label',parking_purpose=s.before_state->>'parking_purpose',
        daily_eligible=(s.before_state->>'daily_eligible')::boolean,
        weekly_eligible=(s.before_state->>'weekly_eligible')::boolean,
        monthly_eligible=(s.before_state->>'monthly_eligible')::boolean,
        space_public_bookable=(s.before_state->>'space_public_bookable')::boolean,
        x=(s.before_state->>'x')::numeric,y=(s.before_state->>'y')::numeric,
        width=(s.before_state->>'width')::numeric,height=(s.before_state->>'height')::numeric,
        rotation=(s.before_state->>'rotation')::numeric,version=current.version+1,updated_at=now()
      FROM parking_management_migration_snapshots s
      WHERE s.migration_key=$1 AND s.entity_type='LAYOUT_ELEMENT' AND current.id=s.entity_id
      RETURNING current.id`, [MIGRATION_KEY]);
    const restoredZones = await client.query(`UPDATE parking_zones current SET
        name=s.before_state->>'name',description=s.before_state->>'description',version=current.version+1
      FROM parking_management_migration_snapshots s
      WHERE s.migration_key=$1 AND s.entity_type='ZONE' AND current.id=s.entity_id RETURNING current.id`, [MIGRATION_KEY]);
    await client.query(`UPDATE parking_locations current SET name=s.before_state->>'name',version=current.version+1,updated_at=now()
      FROM parking_management_migration_snapshots s
      WHERE s.migration_key=$1 AND s.entity_type='LOCATION' AND current.id=s.entity_id`, [MIGRATION_KEY]);
    const restoredDirections = await client.query(`UPDATE parking_area_directions current SET
        entrance_element_key=s.before_state->>'entrance_element_key',exit_element_key=s.before_state->>'exit_element_key',
        arrival_route_element_keys=ARRAY(SELECT jsonb_array_elements_text(s.before_state->'arrival_route_element_keys')),
        exit_route_element_keys=ARRAY(SELECT jsonb_array_elements_text(s.before_state->'exit_route_element_keys')),
        version=current.version+1,updated_at=now()
      FROM parking_management_migration_snapshots s
      WHERE s.migration_key=$1 AND s.entity_type='AREA_DIRECTIONS' AND current.id=s.entity_id RETURNING current.id`, [MIGRATION_KEY]);
    await client.query(`UPDATE parking_configuration_conflicts SET status='RESOLVED',resolved_at=now()
      WHERE migration_key=$1 AND location_id=$2 AND status='OPEN'`, [MIGRATION_KEY,location.id]);
    await client.query('COMMIT');
    return { locationId: Number(location.id), restoredLayoutElements: restoredElements.rowCount,
      restoredZones: restoredZones.rowCount, restoredDirections: restoredDirections.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const input = options(argv, env);
  const pool = new Pool(createDatabasePoolConfig(input.connectionString, { allowLocal: !input.production }));
  try {
    const identity = (await pool.query('SELECT current_database() database,current_schema() schema')).rows[0];
    const result = input.rollback ? await rollback(pool) : await audit(pool);
    process.stdout.write(`${JSON.stringify({ target: identity, mode: input.rollback ? 'rollback' : 'audit', result }, null, 2)}\n`);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { MIGRATION_KEY, ROLLBACK_CONFIRMATION, options, canonicalLocation, audit, rollback };
