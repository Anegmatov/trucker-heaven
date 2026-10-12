const test = require('node:test');
const assert = require('node:assert/strict');
const { locationInterval } = require('../utils');
const { validateBookingPolicy, monthlyOccupancyEnd } = require('../services/bookingPolicy');
const { monthlyInitialCents } = require('../services/parkingService');

test('Monthly accepts a start without an end and retains a separate technical occupancy horizon', () => {
  const interval = locationInterval('2026-09-15T09:00', '', 'America/Chicago', { allowOpenEnded: true });
  assert.equal(interval.end, null);
  assert.equal(validateBookingPolicy(interval.start, interval.end, 'America/Chicago', 'MONTHLY', Date.parse('2026-09-01T00:00:00Z')), 'MONTHLY');
  assert.equal(monthlyOccupancyEnd(), '9999-12-31T23:59:59.999Z');
});

test('Monthly initial billing is one $250 unit on the first and prorates the remainder of a calendar month', () => {
  assert.equal(monthlyInitialCents(25000, '2026-09-01T14:00:00.000Z', 'America/Chicago'), 25000);
  assert.equal(monthlyInitialCents(25000, '2026-09-15T14:00:00.000Z', 'America/Chicago'), 13333);
  assert.equal(monthlyInitialCents(25000, '2026-10-01T14:00:00.000Z', 'America/Chicago'), 25000);
});

test('Monthly proration uses exact 28, 29, 30, and 31-day calendar months with canonical cent rounding', () => {
  assert.equal(monthlyInitialCents(25000, '2027-02-15T15:00:00.000Z', 'America/Chicago'), 12500);
  assert.equal(monthlyInitialCents(25000, '2028-02-15T15:00:00.000Z', 'America/Chicago'), 12931);
  assert.equal(monthlyInitialCents(25000, '2026-09-15T14:00:00.000Z', 'America/Chicago'), 13333);
  assert.equal(monthlyInitialCents(25000, '2026-10-15T14:00:00.000Z', 'America/Chicago'), 13710);
  assert.equal(monthlyInitialCents(25000, '2026-04-30T14:00:00.000Z', 'America/Chicago'), 833);
  assert.equal(monthlyInitialCents(25000, '2026-10-31T14:00:00.000Z', 'America/Chicago'), 806);
});

test('Daily continues to require an end date', () => {
  assert.throws(() => validateBookingPolicy('2026-09-15T14:00:00.000Z', null, 'America/Chicago', 'DAILY', Date.parse('2026-09-01T00:00:00Z')), /Departure is required/);
});
