const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');
const importer = require('../scripts/importTruckerHeavenRealLot');
const runner = require('../scripts/runProductionRealLotImport');
const liveLotReadModel = require('../services/liveLotReadModel');
const canonicalLayoutMaintenance = require('../services/canonicalLayoutMaintenance');
const { canonicalPublicCategories } = require('../services/canonicalLot');
const { catalogCategoryOffers } = require('../services/publicProductDiscovery');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing real-lot importer PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}
const testDatabase = new URL(process.env.PARKING_DATABASE_URL).pathname.slice(1);

const fixtureName = 'South Zone';
const labels = [...importer.LEGACY_GENERIC_LABELS].sort();
const elementKey = value => `le_${crypto.createHash('md5').update(`importer-fixture:${value}`).digest('hex')}`;

async function resetFixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('parking.layout_publication','on',true)");
    await client.query("SELECT set_config('session_replication_role','replica',true)");
    // Other focused integration fixtures can leave a canonical-looking layout in the
    // shared parkingops_test database. Archive those test-only names so this runner
    // always audits the baseline created below, just as it would in an isolated DB.
    await client.query(`UPDATE parking_lot_layouts SET name='Archived test layout · ' || id
      WHERE name LIKE 'Trucker Heaven physical lot · %'`);
    const found = await client.query('SELECT id FROM parking_locations WHERE name=$1 FOR UPDATE', [fixtureName]);
    for (const foundLocation of found.rows) {
      const locationId = foundLocation.id;
      await client.query('DELETE FROM reservation_spot_assignments WHERE parking_spot_id IN (SELECT id FROM parking_spots WHERE location_id=$1)', [locationId]);
      await client.query('DELETE FROM parking_spot_blocks WHERE parking_spot_id IN (SELECT id FROM parking_spots WHERE location_id=$1)', [locationId]);
      await client.query('DELETE FROM parking_bookings WHERE location_id=$1', [locationId]);
      await client.query('DELETE FROM parking_layout_elements WHERE layout_id IN (SELECT id FROM parking_lot_layouts WHERE location_id=$1)', [locationId]);
      await client.query('DELETE FROM parking_lot_layouts WHERE location_id=$1', [locationId]);
      await client.query('DELETE FROM parking_spots WHERE location_id=$1', [locationId]);
      await client.query('DELETE FROM parking_rate_rules WHERE location_id=$1', [locationId]);
      await client.query('DELETE FROM parking_inventory WHERE zone_id IN (SELECT id FROM parking_zones WHERE location_id=$1)', [locationId]);
      await client.query('DELETE FROM parking_zones WHERE location_id=$1', [locationId]);
      await client.query('DELETE FROM parking_locations WHERE id=$1', [locationId]);
    }
    const categories = await client.query(`SELECT id,code FROM parking_categories WHERE code IN ('TRACTOR_TRAILER','BOBTAIL') AND active`);
    assert.equal(categories.rowCount, 2, 'development seed must provide real-lot categories');
    const categoryByCode = new Map(categories.rows.map(row => [row.code, row.id]));
    const owner = (await client.query(`INSERT INTO parking_admin_users(username,password_hash,role,active)
      VALUES('real-lot-import-test-owner','not-used','OWNER',true)
      ON CONFLICT(username) DO UPDATE SET role='OWNER',active=true RETURNING id`)).rows[0];
    const location = (await client.query(`INSERT INTO parking_locations(name,public_description,address,timezone,assignment_mode,exact_mode_active,self_service_enabled)
      VALUES($1,'Legacy real-lot import fixture','1 Import Way','America/Chicago','EXACT_SPOT',true,true) RETURNING *`, [fixtureName])).rows[0];
    for (const code of ['TRACTOR_TRAILER', 'BOBTAIL']) await client.query(`INSERT INTO parking_rate_rules
      (location_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,fee_cents,tax_basis_points,priority,active)
      VALUES($1,$2,'Standard Parking',1900,10000,$3,0,0,0,true)`,
    [location.id, categoryByCode.get(code), code === 'BOBTAIL' ? 15000 : 25000]);
    const north = (await client.query(`INSERT INTO parking_zones(location_id,name,description,active,public_visible)
      VALUES($1,'North Zone','Legacy north',true,true) RETURNING *`, [location.id])).rows[0];
    const south = (await client.query(`INSERT INTO parking_zones(location_id,name,description,active,public_visible)
      VALUES($1,'South  Zone','Legacy south whitespace',true,true) RETURNING *`, [location.id])).rows[0];
    const inventory = new Map();
    for (const zone of [north, south]) for (const code of ['TRACTOR_TRAILER', 'BOBTAIL']) {
      const row = (await client.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity,active)
        VALUES($1,$2,25,'Legacy generic fixture',true,true) RETURNING *`, [zone.id, categoryByCode.get(code)])).rows[0];
      inventory.set(`${zone.id}:${code}`, row);
    }
    const old = (await client.query(`INSERT INTO parking_lot_layouts(location_id,name,status,version,published_at,created_by_admin_user_id,updated_by_admin_user_id)
      VALUES($1,'North Zone layout','PUBLISHED',4,now(),$2,$2) RETURNING *`, [location.id, owner.id])).rows[0];
    const generic = new Map();
    for (const label of labels) {
      const zone = label.startsWith('N-') ? north : south;
      const inv = inventory.get(`${zone.id}:TRACTOR_TRAILER`);
      const spot = (await client.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
        VALUES($1,$2,$3,$4,$5,$6,true,'LEGACY','CUSTOMER',false,'COMPLETE') RETURNING *`, [location.id, zone.id, inv.id, label, Number(label.slice(2)), elementKey(`spot:${label}`)])).rows[0];
      generic.set(label, spot);
      await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active)
        VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,3,3,0,10,true,true)`, [old.id, spot.visual_element_key, label, zone.id, inv.id, spot.id, (generic.size % 8) * 5, Math.floor(generic.size / 8) * 5]);
    }
    const booking = (await client.query(`INSERT INTO parking_bookings(reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,assignment_mode_snapshot,arrival_at,departure_at,first_name,last_name,mobile_phone,email,tractor_unit_number,license_plate,license_plate_state,assigned_zone_id,assigned_spot_label,terms_accepted_at,cancellation_terms_accepted_at)
      VALUES('IMPORT-HISTORY-1','history-public-token','history-lookup',$1,$2,$3,'COMPLETED','EXACT_SPOT','2030-01-01T12:00:00Z','2030-01-02T12:00:00Z','Historic','Driver','+15555550100','historic@example.test','HISTORY-1','HIST1','TN',$4,'N-01',now(),now()) RETURNING *`, [inventory.get(`${north.id}:TRACTOR_TRAILER`).id, location.id, categoryByCode.get('TRACTOR_TRAILER'), north.id])).rows[0];
    const assignment = (await client.query(`INSERT INTO reservation_spot_assignments(booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source,released_at,release_reason)
      VALUES($1,$2,'2030-01-01T12:00:00Z','2030-01-02T12:00:00Z','2030-01-02T12:00:00Z','SYSTEM',now(),'completed fixture') RETURNING *`, [booking.id, generic.get('N-01').id])).rows[0];
    await client.query('COMMIT');
    return { location, north, south, owner, old, generic, booking, assignment, categoryByCode,
      baseline: { target: { kind: 'legacy', location, zones: { north, south }, layout: old } } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function importCombined(fixture, onStep = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await importer.applyRealLotTransaction(client, {
      location: fixture.location, owner: fixture.owner, categoryByCode: fixture.categoryByCode,
      productionTarget: true, baseline: fixture.baseline, report: {}, onStep
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function withOwnerApi(fixture, callback) {
  const username = `parking-management-owner-${Date.now()}`;
  const password = 'Parking-management-integration-2036';
  await pool.query('UPDATE parking_admin_users SET username=$1,password_hash=$2,role=\'OWNER\',active=true WHERE id=$3',
    [username, await bcrypt.hash(password, 4), fixture.owner.id]);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }) });
    const loginBody = await login.json();
    assert.equal(login.status, 200, JSON.stringify(loginBody));
    const auth = { cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: loginBody.csrfToken };
    const request = (path, { method = 'GET', body } = {}) => fetch(`${base}/api/admin/parking/v1${path}`, {
      method, headers: { cookie: auth.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': auth.csrfToken }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return await callback(request);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function baselineState(fixture) {
  const [spots, zones, layouts, elements, booking, assignment] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE public_label ~ '^[0-9]+$')::int numeric,
      count(*) FILTER (WHERE public_label ~ '^[NS]-[0-9]+$' AND active)::int generic_active,
      count(*) FILTER (WHERE public_label ~ '^[NS]-[0-9]+$')::int generic_total FROM parking_spots WHERE location_id=$1`, [fixture.location.id]),
    pool.query('SELECT name,public_visible FROM parking_zones WHERE location_id=$1 ORDER BY id', [fixture.location.id]),
    pool.query('SELECT id,status,version FROM parking_lot_layouts WHERE location_id=$1 ORDER BY id', [fixture.location.id]),
    pool.query('SELECT label,x,y,width,height FROM parking_layout_elements WHERE layout_id=$1 ORDER BY id', [fixture.old.id]),
    pool.query('SELECT assigned_spot_label,status FROM parking_bookings WHERE id=$1', [fixture.booking.id]),
    pool.query('SELECT parking_spot_id,released_at FROM reservation_spot_assignments WHERE id=$1', [fixture.assignment.id])
  ]);
  return { spots: spots.rows[0], zones: zones.rows, layouts: layouts.rows, elements: elements.rows, booking: booking.rows[0], assignment: assignment.rows[0] };
}

function numericRange(numbers, from, to) { return numbers.filter(number => number >= from && number <= to).length; }

test.after(async () => {
  await resetFixture();
  await pool.end();
});

test('combined production-like real-lot import commits 185 physical spaces, immutable publication, and generic history', async () => {
  const fixture = await resetFixture();
  const before = await baselineState(fixture);
  const result = await importCombined(fixture);
  assert.equal(result.publication.previous.id, fixture.old.id);
  const catalog = await catalogCategoryOffers(pool, fixture.location.id, await canonicalPublicCategories(pool, fixture.location.id));
  const general = catalog.find(category => category.code === 'TRACTOR_TRAILER');
  const bobtail = catalog.find(category => category.code === 'BOBTAIL');
  assert.deepEqual(general.offeredDurations.map(item => item.code), ['DAILY', 'WEEKLY', 'MONTHLY']);
  assert.deepEqual(general.offeredDurations, [
    { code: 'DAILY', unitRateCents: 1900 },
    { code: 'WEEKLY', unitRateCents: 10000 },
    { code: 'MONTHLY', unitRateCents: 25000 }
  ]);
  assert.deepEqual(bobtail.offeredDurations, [
    { code: 'DAILY', unitRateCents: 1900 },
    { code: 'WEEKLY', unitRateCents: 10000 },
    { code: 'MONTHLY', unitRateCents: 15000 }
  ]);
  const current = await baselineState(fixture);
  assert.equal(current.spots.numeric, 185);
  assert.equal(current.spots.generic_total, 25);
  assert.equal(current.spots.generic_active, 0);
  assert.equal(current.booking.assigned_spot_label, 'N-01');
  assert.equal(String(current.assignment.parking_spot_id), String(fixture.generic.get('N-01').id));
  assert.deepEqual((await pool.query('SELECT label,x,y,width,height FROM parking_layout_elements WHERE layout_id=$1 ORDER BY id', [fixture.old.id])).rows, before.elements);
  const numbers = (await pool.query("SELECT public_label::int number FROM parking_spots WHERE location_id=$1 AND public_label ~ '^[0-9]+$' ORDER BY 1", [fixture.location.id])).rows.map(row => row.number);
  assert.equal(numbers.length, 185);
  assert.equal(numericRange(numbers, 10, 90), 81);
  assert.equal(numericRange(numbers, 101, 196), 96);
  assert.equal(numericRange(numbers, 197, 204), 8);
  assert.equal(numbers.filter(number => number >= 91 && number <= 100).length, 0);
  const classifiedRows = await pool.query("SELECT public_label,parking_use,public_bookable,classification_state FROM parking_spots WHERE location_id=$1 AND ((CASE WHEN public_label ~ '^[0-9]+$' THEN public_label::int END) BETWEEN 73 AND 80 OR (CASE WHEN public_label ~ '^[0-9]+$' THEN public_label::int END) BETWEEN 197 AND 204)", [fixture.location.id]);
  assert.equal(classifiedRows.rowCount, 16);
  assert.ok(classifiedRows.rows.filter(row => Number(row.public_label) <= 80).every(row => row.parking_use === 'SHOP' && !row.public_bookable && row.classification_state === 'COMPLETE'));
  assert.ok(classifiedRows.rows.filter(row => Number(row.public_label) >= 197).every(row => row.parking_use === 'CUSTOMER' && row.public_bookable && row.classification_state === 'COMPLETE'));
  const internal = await pool.query("SELECT public_label,parking_use,public_bookable FROM parking_spots WHERE location_id=$1 AND ((CASE WHEN public_label ~ '^[0-9]+$' THEN public_label::int END) BETWEEN 68 AND 90 OR (CASE WHEN public_label ~ '^[0-9]+$' THEN public_label::int END) BETWEEN 101 AND 109)", [fixture.location.id]);
  assert.ok(internal.rows.filter(row => Number(row.public_label) <= 90).every(row => row.parking_use === 'SHOP' && !row.public_bookable));
  assert.ok(internal.rows.filter(row => Number(row.public_label) >= 101).every(row => row.parking_use === 'COMPANY' && !row.public_bookable));
  const layouts = await pool.query('SELECT id,status,version,superseded_by_layout_id FROM parking_lot_layouts WHERE location_id=$1 ORDER BY version', [fixture.location.id]);
  const snapshots = layouts.rows.filter(row => row.status !== 'DRAFT');
  assert.deepEqual(snapshots.map(row => row.status), ['SUPERSEDED', 'PUBLISHED']);
  assert.ok(Number(snapshots[1].version) > 4);
  assert.equal(String(snapshots[0].superseded_by_layout_id), String(snapshots[1].id));
  const elementCounts = await pool.query(`SELECT count(*)::int total,count(*) FILTER (WHERE element_type='PARKING_SPOT')::int spaces,
    count(*) FILTER (WHERE parking_spot_id IN (SELECT id FROM parking_spots WHERE location_id=$1 AND NOT active))::int inactive_refs
    FROM parking_layout_elements WHERE layout_id=$2`, [fixture.location.id, snapshots[1].id]);
  assert.deepEqual(elementCounts.rows[0], { total: importer.spaces.length + importer.data.elements.length, spaces: importer.spaces.length, inactive_refs: 0 });
  const canonicalDraft = (await pool.query("SELECT id FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT'", [fixture.location.id])).rows[0];
  assert.equal(await canonicalLayoutMaintenance.structuralChanges(pool, canonicalDraft.id, fixture.location.id), false);
  const structuralClient = await pool.connect();
  try {
    await structuralClient.query('BEGIN');
    await structuralClient.query(`UPDATE parking_layout_elements SET x=x+0.01
      WHERE id=(SELECT id FROM parking_layout_elements WHERE layout_id=$1 ORDER BY id LIMIT 1)`, [canonicalDraft.id]);
    assert.equal(await canonicalLayoutMaintenance.structuralChanges(structuralClient, canonicalDraft.id, fixture.location.id), true);
    await structuralClient.query('ROLLBACK');
  } finally { structuralClient.release(); }
  assert.ok(current.zones.filter(row => ['North Zone', 'South  Zone'].includes(row.name)).every(row => !row.public_visible));
  await assert.rejects(() => importCombined(fixture), /already transformed/);
});

test('canonical reclassification keeps compatible checked-in legacy assignments on the same physical space', async () => {
  const fixture = await resetFixture();
  await importCombined(fixture);
  const published = (await pool.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'", [fixture.location.id])).rows[0];
  const target = (await pool.query("SELECT * FROM parking_spots WHERE location_id=$1 AND public_label='198'", [fixture.location.id])).rows[0];
  const bobtailTarget = (await pool.query("SELECT * FROM parking_spots WHERE location_id=$1 AND public_label='10'", [fixture.location.id])).rows[0];
  const oldInventory = (await pool.query(`SELECT inventory.id,zone.id zone_id,category.id category_id
    FROM parking_inventory inventory
    JOIN parking_zones zone ON zone.id=inventory.zone_id
    JOIN parking_categories category ON category.id=inventory.category_id
    WHERE zone.location_id=$1 AND zone.name='Bobtail Parking' AND category.code='BOBTAIL' AND inventory.active`, [fixture.location.id])).rows[0];
  const client = await pool.connect();
  let booking; let bobtailBooking;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('session_replication_role','replica',true)");
    await client.query("UPDATE parking_spots SET zone_id=$1,inventory_id=$2,parking_use='CUSTOMER_BOBTAIL' WHERE id=$3",
      [oldInventory.zone_id, oldInventory.id, target.id]);
    await client.query('UPDATE parking_layout_elements SET zone_id=$1,inventory_id=$2 WHERE layout_id=$3 AND parking_spot_id=$4',
      [oldInventory.zone_id, oldInventory.id, published.id, target.id]);
    booking = (await client.query(`INSERT INTO parking_bookings(
        reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
        arrival_at,departure_at,actual_arrival_at,first_name,last_name,mobile_phone,email,tractor_unit_number,
        license_plate,license_plate_state,assigned_zone_id,assigned_spot_label,terms_accepted_at,
        cancellation_terms_accepted_at,assignment_mode_snapshot,parking_product,payment_status)
      VALUES($1,$2,'legacy-rebind-hash',$3,$4,$5,'CHECKED_IN',now()-interval '1 day','2099-12-31',now()-interval '1 day',
        'Legacy','Rebind','+16155550198','legacy.rebind@example.test','LEG-198','LEG198','TN',$6,'198',now(),now(),
        'EXACT_SPOT','LEGACY','NOT_REQUIRED') RETURNING *`, [`LEGACY-REBIND-${Date.now()}`, `legacy-rebind-token-${Date.now()}`,
    oldInventory.id, fixture.location.id, oldInventory.category_id, oldInventory.zone_id])).rows[0];
    await client.query(`INSERT INTO reservation_spot_assignments(
        booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source)
      VALUES($1,$2,$3,$4,'2099-12-31','SYSTEM')`, [booking.id, target.id, booking.arrival_at, booking.departure_at]);
    await client.query('INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)',
      [booking.id, JSON.stringify({ duration: 'IN_PERSON', unitRateCents: 25000, quantity: 1, totalCents: 25000, currency: 'USD' })]);
    await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
      VALUES($1,'CHECKED_IN','SYSTEM','Legacy canonical rebind fixture',1)`, [booking.id]);
    bobtailBooking = (await client.query(`INSERT INTO parking_bookings(
        reservation_number,public_token,lookup_credential_hash,inventory_id,location_id,category_id,status,
        arrival_at,departure_at,actual_arrival_at,first_name,last_name,mobile_phone,email,tractor_unit_number,
        license_plate,license_plate_state,assigned_zone_id,assigned_spot_label,terms_accepted_at,
        cancellation_terms_accepted_at,assignment_mode_snapshot,parking_product,payment_status)
      VALUES($1,$2,'legacy-bobtail-hash',$3,$4,$5,'CHECKED_IN',now()-interval '1 day','2099-12-31',now()-interval '1 day',
        'Legacy','Bobtail','+16155550010','legacy.bobtail@example.test','LEG-010','LEG010','TN',$6,'10',now(),now(),
        'EXACT_SPOT','LEGACY','NOT_REQUIRED') RETURNING *`, [`LEGACY-BOBTAIL-${Date.now()}`, `legacy-bobtail-token-${Date.now()}`,
    bobtailTarget.inventory_id, fixture.location.id, oldInventory.category_id, bobtailTarget.zone_id])).rows[0];
    await client.query(`INSERT INTO reservation_spot_assignments(
        booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assignment_source)
      VALUES($1,$2,$3,$4,'2099-12-31','SYSTEM')`, [bobtailBooking.id, bobtailTarget.id, bobtailBooking.arrival_at, bobtailBooking.departure_at]);
    await client.query('INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)',
      [bobtailBooking.id, JSON.stringify({ duration: 'IN_PERSON', unitRateCents: 15000, quantity: 1, totalCents: 15000, currency: 'USD' })]);
    await client.query(`INSERT INTO parking_booking_status_history(booking_id,new_status,actor_type,reason,version)
      VALUES($1,'CHECKED_IN','SYSTEM','Legacy Bobtail capacity fixture',1)`, [bobtailBooking.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }

  const result = await importCombined({ ...fixture, baseline: { target: { kind: 'canonical', location: fixture.location, layout: published } } });
  assert.deepEqual(result.report.legacyBookingsRebound, [{ bookingId: Number(booking.id), space: '198' }]);
  const after = (await pool.query(`SELECT booking.inventory_id,booking.category_id,booking.assigned_zone_id,
      booking.assigned_spot_label,assignment.parking_spot_id,spot.inventory_id spot_inventory,
      inventory.category_id spot_category,snapshot.snapshot
    FROM parking_bookings booking
    JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
    JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
    JOIN parking_inventory inventory ON inventory.id=spot.inventory_id
    JOIN parking_booking_price_snapshots snapshot ON snapshot.booking_id=booking.id
    WHERE booking.id=$1`, [booking.id])).rows[0];
  assert.equal(String(after.inventory_id), String(after.spot_inventory));
  assert.equal(String(after.category_id), String(after.spot_category));
  assert.equal(String(after.parking_spot_id), String(target.id));
  assert.equal(after.assigned_spot_label, '198');
  assert.deepEqual(after.snapshot, { duration: 'IN_PERSON', currency: 'USD', quantity: 1, totalCents: 25000, unitRateCents: 25000 });
  const preservedBobtail = (await pool.query(`SELECT booking.inventory_id,spot.inventory_id spot_inventory,
      assignment.parking_spot_id,booking.assigned_spot_label
    FROM parking_bookings booking
    JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
    JOIN parking_spots spot ON spot.id=assignment.parking_spot_id WHERE booking.id=$1`, [bobtailBooking.id])).rows[0];
  assert.equal(String(preservedBobtail.inventory_id), String(preservedBobtail.spot_inventory));
  assert.equal(String(preservedBobtail.parking_spot_id), String(bobtailTarget.id));
  assert.equal(preservedBobtail.assigned_spot_label, '10');
});

test('canonical Live Lot excludes superseded generic spaces and reports only actionable configuration warnings', async () => {
  const fixture = await resetFixture();
  await importCombined(fixture);
  const view = await liveLotReadModel.snapshot(pool, fixture.location.id, new Date().toISOString());
  assert.deepEqual(view.summary, {
    physicalSpaces: 185, customerSpaces: 153, availableCustomerSpaces: 153,
    dailyAvailable: 97, monthlyAvailable: 114, dailyPhysical: 97, monthlyPhysical: 114,
    publiclyBookable: 153, generalTruck: 95, bobtail: 58, internalUse: 32, unresolved: 0,
    reserved: 0, occupied: 0, blocked: 0, inactive: 0, configurationIssues: 0
  });
  assert.equal(view.spaces.length, 185);
  assert.equal(view.spaces.filter(space => /^N-|^S-/.test(space.number)).length, 0);
  assert.equal(view.warnings.length, 0);
  const company = view.spaces.find(space => space.number === '109');
  assert.deepEqual({ parkingUse: company.parkingUse, publicBookable: company.publicBookable, classificationState: company.classificationState, warnings: company.warnings },
    { parkingUse: 'COMPANY', publicBookable: false, classificationState: 'COMPLETE', warnings: [] });
  const shop = view.spaces.find(space => space.number === '73');
  assert.deepEqual({ parkingUse: shop.parkingUse, publicBookable: shop.publicBookable, classificationState: shop.classificationState },
    { parkingUse: 'SHOP', publicBookable: false, classificationState: 'COMPLETE' });
  const mapNumbers = view.layout.elements.filter(item => item.spaceId).map(item => String(item.label));
  assert.equal(mapNumbers.length, 185);
  assert.equal(new Set(mapNumbers).size, 185);
  assert.ok(!mapNumbers.some(number => Number(number) >= 91 && Number(number) <= 100));
  assert.ok(!mapNumbers.some(number => /^N-|^S-/.test(number)));
  const search = await liveLotReadModel.search(pool, fixture.location.id, 'N-');
  assert.equal(search.spaces.length, 0);
});

test('direct and bulk parking management edits are versioned, validated, previewable, and auditable', async () => {
  const fixture = await resetFixture();
  await importCombined(fixture);
  await pool.query("UPDATE parking_locations SET name='Trucker Heaven Parking' WHERE id=$1", [fixture.location.id]);
  try {
    await withOwnerApi(fixture, async request => {
      const spots = (await pool.query("SELECT id,public_label FROM parking_spots WHERE location_id=$1 AND public_label=ANY($2::text[])",
        [fixture.location.id, ['111','149','150','165']])).rows;
      const byLabel = new Map(spots.map(row => [row.public_label, row]));
      assert.equal(byLabel.size, 4);

      const direct = await request(`/spaces/${byLabel.get('165').id}/configuration`, { method: 'PATCH', body: {
        vehicleType: 'BOBTAIL', bookingTerm: 'MONTHLY', access: 'CUSTOMER', controlState: 'ACTIVE',
        internalNotes: 'Parking-management integration test', changeReason: 'Verify stable direct edit'
      } });
      const directBody = await direct.json();
      assert.equal(direct.status, 200, JSON.stringify(directBody));
      assert.equal(directBody.item.spotId, Number(byLabel.get('165').id));
      assert.deepEqual({ vehicleType: directBody.item.after.vehicleType, bookingTerm: directBody.item.after.bookingTerm },
        { vehicleType: 'BOBTAIL', bookingTerm: 'MONTHLY' });
      assert.equal(directBody.review.summary.spacesChanged, 1);

      const invalidTerm = await request(`/spaces/${byLabel.get('111').id}/configuration`, { method: 'PATCH', body: {
        bookingTerm: 'MONTHLY', changeReason: 'Expected validation failure'
      } });
      assert.equal(invalidTerm.status, 409);
      assert.equal((await invalidTerm.json()).error.code, 'SPACE_TERM_NUMBER_MISMATCH');

      const preview = await request('/spaces/bulk-preview', { method: 'POST', body: {
        spaceIds: [byLabel.get('149').id, byLabel.get('150').id], changes: { vehicleType: 'BOBTAIL' }
      } });
      const previewBody = await preview.json();
      assert.equal(preview.status, 200, JSON.stringify(previewBody));
      assert.equal(previewBody.preview, true);
      assert.equal(previewBody.items.length, 2);
      const previewPersisted = await pool.query(`SELECT category.code FROM parking_layout_elements element
        JOIN parking_lot_layouts layout ON layout.id=element.layout_id
        JOIN parking_inventory inventory ON inventory.id=element.inventory_id
        JOIN parking_categories category ON category.id=inventory.category_id
        WHERE layout.location_id=$1 AND layout.status='DRAFT' AND element.parking_spot_id=ANY($2::bigint[])`,
      [fixture.location.id, [byLabel.get('149').id, byLabel.get('150').id]]);
      assert.ok(previewPersisted.rows.every(row => row.code === 'TRACTOR_TRAILER'), 'preview must roll back every proposed write');

      const applied = await request('/spaces/bulk-configuration', { method: 'PATCH', body: {
        spaceIds: [byLabel.get('149').id, byLabel.get('150').id], changes: { vehicleType: 'BOBTAIL' }
      } });
      const appliedBody = await applied.json();
      assert.equal(applied.status, 200, JSON.stringify(appliedBody));
      assert.equal(appliedBody.preview, false);
      assert.equal(appliedBody.review.validation.ready, true);
      assert.deepEqual(appliedBody.review.summary.dailyCapacity, { before: 97, after: 97 });
      assert.equal(appliedBody.review.summary.spacesChanged, 3);
      const audits = await pool.query("SELECT count(*)::int count FROM parking_audit_events WHERE action IN ('UPDATE_DRAFT_SPACE','BULK_UPDATE_DRAFT_SPACES') AND admin_user_id=$1", [fixture.owner.id]);
      assert.equal(audits.rows[0].count, 4);
    });
  } finally {
    await pool.query("UPDATE parking_locations SET name=$1 WHERE id=$2", [fixtureName, fixture.location.id]);
  }
});

test('every importer checkpoint rolls back the full production-like transformation', async () => {
  const checkpoints = ['after_physical_spaces_created', 'after_classifications_written', 'after_generic_spaces_deactivated', 'after_legacy_zones_hidden', 'after_layout_snapshot_created', 'after_layout_elements_inserted', 'after_previous_layout_superseded', 'after_new_layout_published', 'before_commit'];
  for (const checkpoint of checkpoints) {
    const fixture = await resetFixture();
    const before = await baselineState(fixture);
    await assert.rejects(() => importCombined(fixture, step => { if (step === checkpoint) throw new Error(`IMPORT_ROLLBACK_${checkpoint}`); }), new RegExp(`IMPORT_ROLLBACK_${checkpoint}`));
    assert.deepEqual(await baselineState(fixture), before, checkpoint);
  }
});

test('concurrent production-like imports serialize to one complete transformation and a clean loser', async () => {
  const fixture = await resetFixture();
  const outcomes = await Promise.allSettled([importCombined(fixture), importCombined(fixture)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && /already transformed/.test(result.reason.message)).length, 1);
  const state = await baselineState(fixture);
  assert.equal(state.spots.numeric, 185);
  assert.equal(state.spots.generic_active, 0);
  const snapshots = state.layouts.filter(row => row.status !== 'DRAFT');
  assert.deepEqual(snapshots.map(row => row.status), ['SUPERSEDED', 'PUBLISHED']);
  assert.equal(new Set(snapshots.map(row => row.version)).size, 2);
});

test('production runner recovery snapshot is durable before a failed import and validates the committed canonical map', async () => {
  const fixture = await resetFixture();
  const client = await pool.connect();
  const migrationId = `runner_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const snapshot = await runner.createSnapshot(client, { migrationId, connection: { database: testDatabase }, baseline: fixture.baseline, locationId: fixture.location.id });
    assert.equal(snapshot.before.spots.count, 25);
    await assert.rejects(() => importCombined(fixture, step => { if (step === 'after_physical_spaces_created') throw new Error('runner rollback fixture'); }), /runner rollback fixture/);
    const durable = await pool.query(`SELECT status,before_state->'spots'->>'count' count FROM parkingops_real_lot_recovery.real_lot_migrations WHERE migration_id=$1`, [migrationId]);
    assert.deepEqual(durable.rows[0], { status: 'SNAPSHOTTED', count: '25' });
    await importCombined(fixture);
    await client.query('BEGIN');
    const verified = await runner.canonicalVerification(client, fixture.location.id);
    await client.query('COMMIT');
    assert.equal(verified.activeSpaces, 185);
    assert.equal(verified.publicEligible, 153);
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
  }
});

test('production runner rejects an altered baseline, is a no-op after import, and performs a guarded exact rollback', async () => {
  let fixture = await resetFixture();
  const options = { testOnly: true, connection: { connectionString: process.env.PARKING_DATABASE_URL, database: testDatabase, host: 'postgres-test' } };
  await pool.query("UPDATE parking_spots SET public_label='N-X' WHERE id=$1", [fixture.generic.get('N-01').id]);
  await assert.rejects(() => runner.runAudit(options), /recognizable ParkingOps legacy baseline/);

  fixture = await resetFixture();
  const before = await baselineState(fixture);
  const audit = await runner.runAudit(options);
  assert.equal(audit.dryRun, true);
  assert.equal(audit.activeGeneric.length, 25);

  const imported = await runner.runImport(options);
  assert.equal(imported.success, true);
  assert.equal(imported.activeSpaces, 185);
  assert.equal(imported.publicEligible, 153);
  const metadata = await pool.query(`SELECT status,canonical_json_sha256,after_state IS NOT NULL committed
    FROM parkingops_real_lot_recovery.real_lot_migrations WHERE migration_id=$1`, [imported.migrationId]);
  assert.equal(metadata.rows[0].status, 'COMMITTED');
  assert.match(metadata.rows[0].canonical_json_sha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.rows[0].committed, true);
  const noop = await runner.runImport(options);
  assert.equal(noop.noOp, true);

  const rolledBack = await runner.rollback(imported.migrationId, options);
  assert.equal(rolledBack.restored, true);
  assert.deepEqual(await baselineState(fixture), before);
});
