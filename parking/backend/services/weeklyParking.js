const { DateTime } = require('luxon');
const { apiError } = require('../utils');

function isOpenEndedWeekly(booking) {
  return String(booking?.parking_product || booking?.product || '').toUpperCase() === 'WEEKLY'
    && !booking?.departure_at && !booking?.departureAt;
}

function nextWeeklyBillingAt(arrival) {
  // Accept the Date objects node-postgres returns as well as ISO strings.
  const start = arrival instanceof Date ? DateTime.fromJSDate(arrival, { zone: 'utc' }) : DateTime.fromISO(String(arrival || ''), { zone: 'utc' });
  if (!start.isValid) throw apiError('PAYMENT_QUOTE_INVALID', 'The Weekly parking start date is invalid', 409);
  return start.plus({ days: 7 }).toUTC().toISO();
}

function weeklyCheckoutPlan({ currency, initialAmountCents, recurringAmountCents, metadata, arrival }) {
  const trialEnd = Math.floor(Date.parse(nextWeeklyBillingAt(arrival)) / 1000);
  if (!Number.isSafeInteger(trialEnd)) throw apiError('PAYMENT_QUOTE_INVALID', 'The Weekly billing date is invalid', 409);
  return {
    lineItems: [
      { quantity: 1, price_data: { currency, unit_amount: recurringAmountCents,
        product_data: { name: 'Weekly Parking', metadata }, recurring: { interval: 'week' } } },
      { quantity: 1, price_data: { currency, unit_amount: initialAmountCents,
        product_data: { name: 'First Weekly Parking Period', metadata } } }
    ],
    subscriptionData: { metadata, trial_end: trialEnd }
  };
}

module.exports = { isOpenEndedWeekly, nextWeeklyBillingAt, weeklyCheckoutPlan };
