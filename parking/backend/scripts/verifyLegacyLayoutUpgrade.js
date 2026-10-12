/* PostgreSQL 18 disposable-database verifier for the legacy-to-current upgrade. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const importer = require('./importTruckerHeavenRealLot');

const databaseUrl = String(process.env.PARKING_DATABASE_URL || '');
if (!databaseUrl.includes('parkingops_test')) throw new Error('Refusing legacy upgrade verification outside parkingops_test.');
const pool = new Pool({ connectionString: databaseUrl });
const labels = [...importer.LEGACY_GENERIC_LABELS].sort();
const key = value => `le_${crypto.createHash('md5').update(`upgrade-fixture:${value}`).digest('hex')}`;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function applyMigrations(files) {
  for (const name of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (done.rowCount) continue;
    await pool.query('BEGIN');
    try {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8'));
      await pool.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await pool.query('COMMIT');
    } catch (error) { await pool.query('ROLLBACK'); throw error; }
  }
}

async function snapshot(locationId, layoutId, bookingId, assignmentId) {
  const [location, zones, spots, layout, elements, booking, assignment] = await Promise.all([
    pool.query('SELECT id,name,address,timezone FROM parking_locations WHERE id=$1', [locationId]),
    pool.query('SELECT id,name,active,public_visible FROM parking_zones WHERE location_id=$1 ORDER BY id', [locationId]),
    pool.query(`SELECT id,public_label,zone_id,inventory_id,active,visual_element_key FROM parking_spots
      WHERE location_id=$1 ORDER BY public_label`, [locationId]),
    pool.query('SELECT id,name,status,version,published_at FROM parking_lot_layouts WHERE id=$1', [layoutId]),
    pool.query(`SELECT id,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active
      FROM parking_layout_elements WHERE layout_id=$1 ORDER BY id`, [layoutId]),
    pool.query('SELECT id,assigned_spot_label,status,inventory_id,location_id,category_id,tractor_unit_number FROM parking_bookings WHERE id=$1', [bookingId]),
    pool.query('SELECT id,booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,released_at FROM reservation_spot_assignments WHERE id=$1', [assignmentId])
  ]);
  return { location: location.rows[0], zones: zones.rows, spots: spots.rows, layout: layout.rows[0], elements: elements.rows, booking: booking.rows[0], assignment: assignment.rows[0] };
}

async function expectReject(query) {
  await assert.rejects(query, /immutable/);
}

(async () => {
  const all = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const legacy = all.filter(name => Number(name.slice(0, 3)) <= 15);
  const immutable = all.filter(name => Number(name.slice(0, 3)) >= 16 && Number(name.slice(0, 3)) <= 19);
  assert.equal((await pool.query("SELECT to_regclass('public.parking_locations') relation")).rows[0].relation, null, 'use a fresh parkingops_test database');
  await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await applyMigrations(legacy);
  const categories = await pool.query(`INSERT INTO parking_categories(code,name,active) VALUES
    ('TRACTOR_TRAILER','Tractor Trailer',true),('BOBTAIL','Bobtail',true) RETURNING id,code`);
  const categoryByCode = new Map(categories.rows.map(row => [row.code, row.id]));
  const owner = (await pool.query("INSERT INTO parking_admin_users(username,password_hash,role,active) VALUES('upgrade-fixture-owner','not-used','OWNER',true) RETURNING id")).rows[0];
  const location = (await pool.query("INSERT INTO parking_locations(name,address,timezone,assignment_mode,exact_mode_active,self_service_enabled) VALUES('South Zone','1 Upgrade Way','America/Chicago','EXACT_SPOT',true,true) RETURNING *")).rows[0];
  const north = (await pool.query("INSERT INTO parking_zones(location_id,name,description,active,public_visible) VALUES($1,'North Zone','Legacy north',true,true) RETURNING *", [location.id])).rows[0];
  const south = (await pool.query("INSERT INTO parking_zones(location_id,name,description,active,public_visible) VALUES($1,'South  Zone','Legacy south whitespace',true,true) RETURNING *", [location.id])).rows[0];
  const inventory = new Map();
  for (const zone of [north, south]) for (const code of ['TRACTOR_TRAILER', 'BOBTAIL']) {
    const row = (await pool.query('INSERT INTO parking_inventory(zone_id,category_id,capacity,active) VALUES($1,$2,25,true) RETURNING *', [zone.id, categoryByCode.get(code)])).rows[0];
    inventory.set(`${zone.id}:${code}`, row);
  }
  const old = (await pool.query("INSERT INTO parking_lot_layouts(location_id,name,status,version,published_at,created_by_admin_user_id,updated_by_admin_user_id) VALUES($1,'North Zone layout','PUBLISHED',4,now(),$2,$2) RETURNING *", [location.id, owner.id])).rows[0];
  const generic = new Map();
  for (const [index, label] of labels.entries()) {
    const zone = label.startsWith('N-') ? north : south;
    const inv = inventory.get(`${zone.id}:TRACTOR_TRAILER`);
    const visualKey = key(`spot:${label}`);
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,true,'LEGACY','CUSTOMER',false,'COMPLETE') RETURNING *`, [location.id, zone.id, inv.id, label, index, visualKey])).rows[0];
    generic.set(label, spot);
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,3,3,0,10,true,true)`, [old.id, visualKey, label, zone.id, inv.id, spot.id, (index % 8) * 5, Math.floor(index / 8) * 5]);
  }
  const booking = (await pool.query(`INSERT INTO parking_bookings(reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,arrival_at,departure_at,first_name,last_name,mobile_phone,email,tractor_unit_number,license_plate,license_plate_state,assigned_zone_id,assigned_spot_label,terms_accepted_at,cancellation_terms_accepted_at)
    VALUES('UPGRADE-HISTORY-1','upgrade-public','upgrade-lookup',$1,$2,$3,'COMPLETED','2030-01-01T12:00:00Z','2030-01-02T12:00:00Z','Historic','Driver','+15555550100','upgrade@example.test','UPGRADE-1','UPG1','TN',$4,'N-01',now(),now()) RETURNING *`, [inventory.get(`${north.id}:TRACTOR_TRAILER`).id, location.id, categoryByCode.get('TRACTOR_TRAILER'), north.id])).rows[0];
  const assignment = (await pool.query(`INSERT INTO reservation_spot_assignments(booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source,released_at,release_reason)
    VALUES($1,$2,'2030-01-01T12:00:00Z','2030-01-02T12:00:00Z','2030-01-02T12:00:00Z','SYSTEM',now(),'completed fixture') RETURNING *`, [booking.id, generic.get('N-01').id])).rows[0];
  const before = await snapshot(location.id, old.id, booking.id, assignment.id);
  assert.equal(before.elements.length, 25);
  assert.equal(before.elements.filter(element => element.parking_spot_id).length, 25);
  await applyMigrations(immutable);
  const after = await snapshot(location.id, old.id, booking.id, assignment.id);
  assert.equal(hash(after), hash(before), '016–019 must not rewrite legacy history');
  assert.equal(after.layout.status, 'PUBLISHED');
  assert.equal(Number(after.layout.version), 4);
  await expectReject(() => pool.query('UPDATE parking_lot_layouts SET name=$1 WHERE id=$2', ['mutated', old.id]));
  await expectReject(() => pool.query('UPDATE parking_lot_layouts SET version=99 WHERE id=$1', [old.id]));
  await expectReject(() => pool.query('DELETE FROM parking_lot_layouts WHERE id=$1', [old.id]));
  await expectReject(() => pool.query('UPDATE parking_layout_elements SET label=$1 WHERE id=$2', ['mutated', before.elements[0].id]));
  await expectReject(() => pool.query('DELETE FROM parking_layout_elements WHERE id=$1', [before.elements[0].id]));
  // The importer is current application code and intentionally depends on the
  // current draft-classification and rate-plan schema. Preserve the 016–019
  // hash assertion above, then finish the schema upgrade before invoking it.
  await applyMigrations(all.filter(name => Number(name.slice(0, 3)) >= 20));
  const report = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await importer.applyRealLotTransaction(client, { location, owner, categoryByCode, productionTarget: true,
      baseline: { target: { location, zones: { north, south }, layout: old } }, report });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const finalLayouts = await pool.query('SELECT id,status,version FROM parking_lot_layouts WHERE location_id=$1 ORDER BY version', [location.id]);
  const current = finalLayouts.rows.find(row => row.status === 'PUBLISHED');
  assert.equal((await pool.query("SELECT count(*)::int count FROM parking_spots WHERE location_id=$1 AND public_label ~ '^[0-9]+$' AND active", [location.id])).rows[0].count, 185);
  assert.equal((await pool.query("SELECT count(*)::int count FROM parking_spots WHERE location_id=$1 AND public_label ~ '^[NS]-[0-9]+$' AND active", [location.id])).rows[0].count, 0);
  const expectedElements = importer.spaces.length + importer.data.elements.length;
  assert.equal((await pool.query('SELECT count(*)::int count FROM parking_layout_elements WHERE layout_id=$1', [current.id])).rows[0].count, expectedElements);
  assert.equal((await pool.query('SELECT count(*)::int count FROM parking_layout_elements WHERE layout_id=$1 AND element_type=$2', [current.id, 'PARKING_SPOT'])).rows[0].count, 185);
  assert.equal((await pool.query('SELECT status FROM parking_lot_layouts WHERE id=$1', [old.id])).rows[0].status, 'SUPERSEDED');
  assert.equal(String((await pool.query('SELECT parking_spot_id FROM reservation_spot_assignments WHERE id=$1', [assignment.id])).rows[0].parking_spot_id), String(generic.get('N-01').id));
  await applyMigrations(all);
  console.log(JSON.stringify({ database: 'parkingops_test', preUpgrade: { layoutId: Number(old.id), version: 4, elements: 25, parkingElements: 25, hash: hash(before) }, postUpgrade: { preserved: true }, postImport: { publishedLayoutId: Number(current.id), elements: expectedElements, numericSpaces: 185 }, replay: 'no-op', invalidUpgradeFixture: 'Pre-016 constraints prevent a second published layout; no unrealistic invalid state was fabricated.' }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
