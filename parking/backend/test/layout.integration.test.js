const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');
const { publishDraftSnapshot } = require('../services/layoutPublication');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing layout PostgreSQL tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

let server;
let base;
let locationId;
let publicLocationId;
let zoneId;
let inventoryId;
let categoryCode;
let otherLocationId;
let otherZoneId;
let otherInventoryId;
const password = 'ParkingOps-layout-test-password-2031';

function publicGet(path) {
  return fetch(`${base}/api/public/parking/v1${path}`);
}

async function createAdmin(username, role) {
  const passwordHash = await bcrypt.hash(password, 4);
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,$3,true,0,NULL)
    ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,active=true,failed_login_count=0,locked_until=NULL`, [username, passwordHash, role]);
}

async function loginAs(username) {
  const response = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const user = await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [username]);
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken, userId: user.rows[0].id };
}

function adminRequest(path, session, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = session.csrfToken;
  return fetch(`${base}/api/admin/parking/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function element(overrides = {}) {
  return {
    element_type: 'PARKING_SPOT', label: 'North 1', zone_id: zoneId, inventory_id: inventoryId,
    x: 10, y: 15, width: 12, height: 8, rotation: 0, layer_order: 2, public_visible: true, active: true,
    ...overrides
  };
}

async function createDraft(session, name = 'Main layout') {
  const response = await adminRequest(`/locations/${locationId}/layout`, session, { method: 'POST', body: { name } });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.draft;
}

async function createDraftAt(session, targetLocationId, name = 'Main layout') {
  const response = await adminRequest(`/locations/${targetLocationId}/layout`, session, { method: 'POST', body: { name } });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.draft;
}

async function addElement(session, draft, overrides = {}) {
  const response = await adminRequest(`/layouts/${draft.id}/elements`, session, {
    method: 'POST', body: { layout_version: draft.version, ...element(overrides) }
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

test.before(async () => {
  const category = await pool.query("SELECT id,code FROM parking_categories WHERE code='BOBTAIL'");
  assert.equal(category.rowCount, 1, 'load the development seed before layout integration tests');
  const primary = await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone)
    VALUES('Layout Primary Location','Layout test location','1 Layout Way','America/Chicago')
    ON CONFLICT(name) DO UPDATE SET address=EXCLUDED.address RETURNING id,public_id`);
  locationId = primary.rows[0].id;
  publicLocationId = primary.rows[0].public_id;
  const primaryZone = await pool.query(`INSERT INTO parking_zones(location_id,name,description)
    VALUES($1,'Layout Primary Zone','Layout test zone')
    ON CONFLICT(location_id,name) DO UPDATE SET description=EXCLUDED.description RETURNING id`, [locationId]);
  zoneId = primaryZone.rows[0].id;
  const primaryInventory = await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity)
    VALUES($1,$2,5) ON CONFLICT(zone_id,category_id) DO UPDATE SET capacity=EXCLUDED.capacity RETURNING id`, [zoneId, category.rows[0].id]);
  inventoryId = primaryInventory.rows[0].id;
  categoryCode = category.rows[0].code;
  const other = await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone)
    VALUES('Layout Cross Location','Layout test location','2 Layout Way','America/Chicago')
    ON CONFLICT(name) DO UPDATE SET address=EXCLUDED.address RETURNING id`);
  otherLocationId = other.rows[0].id;
  const otherZone = await pool.query(`INSERT INTO parking_zones(location_id,name,description)
    VALUES($1,'Layout Cross Zone','Cross-location test zone')
    ON CONFLICT(location_id,name) DO UPDATE SET description=EXCLUDED.description RETURNING id`, [otherLocationId]);
  otherZoneId = otherZone.rows[0].id;
  const otherInventory = await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity)
    VALUES($1,$2,5) ON CONFLICT(zone_id,category_id) DO UPDATE SET capacity=EXCLUDED.capacity RETURNING id`, [otherZoneId, category.rows[0].id]);
  otherInventoryId = otherInventory.rows[0].id;
  await createAdmin('layout-test-owner', 'OWNER');
  await createAdmin('layout-test-staff', 'STAFF');
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test.beforeEach(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Test-fixture cleanup uses the same transaction-local bypass reserved for the publisher.
    await client.query("SELECT set_config('parking.layout_publication','on',true)");
    // Disposable fixture reset: row-level audit UPDATE/DELETE remain forbidden.
    await client.query('TRUNCATE parking_audit_events RESTART IDENTITY');
    await client.query('DELETE FROM parking_lot_layouts');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await pool.query('DELETE FROM parking_admin_sessions');
});

test('layout migration is present and repeat-safe migration tracking records it once', async () => {
  const schema = await pool.query(`SELECT to_regclass('public.parking_lot_layouts') layouts,
    to_regclass('public.parking_layout_elements') elements,
    (SELECT count(*)::int FROM schema_migrations WHERE name='012_parking_lot_layouts.sql') migration_count,
    (SELECT count(*)::int FROM schema_migrations WHERE name='016_immutable_layout_publication.sql') immutable_migration_count,
    (SELECT count(*)::int FROM schema_migrations WHERE name='017_fix_immutable_layout_delete_trigger.sql') immutable_trigger_fix_count,
    (SELECT count(*)::int FROM schema_migrations WHERE name='018_remove_legacy_layout_status_check.sql') legacy_check_fix_count,
    (SELECT count(*)::int FROM schema_migrations WHERE name='019_fix_historical_element_immutability.sql') element_trigger_fix_count,
    (SELECT count(*)::int FROM schema_migrations WHERE name='020_draft_space_configuration.sql') draft_space_configuration_migration_count,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='parking_layout_elements' AND column_name='monthly_eligible') monthly_eligibility_column,
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid='parking_lot_layouts'::regclass AND tgname='aaa_parking_layout_history_immutable') layout_trigger_count,
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid='parking_layout_elements'::regclass AND tgname='aaa_parking_historical_layout_elements_immutable') element_trigger_count`);
  assert.equal(schema.rows[0].layouts, 'parking_lot_layouts');
  assert.equal(schema.rows[0].elements, 'parking_layout_elements');
  assert.equal(schema.rows[0].migration_count, 1);
  assert.equal(schema.rows[0].immutable_migration_count, 1);
  assert.equal(schema.rows[0].immutable_trigger_fix_count, 1);
  assert.equal(schema.rows[0].legacy_check_fix_count, 1);
  assert.equal(schema.rows[0].element_trigger_fix_count, 1);
  assert.equal(schema.rows[0].draft_space_configuration_migration_count, 1);
  assert.equal(schema.rows[0].monthly_eligibility_column, true);
  assert.equal(schema.rows[0].layout_trigger_count, 1);
  assert.equal(schema.rows[0].element_trigger_count, 1);
});

test('OWNER creates a draft and STAFF receives PERMISSION_DENIED', async () => {
  const owner = await loginAs('layout-test-owner');
  const staff = await loginAs('layout-test-staff');
  const denied = await adminRequest(`/locations/${locationId}/layout`, staff, { method: 'POST', body: { name: 'Denied' } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'PERMISSION_DENIED');
  const draft = await createDraft(owner);
  assert.equal(draft.status, 'DRAFT');
  assert.equal(Number(draft.version), 1);
});

test('layout elements reject invalid coordinates and dimensions', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner);
  const invalidCoordinate = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: draft.version, ...element({ x: -1 }) }
  });
  assert.equal(invalidCoordinate.status, 400);
  const invalidDimension = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: draft.version, ...element({ width: 0 }) }
  });
  assert.equal(invalidDimension.status, 400);
});

test('layout elements reject cross-location zone and inventory links', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner);
  const wrongZone = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: draft.version, ...element({ zone_id: otherZoneId }) }
  });
  assert.equal(wrongZone.status, 400);
  const wrongInventory = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: draft.version, ...element({ inventory_id: otherInventoryId }) }
  });
  assert.equal(wrongInventory.status, 400);
});

test('layout mutations enforce optimistic layout and element versions', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner);
  const added = await addElement(owner, draft);
  const staleLayout = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: draft.version, ...element({ x: 30 }) }
  });
  assert.equal(staleLayout.status, 409);
  assert.equal((await staleLayout.json()).error.code, 'LAYOUT_VERSION_CONFLICT');
  const staleElement = await adminRequest(`/layouts/${draft.id}/elements/${added.item.id}`, owner, {
    method: 'PATCH', body: { layout_version: added.layoutVersion, version: Number(added.item.version) + 1, label: 'Stale' }
  });
  assert.equal(staleElement.status, 409);
  assert.equal((await staleElement.json()).error.code, 'LAYOUT_ELEMENT_VERSION_CONFLICT');
});

test('drafts stay private and published layouts expose only safe public elements', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner);
  const added = await addElement(owner, draft);
  const privateElement = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: added.layoutVersion, ...element({ x: 30, public_visible: false }) }
  });
  assert.equal(privateElement.status, 201);
  const inactiveElement = await adminRequest(`/layouts/${draft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: (await privateElement.json()).layoutVersion, ...element({ x: 50, active: false }) }
  });
  const afterDraft = await publicGet(`/locations/${publicLocationId}/layout`);
  assert.equal(afterDraft.status, 200);
  assert.equal((await afterDraft.json()).layout, null);
  const publish = await adminRequest(`/layouts/${draft.id}/publish`, owner, {
    method: 'POST', body: { version: (await inactiveElement.json()).layoutVersion }
  });
  assert.equal(publish.status, 200);
  const publicLayout = await publicGet(`/locations/${publicLocationId}/layout`);
  const body = await publicLayout.json();
  assert.equal(publicLayout.status, 200);
  assert.equal(body.layout.elements.length, 1);
  assert.equal(body.layout.elements[0].elementType, 'PARKING_SPOT');
  assert.equal(body.layout.elements[0].inventory.categoryCode, categoryCode);
  assert.ok(!Object.hasOwn(body.layout.elements[0], 'id'));
});

test('transactional publish preserves the previous published layout while a draft is incomplete or edited', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner, 'Published first');
  const added = await addElement(owner, draft, { label: 'Published north' });
  const firstPublish = await adminRequest(`/layouts/${draft.id}/publish`, owner, { method: 'POST', body: { version: added.layoutVersion } });
  assert.equal(firstPublish.status, 200);
  const publishedBefore = await publicGet(`/locations/${publicLocationId}/layout`);
  assert.equal((await publishedBefore.json()).layout.elements[0].label, 'Published north');
  const edit = await adminRequest(`/layouts/${draft.id}/elements/${added.item.id}`, owner, {
    method: 'PATCH', body: { layout_version: 3, version: added.item.version, label: 'Unpublished edit', active: false }
  });
  const edited = await edit.json();
  assert.equal(edit.status, 200, JSON.stringify(edited));
  const whileDraftEdits = await publicGet(`/locations/${publicLocationId}/layout`);
  assert.equal((await whileDraftEdits.json()).layout.elements[0].label, 'Published north');
  const rejectedPublish = await adminRequest(`/layouts/${draft.id}/publish`, owner, { method: 'POST', body: { version: edited.layoutVersion } });
  assert.equal(rejectedPublish.status, 409);
  assert.equal((await rejectedPublish.json()).error.code, 'LAYOUT_INCOMPLETE');
  const afterRejectedPublish = await publicGet(`/locations/${publicLocationId}/layout`);
  assert.equal((await afterRejectedPublish.json()).layout.elements[0].label, 'Published north');
});

test('layout mutations create audit events', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner);
  const added = await addElement(owner, draft);
  const published = await adminRequest(`/layouts/${draft.id}/publish`, owner, { method: 'POST', body: { version: added.layoutVersion } });
  assert.equal(published.status, 200);
  const events = await pool.query(`SELECT action FROM parking_audit_events
    WHERE entity_type IN ('parking_lot_layout','parking_layout_element') ORDER BY id`);
  assert.deepEqual(events.rows.map(row => row.action), ['CREATE_LAYOUT', 'CREATE_LAYOUT_ELEMENT', 'PUBLISH_LAYOUT']);
});

test('immutable publication snapshots preserve historical geometry and every injected failure rolls back', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner, 'Immutable snapshot');
  const added = await addElement(owner, draft, { label: 'v1 geometry' });
  const first = await adminRequest(`/layouts/${draft.id}/publish`, owner, { method: 'POST', body: { version: added.layoutVersion } });
  const firstBody = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  const oldId = firstBody.published.id;
  const oldElements = (await pool.query('SELECT label,x,y,width,height FROM parking_layout_elements WHERE layout_id=$1 ORDER BY id', [oldId])).rows;
  const edited = await adminRequest(`/layouts/${draft.id}/elements/${added.item.id}`, owner, { method: 'PATCH', body: { layout_version: firstBody.draft.version, version: added.item.version, label: 'v2 geometry' } });
  const editedBody = await edited.json();
  assert.equal(edited.status, 200, JSON.stringify(editedBody));
  const baseline = async () => {
    const layouts = await pool.query("SELECT id,status FROM parking_lot_layouts WHERE location_id=$1 ORDER BY id", [locationId]);
    assert.deepEqual(layouts.rows.filter(row => row.status === 'PUBLISHED').map(row => String(row.id)), [String(oldId)]);
    assert.equal(layouts.rows.length, 2, 'a failed transaction must leave no snapshot row');
    assert.deepEqual((await pool.query('SELECT label,x,y,width,height FROM parking_layout_elements WHERE layout_id=$1 ORDER BY id', [oldId])).rows, oldElements);
    assert.equal((await pool.query(`SELECT count(*)::int count FROM parking_layout_elements e
      JOIN parking_lot_layouts l ON l.id=e.layout_id WHERE l.location_id=$1 AND e.layout_id<>ALL($2::bigint[])`, [locationId, [oldId, draft.id]])).rows[0].count, 0, 'a failed transaction must leave no copied elements');
  };
  for (const checkpoint of ['after_snapshot_created', 'after_elements_copied', 'before_previous_superseded', 'after_previous_superseded', 'before_snapshot_published', 'before_commit']) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(() => publishDraftSnapshot(client, {
        layoutId: draft.id, actorId: owner.userId,
        onStep: step => { if (step === checkpoint) throw new Error(`TEST_ROLLBACK_${checkpoint}`); }
      }), new RegExp(`TEST_ROLLBACK_${checkpoint}`));
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await baseline();
  }
  const second = await adminRequest(`/layouts/${draft.id}/publish`, owner, { method: 'POST', body: { version: editedBody.layoutVersion } });
  const secondBody = await second.json();
  assert.equal(second.status, 200, JSON.stringify(secondBody));
  assert.notEqual(secondBody.published.id, oldId);
  assert.equal((await pool.query('SELECT status FROM parking_lot_layouts WHERE id=$1', [oldId])).rows[0].status, 'SUPERSEDED');
  await assert.rejects(() => pool.query('UPDATE parking_lot_layouts SET version=999 WHERE id=$1', [oldId]), /immutable/);
  await assert.rejects(() => pool.query('DELETE FROM parking_lot_layouts WHERE id=$1', [oldId]), /immutable/);
  await assert.rejects(() => pool.query('UPDATE parking_layout_elements SET label=$1 WHERE layout_id=$2', ['mutate', oldId]), /immutable/);
  await assert.rejects(() => pool.query('DELETE FROM parking_layout_elements WHERE layout_id=$1', [oldId]), /immutable/);
});

async function publishDirect(layoutId, actorId, onStep) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const publication = await publishDraftSnapshot(client, { layoutId, actorId, onStep });
    await client.query('COMMIT');
    return publication;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('database triggers make published and superseded layouts and elements immutable while draft edits work', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner, 'Trigger baseline');
  const added = await addElement(owner, draft, { label: 'draft editable' });
  const first = await publishDirect(draft.id, owner.userId);
  const publishedId = first.published.id;
  const publishedElement = (await pool.query('SELECT id FROM parking_layout_elements WHERE layout_id=$1', [publishedId])).rows[0].id;

  await assert.rejects(() => pool.query('UPDATE parking_lot_layouts SET name=$1 WHERE id=$2', ['mutated', publishedId]), /immutable/);
  await assert.rejects(() => pool.query('UPDATE parking_lot_layouts SET version=version+1 WHERE id=$1', [publishedId]), /immutable/);
  await assert.rejects(() => pool.query('DELETE FROM parking_lot_layouts WHERE id=$1', [publishedId]), /immutable/);
  await assert.rejects(() => pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height)
    VALUES($1,'PARKING_SPOT','le_00000000000000000000000000000000','forbidden',1,1,1,1)`, [publishedId]), /immutable/);
  await assert.rejects(() => pool.query('UPDATE parking_layout_elements SET label=$1 WHERE id=$2', ['mutated', publishedElement]), /immutable/);
  await assert.rejects(() => pool.query('DELETE FROM parking_layout_elements WHERE id=$1', [publishedElement]), /immutable/);

  const draftEdit = await adminRequest(`/layouts/${draft.id}/elements/${added.item.id}`, owner, {
    method: 'PATCH', body: { layout_version: added.layoutVersion, version: added.item.version, label: 'draft still editable' }
  });
  assert.equal(draftEdit.status, 200, JSON.stringify(await draftEdit.json()));
  const second = await publishDirect(draft.id, owner.userId);
  assert.equal(Number(second.nextVersion), Number(first.nextVersion) + 1);
  assert.equal((await pool.query('SELECT status FROM parking_lot_layouts WHERE id=$1', [publishedId])).rows[0].status, 'SUPERSEDED');
  await assert.rejects(() => pool.query('UPDATE parking_lot_layouts SET name=$1 WHERE id=$2', ['mutated', publishedId]), /immutable/);
  await assert.rejects(() => pool.query('DELETE FROM parking_lot_layouts WHERE id=$1', [publishedId]), /immutable/);
  await assert.rejects(() => pool.query('UPDATE parking_layout_elements SET label=$1 WHERE id=$2', ['mutated', publishedElement]), /immutable/);
  await assert.rejects(() => pool.query('UPDATE parking_lot_layouts SET status=$1 WHERE id=$2', ['PUBLISHED', publishedId]), /immutable/);
  assert.equal((await pool.query("SELECT count(*)::int count FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'", [locationId])).rows[0].count, 1);
});

test('same-location publishers serialize and never commit two current snapshots', async () => {
  const owner = await loginAs('layout-test-owner');
  const draft = await createDraft(owner, 'Concurrent same location');
  await addElement(owner, draft);
  const [first, second] = await Promise.all([
    publishDirect(draft.id, owner.userId),
    publishDirect(draft.id, owner.userId)
  ]);
  assert.equal(Math.abs(Number(first.nextVersion) - Number(second.nextVersion)), 1);
  const snapshots = await pool.query(`SELECT id,status,version,superseded_by_layout_id FROM parking_lot_layouts
    WHERE location_id=$1 AND status<>'DRAFT' ORDER BY version`, [locationId]);
  assert.deepEqual(snapshots.rows.map(row => row.status), ['SUPERSEDED', 'PUBLISHED']);
  assert.equal(Number(snapshots.rows[1].version), Number(snapshots.rows[0].version) + 1);
  assert.equal(String(snapshots.rows[0].superseded_by_layout_id), String(snapshots.rows[1].id));
  assert.equal((await pool.query('SELECT count(*)::int count FROM parking_layout_elements WHERE layout_id=$1', [snapshots.rows[1].id])).rows[0].count, 1);
});

test('different-location publications proceed independently and readers see only complete committed snapshots', async () => {
  const owner = await loginAs('layout-test-owner');
  const mainDraft = await createDraft(owner, 'MVCC main');
  await addElement(owner, mainDraft, { label: 'old public geometry' });
  const old = await publishDirect(mainDraft.id, owner.userId);
  const otherDraft = await createDraftAt(owner, otherLocationId, 'MVCC other');
  const otherElement = await adminRequest(`/layouts/${otherDraft.id}/elements`, owner, {
    method: 'POST', body: { layout_version: otherDraft.version, ...element({ zone_id: otherZoneId, inventory_id: otherInventoryId, label: 'other geometry' }) }
  });
  assert.equal(otherElement.status, 201, JSON.stringify(await otherElement.json()));

  let releaseCommit;
  let reachedCommit;
  const release = new Promise(resolve => { releaseCommit = resolve; });
  const reached = new Promise(resolve => { reachedCommit = resolve; });
  const writer = publishDirect(mainDraft.id, owner.userId, async step => {
    if (step === 'before_commit') { reachedCommit(); await release; }
  });
  await reached;
  const oldReader = await pool.connect();
  try {
    const current = await oldReader.query(`SELECT l.id,e.label FROM parking_lot_layouts l JOIN parking_layout_elements e ON e.layout_id=l.id
      WHERE l.location_id=$1 AND l.status='PUBLISHED' ORDER BY e.id`, [locationId]);
    assert.deepEqual(current.rows.map(row => String(row.id)), [String(old.published.id)]);
    assert.deepEqual(current.rows.map(row => row.label), ['old public geometry']);
  } finally { oldReader.release(); }
  const other = publishDirect(otherDraft.id, owner.userId);
  releaseCommit();
  await Promise.all([writer, other]);
  const current = await pool.query(`SELECT l.id,e.label FROM parking_lot_layouts l JOIN parking_layout_elements e ON e.layout_id=l.id
    WHERE l.location_id=$1 AND l.status='PUBLISHED' ORDER BY e.id`, [locationId]);
  assert.equal(current.rowCount, 1);
  assert.notEqual(String(current.rows[0].id), String(old.published.id));
  assert.equal(current.rows[0].label, 'old public geometry');
  assert.equal((await pool.query("SELECT count(*)::int count FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED'", [otherLocationId])).rows[0].count, 1);
});
