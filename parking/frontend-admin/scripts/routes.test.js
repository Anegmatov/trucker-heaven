'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const routes = require('../routes');

test('deep links and aliases retain intended workspace targets', () => {
  assert.equal(routes.resolve('#live-lot').view, 'live-lot');
  assert.deepEqual({ view: routes.resolve('#closures').view, tab: routes.resolve('#closures').configTab }, { view: 'business-settings', tab: 'closures' });
  for (const alias of ['rates', 'pricing', 'pricing-policies', 'rates-rules']) assert.equal(routes.resolve(alias).view, 'lot-setup');
  assert.deepEqual({ view: routes.resolve('arrivals').view, tab: routes.resolve('arrivals').reservationTab }, { view: 'reservations', tab: 'arriving-today' });
  assert.deepEqual({ view: routes.resolve('departures').view, tab: routes.resolve('departures').reservationTab }, { view: 'reservations', tab: 'departing-today' });
  assert.equal(routes.resolve('new-reservation').view, 'reservation-desk');
});

test('unsupported and retired feature routes do not silently become Dashboard', () => {
  for (const value of ['customers', 'history', 'activity', 'reports', 'locations', 'zones', 'categories', 'inventory']) {
    assert.equal(routes.resolve(value).supported, false);
    assert.equal(routes.normalize(value), null);
  }
});

test('owner permissions and primary navigation come from the route registry', () => {
  assert.equal(routes.ownerViews.has('lot-setup'), true);
  assert.equal(routes.ownerViews.has('staff-accounts'), true);
  assert.equal(routes.ownerViews.has('business-settings'), true);
  assert.deepEqual(routes.primaryNavigation.map(route => route.view), ['dashboard', 'live-lot', 'reservations', 'reservation-desk', 'lot-setup', 'staff-accounts', 'business-settings']);
  assert.deepEqual(routes.configurationTabs, ['property', 'contact', 'instructions', 'policies', 'closures']);
});
