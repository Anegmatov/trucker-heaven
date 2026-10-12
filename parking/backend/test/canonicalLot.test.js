const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCanonicalLot, canonicalPublicCategories } = require('../services/canonicalLot');

const canonicalRow = { id: 42, name: 'Legacy internal name', layout_name: 'Trucker Heaven physical lot · v4', timezone: 'America/Chicago' };

test('canonical lot resolver accepts exactly one published Trucker Heaven physical layout', async () => {
  const client = { query: async () => ({ rowCount: 1, rows: [canonicalRow] }) };
  assert.deepEqual(await resolveCanonicalLot(client), { ...canonicalRow, canonical_customer_lot: true });
});

test('canonical lot resolver refuses missing or ambiguous canonical layouts', async () => {
  for (const rowCount of [0, 2]) {
    await assert.rejects(() => resolveCanonicalLot({ query: async () => ({ rowCount, rows: [] }) }), error => error.code === 'CANONICAL_LOT_UNAVAILABLE');
  }
});

test('canonical customer choices are limited to Bobtail Parking and General Truck Parking', async () => {
  let sql = '';
  const client = { query: async query => { sql = query; return { rows: [
    { code: 'BOBTAIL', name: 'Bobtail Parking' }, { code: 'TRACTOR_TRAILER', name: 'General Truck Parking' }
  ] }; } };
  assert.deepEqual(await canonicalPublicCategories(client, 42), [
    { code: 'BOBTAIL', name: 'Bobtail Parking' }, { code: 'TRACTOR_TRAILER', name: 'General Truck Parking' }
  ]);
  assert.match(sql, /GROUP BY c\.code,c\.name/);
});
