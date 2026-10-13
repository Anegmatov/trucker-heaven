process.env.NODE_ENV = 'test';
process.env.PARKING_PAYMENT_MODE = 'PAY_ON_SITE';
process.env.PARKING_DOCUMENT_STORAGE_PROVIDER = 'LOCAL';
process.env.PARKING_DOCUMENT_STORAGE_DIR = require('node:path').join(require('node:os').tmpdir(), `parking-docs-${process.pid}`);

// Mixed-term, mixed-type lot: Daily-only truck spaces, Monthly-only truck spaces, and Bobtail spaces,
// with a long-term customer (Amazon) holding the Monthly truck spaces and one Bobtail space.
// Guards the rules the customer map relies on:
//   - a Monthly booking on a Monthly space never consumes Daily capacity
//   - the Daily layout marks only spaces of the requested TYPE and term: open ones available,
//     taken ones eligible-but-unavailable, everything else unmarked (never a Bobtail on a truck search)
//   - a full Monthly lot is returned as a lot (every space taken), not as an error
// Runs against parkingops_test only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const app = require('../app');
const { publishDraftSnapshot } = require('../services/layoutPublication');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Set PARKING_TEST_DATABASE=parkingops_test and a parkingops_test PARKING_DATABASE_URL');
}

const ownerName = `mixed-owner-${Date.now()}`;
const password = 'MixedTerm!Owner2036';
const elementKey = () => `le_${crypto.randomBytes(16).toString('hex')}`;
const dailyInterval = { arrivalLocal: '2035-03-10T09:00', departureLocal: '2035-03-11T09:00' };
const monthlyArrival = '2035-03-01T09:00';

let server; let base; let session; let location; let truckZone; let bobtailZone; let spots = {}; let categories;

async function publicPost(path, body) {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}
async function adminPost(path, body, key) {
  const response = await fetch(`${base}/api/admin/parking/v1${path}`, {
    method: 'POST', headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}
const spaceByNumber = layout => new Map((layout?.elements || []).filter(e => e?.space?.number).map(e => [String(e.space.number), e.space]));

async function deskMonthly(label, categoryCode, company) {
  const spot = spots[label];
  const availability = await adminPost('/reservation-desk/availability', { locationId: location.id, duration: 'MONTHLY', categoryCode, arrivalLocal: monthlyArrival });
  assert.equal(availability.response.status, 200, JSON.stringify(availability.body));
  const option = availability.body.options.find(o => o.available && (o.positions || []).some(p => Number(p.id) === Number(spot.id)));
  assert.ok(option, `space ${label} should be offered for Monthly ${categoryCode}`);
  const created = await adminPost('/reservation-desk/reservations', {
    parking: { locationId: location.id, duration: 'MONTHLY', categoryCode, arrivalLocal: monthlyArrival, inventoryId: option.inventoryId, selectedSpotId: spot.id },
    customer: { firstName: company, lastName: 'Logistics', mobilePhone: '6155550100', email: `fleet@${company.toLowerCase()}.example`, companyName: company },
    vehicle: { unitNumber: `${company}-${label}`, licensePlate: `${company.slice(0, 3)}${label}`, licensePlateState: 'TN' }
  }, `mixed-${label}-${crypto.randomBytes(8).toString('hex')}`);
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
}

test.before(async () => {
  categories = Object.fromEntries((await pool.query("SELECT id,code FROM parking_categories WHERE code IN ('TRACTOR_TRAILER','BOBTAIL')")).rows.map(r => [r.code, r]));
  assert.ok(categories.TRACTOR_TRAILER && categories.BOBTAIL, 'load the development seed before this suite');
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until) VALUES($1,$2,'OWNER',true,0,NULL)`, [ownerName, await bcrypt.hash(password, 4)]);
  const ownerId = (await pool.query('SELECT id FROM parking_admin_users WHERE username=$1', [ownerName])).rows[0].id;
  location = (await pool.query(`INSERT INTO parking_locations(name,public_description,address,timezone,phone,arrival_instructions,exit_instructions,payment_instructions,
      booking_approval_mode,cancellation_cutoff_hours,assignment_mode,exact_mode_active,self_service_enabled,check_in_early_minutes,check_in_late_minutes,turnaround_buffer_minutes)
    VALUES($1,'Mixed-term lot','1 Mixed Way','America/Chicago','+16155550301','Enter.','Exit.','Pay at the office.','AUTO_CONFIRM',0,'ZONE_CAPACITY',false,true,120,240,0) RETURNING *`,
  [`Mixed term occupancy ${Date.now()}`])).rows[0];
  truckZone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order) VALUES($1,'General Truck Parking','','','',1) RETURNING *`, [location.id])).rows[0];
  bobtailZone = (await pool.query(`INSERT INTO parking_zones(location_id,name,description,arrival_directions,exit_directions,display_order) VALUES($1,'Bobtail Parking','','','',2) RETURNING *`, [location.id])).rows[0];
  const inventories = {};
  const plans = {};
  for (const [code, zone] of [['TRACTOR_TRAILER', truckZone], ['BOBTAIL', bobtailZone]]) {
    inventories[code] = (await pool.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,public_remaining_capacity) VALUES($1,$2,0,'',true) RETURNING *`, [zone.id, categories[code].id])).rows[0];
    plans[code] = (await pool.query(`INSERT INTO parking_rate_rules(location_id,zone_id,category_id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents,active) VALUES($1,$2,$3,'Mixed',1900,10000,25000,true) RETURNING *`, [location.id, zone.id, categories[code].id])).rows[0];
  }
  const draft = (await pool.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id) VALUES($1,'Mixed fixture','DRAFT',$2,$2) RETURNING *`, [location.id, ownerId])).rows[0];
  const entrance = elementKey(); const lane = elementKey();
  await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active) VALUES($1,'ENTRANCE',$2,'Entrance',2,44,8,8,1,true,true)`, [draft.id, entrance]);
  await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,layer_order,public_visible,active) VALUES($1,'DRIVE_LANE',$2,'Lane',11,46,75,6,2,true,true)`, [draft.id, lane]);
  const definitions = [
    { label: '101', code: 'TRACTOR_TRAILER', daily: true, monthly: false },
    { label: '102', code: 'TRACTOR_TRAILER', daily: true, monthly: false },
    { label: '130', code: 'TRACTOR_TRAILER', daily: false, monthly: true },
    { label: '131', code: 'TRACTOR_TRAILER', daily: false, monthly: true },
    { label: '20', code: 'BOBTAIL', daily: true, monthly: true },
    { label: '21', code: 'BOBTAIL', daily: true, monthly: true }
  ];
  for (const [index, d] of definitions.entries()) {
    const zone = d.code === 'BOBTAIL' ? bobtailZone : truckZone; const key = elementKey();
    const spot = (await pool.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,visual_element_key,active,physical_section,parking_use,public_bookable,classification_state)
      VALUES($1,$2,$3,$4,$5,$6,true,'TEST','NEEDS_CLASSIFICATION',false,'NEEDS_CLASSIFICATION') RETURNING *`, [location.id, zone.id, inventories[d.code].id, d.label, index + 1, key])).rows[0];
    await pool.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,10,6,$9,true,true,'CUSTOMER',$10,true,$11,true,$12)`,
    [draft.id, key, d.label, zone.id, inventories[d.code].id, spot.id, 16 + (index % 3) * 20, 18 + Math.floor(index / 3) * 20, 10 + index, d.daily, d.monthly, plans[d.code].id]);
    spots[d.label] = spot;
  }
  for (const zone of [truckZone, bobtailZone]) {
    await pool.query(`INSERT INTO parking_area_directions(location_id,zone_id,entrance_element_key,arrival_route_element_keys,updated_by_admin_user_id) VALUES($1,$2,$3,$4,$5)`, [location.id, zone.id, entrance, [entrance, lane], ownerId]);
  }
  const client = await pool.connect();
  try { await client.query('BEGIN'); await publishDraftSnapshot(client, { layoutId: draft.id, actorId: ownerId }); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ownerName, password }) });
  const loginBody = await login.json(); assert.equal(login.status, 200, JSON.stringify(loginBody));
  session = { cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: loginBody.csrfToken };

  // Amazon takes every Monthly truck space and one Bobtail space.
  await deskMonthly('130', 'TRACTOR_TRAILER', 'Amazon');
  await deskMonthly('131', 'TRACTOR_TRAILER', 'Amazon');
  await deskMonthly('20', 'BOBTAIL', 'Amazon');
});

test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });

async function publicBook(body) {
  const quote = await publicPost('/quotes', body); assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
  const response = await fetch(`${base}/api/public/parking/v1/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `mixed-${crypto.randomBytes(18).toString('hex')}` },
    body: JSON.stringify({ ...body, quoteToken: quote.body.quoteToken, termsVersion: quote.body.terms.version }) });
  const json = await response.json(); assert.equal(response.status, 201, JSON.stringify(json)); return json;
}

test('an area reservation holds a space back: offer and map agree, and the held space is marked CAPACITY_HOLD, not taken', async () => {
  // A Daily bobtail booking with no numbered space (area booking) that overlaps the Monthly start.
  await publicBook({ parkingAreaId: bobtailZone.public_id, categoryCode: 'BOBTAIL', duration: 'DAILY', arrivalLocal: '2035-03-01T08:00', departureLocal: '2035-03-02T08:00',
    firstName: 'Area', lastName: 'Driver', mobilePhone: '+16155559001', email: `area.${Date.now()}@example.test`, companyName: 'Area Freight',
    tractorUnitNumber: 'AREA-1', licensePlate: `AR${Date.now() % 10000}`, licensePlateState: 'TN', termsAccepted: true, cancellationTermsAccepted: true });
  // Monthly bobtail: Amazon has 20, the area booking needs 21 → nothing sellable, and the map must say so too.
  const availability = await publicPost('/availability', { parkingAreaId: bobtailZone.public_id, categoryCode: 'BOBTAIL', duration: 'MONTHLY', arrivalLocal: monthlyArrival });
  assert.equal(availability.response.status, 200, JSON.stringify(availability.body));
  const offer = availability.body.results.find(r => r.categoryCode === 'BOBTAIL');
  assert.equal(offer.available, false, 'the last free bobtail is held for the area reservation');
  const positions = await publicPost('/monthly-positions', { parkingAreaId: bobtailZone.public_id, categoryCode: 'BOBTAIL', duration: 'MONTHLY', arrivalLocal: monthlyArrival });
  assert.equal(positions.response.status, 200, JSON.stringify(positions.body));
  assert.equal(positions.body.positions.filter(p => p.available).length, 0, 'no position is offered when the offer says none');
  const space = spaceByNumber(positions.body.layout);
  assert.equal(space.get('21').selectable, false); assert.equal(space.get('21').selectionState, 'CAPACITY_HOLD', '21 is held back, not taken');
  assert.match(space.get('20').selectionState, /RESERVED|OCCUPIED/, '20 is physically taken by Amazon');
  // Daily bobtail on the same day: 21 is the area booking's capacity, so it shows as CAPACITY_HOLD there too.
  const daily = await publicPost('/availability', { parkingAreaId: bobtailZone.public_id, categoryCode: 'BOBTAIL', duration: 'DAILY', arrivalLocal: '2035-03-01T09:00', departureLocal: '2035-03-02T07:00' });
  const dailySpace = spaceByNumber(daily.body.layout);
  assert.equal(dailySpace.get('21').available, false); assert.equal(dailySpace.get('21').selectionState, 'CAPACITY_HOLD');
  assert.equal(dailySpace.get('20').selectionState, 'TAKEN');
});

test('Monthly bookings on Monthly spaces do not consume Daily truck capacity', async () => {
  const { response, body } = await publicPost('/availability', { parkingAreaId: truckZone.public_id, categoryCode: 'TRACTOR_TRAILER', duration: 'DAILY', ...dailyInterval });
  assert.equal(response.status, 200, JSON.stringify(body));
  const offer = body.results.find(r => r.categoryCode === 'TRACTOR_TRAILER');
  assert.ok(offer?.available, 'Daily truck parking must still be available');
  assert.equal(offer.remainingCapacity ?? offer.availableSpots ?? offer.available_spots, 2, 'both Daily-only spaces remain');
});

test('Daily truck layout marks only truck spaces: open Daily ones available, occupied Monthly ones taken, never Bobtail', async () => {
  const { body } = await publicPost('/availability', { parkingAreaId: truckZone.public_id, categoryCode: 'TRACTOR_TRAILER', duration: 'DAILY', ...dailyInterval });
  const space = spaceByNumber(body.layout);
  for (const n of ['101', '102']) { assert.equal(space.get(n).eligible, true, `${n} eligible`); assert.equal(space.get(n).available, true, `${n} available`); }
  // Amazon's Monthly spaces are not for sale on a Daily search, but they are shown as taken (red), not as empty grey spaces.
  for (const n of ['130', '131']) { assert.notEqual(space.get(n).eligible, true, `${n} is Monthly-only and must not be marked for Daily`); assert.equal(space.get(n).selectionState, 'TAKEN', `${n} is occupied by Amazon`); }
  for (const n of ['20', '21']) { assert.notEqual(space.get(n).eligible, true, `Bobtail ${n} must never be marked on a truck search`); assert.notEqual(space.get(n).available, true); }
});

test('Daily bobtail layout marks the taken bobtail space as eligible but unavailable and ignores trucks', async () => {
  const { body } = await publicPost('/availability', { parkingAreaId: bobtailZone.public_id, categoryCode: 'BOBTAIL', duration: 'DAILY', ...dailyInterval });
  const space = spaceByNumber(body.layout);
  assert.equal(space.get('20').eligible, true); assert.equal(space.get('20').available, false, 'Amazon holds 20');
  assert.equal(space.get('21').eligible, true); assert.equal(space.get('21').available, true);
  for (const n of ['101', '102', '130', '131']) assert.notEqual(space.get(n).eligible, true, `truck ${n} must not be marked on a bobtail search`);
});

test('a full Monthly lot comes back as a lot with every space taken, not an error', async () => {
  const availability = await publicPost('/availability', { parkingAreaId: truckZone.public_id, categoryCode: 'TRACTOR_TRAILER', duration: 'MONTHLY', arrivalLocal: monthlyArrival });
  assert.equal(availability.response.status, 200);
  assert.equal(availability.body.results.some(r => r.available), false, 'nothing Monthly is open');
  const positions = await publicPost('/monthly-positions', { parkingAreaId: truckZone.public_id, categoryCode: 'TRACTOR_TRAILER', duration: 'MONTHLY', arrivalLocal: monthlyArrival });
  assert.equal(positions.response.status, 200, JSON.stringify(positions.body));
  assert.equal(positions.body.available, false);
  assert.equal(positions.body.positions.filter(p => p.available).length, 0);
  const space = spaceByNumber(positions.body.layout);
  for (const n of ['130', '131']) { assert.equal(space.get(n).selectable, false, `${n} is taken`); assert.match(String(space.get(n).selectionState), /RESERVED|OCCUPIED|HELD|UNAVAILABLE/); }
});

test('when the truck area accepts bobtails, a Daily bobtail search also offers 101-129 and a bobtail booking there uses truck Daily capacity', async () => {
  await pool.query(`UPDATE parking_inventory SET accepts_category_codes='{BOBTAIL}' WHERE zone_id=$1 AND category_id=$2`, [truckZone.id, categories.TRACTOR_TRAILER.id]);
  try {
    const search = { categoryCode: 'BOBTAIL', duration: 'DAILY', arrivalLocal: '2035-04-01T09:00', departureLocal: '2035-04-02T09:00' };
    // The customer app searches the whole lot (no area), so both the bobtail area and the truck Daily area come back.
    const bobtail = await publicPost('/availability', { locationId: location.public_id, ...search });
    assert.equal(bobtail.response.status, 200, JSON.stringify(bobtail.body));
    const space = spaceByNumber(bobtail.body.layout);
    for (const n of ['101', '102']) { assert.equal(space.get(n).eligible, true, `${n} is open to bobtails`); assert.equal(space.get(n).available, true); }
    assert.equal(space.get('21').available, true, 'own bobtail space still open');
    assert.deepEqual(bobtail.body.results.filter(r => r.available).map(r => r.zone).sort(), ['Bobtail Parking', 'General Truck Parking'], 'two areas offered');
    for (const n of ['130', '131']) { assert.notEqual(space.get(n).eligible, true); assert.equal(space.get(n).selectionState, 'TAKEN', `${n} shows red for bobtails too`); }
    // The truck zone itself offers Daily parking to a bobtail now.
    const truckArea = await publicPost('/availability', { parkingAreaId: truckZone.public_id, ...search });
    assert.equal(truckArea.response.status, 200, JSON.stringify(truckArea.body));
    const offer = truckArea.body.results.find(r => r.available);
    assert.ok(offer, 'the truck Daily area is offered to a bobtail');
    assert.equal(offer.remainingCapacity, 2);
    await publicBook({ parkingAreaId: truckZone.public_id, ...search,
      firstName: 'Bob', lastName: 'Tail', mobilePhone: '+16155559002', email: `bob.${Date.now()}@example.test`, companyName: 'Bobtail Freight',
      tractorUnitNumber: 'BOB-1', licensePlate: `BT${Date.now() % 10000}`, licensePlateState: 'TN', termsAccepted: true, cancellationTermsAccepted: true });
    const after = await publicPost('/availability', { parkingAreaId: truckZone.public_id, categoryCode: 'TRACTOR_TRAILER', duration: 'DAILY', arrivalLocal: search.arrivalLocal, departureLocal: search.departureLocal });
    assert.equal(after.body.results.find(r => r.categoryCode === 'TRACTOR_TRAILER').remainingCapacity, 1, 'the bobtail took one of the two truck Daily spaces');
  } finally {
    await pool.query(`UPDATE parking_inventory SET accepts_category_codes='{}' WHERE zone_id=$1`, [truckZone.id]);
  }
});
