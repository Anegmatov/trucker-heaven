const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTransition, blocksCapacity } = require('../services/bookingWorkflow');
const { durationFor, unitsFor } = require('../services/parkingService');

test('workflow only allows centralized transitions', () => {
  assert.doesNotThrow(() => assertTransition('PENDING', 'CONFIRMED'));
  assert.throws(() => assertTransition('CHECKED_OUT', 'CANCELLED'));
  assert.equal(blocksCapacity('PENDING'), false);
  assert.equal(blocksCapacity('CONFIRMED'), true);
  assert.equal(blocksCapacity('CANCELLED'), false);
});

test('public duration pricing keeps Daily days, Weekly seven-day units, and one recurring Monthly unit', () => {
  const start = '2026-07-01T10:00:00Z';
  assert.equal(durationFor(start, '2026-07-02T10:00:00Z'), 'DAILY');
  assert.equal(unitsFor(start, '2026-07-03T11:00:00Z', 'DAILY'), 3);
  assert.equal(durationFor(start, '2026-07-08T10:00:00Z'), 'DAILY');
  assert.equal(unitsFor(start, '2026-07-08T10:00:00Z', 'WEEKLY'), 1);
  assert.equal(unitsFor(start, '2026-07-16T10:00:00Z', 'WEEKLY'), 3);
  assert.equal(durationFor(start, '2026-07-29T10:00:00Z'), 'MONTHLY');
  assert.equal(unitsFor(start, '2026-07-29T10:00:00Z', 'MONTHLY'), 1);
  assert.equal(unitsFor(start, '2026-08-01T10:00:00Z', 'MONTHLY'), 1);
  assert.equal(unitsFor(start, '2026-08-02T11:00:00Z', 'MONTHLY'), 1);
});
