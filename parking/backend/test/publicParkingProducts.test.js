'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SUPPORTED_PUBLIC_DURATIONS, assertSupportedPublicDuration, filterSupportedPublicDurations } = require('../services/publicParkingProducts');
const { requestedDuration, validateBookingPolicy } = require('../services/bookingPolicy');

test('the public product allowlist contains Daily, Weekly, and Monthly', () => {
  assert.deepEqual(SUPPORTED_PUBLIC_DURATIONS, ['DAILY', 'WEEKLY', 'MONTHLY']);
  assert.deepEqual(filterSupportedPublicDurations([{ code: 'DAILY' }, { code: 'WEEKLY' }, { code: 'MONTHLY' }]).map(item => item.code), ['DAILY', 'WEEKLY', 'MONTHLY']);
});

test('explicit Weekly requests are supported while unknown products fail closed', () => {
  assert.equal(assertSupportedPublicDuration('WEEKLY'), 'WEEKLY');
  assert.equal(requestedDuration('WEEKLY', '2030-01-01T00:00:00Z', '2030-01-08T00:00:00Z'), 'WEEKLY');
  assert.throws(() => assertSupportedPublicDuration('YEARLY'), error => error.code === 'UNSUPPORTED_PRODUCT_DURATION' && error.status === 422);
});

test('explicit public products remain explicit instead of being derived from dates', () => {
  assert.equal(requestedDuration('DAILY', '2030-01-01T00:00:00Z', '2030-01-08T00:00:00Z'), 'DAILY');
  assert.equal(requestedDuration('MONTHLY', '2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'), 'MONTHLY');
  assert.equal(requestedDuration('WEEKLY', '2030-01-01T00:00:00Z', '2030-01-08T00:00:00Z'), 'WEEKLY');
  assert.equal(requestedDuration('DAILY', '2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'), 'DAILY');
  assert.equal(requestedDuration('MONTHLY', '2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z'), 'MONTHLY');
});

test('booking policy validates the explicit product against its own interval rules', () => {
  const now = Date.parse('2029-12-01T00:00:00Z');
  assert.equal(validateBookingPolicy('2030-01-01T00:00:00Z', '2030-01-29T00:00:00Z', 'UTC', 'MONTHLY', now), 'MONTHLY');
  assert.equal(validateBookingPolicy('2030-01-01T00:00:00Z', '2030-01-08T00:00:00Z', 'UTC', 'WEEKLY', now), 'WEEKLY');
  assert.throws(() => validateBookingPolicy('2030-01-01T00:00:00Z', '2030-01-07T00:00:00Z', 'UTC', 'WEEKLY', now), error => error.code === 'WEEKLY_STAY_TOO_SHORT');
  assert.equal(validateBookingPolicy('2030-01-01T00:00:00Z', null, 'UTC', 'MONTHLY', now), 'MONTHLY');
  assert.throws(() => validateBookingPolicy('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z', 'UTC', 'DAILY', now), error => error.code === 'BOOKING_STAY_TOO_LONG' && /daily/.test(error.message));
});
