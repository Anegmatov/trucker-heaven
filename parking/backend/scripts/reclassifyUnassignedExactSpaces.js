require('dotenv').config();

const pool = require('../db');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function wholeNumber(value, name) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive database ID`);
  return Number(value);
}

(async () => {
  const apply = process.env.PARKING_REPAIR_APPLY === 'true';
  if (apply && process.env.PARKING_REPAIR_CONFIRM !== 'RECLASSIFY_UNASSIGNED_EXACT_SPACES') {
    throw new Error('Set PARKING_REPAIR_CONFIRM=RECLASSIFY_UNASSIGNED_EXACT_SPACES before applying this repair');
  }
  const locationId = wholeNumber(required('PARKING_REPAIR_LOCATION_ID'), 'PARKING_REPAIR_LOCATION_ID');
  const zoneId = wholeNumber(required('PARKING_REPAIR_ZONE_ID'), 'PARKING_REPAIR_ZONE_ID');
  const fromCode = required('PARKING_REPAIR_FROM_CATEGORY').toUpperCase();
  const toCode = required('PARKING_REPAIR_TO_CATEGORY').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,62}$/.test(fromCode) || !/^[A-Z][A-Z0-9_]{1,62}$/.test(toCode) || fromCode === toCode) {
    throw new Error('Source and target categories must be different valid category codes');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [zoneId]);
    const inventories = await client.query(`SELECT i.id,c.code
      FROM parking_inventory i JOIN parking_zones z ON z.id=i.zone_id
      JOIN parking_categories c ON c.id=i.category_id
      WHERE z.id=$1 AND z.location_id=$2 AND c.code=ANY($3::text[])
      FOR UPDATE OF i`, [zoneId, locationId, [fromCode, toCode]]);
    const source = inventories.rows.find(item => item.code === fromCode);
    const target = inventories.rows.find(item => item.code === toCode);
    if (!source || !target) throw new Error('Both source and target category inventory must exist in the selected parking area');

    const candidates = await client.query(`SELECT id FROM parking_spots
      WHERE location_id=$1 AND zone_id=$2 AND inventory_id=$3 AND active
      FOR UPDATE`, [locationId, zoneId, source.id]);
    if (!candidates.rowCount) throw new Error('No active, history-free numbered spaces matched the requested source category');
    const history = await client.query(`SELECT count(*)::int count
      FROM reservation_spot_assignments
      WHERE parking_spot_id=ANY($1::bigint[])`, [candidates.rows.map(row => row.id)]);
    if (history.rows[0].count) throw new Error('Refusing to reclassify spaces with exact-space assignment history; create replacement spaces instead');
    if (!apply) {
      await client.query('ROLLBACK');
      console.log(`Dry run: ${candidates.rowCount} history-free exact spaces would move from ${fromCode} to ${toCode}. Set PARKING_REPAIR_APPLY=true and the confirmation value to apply.`);
      return;
    }
    const moved = await client.query(`UPDATE parking_spots SET inventory_id=$1,version=version+1,updated_at=now()
      WHERE location_id=$2 AND zone_id=$3 AND inventory_id=$4 AND active
      RETURNING id`, [target.id, locationId, zoneId, source.id]);
    await client.query(`UPDATE parking_layout_elements SET inventory_id=$1,version=version+1
      WHERE parking_spot_id=ANY($2::bigint[])`, [target.id, moved.rows.map(row => row.id)]);
    await client.query('COMMIT');
    console.log(`Reclassified ${moved.rowCount} history-free exact spaces from ${fromCode} to ${toCode}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error(`Exact-space category repair failed: ${error.message}`);
  process.exit(1);
});
