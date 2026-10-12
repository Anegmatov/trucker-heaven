/*
 * Explicit, idempotent real-lot provisioner.  This tool intentionally does
 * nothing without --apply; use --publish only after an owner has approved the
 * calibrated map in the target environment.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { publishDraftSnapshot } = require('../services/layoutPublication');
const { capacityBlockingStatuses } = require('../services/bookingWorkflow');
const { parsePostgresUrl, createDatabasePoolConfig } = require('../databaseConnection');

const DEVELOPMENT_DATABASE = 'parkingops_dev_20260723_014831';
const PRODUCTION_DATABASE = 'parkingops_prod';
const PRODUCTION_CONFIRMATION = 'REAL_LOT_IMPORT_APPROVED';
const REQUIRED_PRODUCTION_TABLES = ['parking_locations', 'parking_zones', 'parking_spots', 'parking_lot_layouts', 'parking_layout_elements', 'parking_rate_rules'];
const LEGACY_LOCATION_NAME = 'South Zone';
const LEGACY_ZONE_NAMES = { north: 'North Zone', south: 'South Zone' };
const LEGACY_LAYOUT_NAME = 'North Zone layout';
const LEGACY_LAYOUT_VERSION = 4;
const LEGACY_GENERIC_LABELS = new Set([
  ...Array.from({ length: 15 }, (_, index) => `N-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, index) => `S-${String(index + 1).padStart(2, '0')}`)
]);

function usage() {
  return 'Usage: node scripts/importTruckerHeavenRealLot.js [--dry-run|--apply] [--publish] [--database-url-file <path>] [--expected-database <name>] [--production] [--confirm-production REAL_LOT_IMPORT_APPROVED]';
}

function readOption(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseImporterOptions(argv = process.argv.slice(2), env = process.env) {
  const options = { apply: false, publish: false, production: false, databaseUrlFile: null, expectedDatabase: null, confirmation: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') continue;
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--publish') { options.publish = true; continue; }
    if (arg === '--production') { options.production = true; continue; }
    if (arg === '--database-url-file') { options.databaseUrlFile = readOption(argv, index, arg); index += 1; continue; }
    if (arg === '--expected-database') { options.expectedDatabase = readOption(argv, index, arg); index += 1; continue; }
    if (arg === '--confirm-production') { options.confirmation = readOption(argv, index, arg); index += 1; continue; }
    throw new Error(usage());
  }
  if (options.publish && !options.apply) throw new Error('--publish requires --apply');
  if (options.apply && !options.publish) throw new Error('Refusing unsafe apply-only real-lot import: --publish is required for public continuity.');
  options.expectedDatabase ||= DEVELOPMENT_DATABASE;
  if (![DEVELOPMENT_DATABASE, PRODUCTION_DATABASE].includes(options.expectedDatabase)) throw new Error('Refusing import: expected database is not an approved ParkingOps target.');
  const productionTarget = options.expectedDatabase === PRODUCTION_DATABASE;
  if (productionTarget && !options.production) throw new Error('Refusing production import: --production is required.');
  if (!productionTarget && options.production) throw new Error('--production is only valid with --expected-database parkingops_prod.');
  if (productionTarget && !options.databaseUrlFile) throw new Error('Refusing production import: --database-url-file is required.');
  if (options.confirmation && !productionTarget) throw new Error('--confirm-production is only valid for a production target.');
  if (productionTarget && options.apply && options.confirmation !== PRODUCTION_CONFIRMATION) throw new Error('Refusing production apply: exact --confirm-production value is required.');
  if (!productionTarget && /(?:ifta_db|trucker_heaven_postgres|parkingops_test)/i.test(options.expectedDatabase)) throw new Error('Refusing import: database is not an approved ParkingOps target.');
  let connectionString;
  if (options.databaseUrlFile) {
    try { connectionString = fs.readFileSync(options.databaseUrlFile, 'utf8').trim(); }
    catch (_) { throw new Error('Refusing import: unable to read --database-url-file.'); }
  } else connectionString = String(env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('Refusing import: provide an explicit ParkingOps DATABASE_URL or --database-url-file.');
  let parsed;
  try { parsed = parsePostgresUrl(connectionString); } catch (_) { throw new Error('Refusing import: database URL is invalid.'); }
  const urlDatabase = parsed.database;
  if (urlDatabase !== options.expectedDatabase) throw new Error('Refusing import: database URL does not match --expected-database.');
  if (/(?:ifta_db|trucker_heaven_postgres|parkingops_test)/i.test(urlDatabase)) throw new Error('Refusing import: database is not an approved ParkingOps target.');
  if (productionTarget && parsed.hostClassification === 'local-or-service-alias') throw new Error('Refusing production import: database host must be remote.');
  return { ...options, connectionString, productionTarget, hostClassification: parsed.hostClassification };
}

function normalizeHumanName(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

function sameHumanName(left, right) {
  return normalizeHumanName(left).toLocaleLowerCase('en-US') === normalizeHumanName(right).toLocaleLowerCase('en-US');
}

function hasExpectedGenericLabels(spaces) {
  const labels = new Set(spaces.map(space => space.public_label));
  return labels.size === LEGACY_GENERIC_LABELS.size && [...LEGACY_GENERIC_LABELS].every(label => labels.has(label));
}

function selectLegacyProductionTarget(baseline) {
  const matches = baseline.locations.filter(location => sameHumanName(location.name, LEGACY_LOCATION_NAME)).map(location => {
    const zones = baseline.zones.filter(zone => String(zone.location_id) === String(location.id));
    const north = zones.filter(zone => sameHumanName(zone.name, LEGACY_ZONE_NAMES.north));
    const south = zones.filter(zone => sameHumanName(zone.name, LEGACY_ZONE_NAMES.south));
    const spaces = baseline.spaces.filter(space => String(space.location_id) === String(location.id));
    const numericSpaces = spaces.filter(space => /^\d+$/.test(space.public_label));
    const layouts = baseline.layouts.filter(layout => String(layout.location_id) === String(location.id)
      && sameHumanName(layout.name, LEGACY_LAYOUT_NAME) && Number(layout.version) === LEGACY_LAYOUT_VERSION
      && Number(layout.generic_spot_references) === LEGACY_GENERIC_LABELS.size
      && Number(layout.generic_label_references) === LEGACY_GENERIC_LABELS.size);
    return { location, north, south, spaces, numericSpaces, layouts,
      structurallyValid: north.length === 1 && south.length === 1 && hasExpectedGenericLabels(spaces) && numericSpaces.length === 0 && layouts.length === 1 };
  }).filter(candidate => candidate.structurallyValid);
  if (matches.length > 1) throw new Error('Refusing production import: multiple structurally valid legacy locations are ambiguous.');
  if (matches.length !== 1) throw new Error('Refusing production import: recognizable ParkingOps legacy baseline records are missing or inconsistent.');
  const match = matches[0];
  return { kind: 'legacy', location: match.location, zones: { north: match.north[0], south: match.south[0] }, layout: match.layouts[0], genericSpaceCount: match.spaces.length };
}

function validateConnectedTarget(identity, options, baseline = null) {
  if (identity.database !== options.expectedDatabase) throw new Error('Refusing import: connected database does not match --expected-database.');
  if (!options.productionTarget) return;
  const missing = REQUIRED_PRODUCTION_TABLES.filter(table => !baseline?.tables?.includes(table));
  if (missing.length) throw new Error('Refusing production import: required ParkingOps tables are missing.');
  if (!baseline.target) throw new Error('Refusing production import: recognizable ParkingOps legacy baseline records are missing or inconsistent.');
}

async function readProductionBaseline(client) {
  const tables = await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name = ANY($1::text[])`, [REQUIRED_PRODUCTION_TABLES]);
  const found = tables.rows.map(row => row.table_name);
  const missing = REQUIRED_PRODUCTION_TABLES.filter(table => !found.includes(table));
  if (missing.length) return { tables: found };
  const locations = await client.query('SELECT id,name FROM parking_locations ORDER BY id');
  const zones = await client.query('SELECT id,location_id,name FROM parking_zones ORDER BY location_id,id');
  const spaces = await client.query("SELECT id,location_id,zone_id,public_label FROM parking_spots WHERE public_label ~ '^(?:[NS]-[0-9]+|[0-9]+)$' ORDER BY location_id,public_label");
  const layouts = await client.query(`SELECT l.id,l.location_id,l.name,l.version,
      count(DISTINCT e.parking_spot_id) FILTER (WHERE s.public_label ~ '^[NS]-[0-9]+$')::int generic_spot_references,
      count(DISTINCT e.label) FILTER (WHERE e.label ~ '^[NS]-[0-9]+$')::int generic_label_references
      FROM parking_lot_layouts l LEFT JOIN parking_layout_elements e ON e.layout_id=l.id
      LEFT JOIN parking_spots s ON s.id=e.parking_spot_id
      WHERE l.status='PUBLISHED' GROUP BY l.id ORDER BY l.id`);
  const raw = { tables: found, locations: locations.rows, zones: zones.rows, spaces: spaces.rows, layouts: layouts.rows };
  return { ...raw, target: selectLegacyProductionTarget(raw) };
}

function redactSecrets(message) {
  return String(message)
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/(password authentication failed for user\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\buser\s+)(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(user(?:name)?\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function poolOptions(options) {
  return createDatabasePoolConfig(options.connectionString, { allowLocal: !options.productionTarget });
}

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'trucker-heaven-real-lot-layout.v1.json'), 'utf8'));
const key = value => `le_${crypto.createHash('md5').update(`trucker-heaven-real-lot-v${data.version}:${value}`).digest('hex')}`;
const expand = ([start, end], direction = 'ASCENDING') => Array.from({ length: end - start + 1 }, (_, index) => direction === 'DESCENDING' ? end - index : start + index);
const spaces = data.rows.flatMap(row => expand(row.range, row.numberDirection).map((number, index) => ({ ...row, number, index })));

function geometry(row) {
  const columns = Number(row.columns || 1);
  const column = row.index % columns; const line = Math.floor(row.index / columns);
  const step = Number(row.step || (Number(row.height) + Number(row.gap || 0)));
  return { x: Number(row.x) + column * (Number(row.width) + Number(row.gap || 0)), y: Number(row.y) + line * step, width: Number(row.width), height: Number(row.height), rotation: Number(row.rotation || 0) };
}
function bookingEligibility(space) {
  const customerEligible = Boolean(space.publicBookable) && !['COMPANY', 'SHOP', 'SHOP_BOBTAIL', 'NEEDS_CLASSIFICATION'].includes(space.use);
  const bobtail = space.category === 'BOBTAIL';
  const daily = customerEligible && (bobtail || (Number(space.number) >= 110 && Number(space.number) <= 148));
  return { customerEligible, daily, weekly: customerEligible, monthly: customerEligible && (!daily || bobtail) };
}
function assertLayout() {
  const labels = new Set();
  const rectangles = [];
  for (const space of spaces) {
    if (space.number >= 91 && space.number <= 100) throw new Error('Source contains prohibited numbers 91–100');
    if (labels.has(space.number)) throw new Error(`Duplicate physical number ${space.number}`);
    const eligibility = bookingEligibility(space);
    const expectedPeriods = ['DAILY', 'MONTHLY'].filter(period => period === 'DAILY' ? eligibility.daily : eligibility.monthly);
    if (eligibility.customerEligible && (!Array.isArray(space.bookingPeriods)
      || space.bookingPeriods.length !== expectedPeriods.length
      || space.bookingPeriods.some((period, index) => period !== expectedPeriods[index]))) {
      throw new Error(`Customer space ${space.number} must declare its authoritative booking terms`);
    }
    labels.add(space.number); const item = geometry(space);
    if (item.x < 0 || item.y < 0 || item.x + item.width > 100 || item.y + item.height > 100) throw new Error(`Geometry out of bounds for ${space.number}`);
    for (const placed of rectangles) {
      const overlaps = item.x < placed.x + placed.width && item.x + item.width > placed.x && item.y < placed.y + placed.height && item.y + item.height > placed.y;
      if (overlaps) throw new Error(`Geometry conflict between spaces ${placed.number} and ${space.number}`);
    }
    rectangles.push({ ...item, number: space.number });
  }
  for (const element of data.elements) {
    if (Number(element.x) < 0 || Number(element.y) < 0 || Number(element.x) + Number(element.width) > 100 || Number(element.y) + Number(element.height) > 100) {
      throw new Error(`Map element '${element.label || element.type}' is out of bounds`);
    }
    if (element.type !== 'BUILDING') continue;
    for (const space of rectangles) {
      const overlaps = space.x < Number(element.x) + Number(element.width) && space.x + space.width > Number(element.x)
        && space.y < Number(element.y) + Number(element.height) && space.y + space.height > Number(element.y);
      if (overlaps) throw new Error(`Building intersection between '${element.label}' and space ${space.number}`);
    }
  }
  if (labels.size !== 185) throw new Error(`Expected 185 physical spaces, found ${labels.size}`);
}

function matchesSpacePlan(current, space, item, zoneName) {
  if (!current) return false;
  // JSON row arithmetic uses binary floating point while PostgreSQL persists
  // numeric(7,4). Compare at persisted-coordinate precision so a calibrated
  // 0.3/0.38 gap does not cause a false idempotency update.
  const decimal = (actual, expected) => Math.abs(Number(actual) - Number(expected)) < 0.00005;
  const eligibility = bookingEligibility(space);
  return current.active === true
    && current.physical_section === space.key
    && current.parking_use === space.use
    && current.public_bookable === Boolean(space.publicBookable)
    && current.classification_state === (space.classificationState || 'COMPLETE')
    && current.operational_label === (space.note || '')
    && current.zone_name === zoneName
    && current.category_code === space.category
    && current.element_type === 'PARKING_SPOT'
    && current.element_active === true
    && current.element_public_visible === true
    && current.daily_eligible === eligibility.daily
    && current.weekly_eligible === eligibility.weekly
    && current.monthly_eligible === eligibility.monthly
    && current.space_public_bookable === eligibility.customerEligible
    && String(current.element_label) === String(space.number)
    && decimal(current.x, item.x) && decimal(current.y, item.y)
    && decimal(current.width, item.width) && decimal(current.height, item.height)
    && decimal(current.rotation, item.rotation);
}

async function resolveImportRatePlans(client, locationId, zones, categoryByCode, zoneByUse) {
  const plans = new Map();
  for (const space of spaces) {
    const eligibility = bookingEligibility(space);
    if (!eligibility.customerEligible) continue;
    const zoneName = zoneByUse[space.use];
    const zoneId = zones.get(zoneName);
    const categoryId = categoryByCode.get(space.category);
    const key = `${zoneId}:${categoryId}`;
    if (plans.has(key)) continue;
    const plan = (await client.query(`SELECT id,plan_name,daily_rate_cents,weekly_rate_cents,monthly_rate_cents
      FROM parking_rate_rules
      WHERE location_id=$1 AND category_id=$2 AND (zone_id IS NULL OR zone_id=$3)
        AND active AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())
      ORDER BY (zone_id IS NOT NULL) DESC,priority DESC,id DESC LIMIT 1`, [locationId, categoryId, zoneId])).rows[0];
    if (!plan) throw new Error(`Refusing import: ${zoneName} has no effective ${space.category.replaceAll('_', ' ').toLowerCase()} rate plan.`);
    plans.set(key, plan);
  }
  for (const space of spaces) {
    const eligibility = bookingEligibility(space);
    if (!eligibility.customerEligible) continue;
    const zoneName = zoneByUse[space.use];
    const plan = plans.get(`${zones.get(zoneName)}:${categoryByCode.get(space.category)}`);
    if (eligibility.daily && plan.daily_rate_cents == null) throw new Error(`Refusing import: rate plan '${plan.plan_name}' has no Daily parking price required by space ${space.number}.`);
    if (eligibility.weekly && plan.weekly_rate_cents == null) throw new Error(`Refusing import: rate plan '${plan.plan_name}' has no Weekly parking price required by space ${space.number}.`);
    if (eligibility.monthly && plan.monthly_rate_cents == null) throw new Error(`Refusing import: rate plan '${plan.plan_name}' has no Monthly parking price required by space ${space.number}.`);
  }
  return plans;
}

async function rebindCompatibleLegacyAssignments(client, draftLayoutId) {
  const rebound = await client.query(`WITH compatible AS (
      SELECT booking.id booking_id,element.inventory_id,inventory.category_id,
        element.zone_id,element.label assigned_spot_label
      FROM parking_bookings booking
      JOIN reservation_spot_assignments assignment
        ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
      JOIN parking_layout_elements element
        ON element.layout_id=$1 AND element.parking_spot_id=assignment.parking_spot_id
      JOIN parking_inventory inventory ON inventory.id=element.inventory_id
      WHERE booking.parking_product='LEGACY'
        AND booking.assignment_mode_snapshot='EXACT_SPOT'
        AND booking.status=ANY($2::text[])
        AND (booking.status='CHECKED_IN' OR assignment.protected_until_at>now())
        AND element.active AND element.parking_purpose='CUSTOMER'
        AND element.space_public_bookable
        AND (booking.inventory_id IS DISTINCT FROM element.inventory_id
          OR booking.category_id IS DISTINCT FROM inventory.category_id
          OR booking.assigned_zone_id IS DISTINCT FROM element.zone_id
          OR booking.assigned_spot_label IS DISTINCT FROM element.label)
    )
    UPDATE parking_bookings booking SET
      inventory_id=compatible.inventory_id,
      category_id=compatible.category_id,
      assigned_zone_id=compatible.zone_id,
      assigned_spot_label=compatible.assigned_spot_label,
      version=booking.version+1,
      updated_at=now()
    FROM compatible WHERE booking.id=compatible.booking_id
    RETURNING booking.id,booking.assigned_spot_label`, [draftLayoutId, capacityBlockingStatuses()]);
  return rebound.rows.map(row => ({ bookingId: Number(row.id), space: row.assigned_spot_label }));
}

// This performs only the combined write portion of the guarded importer.  It
// deliberately accepts a connected transaction client so tests and the CLI
// execute exactly the same PostgreSQL transaction. `onStep` is in-process
// test instrumentation; it has no command-line, HTTP, or environment path.
async function applyRealLotTransaction(client, { location, owner, categoryByCode, productionTarget, baseline, report, onStep = null }) {
  const step = async name => { if (onStep) await onStep(name); };
  await client.query('SELECT id FROM parking_locations WHERE id=$1 FOR UPDATE', [location.id]);
  if (productionTarget && baseline?.target?.kind === 'canonical') {
    const state = (await client.query(`SELECT
      count(*) FILTER (WHERE active AND public_label ~ '^[0-9]+$')::int numeric_spaces,
      count(*) FILTER (WHERE active AND public_label ~ '^[NS]-[0-9]+$')::int active_generic_spaces
      FROM parking_spots WHERE location_id=$1`, [location.id])).rows[0];
    if (Number(state.numeric_spaces) !== spaces.length || Number(state.active_generic_spaces) !== 0) {
      throw new Error('Refusing production classification update: canonical numbered-space baseline changed after preflight.');
    }
  } else if (productionTarget) {
    const state = (await client.query(`SELECT
      count(*) FILTER (WHERE public_label ~ '^[0-9]+$')::int numeric_spaces,
      count(*) FILTER (WHERE public_label ~ '^[NS]-[0-9]+$' AND active)::int active_generic_spaces
      FROM parking_spots WHERE location_id=$1`, [location.id])).rows[0];
    if (Number(state.numeric_spaces) || Number(state.active_generic_spaces) !== LEGACY_GENERIC_LABELS.size) {
      throw new Error('Refusing production import: legacy baseline was already transformed or changed after preflight.');
    }
  }
  // Retain zone and inventory IDs while correcting the location-specific public labels.
  for (const [from, to] of [['Customer parking', 'General Truck Parking'], ['Customer bobtail', 'Bobtail Parking'], ['Shop parking', 'Shop (internal)'], ['Company / ITM', 'Company (internal)']]) {
    await client.query(`UPDATE parking_zones SET name=$3 WHERE location_id=$1 AND name=$2
      AND NOT EXISTS (SELECT 1 FROM parking_zones existing WHERE existing.location_id=$1 AND existing.name=$3)`, [location.id, from, to]);
  }
  const zoneDefinitions = [
    ['General Truck Parking', true, 'Customer parking for standard full trucks.'], ['Bobtail Parking', true, 'Customer parking for bobtail trucks.'],
    ['Shop (internal)', false, 'Internal Shop-only spaces.'], ['Company (internal)', false, 'Internal Company-only spaces.'],
    ['Unresolved (internal)', false, 'Unresolved spaces retained on the physical map until an owner confirms their purpose.']
  ];
  const zoneByUse = { CUSTOMER: 'General Truck Parking', DAILY: 'General Truck Parking', WEEKLY: 'General Truck Parking', MONTHLY: 'General Truck Parking', CUSTOMER_BOBTAIL: 'Bobtail Parking', SHOP: 'Shop (internal)', SHOP_BOBTAIL: 'Shop (internal)', COMPANY: 'Company (internal)', NEEDS_CLASSIFICATION: 'Unresolved (internal)' };
  const zones = new Map();
  for (const [name, visible, description] of zoneDefinitions) {
    const result = await client.query(`INSERT INTO parking_zones(location_id,name,description,operational_notes,arrival_directions,exit_directions,display_order,active,public_visible)
      VALUES($1,$2,$3,'Imported Trucker Heaven physical-lot grouping.','Enter through the signed main entrance and follow marked circulation lanes.','Follow marked circulation lanes to the south exit.',10,true,$4)
      ON CONFLICT(location_id,name) DO UPDATE SET description=EXCLUDED.description,public_visible=EXCLUDED.public_visible,active=true
      RETURNING id`, [location.id, name, description, visible]);
    zones.set(name, result.rows[0].id);
  }
  const inventory = new Map();
  const zoneCategoryCodes = new Map([
    ['General Truck Parking', ['TRACTOR_TRAILER']], ['Bobtail Parking', ['BOBTAIL']],
    ['Shop (internal)', ['TRACTOR_TRAILER']], ['Company (internal)', ['TRACTOR_TRAILER']], ['Unresolved (internal)', ['BOBTAIL']]
  ]);
  for (const [name, zoneId] of zones) for (const code of zoneCategoryCodes.get(name)) {
    const result = await client.query(`INSERT INTO parking_inventory(zone_id,category_id,capacity,public_description,restrictions,public_remaining_capacity,active)
      VALUES($1,$2,0,$3,'Physical-space capacity is derived from the published lot map.',true,true)
      ON CONFLICT(zone_id,category_id) DO UPDATE SET active=true RETURNING id`, [zoneId, categoryByCode.get(code), `${name} ${code.replaceAll('_', ' ').toLowerCase()} parking`]);
    inventory.set(`${name}:${code}`, result.rows[0].id);
  }
  for (const [name, zoneId] of zones) {
    const allowed = zoneCategoryCodes.get(name);
    await client.query('UPDATE parking_inventory SET active=false WHERE zone_id=$1 AND category_id <> ALL($2::bigint[])', [zoneId, allowed.map(code => categoryByCode.get(code))]);
  }
  const ratePlans = await resolveImportRatePlans(client, location.id, zones, categoryByCode, zoneByUse);
  // The retired legacy unresolved zone is retained for historical foreign keys.
  // The explicit Unresolved (internal) zone above is the current nonpublic home
  // for physical spaces that still require an owner decision.
  await client.query(`UPDATE parking_inventory SET active=false WHERE zone_id IN
    (SELECT id FROM parking_zones WHERE location_id=$1 AND name='Unresolved bobtail')`, [location.id]);
  await client.query(`UPDATE parking_zones SET active=false,public_visible=false,description='Retired: all confirmed bobtail spaces are published.'
    WHERE location_id=$1 AND name='Unresolved bobtail'`, [location.id]);
  // Existing generic zones are retained for history but never exposed as a second public lot.
  if (productionTarget && baseline?.target?.kind === 'legacy') await client.query('UPDATE parking_zones SET public_visible=false WHERE id = ANY($1::bigint[])', [[baseline.target.zones.north.id, baseline.target.zones.south.id]]);
  else await client.query("UPDATE parking_zones SET public_visible=false WHERE location_id=$1 AND name IN ('North Zone','South Zone')", [location.id]);
  await step('after_legacy_zones_hidden');
  const draftResult = await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT' FOR UPDATE", [location.id]);
  let writableDraft = draftResult.rows[0];
  if (writableDraft && writableDraft.name !== data.name) {
    const nonGeneric = await client.query(`SELECT count(*)::int count FROM parking_layout_elements
      WHERE layout_id=$1 AND parking_spot_id IS NOT NULL AND label !~ '^[ABMNS]-[0-9]+$'`, [writableDraft.id]);
    const priorRealLotDraft = /^Trucker Heaven physical lot ·/.test(writableDraft.name);
    const approvedLegacyDraft = productionTarget && sameHumanName(writableDraft.name, LEGACY_LAYOUT_NAME);
    if (!priorRealLotDraft && !approvedLegacyDraft && (writableDraft.name !== 'Trucker Heaven Main Lot layout' || Number(nonGeneric.rows[0].count))) {
      throw new Error(`Refusing to overwrite unrelated draft layout '${writableDraft.name}'. Publish or remove it through the owner workflow first.`);
    }
    writableDraft = (await client.query('UPDATE parking_lot_layouts SET name=$1,updated_by_admin_user_id=$2 WHERE id=$3 RETURNING *', [data.name, owner.id, writableDraft.id])).rows[0];
  }
  if (!writableDraft) writableDraft = (await client.query(`INSERT INTO parking_lot_layouts(location_id,name,status,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,$2,'DRAFT',$3,$3) RETURNING *`, [location.id, data.name, owner.id])).rows[0];
  await client.query('DELETE FROM parking_layout_elements WHERE layout_id=$1', [writableDraft.id]);
  for (const space of spaces) {
    const zoneName = zoneByUse[space.use]; const zoneId = zones.get(zoneName); const inventoryId = inventory.get(`${zoneName}:${space.category}`); const visualKey = key(`space:${space.number}`);
    const existing = await client.query('SELECT id,visual_element_key FROM parking_spots WHERE location_id=$1 AND public_label=$2 FOR UPDATE', [location.id, String(space.number)]);
    const values = [zoneId, inventoryId, space.key, space.use, Boolean(space.publicBookable), space.classificationState || 'COMPLETE', space.note || '', space.number];
    let spot;
    if (existing.rowCount) {
      spot = (await client.query(`UPDATE parking_spots SET zone_id=$1,inventory_id=$2,physical_section=$3,parking_use=$4,public_bookable=$5,classification_state=$6,operational_label=$7,active=true,display_order=$8,version=version+1
        WHERE id=$9 RETURNING *`, [...values, existing.rows[0].id])).rows[0];
    } else {
      spot = (await client.query(`INSERT INTO parking_spots(location_id,zone_id,inventory_id,public_label,display_order,generated_group_key,visual_element_key,active,internal_notes,physical_section,parking_use,public_bookable,classification_state,operational_label)
        VALUES($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11,$12,$13) RETURNING *`, [location.id, zoneId, inventoryId, String(space.number), space.number, `trucker-heaven-${space.key}`, visualKey, space.note || '', space.key, space.use, Boolean(space.publicBookable), space.classificationState || 'COMPLETE', space.note || ''])).rows[0];
    }
    const item = geometry(space);
    const purpose = space.use === 'COMPANY' ? 'COMPANY' : ['SHOP', 'SHOP_BOBTAIL'].includes(space.use) ? 'SHOP' : space.use === 'NEEDS_CLASSIFICATION' ? 'UNRESOLVED' : 'CUSTOMER';
    const eligibility = bookingEligibility(space);
    const ratePlan = eligibility.customerEligible ? ratePlans.get(`${zoneId}:${categoryByCode.get(space.category)}`) : null;
    await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id)
      VALUES($1,'PARKING_SPOT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,20,true,true,$12,$13,$14,$15,$16,$17,$18)`, [writableDraft.id, spot.visual_element_key, String(space.number), zoneId, inventoryId, spot.id, item.x, item.y, item.width, item.height, item.rotation, purpose, eligibility.daily, eligibility.weekly, eligibility.monthly, eligibility.customerEligible, space.note || '', ratePlan?.id || null]);
  }
  await step('after_physical_spaces_created');
  await step('after_classifications_written');
  for (const [index, element] of data.elements.entries()) await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,x,y,width,height,rotation,layer_order,public_visible,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,true)`, [writableDraft.id, element.type, key(`element:${index}:${element.type}`), element.label, element.x, element.y, element.width, element.height, element.layer, element.public !== false]);
  await step('after_layout_elements_inserted');
  report.legacyBookingsRebound = await rebindCompatibleLegacyAssignments(client, writableDraft.id);
  const generic = await client.query(`UPDATE parking_spots SET active=false,public_bookable=false,classification_state='NEEDS_CLASSIFICATION',operational_label='Obsolete generic map space retained for history',version=version+1
    WHERE location_id=$1 AND public_label ~ '^[ABMNS]-[0-9]+$' AND active RETURNING public_label`, [location.id]);
  await step('after_generic_spaces_deactivated');
  await client.query('UPDATE parking_lot_layouts SET version=version+1,updated_by_admin_user_id=$2 WHERE id=$1', [writableDraft.id, owner.id]);
  report.genericDeactivated = generic.rows.map(row => row.public_label);
  const publisherSteps = {
    after_snapshot_created: 'after_layout_snapshot_created',
    after_previous_superseded: 'after_previous_layout_superseded',
    after_snapshot_published: 'after_new_layout_published'
  };
  const publication = await publishDraftSnapshot(client, { layoutId: writableDraft.id, actorId: owner.id, onStep: async name => {
    if (publisherSteps[name]) await step(publisherSteps[name]);
  } });
  report.publishedLayoutId = Number(publication.published.id);
  report.supersededLayoutId = publication.previous ? Number(publication.previous.id) : null;
  await step('before_commit');
  return { report, writableDraft, publication };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseImporterOptions(argv, env);
  const { apply, publish } = options;
  assertLayout();
  const pool = new Pool(poolOptions(options));
  const client = await pool.connect();
  try {
    const identity = (await client.query('SELECT current_database() database,current_user "user",inet_server_addr() host,inet_server_port() port')).rows[0];
    const baseline = options.productionTarget ? await readProductionBaseline(client) : null;
    validateConnectedTarget(identity, options, baseline);
    const location = options.productionTarget
      ? baseline.target.location
      : (await client.query(`SELECT id,name FROM parking_locations WHERE name='Trucker Heaven Main Lot'${apply ? ' FOR UPDATE' : ''}`)).rows[0];
    if (!location) throw new Error('Trucker Heaven Main Lot does not exist. Run the approved ParkingOps seed/setup first.');
    const categories = await client.query('SELECT id,code FROM parking_categories WHERE active');
    const categoryByCode = new Map(categories.rows.map(row => [row.code, row.id]));
    for (const code of ['TRACTOR_TRAILER', 'BOBTAIL']) if (!categoryByCode.has(code)) throw new Error(`Missing required category ${code}`);
    const owner = (await client.query("SELECT id FROM parking_admin_users WHERE role='OWNER' AND active ORDER BY id LIMIT 1")).rows[0];
    if (!owner) throw new Error('An active OWNER account is required to own the imported map version.');
    const zoneByUse = { CUSTOMER: 'General Truck Parking', DAILY: 'General Truck Parking', WEEKLY: 'General Truck Parking', MONTHLY: 'General Truck Parking', CUSTOMER_BOBTAIL: 'Bobtail Parking', SHOP: 'Shop (internal)', SHOP_BOBTAIL: 'Shop (internal)', COMPANY: 'Company (internal)', NEEDS_CLASSIFICATION: 'Unresolved (internal)' };
    const draft = (await client.query(`SELECT id,name,version FROM parking_lot_layouts WHERE location_id=$1 AND status='DRAFT'${apply ? ' FOR UPDATE' : ''}`, [location.id])).rows[0] || null;
    const existing = await client.query(`SELECT s.id,s.public_label,s.active,s.physical_section,s.parking_use,s.public_bookable,s.classification_state,s.operational_label,
      z.name zone_name,c.code category_code,e.element_type,e.label element_label,e.x,e.y,e.width,e.height,e.rotation,e.active element_active,e.public_visible element_public_visible,e.daily_eligible,e.weekly_eligible,e.monthly_eligible,e.space_public_bookable
      FROM parking_spots s JOIN parking_zones z ON z.id=s.zone_id JOIN parking_inventory i ON i.id=s.inventory_id JOIN parking_categories c ON c.id=i.category_id
      LEFT JOIN parking_layout_elements e ON e.parking_spot_id=s.id AND e.layout_id=$2
      WHERE s.location_id=$1`, [location.id, draft?.id || -1]);
    const existingByNumber = new Map(existing.rows.filter(row => /^\d+$/.test(row.public_label)).map(row => [Number(row.public_label), row]));
    const plan = spaces.map(space => {
      const current = existingByNumber.get(space.number); const item = geometry(space); const zoneName = zoneByUse[space.use];
      return { number: space.number, action: !current ? 'CREATE' : matchesSpacePlan(current, space, item, zoneName) ? 'UNCHANGED' : 'UPDATE' };
    });
    const historicGeneric = await client.query(`SELECT s.id,s.public_label,
      EXISTS(SELECT 1 FROM reservation_spot_assignments a WHERE a.parking_spot_id=s.id) assignment_history,
      EXISTS(SELECT 1 FROM parking_bookings b WHERE b.location_id=s.location_id AND b.assigned_spot_label=s.public_label) booking_history,
      EXISTS(SELECT 1 FROM parking_spot_blocks b WHERE b.parking_spot_id=s.id) block_history
      FROM parking_spots s WHERE s.location_id=$1 AND s.public_label ~ '^[ABMNS]-[0-9]+$' ORDER BY s.public_label`, [location.id]);
    const preservation = (await client.query(`SELECT
      (SELECT count(*)::int FROM parking_bookings WHERE location_id=$1) reservations,
      (SELECT count(*)::int FROM reservation_spot_assignments a JOIN parking_bookings b ON b.id=a.booking_id WHERE b.location_id=$1) assignments,
      (SELECT count(DISTINCT lower(email))::int FROM parking_bookings WHERE location_id=$1) customers,
      (SELECT count(DISTINCT NULLIF(tractor_unit_number,''))::int FROM parking_bookings WHERE location_id=$1) vehicles`, [location.id])).rows[0];
    const report = { mode: apply ? 'apply' : 'dry-run', publish, target: { expectedDatabase: options.expectedDatabase, production: options.productionTarget, hostname: options.hostClassification }, identity,
      legacyBaseline: baseline?.target ? { location: { id: Number(baseline.target.location.id), name: baseline.target.location.name }, zones: { north: { id: Number(baseline.target.zones.north.id), name: baseline.target.zones.north.name }, south: { id: Number(baseline.target.zones.south.id), name: baseline.target.zones.south.name } }, publishedLayout: { id: Number(baseline.target.layout.id), name: baseline.target.layout.name, version: Number(baseline.target.layout.version) } } : null,
      nameTransition: baseline?.target ? { location: 'REUSE_LEGACY_LOCATION_WITHOUT_RENAMING', zones: 'PRESERVE_LEGACY_ZONES_FOR_HISTORY_AND_HIDE_GENERIC_ZONES_ON_APPLY', duplicatePublicLocation: 'NO_CREATE' } : null,
      physicalSpaces: spaces.length,
      numbers: '10–90, 101–196, 197–204',
      spacePlan: { create: plan.filter(item => item.action === 'CREATE').map(item => item.number), update: plan.filter(item => item.action === 'UPDATE').map(item => item.number), unchanged: plan.filter(item => item.action === 'UNCHANGED').map(item => item.number), deactivate: historicGeneric.rows.map(item => item.public_label) },
      layout: { draft: draft ? { id: Number(draft.id), name: draft.name, version: Number(draft.version), action: 'REBUILD_CALIBRATED_ELEMENTS' } : { action: 'CREATE_DRAFT' }, structuralElements: data.elements.length, totalElements: spaces.length + data.elements.length, publish: publish ? 'CREATE_NEW_PUBLISHED_SNAPSHOT_AND_SUPERSEDE_CURRENT' : 'NO_PUBLISH', oldPublishedElements: 'UNCHANGED' },
      validations: { duplicateNumbers: [], prohibitedNumbers: [], geometryConflicts: [], buildingIntersections: [], activePhysicalCount: spaces.length },
      generic: historicGeneric.rows.map(item => ({ label: item.public_label, history: item.assignment_history || item.booking_history || item.block_history, action: 'deactivate-if-active' })),
      preservation: { reservations: { existing: preservation.reservations, plannedDeletion: 0 }, assignments: { existing: preservation.assignments, plannedDeletion: 0 }, customers: { existing: preservation.customers, plannedDeletion: 0 }, vehicles: { existing: preservation.vehicles, plannedDeletion: 0 }, genericHistoryDeletion: 0, historicalRewrites: 0, nonParkingOpsTableMutations: 0 },
      classifications: { unresolved: spaces.filter(space => space.classificationState === 'NEEDS_CLASSIFICATION').map(space => space.number), shop: spaces.filter(space => space.use === 'SHOP').map(space => space.number), company: spaces.filter(space => space.use === 'COMPANY').map(space => space.number) } };
    if (!apply) { console.log(JSON.stringify(report, null, 2)); return; }
    await client.query('BEGIN');
    await applyRealLotTransaction(client, { location, owner, categoryByCode, productionTarget: options.productionTarget, baseline, report });
    await client.query('COMMIT'); console.log(JSON.stringify(report, null, 2));
  } catch (error) { try { await client.query('ROLLBACK'); } catch (_) {} throw error; }
  finally { client.release(); await pool.end(); }
}
module.exports = { DEVELOPMENT_DATABASE, PRODUCTION_DATABASE, PRODUCTION_CONFIRMATION, REQUIRED_PRODUCTION_TABLES, LEGACY_GENERIC_LABELS, data, spaces, normalizeHumanName, sameHumanName, hasExpectedGenericLabels, selectLegacyProductionTarget, assertLayout, bookingEligibility, matchesSpacePlan, resolveImportRatePlans, rebindCompatibleLegacyAssignments, parseImporterOptions, validateConnectedTarget, readProductionBaseline, redactSecrets, poolOptions, applyRealLotTransaction, main };

if (require.main === module) main().catch(error => { console.error(`Real-lot import failed: ${redactSecrets(error.message)}`); process.exit(1); });
