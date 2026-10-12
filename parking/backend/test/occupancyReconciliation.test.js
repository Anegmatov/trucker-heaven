const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
const workbook = require('../services/occupancyWorkbook');
const reconciliation = require('../services/occupancyReconciliation');

function style(display = null, rgb = null) {
  return { type: display ? 'solid' : null, foreground: rgb ? { rgb } : null, background: null,
    display, styleId: display ? 1 : 0, fillId: display ? 2 : 0 };
}

function rows(...values) { return [['LOT #','Customer','Phone','Email','','','','Plate','Unit','','','Rate'], ...values]; }

function production({ spots = [], assignments = [], identities = [], blocks = [] } = {}) {
  return { spots, assignments, identities, blocks };
}

function spot(label, overrides = {}) {
  return { id: Number(label), label: String(label), locationId: 1, zoneId: 1, inventoryId: 1, categoryId: 1,
    parkingUse: 'CUSTOMER', publicBookable: true, classificationState: 'COMPLETE', layoutId: 1,
    elementId: Number(label), parkingPurpose: 'CUSTOMER', dailyEligible: false, weeklyEligible: false,
    monthlyEligible: true, spacePublicBookable: true, ratePlanId: 1, ...overrides };
}

function assignment(spotId, overrides = {}) {
  return { id: spotId, spotId, bookingId: spotId, assignmentSource: 'CUSTOMER_SELECTED',
    assignedAt: '2026-08-01T00:00:00.000Z', reservedArrivalAt: '2026-08-01T00:00:00.000Z',
    reservedDepartureAt: '2026-09-01T00:00:00.000Z', protectedUntilAt: '2026-09-01T00:00:00.000Z',
    actualCheckOutAt: null, bookingStatus: 'CONFIRMED', customerId: 9, paymentStatus: 'NOT_REQUIRED',
    bookingCreatedAt: '2026-08-01T00:00:00.000Z', hasStripeEvidence: false, ...overrides };
}

function metadata() {
  return { filename: 'current.xlsx', sha256: 'a'.repeat(64), sheet: workbook.SHEET_NAME,
    modifiedAt: '2026-08-10T00:00:00.000Z' };
}

function classified(inputRows, styleEntries) {
  return workbook.classifyWorkbookRows(rows(...inputRows), new Map(styleEntries),
    { available: ['#FFFF00'], internal: ['#FF0000'] });
}

test('extracts exact direct RGB yellow and red fills from XLSX cell styles', () => {
  const archive = zipSync(Object.fromEntries(Object.entries({
    'xl/workbook.xml': `<workbook xmlns:r="r"><sheets><sheet name="${workbook.SHEET_NAME}" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="2"><c r="A2" s="1"/></row><row r="3"><c r="A3" s="2"/></row></sheetData></worksheet>',
    'xl/styles.xml': '<styleSheet><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill></fills><cellXfs count="3"><xf fillId="0"/><xf fillId="2" applyFill="1"/><xf fillId="3" applyFill="1"/></cellXfs></styleSheet>'
  }).map(([name, value]) => [name, strToU8(value)])));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parkingops-colors-'));
  const file = path.join(directory, 'colors.xlsx');
  fs.writeFileSync(file, archive);
  try {
    const parsed = workbook.lotCellStyles(file);
    assert.equal(parsed.get(2).foreground.rgb, 'FFFFFF00');
    assert.equal(parsed.get(2).display, '#FFFF00');
    assert.equal(parsed.get(3).foreground.rgb, 'FFFF0000');
    assert.equal(parsed.get(3).display, '#FF0000');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('occupied spreadsheet lot proposes a canonical customer assignment', () => {
  const source = classified([[20,'Customer A','','','','','','TN20','U20','','',250]], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(20)], identities: [{ sourceRow: 2, customerId: 7, vehicleId: 8 }] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'ASSIGNED');
  assert.equal(plan.rows[0].action, 'ASSIGN_CUSTOMER');
});

test('Excel date plate provenance is timezone-independent', () => {
  const source = classified([[129,'Legacy Customer','','','','','',new Date('2026-03-04T00:00:00.000Z'),'W93698']], [[2,style()]]);
  assert.equal(source.rows[0].plate, '2026-03-04');
  assert.equal(reconciliation.fingerprint(source.rows[0]), reconciliation.fingerprint({ ...source.rows[0], plate: '2026-03-04' }));
});

test('yellow AVAIL clears only stale occupancy and becomes available', () => {
  const source = classified([[21,'AVAIL']], [[2,style('#FFFF00','FFFFFF00')], [3,style('#FF0000','FFFF0000')]]);
  const stale = assignment(21, { reservedDepartureAt: '2026-08-05T00:00:00.000Z', protectedUntilAt: '2026-08-05T00:00:00.000Z' });
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(21)], assignments: [stale] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'AVAILABLE');
});

test('paid current ParkingOps reservation overrides spreadsheet AVAIL', () => {
  const source = classified([[22,'AVAIL']], [[2,style('#FFFF00','FFFFFF00')], [3,style('#FF0000','FFFF0000')]]);
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(22)], assignments: [assignment(22, { paymentStatus: 'PAID' })] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'PROTECTED_NEWER_PARKINGOPS');
});

test('newer current ParkingOps customer overrides spreadsheet customer', () => {
  const source = classified([[23,'Customer Old']], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const newer = assignment(23, { customerId: 99, bookingCreatedAt: '2026-08-12T00:00:00.000Z' });
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(23)], assignments: [newer], identities: [{ sourceRow: 2, customerId: 7 }] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'PROTECTED_NEWER_PARKINGOPS');
});

test('same customer in two spreadsheet lots produces two assignments, not two identities', () => {
  const source = classified([[24,'Customer A'],[25,'Customer A']], [[2,style()], [3,style()], [4,style('#FFFF00','FFFFFF00')], [5,style('#FF0000','FFFF0000')]]);
  const identities = [{ sourceRow: 2, customerId: 7 }, { sourceRow: 3, customerId: 7 }];
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(24),spot(25)], identities }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.deepEqual(plan.rows.map(row => row.resolution), ['ASSIGNED','ASSIGNED']);
  assert.deepEqual([...new Set(plan.rows.map(row => row.identity.customerId))], [7]);
});

test('duplicate lot claims remain conflicts and produce no mutation action', () => {
  const source = classified([[26,'Customer A'],[26,'AVAIL']], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(26)] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.deepEqual(plan.rows.map(row => row.resolution), ['CONFLICT_SKIPPED','CONFLICT_SKIPPED']);
  assert.ok(plan.rows.every(row => row.action === 'NONE'));
});

test('unresolved occupied lot is physically blocked instead of guessed or sold', () => {
  const source = classified([[27,'Customer A']], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(27)] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'OCCUPANCY_BLOCKED');
  assert.equal(plan.rows[0].action, 'BLOCK_UNRESOLVED');
});

test('physical occupancy proposal contains no inferred payment state', () => {
  const source = classified([[28,'Customer A']], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(28)], identities: [{ sourceRow: 2, customerId: 7 }] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'ASSIGNED');
  assert.equal('paymentStatus' in plan.rows[0], false);
});

test('historical ended assignment does not block current spreadsheet truth', () => {
  const source = classified([[29,'Customer New']], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const historical = assignment(29, { customerId: 3, bookingStatus: 'CHECKED_IN', reservedDepartureAt: '2026-08-02T00:00:00.000Z', protectedUntilAt: '2026-08-02T00:00:00.000Z' });
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(29)], assignments: [historical], identities: [{ sourceRow: 2, customerId: 7 }] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'ASSIGNED');
});

test('same reconciled customer and live lot assignment is idempotent NO_CHANGE', () => {
  const source = classified([[30,'Customer A']], [[2,style()], [3,style('#FFFF00','FFFFFF00')], [4,style('#FF0000','FFFF0000')]]);
  const existing = assignment(30, { customerId: 7, assignmentSource: 'SPREADSHEET_RECONCILIATION' });
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(30)], assignments: [existing], identities: [{ sourceRow: 2, customerId: 7 }] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].resolution, 'NO_CHANGE');
});

test('red exact fill always makes a lot internal and not publicly saleable', () => {
  const source = classified([[31,'Customer A']], [[2,style('#FF0000','FFFF0000')], [3,style('#FFFF00','FFFFFF00')]]);
  const plan = reconciliation.buildPlan(source, production({ spots: [spot(31)] }), metadata(), '2026-08-14T00:00:00.000Z');
  assert.equal(plan.rows[0].classification, 'SHOP_COMPANY_INTERNAL');
  assert.equal(plan.rows[0].action, 'SET_INTERNAL');
});

test('closing an unchecked stale assignment does not fabricate check-in or check-out evidence', async () => {
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (/UPDATE reservation_spot_assignments/.test(sql)) return { rowCount: 1, rows: [{ booking_id: 22 }] };
    if (/UPDATE parking_bookings/.test(sql)) return { rowCount: 1, rows: [{ id: 22, version: 4 }] };
    return { rowCount: 1, rows: [] };
  } };
  const closed = await reconciliation._private.closeStaleAssignment(client,
    { id: 5, bookingStatus: 'CONFIRMED' }, 1, '2026-08-14T00:00:00.000Z');
  assert.equal(closed, true);
  assert.match(statements[0], /CASE WHEN actual_check_in_at IS NULL THEN actual_check_out_at/);
  assert.doesNotMatch(statements[0], /actual_check_in_at\s*=/);
});

test('customer reconfiguration preserves the space canonical zone-local inventory', async () => {
  const statements = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (/SELECT element\.rate_plan_id/.test(sql)) return { rows: [{ rate_plan_id: 9 }] };
    return { rowCount: 1, rows: [] };
  } };
  await reconciliation._private.setCustomerConfiguration(client, {
    id: 101, label: '101', locationId: 1, inventoryId: 15, elementId: 901
  });
  assert.match(statements[0], /reference_inventory\.category_id=target_inventory\.category_id/);
  assert.doesNotMatch(statements[1], /inventory_id\s*=/);
  assert.match(statements[1], /parking_use='CUSTOMER'/);
});
