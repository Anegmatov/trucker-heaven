'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverCategoryProducts } = require('../services/publicProductDiscovery');

const categories = [{ code: 'BOBTAIL', name: 'Bobtail Parking' }];
const configured = Object.freeze({
  code: 'BOBTAIL', inventory_location_id: 1, inventory_zone_id: 2, inventory_category_id: 3,
  layout_status: 'PUBLISHED', element_type: 'PARKING_SPOT',
  inventory_active: true, zone_active: true, zone_public_visible: true, category_active: true,
  element_active: true, element_public_visible: true, parking_purpose: 'CUSTOMER', space_public_bookable: true,
  spot_active: true, spot_public_bookable: true, classification_state: 'COMPLETE', assigned_rate_plan_id: 4,
  rate_plan_id: 4, rule_location_id: 1, rule_zone_id: 2, rule_category_id: 3, rule_active: true,
  rule_starts_at: null, rule_ends_at: null, daily_eligible: true, weekly_eligible: true, monthly_eligible: true,
  plan_name: 'Bobtail Parking', daily_rate_cents: 1900, weekly_rate_cents: 10000, monthly_rate_cents: 15000
});
const offers = rows => discoverCategoryProducts(rows, categories, Date.parse('2030-01-01T00:00:00Z'))[0];

test('configured Daily, Weekly, and Monthly inventory advertises every authoritative product', () => {
  assert.deepEqual(offers([configured]).offeredDurations, [
    { code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 15000 }
  ]);
});

test('one-day request-shaped values do not affect configured capability discovery', () => {
  const result = offers([{ ...configured, arrivalLocal: '2030-02-01T10:00', departureLocal: '2030-02-02T10:00' }]);
  assert.deepEqual(result.offeredDurations.map(item => item.code), ['DAILY', 'WEEKLY', 'MONTHLY']);
});

test('Daily-only and Monthly-only inventory advertise only their enabled priced product', () => {
  assert.deepEqual(offers([{ ...configured, weekly_eligible: false, monthly_eligible: false }]).offeredDurations.map(item => item.code), ['DAILY']);
  assert.deepEqual(offers([{ ...configured, daily_eligible: false, weekly_eligible: false }]).offeredDurations.map(item => item.code), ['MONTHLY']);
});

test('Weekly-only configured inventory advertises the Weekly customer product', () => {
  const result = offers([{ ...configured, daily_eligible: false, monthly_eligible: false, weekly_eligible: true, weekly_rate_cents: 9000 }]);
  assert.deepEqual(result.offeredDurations, [{ code: 'WEEKLY', unitRateCents: 9000 }]);
  assert.equal(result.startingRateCents, 9000);
});

test('Monthly discovery requires its own valid price and never borrows Weekly', () => {
  for (const monthly_rate_cents of [null, undefined, 'not-cents']) {
    const result = offers([{ ...configured, daily_eligible: false, weekly_eligible: false, monthly_rate_cents, weekly_rate_cents: 9000 }]);
    assert.deepEqual(result.offeredDurations, []);
  }
});

test('internal, inactive, incomplete, hidden, and unassigned spaces create no capability', () => {
  const unsafe = [
    { parking_purpose: 'SHOP' }, { parking_purpose: 'COMPANY' }, { parking_purpose: 'UNRESOLVED' },
    { layout_status: 'DRAFT' }, { element_type: 'LABEL' }, { element_active: false }, { spot_active: false }, { spot_public_bookable: false }, { inventory_active: false }, { zone_active: false },
    { category_active: false }, { element_public_visible: false }, { zone_public_visible: false },
    { space_public_bookable: false }, { classification_state: 'NEEDS_CLASSIFICATION' },
    { assigned_rate_plan_id: null }, { rate_plan_id: 99 }, { rule_active: false }
  ];
  for (const change of unsafe) assert.deepEqual(offers([{ ...configured, ...change }]).offeredDurations, [], JSON.stringify(change));
});

test('expired, future, and incompatible plans create no capability', () => {
  for (const change of [
    { rule_ends_at: '2029-12-31T23:59:59Z' }, { rule_starts_at: '2030-01-01T00:00:01Z' },
    { rule_location_id: 9 }, { rule_zone_id: 9 }, { rule_category_id: 9 }
  ]) assert.deepEqual(offers([{ ...configured, ...change }]).offeredDurations, [], JSON.stringify(change));
});

test('starting prices are calculated from each product own configured prices', () => {
  const result = offers([
    { ...configured, daily_rate_cents: 2100, monthly_rate_cents: 28000 },
    { ...configured, rate_plan_id: 5, assigned_rate_plan_id: 5, daily_rate_cents: 1800, monthly_rate_cents: 31000 }
  ]);
  assert.deepEqual(result.offeredDurations, [
    { code: 'DAILY', unitRateCents: 1800 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 28000 }
  ]);
  assert.equal(result.startingRateCents, 1800);
});
