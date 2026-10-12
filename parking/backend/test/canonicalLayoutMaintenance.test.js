'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const maintenance = require('../services/canonicalLayoutMaintenance');

test('canonical physical layouts are locked by default', () => {
  assert.equal(maintenance.locked(true, {}), true);
  assert.equal(maintenance.locked(false, {}), false);
});

test('the explicit maintenance window is the only structural unlock', () => {
  assert.equal(maintenance.locked(true, { PARKING_CANONICAL_LAYOUT_MAINTENANCE: 'true' }), false);
  assert.equal(maintenance.locked(true, { PARKING_CANONICAL_LAYOUT_MAINTENANCE: 'TRUE' }), true);
  assert.equal(maintenance.locked(true, { PARKING_CANONICAL_LAYOUT_MAINTENANCE: '1' }), true);
});
