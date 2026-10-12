'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../admin-core');

const base = { active: true, publicBookable: true, parkingPurpose: 'CUSTOMER', parkingUse: 'CUSTOMER', classificationState: 'COMPLETE', vehicleEligibility: [{ id: 1 }] };
const fixtures = [
  { ...base, id: 1, operationalStatus: 'AVAILABLE' },
  { ...base, id: 2, operationalStatus: 'AVAILABLE', publicBookable: false },
  { ...base, id: 3, operationalStatus: 'RESERVED' },
  { ...base, id: 4, operationalStatus: 'OCCUPIED' },
  { ...base, id: 5, operationalStatus: 'AVAILABLE', active: false },
  { ...base, id: 6, operationalStatus: 'AVAILABLE', classificationState: 'NEEDS_CLASSIFICATION' },
  { ...base, id: 7, operationalStatus: 'AVAILABLE', parkingPurpose: 'SHOP', parkingUse: 'SHOP', publicBookable: false }
];

test('Live Lot separates operational availability from customer bookability', () => {
  const summary = core.summarizeLiveSpaces(fixtures);
  assert.deepEqual(summary, { physical: 7, available: 4, customerBookable: 1, publiclyBookable: 5, reserved: 1, occupied: 1, blocked: 0, inactive: 1, unknown: 0, unresolved: 1, configurationWarnings: 0 });
  assert.deepEqual(core.filterLiveSpaces(fixtures, { availableOnly: true }).map(item => item.id), [1, 2, 6, 7]);
  assert.deepEqual(core.filterLiveSpaces(fixtures, { operationalStatus: 'INACTIVE' }).map(item => item.id), [5]);
  assert.equal(core.operationallyAvailable(fixtures[6]), true);
  assert.equal(core.publiclyBookableAvailable(fixtures[6]), false);
  assert.equal(core.canonicalStatus(fixtures[0]), 'AVAILABLE');
  assert.equal(core.statusClass(fixtures[0]), 'available');
});

test('official Live Lot allocations are independent from operational status', () => {
  const cases = [
    [10, 'MONTHLY_BOBTAIL'], [67, 'MONTHLY_BOBTAIL'],
    [68, 'SHOP'], [90, 'SHOP'], [101, 'COMPANY'], [109, 'COMPANY'],
    [110, 'DAILY'], [148, 'DAILY'], [149, 'MONTHLY_TRUCK_TRAILER'],
    [164, 'MONTHLY_TRUCK_TRAILER'], [165, 'CAR_HAULER'], [167, 'CAR_HAULER'],
    [168, 'MONTHLY_TRUCK_TRAILER'], [194, 'MONTHLY_TRUCK_TRAILER'],
    [195, 'CAR_HAULER'], [204, 'CAR_HAULER']
  ];
  for (const [number, category] of cases) {
    assert.equal(core.allocationCategory({ number, operationalStatus: number % 2 ? 'OCCUPIED' : 'AVAILABLE' }), category);
  }
  assert.equal(core.allocationClass({ number: 164, operationalStatus: 'AVAILABLE' }), 'allocation-monthly-truck-trailer');
  assert.equal(core.allocationLabel({ number: 164 }), 'Monthly Truck & Trailer');
  const lot164 = { ...base, number: 164, operationalStatus: 'AVAILABLE', dailyEligible: false,
    monthlyEligible: true, ratePlan: { id: 25, active: true } };
  assert.equal(core.publiclyBookableAvailable(lot164), true);
  assert.equal(core.publiclyBookableAvailable({ ...lot164, operationalStatus: 'RESERVED' }), false);
});

test('Live Lot summary prefers authoritative backend reconciliation fields', () => {
  const summary = core.summarizeLiveSpaces(fixtures, { physicalSpaces: 7, availableCustomerSpaces: 2, publiclyBookable: 3, reserved: 4, occupied: 5, blocked: 6, unresolved: 7, configurationIssues: 8 });
  assert.deepEqual({ physical: summary.physical, customerBookable: summary.customerBookable, publiclyBookable: summary.publiclyBookable, reserved: summary.reserved, occupied: summary.occupied, blocked: summary.blocked, unresolved: summary.unresolved, configurationWarnings: summary.configurationWarnings }, { physical: 7, customerBookable: 2, publiclyBookable: 3, reserved: 4, occupied: 5, blocked: 6, unresolved: 7, configurationWarnings: 8 });
});

test('booking eligibility warnings separate Daily and Monthly prices from product flags', () => {
  const space = { parking_purpose: 'CUSTOMER', active: true, daily_eligible: true, monthly_eligible: false, space_public_bookable: true, rate_plan_id: 7, spot_category_code: 'BOBTAIL' };
  const complete = { id: 7, active: true, category_code: 'BOBTAIL', daily_rate_cents: 1900, monthly_rate_cents: 25000 };
  assert.deepEqual(core.bookingEligibilityWarnings(space, complete), []);
  assert.deepEqual(core.bookingEligibilityWarnings({ ...space, monthly_eligible: true }, { ...complete, monthly_rate_cents: null }).map(item => item.code), ['MULTIPLE_BOOKING_TERMS', 'MONTHLY_RATE_REQUIRED']);
  assert.deepEqual(core.bookingEligibilityWarnings({ ...space, daily_eligible: false, monthly_eligible: true }, { ...complete, daily_rate_cents: null }).map(item => item.code), []);
});

test('booking eligibility warnings block missing, inactive, and incompatible plans', () => {
  const space = { parking_purpose: 'CUSTOMER', active: true, daily_eligible: true, monthly_eligible: false, space_public_bookable: true, spot_category_code: 'TRACTOR_TRAILER' };
  assert.equal(core.bookingEligibilityWarnings(space, null)[0].code, 'RATE_PLAN_REQUIRED');
  assert.ok(core.bookingEligibilityWarnings({ ...space, rate_plan_id: 8 }, { id: 8, active: false, category_code: 'TRACTOR_TRAILER', daily_rate_cents: 1900, monthly_rate_cents: 25000 }).some(item => item.code === 'RATE_PLAN_INACTIVE'));
  assert.ok(core.bookingEligibilityWarnings({ ...space, rate_plan_id: 9 }, { id: 9, active: true, category_code: 'BOBTAIL', daily_rate_cents: 1900, monthly_rate_cents: 25000 }).some(item => item.code === 'RATE_PLAN_INCOMPATIBLE'));
});

test('internal spaces cannot retain customer booking configuration', () => {
  for (const space of [
    { parking_purpose: 'SHOP', active: true },
    { parking_purpose: 'COMPANY', active: true },
    { parking_purpose: 'UNRESOLVED', active: true }
  ]) {
    const warnings = core.bookingEligibilityWarnings({ ...space, daily_eligible: true, monthly_eligible: true, space_public_bookable: true, rate_plan_id: 2 }, { id: 2, active: true, daily_rate_cents: 1900, monthly_rate_cents: 25000 });
    assert.equal(warnings[0].code, 'NON_CUSTOMER_BOOKING_CONFIGURATION');
    assert.equal(warnings[0].blocking, true);
  }
});

test('inactive customer spaces retain one booking term but remain operationally unavailable', () => {
  const space = { parking_purpose: 'CUSTOMER', active: false, daily_eligible: true, monthly_eligible: false, space_public_bookable: true, rate_plan_id: 2, spot_category_code: 'BOBTAIL' };
  const plan = { id: 2, active: true, category_code: 'BOBTAIL', daily_rate_cents: 1900, monthly_rate_cents: 25000 };
  assert.deepEqual(core.bookingEligibilityWarnings(space, plan), []);
  assert.equal(core.publiclyBookableAvailable({ ...base, active: false, dailyEligible: true, ratePlan: { active: true } }), false);
});

test('customer spaces cannot retain both Daily and Monthly terms', () => {
  const space = { parking_purpose: 'CUSTOMER', active: true, daily_eligible: true, monthly_eligible: true, space_public_bookable: true, rate_plan_id: 2, spot_category_code: 'BOBTAIL' };
  const plan = { id: 2, active: true, category_code: 'BOBTAIL', daily_rate_cents: 1900, monthly_rate_cents: 25000 };
  assert.ok(core.bookingEligibilityWarnings(space, plan).some(item => item.code === 'MULTIPLE_BOOKING_TERMS'));
});

test('Live Lot product filters and customer bookability use authoritative backend eligibility', () => {
  const spaces = [
    { ...base, id: 10, operationalStatus: 'AVAILABLE', dailyEligible: true, monthlyEligible: false, ratePlan: { active: true } },
    { ...base, id: 11, operationalStatus: 'AVAILABLE', dailyEligible: false, monthlyEligible: true, ratePlan: { active: true } },
    { ...base, id: 12, operationalStatus: 'AVAILABLE', dailyEligible: false, monthlyEligible: false, ratePlan: { active: true } }
  ];
  assert.deepEqual(core.filterLiveSpaces(spaces, { dailyOnly: true }).map(item => item.id), [10]);
  assert.deepEqual(core.filterLiveSpaces(spaces, { monthlyOnly: true }).map(item => item.id), [11]);
  assert.equal(core.publiclyBookableAvailable(spaces[0]), true);
  assert.equal(core.publiclyBookableAvailable(spaces[1]), true);
  assert.equal(core.publiclyBookableAvailable(spaces[2]), false);
});

test('busy state restores every intentional disabled control after success or failure', () => {
  const controls = [{ type: 'text', disabled: true, isConnected: true }, { type: 'text', disabled: false, isConnected: true }, { type: 'submit', disabled: false, isConnected: true, classList: { add() {}, remove() {} } }];
  const attributes = new Map();
  const form = { querySelectorAll: () => controls, querySelector: () => controls[2], setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), classList: { add() {}, remove() {} } };
  core.setFormBusy(form, true);
  assert.ok(controls.every(control => control.disabled));
  core.setFormBusy(form, false);
  assert.deepEqual(controls.map(control => control.disabled), [true, false, false]);
});

test('request gates reject stale responses', () => {
  const gate = core.createRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
});

test('America/Chicago local time conversion handles normal and DST transition times', () => {
  assert.equal(core.localDateTimeToInstant('2026-01-15T12:00', 'America/Chicago'), '2026-01-15T18:00:00.000Z');
  assert.throws(() => core.localDateTimeToInstant('2026-03-08T02:30', 'America/Chicago'), /does not exist/);
  assert.throws(() => core.localDateTimeToInstant('2026-11-01T01:30', 'America/Chicago'), /occurs twice/);
  assert.equal(core.localDateTimeToInstant('2026-11-01T01:30', 'America/Chicago', { disambiguation: 'later' }), '2026-11-01T07:30:00.000Z');
});

test('map bounds and Fit calculations use actual content', () => {
  const elements = [{ x: 10, y: 20, width: 20, height: 30 }, { x: 60, y: 90, width: 10, height: 20 }];
  assert.deepEqual(core.boundsFor(elements), { minX: 10, minY: 20, maxX: 70, maxY: 110, width: 60, height: 90 });
  assert.ok(core.fitScale(elements, 1000, 700) > 0);
});
