'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eligibilityErrors, productEligible } = require('../services/spaceProductEligibility');

const now = Date.parse('2032-01-01T00:00:00.000Z');
const configuration = {
  purpose: 'CUSTOMER', active: true, publicBookable: true, classificationComplete: true,
  dailyEligible: false, weeklyEligible: false, monthlyEligible: false,
  ratePlanId: 7, locationId: 1, zoneId: 2, categoryId: 3
};
const plan = {
  id: 7, location_id: 1, zone_id: 2, category_id: 3, active: true,
  starts_at: null, ends_at: null, daily_rate_cents: 1900,
  weekly_rate_cents: 10000, monthly_rate_cents: 25000
};

test('daily-only space is eligible for DAILY', () => {
  assert.equal(productEligible({ ...configuration, dailyEligible: true }, plan, 'DAILY', { now }), true);
});

test('daily-only space is not eligible for MONTHLY', () => {
  assert.equal(productEligible({ ...configuration, dailyEligible: true }, plan, 'MONTHLY', { now }), false);
});

test('monthly-only space is eligible for MONTHLY', () => {
  assert.equal(productEligible({ ...configuration, monthlyEligible: true }, plan, 'MONTHLY', { now }), true);
});

test('monthly-only space is not eligible for DAILY', () => {
  assert.equal(productEligible({ ...configuration, monthlyEligible: true }, plan, 'DAILY', { now }), false);
});

test('both-enabled space is eligible for DAILY and MONTHLY', () => {
  const both = { ...configuration, dailyEligible: true, monthlyEligible: true };
  assert.equal(productEligible(both, plan, 'DAILY', { now }), true);
  assert.equal(productEligible(both, plan, 'MONTHLY', { now }), true);
});

test('neither-enabled space is not eligible for either public product', () => {
  assert.equal(productEligible(configuration, plan, 'DAILY', { now }), false);
  assert.equal(productEligible(configuration, plan, 'MONTHLY', { now }), false);
});

test('Weekly fields create the public capacity product', () => {
  const weekly = { ...configuration, weeklyEligible: true };
  assert.equal(productEligible(weekly, plan, 'WEEKLY', { now }), true);
  assert.deepEqual(eligibilityErrors(weekly, plan, { now }), []);
});

test('Shop cannot enable customer products', () => {
  const errors = eligibilityErrors({ ...configuration, purpose: 'SHOP', dailyEligible: true, monthlyEligible: true }, plan, { now });
  assert.equal(errors[0].code, 'NON_CUSTOMER_BOOKING_CONFIGURATION');
});

test('Company cannot enable customer products', () => {
  const errors = eligibilityErrors({ ...configuration, purpose: 'COMPANY', dailyEligible: true }, plan, { now });
  assert.equal(errors[0].code, 'NON_CUSTOMER_BOOKING_CONFIGURATION');
});

test('inactive customer spaces retain configuration but are unavailable; unresolved spaces cannot enable products', () => {
  const inactive = { ...configuration, active: false, dailyEligible: true };
  assert.deepEqual(eligibilityErrors(inactive, plan, { now }), []);
  assert.equal(productEligible(inactive, plan, 'DAILY', { now }), false);
  assert.equal(eligibilityErrors({ ...configuration, purpose: 'UNRESOLVED', monthlyEligible: true }, plan, { now })[0].code, 'NON_CUSTOMER_BOOKING_CONFIGURATION');
});

test('a customer space can enable both Daily and Monthly when both rates are configured', () => {
  const errors = eligibilityErrors({ ...configuration, dailyEligible: true, monthlyEligible: true }, plan, { now });
  assert.deepEqual(errors, []);
});

test('daily enabled without a daily price is invalid and unavailable', () => {
  const daily = { ...configuration, dailyEligible: true };
  const missing = { ...plan, daily_rate_cents: null };
  assert.ok(eligibilityErrors(daily, missing, { now }).some(error => error.code === 'DAILY_RATE_REQUIRED'));
  assert.equal(productEligible(daily, missing, 'DAILY', { now }), false);
});

test('monthly enabled without a monthly price is invalid and unavailable', () => {
  const monthly = { ...configuration, monthlyEligible: true };
  const missing = { ...plan, monthly_rate_cents: null };
  assert.ok(eligibilityErrors(monthly, missing, { now }).some(error => error.code === 'MONTHLY_RATE_REQUIRED'));
  assert.equal(productEligible(monthly, missing, 'MONTHLY', { now }), false);
});

test('weekly enabled without the authoritative weekly price is invalid and unavailable', () => {
  const weekly = { ...configuration, weeklyEligible: true };
  const missing = { ...plan, weekly_rate_cents: null };
  assert.ok(eligibilityErrors(weekly, missing, { now }).some(error => error.code === 'WEEKLY_RATE_REQUIRED'));
  assert.equal(productEligible(weekly, missing, 'WEEKLY', { now }), false);
});

test('missing, inactive, expired, future, and incompatible plans are rejected', () => {
  const daily = { ...configuration, dailyEligible: true };
  assert.equal(eligibilityErrors(daily, null, { now })[0].code, 'RATE_PLAN_REQUIRED');
  assert.ok(eligibilityErrors(daily, { ...plan, active: false }, { now }).some(error => error.code === 'RATE_PLAN_INACTIVE'));
  assert.ok(eligibilityErrors(daily, { ...plan, ends_at: '2031-12-31T23:59:59.000Z' }, { now }).some(error => error.code === 'RATE_PLAN_INACTIVE'));
  assert.ok(eligibilityErrors(daily, { ...plan, starts_at: '2032-01-02T00:00:00.000Z' }, { now }).some(error => error.code === 'RATE_PLAN_INACTIVE'));
  assert.ok(eligibilityErrors(daily, { ...plan, category_id: 99 }, { now }).some(error => error.code === 'RATE_PLAN_INCOMPATIBLE'));
});
