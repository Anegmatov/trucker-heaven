const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const data = require('../data/trucker-heaven-real-lot-layout.v1.json');
const importer = require('../scripts/importTruckerHeavenRealLot');

const developmentUrl = 'postgresql://developer:development-secret@dev.example/parkingops_dev_20260723_014831';
const productionUrl = 'postgresql://operator:production-secret@production.example/parkingops_prod';

function withUrlFile(url, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parkingops-importer-test-'));
  const filename = path.join(directory, 'database-url');
  fs.writeFileSync(filename, url, { mode: 0o600 });
  try { return work(filename); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function productionOptions(extra = [], url = productionUrl) {
  return withUrlFile(url, filename => importer.parseImporterOptions([
    '--database-url-file', filename, '--expected-database', 'parkingops_prod', '--production', ...extra
  ]));
}

function legacyBaseline(overrides = {}) {
  const locations = [{ id: 1, name: 'South Zone' }];
  const zones = [{ id: 1, location_id: 1, name: 'North Zone' }, { id: 5, location_id: 1, name: 'South  Zone' }];
  const spaces = Array.from(importer.LEGACY_GENERIC_LABELS, (public_label, index) => ({ id: index + 1, location_id: 1, zone_id: 1, public_label }));
  const layouts = [{ id: 2, location_id: 1, name: 'North Zone layout', version: 4, generic_spot_references: 25, generic_label_references: 25 }];
  return { locations, zones, spaces, layouts, ...overrides };
}

const expand = ([start, end]) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
test('real Trucker Heaven inventory is a 185-space physical numbered set with no 91–100', () => {
  const numbers = data.rows.flatMap(row => expand(row.range));
  assert.equal(numbers.length, 185);
  assert.equal(new Set(numbers).size, 185);
  assert.deepEqual(numbers.filter(number => number >= 91 && number <= 100), []);
  assert.ok(numbers.includes(10) && numbers.includes(90) && numbers.includes(101) && numbers.includes(196) && numbers.includes(204));
});
test('the authoritative lot allocation classifies every official customer, Shop, and Company range', () => {
  const byNumber = new Map(data.rows.flatMap(row => expand(row.range).map(number => [number, row])));
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => byNumber.get(from + index));
  for (const row of range(10, 67)) {
    assert.equal(row.use, 'CUSTOMER_BOBTAIL');
    assert.equal(row.category, 'BOBTAIL');
    assert.equal(row.publicBookable, true);
    assert.notEqual(row.classificationState, 'NEEDS_CLASSIFICATION');
  }
  for (const row of range(68, 90)) assert.deepEqual([row.use, row.publicBookable], ['SHOP', false]);
  for (const row of range(101, 204)) assert.deepEqual([row.use, row.category, row.publicBookable], ['CUSTOMER', 'TRACTOR_TRAILER', true]);
  const all = [...byNumber.values()];
  assert.equal(all.filter(row => row.use === 'CUSTOMER_BOBTAIL').length, 58);
  assert.equal(all.filter(row => row.use === 'CUSTOMER').length, 104);
  assert.equal(all.filter(row => row.use === 'SHOP').length, 23);
  assert.equal(all.filter(row => row.use === 'COMPANY').length, 0);
  assert.equal(all.filter(row => row.use === 'NEEDS_CLASSIFICATION').length, 0);
  assert.equal(all.filter(row => ['TRACTOR_ONLY', 'TRAILER_ONLY'].includes(row.category)).length, 0);
  assert.deepEqual([byNumber.get(164).use, byNumber.get(164).category, byNumber.get(164).publicBookable],
    ['CUSTOMER', 'TRACTOR_TRAILER', true]);
});

test('customer booking terms offer Weekly everywhere public while preserving Daily and Monthly base allocation', () => {
  let dailyCount = 0;
  let monthlyCount = 0;
  for (const space of importer.spaces) {
    const eligibility = importer.bookingEligibility(space);
    if (!eligibility.customerEligible) {
      assert.deepEqual(eligibility, { customerEligible: false, daily: false, weekly: false, monthly: false });
      continue;
    }
    const isDaily = (space.number >= 101 && space.number <= 129) || space.category === 'BOBTAIL';
    assert.equal(eligibility.daily, isDaily, `Unexpected Daily classification for Space ${space.number}`);
    assert.equal(eligibility.weekly, true, `Space ${space.number} must offer Weekly parking`);
    assert.equal(eligibility.monthly, space.number < 101 || space.number > 129, `Unexpected Monthly classification for Space ${space.number}`);
    if (eligibility.daily) dailyCount += 1;
    if (eligibility.monthly) monthlyCount += 1;
  }
  assert.equal(dailyCount, 87);
  assert.equal(monthlyCount, 133);
});

test('PDF-calibrated geometry preserves the original paired and stacked physical relationships', () => {
  const row = key => data.rows.find(item => item.key === key);
  assert.deepEqual(row('west-north-monthly').range, [165, 196]);
  assert.equal(row('west-middle-bobtail').range[0], 60);
  assert.equal(row('west-middle-bobtail').y > row('west-north-monthly').y + 32 * (row('west-north-monthly').height + row('west-north-monthly').gap), true);
  assert.equal(row('upper-bobtail-west').range[0], 37);
  assert.equal(row('upper-bobtail-east').numberDirection, 'DESCENDING');
  assert.equal(row('west-middle-bobtail').width < row('west-north-monthly').width, true);
  assert.equal(row('west-middle-bobtail').height < row('west-north-monthly').height, true);
  assert.equal(row('middle-197').y + row('middle-197').height, 57);
  assert.ok(row('middle-shop-south').y > row('middle-197').y);
  assert.equal(row('east-daily-101').numberDirection, 'DESCENDING');
  assert.equal(row('west-shop').use, 'SHOP');
  assert.equal(row('east-north-approach'), undefined);
});

test('calibrated parking rectangles are bounded and do not overlap', () => {
  const rectangles = data.rows.flatMap(row => expand(row.range).map((_, index) => {
    const columns = Number(row.columns || 1);
    const column = index % columns;
    const line = Math.floor(index / columns);
    return { key: `${row.key}-${index}`, x: row.x + column * (row.width + (row.gap || 0)), y: row.y + line * (row.step || (row.height + (row.gap || 0))), width: row.width, height: row.height };
  }));
  for (const rectangle of rectangles) {
    assert.ok(rectangle.x >= 0 && rectangle.y >= 0 && rectangle.x + rectangle.width <= 100 && rectangle.y + rectangle.height <= 100, rectangle.key);
  }
  for (let index = 0; index < rectangles.length; index += 1) for (let other = index + 1; other < rectangles.length; other += 1) {
    const a = rectangles[index], b = rectangles[other];
    const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.equal(overlaps, false, `${a.key} overlaps ${b.key}`);
  }
  for (const obstruction of data.elements.filter(item => ['BUILDING', 'BARRIER'].includes(item.type))) for (const space of rectangles) {
    const overlaps = space.x < obstruction.x + obstruction.width && space.x + space.width > obstruction.x && space.y < obstruction.y + obstruction.height && space.y + space.height > obstruction.y;
    assert.equal(overlaps, false, `${space.key} overlaps ${obstruction.label}`);
  }
});

test('importer defaults to a dry-run and preserves the existing explicit development command', () => {
  const options = importer.parseImporterOptions([], { DATABASE_URL: developmentUrl });
  assert.equal(options.apply, false);
  assert.equal(options.publish, false);
  assert.equal(options.expectedDatabase, importer.DEVELOPMENT_DATABASE);
  assert.doesNotThrow(() => importer.validateConnectedTarget({ database: importer.DEVELOPMENT_DATABASE }, options));
});

test('importer rejects missing URLs and production invocations without an expected production target', () => {
  assert.throws(() => importer.parseImporterOptions([], {}), /explicit ParkingOps DATABASE_URL/);
  assert.throws(() => importer.parseImporterOptions(['--production'], {}), /only valid with --expected-database parkingops_prod/);
});

test('importer requires an explicit remote URL file and production flag for production dry-runs', () => {
  withUrlFile(productionUrl, filename => {
    assert.throws(() => importer.parseImporterOptions(['--database-url-file', filename, '--expected-database', 'parkingops_prod']), /--production is required/);
  });
  assert.throws(() => productionOptions([], 'postgresql://operator:secret@localhost/parkingops_prod'), /host must be remote/);
  const options = productionOptions();
  assert.equal(options.apply, false);
  assert.equal(options.publish, false);
  assert.equal(options.databaseUrlFile.endsWith('database-url'), true);
  assert.deepEqual(importer.poolOptions(options).ssl, { rejectUnauthorized: true });
});

test('importer cannot target unapproved, local, test, IFTA, or legacy PostgreSQL databases', () => {
  for (const database of ['parkingops_test', 'ifta_db', 'trucker_heaven_postgres', 'unknown_parkingops']) {
    assert.throws(() => importer.parseImporterOptions(['--expected-database', database], { DATABASE_URL: `postgresql://u:p@host.example/${database}` }), /approved ParkingOps target/);
  }
});

test('importer verifies the connected database and recognized production schema before any plan is built', () => {
  const options = productionOptions();
  assert.throws(() => importer.validateConnectedTarget({ database: importer.DEVELOPMENT_DATABASE }, options), /connected database/);
  assert.throws(() => importer.validateConnectedTarget({ database: importer.PRODUCTION_DATABASE }, options, { tables: [] }), /required ParkingOps tables/);
  const baseline = { tables: importer.REQUIRED_PRODUCTION_TABLES, target: importer.selectLegacyProductionTarget(legacyBaseline()) };
  assert.doesNotThrow(() => importer.validateConnectedTarget({ database: importer.PRODUCTION_DATABASE }, options, baseline));
});

test('legacy name normalization collapses whitespace without accepting unrelated names', () => {
  assert.equal(importer.normalizeHumanName(' South\t Zone  '), 'South Zone');
  assert.equal(importer.sameHumanName(' south  zone ', 'South Zone'), true);
  for (const name of ['South Parking', 'North Zone', 'South Yard']) assert.equal(importer.sameHumanName(name, 'South Zone'), false);
});

test('a structurally complete legacy production baseline selects one related location without Trucker Heaven Main Lot', () => {
  const target = importer.selectLegacyProductionTarget(legacyBaseline({ locations: [{ id: 1, name: ' south zone ' }] }));
  assert.deepEqual(target.location, { id: 1, name: ' south zone ' });
  assert.equal(target.zones.north.id, 1);
  assert.equal(target.zones.south.id, 5);
  assert.equal(target.layout.id, 2);
  assert.equal(target.genericSpaceCount, 25);
});

test('legacy selection rejects missing structural evidence, conflicting numeric inventory, and cross-location zones', () => {
  assert.throws(() => importer.selectLegacyProductionTarget(legacyBaseline({ spaces: [] })), /legacy baseline records/);
  assert.throws(() => importer.selectLegacyProductionTarget(legacyBaseline({ layouts: [] })), /legacy baseline records/);
  assert.throws(() => importer.selectLegacyProductionTarget(legacyBaseline({ spaces: [...legacyBaseline().spaces, { id: 99, location_id: 1, zone_id: 1, public_label: '101' }] })), /legacy baseline records/);
  assert.throws(() => importer.selectLegacyProductionTarget(legacyBaseline({ zones: [{ id: 1, location_id: 1, name: 'North Zone' }, { id: 5, location_id: 2, name: 'South Zone' }] })), /legacy baseline records/);
});

test('legacy selection rejects multiple plausible locations and missing table validation remains mandatory', () => {
  const first = legacyBaseline();
  const second = { id: 2, name: 'South Zone' };
  const duplicate = {
    locations: [...first.locations, second],
    zones: [...first.zones, { id: 11, location_id: 2, name: 'North Zone' }, { id: 15, location_id: 2, name: 'South Zone' }],
    spaces: [...first.spaces, ...first.spaces.map(space => ({ ...space, id: space.id + 100, location_id: 2, zone_id: 11 }))],
    layouts: [...first.layouts, { id: 12, location_id: 2, name: 'North Zone layout', version: 4, generic_spot_references: 25, generic_label_references: 25 }]
  };
  assert.throws(() => importer.selectLegacyProductionTarget(duplicate), /multiple structurally valid legacy locations/);
  const options = productionOptions();
  assert.throws(() => importer.validateConnectedTarget({ database: importer.PRODUCTION_DATABASE }, options, { tables: [], target: {} }), /required ParkingOps tables/);
});

test('production writes require the exact confirmation and publishing remains explicit', () => {
  assert.throws(() => productionOptions(['--apply', '--publish']), /exact --confirm-production value/);
  assert.throws(() => productionOptions(['--apply', '--publish', '--confirm-production', 'wrong']), /exact --confirm-production value/);
  assert.throws(() => productionOptions(['--apply', '--confirm-production', importer.PRODUCTION_CONFIRMATION]), /unsafe apply-only/);
  assert.doesNotThrow(() => productionOptions(['--apply', '--publish', '--confirm-production', importer.PRODUCTION_CONFIRMATION]));
  assert.throws(() => importer.parseImporterOptions(['--publish'], { DATABASE_URL: developmentUrl }), /--publish requires --apply/);
  assert.doesNotThrow(() => importer.parseImporterOptions(['--apply', '--publish'], { DATABASE_URL: developmentUrl }));
});

test('importer redacts URL credentials and keeps idempotency/layout validation available', () => {
  const secret = 'postgresql://operator:super-secret@production.example/parkingops_prod';
  assert.equal(importer.redactSecrets(`failed ${secret}`), 'failed [REDACTED_DATABASE_URL]');
  assert.doesNotThrow(() => importer.assertLayout());
});
