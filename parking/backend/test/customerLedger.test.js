const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../services/customerLedger');

test('billing periods and dates are canonical calendar values', () => {
  assert.equal(ledger.monthStart('2026-08'), '2026-08-01');
  assert.equal(ledger.monthStart('2026-08-14'), '2026-08-01');
  assert.equal(ledger.isoDate('2026-08-14'), '2026-08-14');
  assert.throws(() => ledger.monthStart('August 2026'), /Billing period/);
  assert.throws(() => ledger.isoDate('08/14/2026'), /YYYY-MM-DD/);
});

test('money remains integer cents including corrections and overpayments', () => {
  assert.equal(ledger.wholeCents(15000), 15000);
  assert.equal(ledger.wholeCents(-15000, 'Correction', { allowNegative: true }), -15000);
  assert.throws(() => ledger.wholeCents(150.5), /whole cents/);
  assert.throws(() => ledger.wholeCents(0), /positive/);
});

test('operational search normalization is exact and formatting-insensitive', () => {
  assert.equal(ledger.normalizedDigits('(662) 555-1212'), '6625551212');
  assert.equal(ledger.normalizedPlate('tn abc-123'), 'TNABC123');
  assert.equal(ledger.normalizedAuthority('USDOT # 3737570'), '3737570');
  assert.equal(ledger.normalizedAuthority('uncertain'), null);
});

test('Monthly billing dates are the first of the calendar month', () => {
  assert.equal(ledger.dueDateForPeriod('2026-02-01', '2025-01-31T12:00:00Z'), '2026-02-01');
  assert.equal(ledger.dueDateForPeriod('2028-02-01', '2025-01-31T12:00:00Z'), '2028-02-01');
});
