'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const C = require('../booking-core.js');
const LotPlan = require('../lot-plan.js');
const PLAN = require('../lot-plan-data.js');

const tz = 'America/Chicago';
const now = new Date('2026-10-07T15:00:00Z'); // 10:00 AM in Mt. Juliet

test('money and dates', () => {
  assert.equal(C.money(16129), '$161.29');
  assert.equal(C.money(1900, { whole: true }), '$19');
  assert.equal(C.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(C.formatLocal('2026-10-16T18:00'), 'Fri, Oct 16 · 6:00 PM');
  assert.deepEqual(C.defaultArrival(tz, now), { date: '2026-10-07', time: '11:00' });
});

test('daily trip needs a departure after arrival', () => {
  const base = { categoryCode: 'TRACTOR_TRAILER', duration: 'DAILY', arrivalDate: '2026-10-10', arrivalTime: '18:00' };
  assert.ok(C.buildTrip({ ...base, departureDate: '2026-10-10', departureTime: '17:00' }, { timezone: tz, now }).errors.departureDate);
  assert.deepEqual(C.buildTrip({ ...base, departureDate: '2026-10-12', departureTime: '08:00' }, { timezone: tz, now }).trip,
    { categoryCode: 'TRACTOR_TRAILER', duration: 'DAILY', arrivalLocal: '2026-10-10T18:00', departureLocal: '2026-10-12T08:00' });
  assert.ok(C.buildTrip({ ...base, arrivalDate: '2026-10-07', arrivalTime: '09:00', departureDate: '2026-10-08', departureTime: '09:00' }, { timezone: tz, now }).errors.arrivalTime, 'past arrival');
});

test('weekly trips end on whole weeks, monthly has no end', () => {
  const weekly = C.buildTrip({ categoryCode: 'BOBTAIL', duration: 'WEEKLY', arrivalDate: '2026-10-10', arrivalTime: '09:00', weeks: 3 }, { timezone: tz, now });
  assert.equal(weekly.trip.departureLocal, '2026-10-31T09:00');
  assert.ok(C.buildTrip({ categoryCode: 'BOBTAIL', duration: 'WEEKLY', arrivalDate: '2026-10-10', arrivalTime: '09:00', weeks: 4 }, { timezone: tz, now }).errors.weeks);
  const monthly = C.buildTrip({ categoryCode: 'TRACTOR_TRAILER', duration: 'MONTHLY', arrivalDate: '2026-10-12', arrivalTime: '09:00' }, { timezone: tz, now });
  assert.equal(monthly.trip.departureLocal, undefined);
});

test('estimate rounds partial days up', () => {
  const rates = { DAILY: 1900, WEEKLY: 10000, MONTHLY: 25000 };
  assert.equal(C.estimate({ duration: 'DAILY', arrivalDate: '2026-10-10', arrivalTime: '18:00', departureDate: '2026-10-12', departureTime: '08:00' }, rates).totalCents, 3800);
  assert.equal(C.estimate({ duration: 'WEEKLY', weeks: 2 }, rates).totalCents, 20000);
});

test('details validation matches the API rules', () => {
  const good = { firstName: 'A', lastName: 'B', mobilePhone: '615 555 0101', email: 'a@b.co', licensePlate: 'X1', licensePlateState: 'TN', tractorUnitNumber: '7', termsAccepted: true };
  assert.deepEqual(C.validateDetails(good), {});
  assert.ok(C.validateDetails(good, { monthly: true }).companyName);
  assert.ok(C.validateDetails({ ...good, tractorUnitNumber: '' }).tractorUnitNumber);
  assert.ok(C.validateDetails({ ...good, termsAccepted: false }).termsAccepted);
  assert.ok(C.validateDetails({ ...good, email: 'nope' }).email);
});

test('manage links keep the code in the URL fragment', () => {
  const hash = C.manageHash('THP-2026-ABCD1234', 'a_b-c');
  assert.equal(hash, '#r=THP-2026-ABCD1234&c=a_b-c');
  assert.deepEqual(C.parseManageHash(hash), { reservationNumber: 'THP-2026-ABCD1234', credential: 'a_b-c' });
  assert.equal(C.parseManageHash('#find'), null);
});

test('the lot plan is traced from the diagram: all 185 numbered spaces, no 91-100', () => {
  const numbers = Object.keys(PLAN.spots).map(Number);
  assert.equal(numbers.length, 185);
  assert.ok(!numbers.some(n => n >= 91 && n <= 100));
  for (const n of [10, 13, 14, 59, 60, 90, 101, 110, 111, 143, 164, 165, 196, 197, 204]) assert.ok(PLAN.spots[String(n)], `space ${n}`);
  for (const [x, y, w, h] of Object.values(PLAN.spots)) assert.ok(w > 10 && h > 10 && x >= PLAN.viewBox[0] && y >= PLAN.viewBox[1]);
});

test('lot plan marks open, taken, area and picked spaces, and only open or picked ones are tappable', () => {
  const states = new Map([['152', 'open'], ['153', 'taken'], ['120', 'area']]);
  const svg = LotPlan.render(PLAN, { states, selected: '160', interactive: true });
  assert.match(svg, /class="sp is-open" data-space="152" role="button"/);
  assert.match(svg, /class="sp is-taken" data-space="153">/);
  assert.match(svg, /class="sp is-area" data-space="120">/);
  assert.match(svg, /class="sp is-mine" data-space="160" role="button"/);
  assert.match(svg, /class="sp is-off" data-space="\d+">/);
});
