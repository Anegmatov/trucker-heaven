const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateBookingPolicy } = require('../services/bookingPolicy');
const { nextWeeklyBillingAt, weeklyCheckoutPlan } = require('../services/weeklyParking');

test('open-ended Weekly accepts a start without changing finite Daily behavior', () => {
  const start = '2034-05-10T14:00:00.000Z';
  const now = Date.parse('2034-05-01T00:00:00.000Z');
  assert.equal(validateBookingPolicy(start, null, 'America/Chicago', 'WEEKLY', now), 'WEEKLY');
  assert.equal(validateBookingPolicy(start, '2034-05-17T14:00:00.000Z', 'America/Chicago', 'WEEKLY', now), 'WEEKLY');
  assert.throws(() => validateBookingPolicy(start, null, 'America/Chicago', 'DAILY', now), /Departure is required/);
});

test('Weekly Checkout charges one $100 initial period and renews seven days after arrival', () => {
  const arrival = '2034-05-10T14:00:00.000Z';
  assert.equal(nextWeeklyBillingAt(arrival), '2034-05-17T14:00:00.000Z');
  const plan = weeklyCheckoutPlan({
    currency: 'usd', initialAmountCents: 10000, recurringAmountCents: 10000,
    metadata: { parking_booking_id: '42' }, arrival
  });
  const initialItems = plan.lineItems.filter(item => !item.price_data.recurring);
  const recurringItems = plan.lineItems.filter(item => item.price_data.recurring);
  assert.equal(initialItems.length, 1);
  assert.equal(initialItems[0].price_data.unit_amount, 10000);
  assert.equal(recurringItems.length, 1);
  assert.equal(recurringItems[0].price_data.unit_amount, 10000);
  assert.deepEqual(recurringItems[0].price_data.recurring, { interval: 'week' });
  assert.equal(plan.subscriptionData.trial_end, Math.floor(Date.parse('2034-05-17T14:00:00.000Z') / 1000));
});

test('Weekly finalization remains zone-capacity and End Parking stops recurrence', () => {
  const root = path.join(__dirname, '..');
  const lifecycle = fs.readFileSync(path.join(root, 'services', 'paymentLifecycle.js'), 'utf8');
  const parkingService = fs.readFileSync(path.join(root, 'services', 'parkingService.js'), 'utf8');
  const adminParking = fs.readFileSync(path.join(root, 'routes', 'adminParking.js'), 'utf8');
  const adminDesk = fs.readFileSync(path.join(root, 'routes', 'adminReservationDesk.js'), 'utf8');
  assert.match(lifecycle, /\['DAILY', 'WEEKLY'\]\.includes\(booking\.parking_product\)[\s\S]*booking\.assignment_mode_snapshot !== 'ZONE_CAPACITY'/);
  assert.match(parkingService, /\['WEEKLY', 'MONTHLY'\]\.includes\(booking\.parking_product\) \? monthlyOccupancyEnd\(\)/);
  assert.match(adminParking, /scheduleSubscriptionCancellation\(booking\.stripe_subscription_id/);
  assert.match(adminParking, /subscription_cancel_at_period_end=true/);
  assert.match(adminParking, /target === 'CHECKED_IN' && booking\.departure_at &&/);
  assert.match(adminDesk, /const assignmentMode = duration === 'MONTHLY' \|\| selectedSpotId \? 'CUSTOMER_SELECTED_SPOT' : 'ZONE_CAPACITY'/);
  assert.match(adminDesk, /requestedProduct === 'WEEKLY' && !body\.departureLocal/);
  assert.match(adminDesk, /const eligible = term === 'DAILY' \? 'element\.daily_eligible' : term === 'WEEKLY' \? 'element\.weekly_eligible'/);
});
