const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const importer = require('../services/customerImport');

const fixture = path.join(__dirname, 'fixtures', 'customer-import-fixture.xlsx');

test('fixture workbook parses the actual parking-ledger shape without changing the file', async () => {
  const before = await importer.fileMetadata(fixture);
  const rows = await importer.readWorkbook(fixture);
  const analysis = importer.analyzeRows(rows);
  const after = await importer.fileMetadata(fixture);
  assert.equal(before.sha256, after.sha256);
  assert.equal(analysis.sheet, 'PARKING PAYMENT MANAGEMENT');
  assert.equal(analysis.rowsInspected, 10);
  assert.deepEqual(analysis.periods.map(period => period.period), ['2025-06', '2025-07', '2025-08', '2025-09']);
  assert.equal(analysis.candidates.filter(row => row.classification === 'NEW_CUSTOMER').length, 5);
  assert.equal(analysis.candidates.filter(row => row.classification === 'BLOCKING_IDENTITY_CONFLICT').length, 2);
  assert.equal(analysis.candidates.filter(row => row.classification === 'NON_CUSTOMER').length, 3);
});

test('dated Daily operational placeholders never become customer accounts', () => {
  const headers = ['LOT #','Customer name / Company name/ Tel # /DOT','PHONE#','EMAIL ADD','FOLLOWUP','DOT/MC #','DATE','License plate','Unit #','Truck','KEYS','Rate',new Date('2025-06-01T00:00:00Z')];
  const analysis = importer.analyzeRows([
    headers,
    [141,'DAILY 07/03TO 08/03',null,null,null,'USDOT 123456',null,null,null,null,null,19,'PAID']
  ]);
  assert.equal(analysis.candidates[0].classification, 'NON_CUSTOMER');
});

test('an Excel date in the plate column is retained only as raw provenance', () => {
  const headers = ['LOT #','Customer name / Company name/ Tel # /DOT','PHONE#','EMAIL ADD','FOLLOWUP','DOT/MC #','DATE','License plate','Unit #','Truck','KEYS','Rate',new Date('2025-06-01T00:00:00Z')];
  const plateCell = new Date('2026-03-04T00:00:00Z');
  const analysis = importer.analyzeRows([
    headers,
    [129,'Legacy Customer','615-555-0129',null,null,null,null,plateCell,'W93698','TRL 1127',null,250,'PAID']
  ]);
  assert.deepEqual(analysis.candidates[0].plates, []);
  assert.equal(analysis.candidates[0].plate, null);
  assert.equal(analysis.candidates[0].rawLicensePlateCell, '2026-03-04');
  assert.equal(importer.executionPlan(analysis).vehicleRecords, 1);
});

test('payment cells preserve exact amount, status-only, and ambiguous provenance', () => {
  assert.deepEqual(importer.paymentCell('PAID 125', null, 15000, 'M2'), {
    confidence: 'EXACT_AMOUNT', paymentAmountCents: 12500, sourceRef: 'M2', raw: 'PAID 125'
  });
  assert.deepEqual(importer.paymentCell('PAID FULL Y', null, 15000, 'M2'), {
    confidence: 'EXACT_STATUS_ONLY', paymentAmountCents: 15000, sourceRef: 'M2', raw: 'PAID FULL Y'
  });
  assert.equal(importer.paymentCell('$75 + $150', null, 15000, 'M2').confidence, 'AMBIGUOUS');
  assert.equal(importer.paymentCell('NOT PAID', null, 15000, 'M2').statusOnly, 'DUE');
  assert.equal(importer.paymentCell('??', null, 15000, 'M2').confidence, 'NON_FINANCIAL_LEGACY_ANOMALY');
});

test('compatible name plus exact plate groups an identity while name alone never does', () => {
  const headers = ['LOT #','Customer name / Company name/ Tel # /DOT','PHONE#','EMAIL ADD','FOLLOWUP','DOT/MC #','DATE','License plate','Unit #','Truck','KEYS','Rate',new Date('2025-06-01T00:00:00Z')];
  const analysis = importer.analyzeRows([
    headers,
    [10,'Same Name',null,null,null,null,null,'TN SAME1','1',null,null,150,'PAID'],
    [11,'Same Name',null,null,null,null,null,'TN DIFFERENT','2',null,null,150,'PAID'],
    [12,'Same Name LLC',null,null,null,null,null,'TN SAME1','3',null,null,150,'PAID']
  ]);
  assert.deepEqual(analysis.candidates.map(row => row.classification), [
    'NEW_CUSTOMER', 'NEW_CUSTOMER', 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE'
  ]);
  const index = {
    customers: new Map([[9, { id: 9, public_id: 'cust_existing_abcdefghijklmnop' }]]),
    bySignal: new Map([['plate:TNSAME1', new Set([9])]]), names: new Map([[9, 'DIFFERENTNAME']]), periods: new Set()
  };
  importer.compareToProduction(analysis, index);
  assert.equal(analysis.candidates[1].classification, 'NEW_CUSTOMER');
});

test('production comparison uses exact strong signals and flags cross-customer or period conflicts', () => {
  const headers = ['LOT #','Customer name / Company name/ Tel # /DOT','PHONE#','EMAIL ADD','FOLLOWUP','DOT/MC #','DATE','License plate','Unit #','Truck','KEYS','Rate',new Date('2025-06-01T00:00:00Z')];
  const analysis = importer.analyzeRows([
    headers,
    [10,'Exact Customer','615-555-0111','exact@example.test',null,'USDOT 123456',null,'TN EX1','1',null,null,150,'PAID']
  ]);
  const customer = { id: 7, public_id: 'cust_existing_abcdefghijklmnop' };
  const index = {
    customers: new Map([[7, customer]]),
    bySignal: new Map([
      ['phone:+16155550111', new Set([7])], ['email:exact@example.test', new Set([7])], ['dot:123456', new Set([7])]
    ]), names: new Map([[7, ['Exact Customer']]]), periods: new Set()
  };
  importer.compareToProduction(analysis, index);
  assert.equal(analysis.candidates[0].classification, 'MATCH_EXISTING');
  assert.equal(analysis.candidates[0].matchedCustomerId, 7);

  const overlap = importer.analyzeRows([
    headers,
    [10,'Exact Customer','615-555-0111','exact@example.test',null,'USDOT 123456',null,'TN EX1','1',null,null,150,'PAID']
  ]);
  importer.compareToProduction(overlap, { ...index, periods: new Set(['7:2025-06']) });
  assert.equal(overlap.candidates[0].classification, 'BLOCKING_IDENTITY_CONFLICT');
  assert.deepEqual(overlap.candidates[0].overlappingPeriods, ['2025-06']);
});

test('dry-run report is aggregate-safe and explicitly states no production mutation', async () => {
  const metadata = await importer.fileMetadata(fixture);
  const analysis = importer.analyzeRows(await importer.readWorkbook(fixture));
  const result = importer.report(analysis, metadata);
  assert.equal(result.reportVersion, 2);
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.productionMutationOccurred, false);
  assert.equal(result.productionCompared, false);
  assert.ok(result.historicalBillingPeriodsProposed > 0);
  assert.ok(result.uncertainPaymentCells > 0);
});

function identityHeaders() {
  return ['LOT #','Customer name / Company name/ Tel # /DOT','PHONE#','EMAIL ADD','FOLLOWUP','DOT/MC #','DATE',
    'License plate','Unit #','Truck','KEYS','Rate',new Date('2025-06-01T00:00:00Z')];
}

test('same DOT with different names and phones remains separate carrier-affiliated customers', () => {
  const analysis = importer.analyzeRows([
    identityHeaders(),
    [10,'Customer A','615-555-0101',null,null,'DOT 123',null,'TN A1','A',null,null,150,'PAID'],
    [11,'Customer B','615-555-0102',null,null,'DOT 123',null,'TN B2','B',null,null,150,'PAID']
  ]);
  assert.deepEqual(analysis.candidates.map(row => row.classification), [
    'SEPARATE_CUSTOMER_SHARED_CARRIER', 'SEPARATE_CUSTOMER_SHARED_CARRIER'
  ]);
  assert.equal(importer.executionPlan(analysis).uniqueLegacyCustomerIdentities, 2);
});

test('same compatible customer and phone consolidates multiple vehicle and space rows', () => {
  const analysis = importer.analyzeRows([
    identityHeaders(),
    [10,'Kevin Gordon','631-774-7331','kevin@example.test',null,'DOT 2122066',null,'TN A1','28',null,null,250,'PAID'],
    [11,'Kevin Gordon','6317747331','kevin@example.test',null,'DOT 2122066',null,'TN B2','14001',null,null,250,'PAID']
  ]);
  assert.deepEqual(analysis.candidates.map(row => row.classification), [
    'NEW_CUSTOMER', 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE'
  ]);
  assert.equal(importer.executionPlan(analysis).uniqueLegacyCustomerIdentities, 1);
  assert.equal(importer.executionPlan(analysis).vehicleRecords, 2);
});

test('company suffix variation groups only when a direct phone signal confirms it', () => {
  const matched = importer.analyzeRows([
    identityHeaders(),
    [10,'Towfiq Salah ROSSO TRUCKING','503-791-4833',null,null,'DOT 1895474',null,'TN A1','114',null,null,250,'PAID'],
    [11,'Towfiq Salah','5037914833',null,null,'DOT 1895474',null,'TN B2','456',null,null,250,'PAID']
  ]);
  assert.equal(matched.candidates[1].classification, 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE');
  const separate = importer.analyzeRows([
    identityHeaders(),
    [10,'Towfiq Salah ROSSO TRUCKING','503-791-4833',null,null,'DOT 1895474',null,'TN A1','114',null,null,250,'PAID'],
    [11,'Towfiq Salah','5037919999',null,null,'DOT 1895474',null,'TN B2','456',null,null,250,'PAID']
  ]);
  assert.deepEqual(separate.candidates.map(row => row.classification), [
    'SEPARATE_CUSTOMER_SHARED_CARRIER', 'SEPARATE_CUSTOMER_SHARED_CARRIER'
  ]);
});

test('approved legacy typo, addition expression, missing, zero, and corrupt evidence parse safely', () => {
  const typo = importer.paymentCell('PIAD 250', null, 35000, 'N177');
  assert.equal(typo.paymentAmountCents, 25000);
  assert.equal(typo.normalization, 'PIAD_TO_PAID');
  const expression = importer.paymentCell('PAID 280+19+19', 318, 25000, 'Q176');
  assert.equal(expression.paymentAmountCents, 31800);
  assert.equal(expression.normalization, 'VERIFIED_ADDITION_EXPRESSION');
  for (const anomaly of [
    importer.paymentCell('Missing', 'MISSING', 25000, 'W172'),
    importer.paymentCell(null, 0, 15000, 'AA10'),
    importer.paymentCell('PAIS6`', '1q2222w3e56222222222', 15000, 'S33')
  ]) {
    assert.equal(anomaly.confidence, 'NON_FINANCIAL_LEGACY_ANOMALY');
    assert.equal(anomaly.paymentAmountCents, null);
  }
});
