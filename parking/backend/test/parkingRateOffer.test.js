const test = require('node:test');
const assert = require('node:assert/strict');
const { priceQuote, rateOffer } = require('../services/parkingService');

function rateClient({ planName = 'Standard Parking', dailyRateCents = 1900, weeklyRateCents = 10000, monthlyRateCents = 25000 } = {}) {
  return {
    async query() {
      return { rowCount: 1, rows: [{
        id: 44, plan_name: planName, daily_rate_cents: dailyRateCents,
        weekly_rate_cents: weeklyRateCents, monthly_rate_cents: monthlyRateCents,
        fee_cents: 0, tax_basis_points: 0
      }] };
    }
  };
}

const inventory = { category_id: 12, zone_id: 8, timezone: 'America/Chicago', start: '2034-05-10T14:00:00.000Z' };

test('public rate offers expose only configured durations and server quotes retain exact integer cents', async () => {
  const client = rateClient();
  const dailyInput = { locationId: 3, arrival: '2034-05-10T14:00:00.000Z', departure: '2034-05-11T14:00:00.000Z' };
  const offer = await rateOffer(client, dailyInput, inventory, 'DAILY');
  assert.deepEqual(offer.durations, [{ code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 25000 }]);
  assert.equal(offer.unitRateCents, 1900);
  const daily = await priceQuote(client, dailyInput, inventory);
  assert.equal(daily.ratePlanName, 'Standard Parking');
  assert.equal(daily.unitRateCents, 1900);
  assert.equal(daily.baseParkingCents, 1900);
  const monthly = await priceQuote(client, { ...dailyInput, duration: 'MONTHLY' }, inventory);
  assert.equal(monthly.duration, 'MONTHLY');
  assert.equal(monthly.units, 1);
  assert.equal(monthly.unitRateCents, 25000);
  assert.equal(monthly.baseParkingCents, 17742);
  assert.equal(monthly.recurringUnitRateCents, 25000);
});

test('Bobtail Daily is $19 per charged day and Monthly prorates one $150 recurring unit', async () => {
  const client = rateClient({ planName: 'Bobtail Parking', monthlyRateCents: 15000 });
  const bobtailInventory = { ...inventory, category_id: 13 };
  const daily = await priceQuote(client, {
    locationId: 3,
    duration: 'DAILY',
    arrival: '2034-05-10T14:00:00.000Z',
    departure: '2034-05-12T14:00:00.000Z'
  }, bobtailInventory);
  assert.equal(daily.units, 2);
  assert.equal(daily.unitRateCents, 1900);
  assert.equal(daily.totalCents, 3800);
  const quote = await priceQuote(client, {
    locationId: 3,
    duration: 'MONTHLY',
    arrival: '2034-05-10T14:00:00.000Z',
    departure: '2034-06-10T14:00:00.000Z'
  }, bobtailInventory);
  assert.equal(quote.duration, 'MONTHLY');
  assert.equal(quote.units, 1);
  assert.equal(quote.unitRateCents, 15000);
  assert.equal(quote.baseParkingCents, 10645);
  assert.equal(quote.totalCents, 10645);
  assert.equal(quote.recurringUnitRateCents, 15000);
  assert.notEqual(quote.totalCents, 18000);
});

test('one-day Daily parking remains the authoritative $19 unit', async () => {
  const quote = await priceQuote(rateClient(), {
    locationId: 3,
    duration: 'DAILY',
    arrival: '2034-05-10T14:00:00.000Z',
    departure: '2034-05-11T14:00:00.000Z'
  }, inventory);
  assert.equal(quote.units, 1);
  assert.equal(quote.unitRateCents, 1900);
  assert.equal(quote.totalCents, 1900);
});

test('Weekly pricing is serialized and quotes one $100 unit for seven days', async () => {
  const client = { async query() { return { rowCount: 1, rows: [{ id: 1, plan_name: 'Legacy', daily_rate_cents: null, weekly_rate_cents: 10000, monthly_rate_cents: null, fee_cents: 0, tax_basis_points: 0, version: 1 }] }; } };
  const offer = await rateOffer(client, { locationId: 3, arrival: '2034-05-10T14:00:00.000Z', departure: '2034-05-17T14:00:00.000Z' }, inventory);
  assert.deepEqual(offer.durations, [{ code: 'WEEKLY', unitRateCents: 10000 }]);
  const quote = await priceQuote(client, { locationId: 3, duration: 'WEEKLY', arrival: '2034-05-10T14:00:00.000Z', departure: '2034-05-17T14:00:00.000Z' }, inventory);
  assert.equal(quote.units, 1);
  assert.equal(quote.totalCents, 10000);
});

test('open-ended Weekly quotes one recurring $100 period anchored seven days after arrival', async () => {
  const client = rateClient();
  const quote = await priceQuote(client, {
    locationId: 3, duration: 'WEEKLY', openEnded: true,
    arrival: '2034-05-10T14:00:00.000Z', departure: '9999-12-31T23:59:59.999Z'
  }, inventory);
  assert.equal(quote.units, 1);
  assert.equal(quote.totalCents, 10000);
  assert.equal(quote.recurringUnitRateCents, 10000);
  assert.equal(quote.nextBillingAt, '2034-05-17T14:00:00.000Z');
  assert.equal(quote.openEnded, true);
});

test('weekly pricing cannot substitute for a missing monthly price', async () => {
  const client = { async query() { return { rowCount: 1, rows: [{ id: 1, plan_name: 'Legacy', daily_rate_cents: 1900, weekly_rate_cents: 10000, monthly_rate_cents: null, fee_cents: 0, tax_basis_points: 0, version: 1 }] }; } };
  const input = { locationId: 3, duration: 'MONTHLY', arrival: '2034-05-10T14:00:00.000Z', departure: '2034-06-09T14:00:00.000Z' };
  await assert.rejects(() => priceQuote(client, input, inventory), error => error.code === 'RATE_NOT_CONFIGURED');
});
