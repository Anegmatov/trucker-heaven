const test = require('node:test');
const assert = require('node:assert/strict');
const { operationalStatus, isAvailableCustomerSpace, mergeIntervals, iso } = require('../services/liveLotReadModel');

test('operational status precedence preserves physical blocking and occupancy semantics', () => {
  assert.equal(operationalStatus({ active: false, block: { id: 1 }, booking: { status: 'CHECKED_IN' } }), 'INACTIVE');
  assert.equal(operationalStatus({ active: true, block: { id: 1 }, booking: { status: 'CHECKED_IN' } }), 'BLOCKED');
  assert.equal(operationalStatus({ active: true, block: null, booking: { status: 'CHECKED_IN' } }), 'OCCUPIED');
  assert.equal(operationalStatus({ active: true, block: null, booking: { status: 'CONFIRMED' } }), 'RESERVED');
  assert.equal(operationalStatus({ active: true, block: null, booking: { status: 'PENDING' } }), 'AVAILABLE');
  assert.equal(operationalStatus({ active: true, block: null, booking: null }), 'AVAILABLE');
});

test('customer availability requires a configured product and effective rate plan and excludes internal spaces', () => {
  const availableCustomer = index => ({ id: index, active: true, publicBookable: true, operationalStatus: 'AVAILABLE', parkingPurpose: 'CUSTOMER', classificationState: 'COMPLETE', vehicleEligibility: [{ id: 1 }], dailyEligible: true, weeklyEligible: false, monthlyEligible: false, ratePlan: { id: 1, active: true } });
  const spaces = [
    ...Array.from({ length: 157 }, (_, index) => availableCustomer(index + 1)),
    ...Array.from({ length: 20 }, (_, index) => ({ ...availableCustomer(index + 158), parkingPurpose: 'SHOP' })),
    ...Array.from({ length: 8 }, (_, index) => ({ ...availableCustomer(index + 178), parkingPurpose: 'UNRESOLVED', classificationState: 'NEEDS_CLASSIFICATION', vehicleEligibility: [] }))
  ];
  assert.equal(spaces.length, 185);
  assert.equal(spaces.filter(isAvailableCustomerSpace).length, 157);
  assert.equal(isAvailableCustomerSpace({ ...availableCustomer(999), ratePlan: null }), false);
  assert.equal(isAvailableCustomerSpace({ ...availableCustomer(998), dailyEligible: false }), false);
  assert.equal(isAvailableCustomerSpace({ ...availableCustomer(1000), publicBookable: false }), false);
});

test('timeline uses half-open boundaries, inserts availability, and gives blocks precedence', () => {
  const intervals = mergeIntervals([
    { type: 'RESERVED', reservationId: 1, startsAt: '2032-01-01T10:00:00.000Z', endsAt: '2032-01-01T12:00:00.000Z' },
    { type: 'BLOCKED', blockId: 9, startsAt: '2032-01-01T11:00:00.000Z', endsAt: '2032-01-01T11:30:00.000Z' },
    { type: 'RESERVED', reservationId: 2, startsAt: '2032-01-01T12:00:00.000Z', endsAt: '2032-01-01T13:00:00.000Z' }
  ], '2032-01-01T09:00:00.000Z', '2032-01-01T14:00:00.000Z');
  assert.deepEqual(intervals.map(item => [item.type, item.startsAt, item.endsAt, item.reservationId || null]), [
    ['AVAILABLE', '2032-01-01T09:00:00.000Z', '2032-01-01T10:00:00.000Z', null],
    ['RESERVED', '2032-01-01T10:00:00.000Z', '2032-01-01T11:00:00.000Z', 1],
    ['BLOCKED', '2032-01-01T11:00:00.000Z', '2032-01-01T11:30:00.000Z', null],
    ['RESERVED', '2032-01-01T11:30:00.000Z', '2032-01-01T12:00:00.000Z', 1],
    ['RESERVED', '2032-01-01T12:00:00.000Z', '2032-01-01T13:00:00.000Z', 2],
    ['AVAILABLE', '2032-01-01T13:00:00.000Z', '2032-01-01T14:00:00.000Z', null]
  ]);
});

test('operational timestamps require an explicit offset', () => {
  assert.throws(() => iso('2032-01-01T10:00:00', 'Operational time'), { code: 'OPERATIONAL_TIME_OFFSET_REQUIRED' });
  assert.throws(() => iso('not-a-time', 'Operational time'), { code: 'OPERATIONAL_TIME_OFFSET_REQUIRED' });
});
