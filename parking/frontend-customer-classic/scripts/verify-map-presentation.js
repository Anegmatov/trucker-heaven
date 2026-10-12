'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../customer-core.js');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

const routeMap = {
  route: { entranceElementKey: 'entrance', arrivalRouteElementKeys: ['lane'], validated: false, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
  elements: [
    { elementKey: 'entrance', elementType: 'ENTRANCE', x: 83, y: 42, width: 15, height: 2 },
    { elementKey: 'lane', elementType: 'DRIVE_LANE', x: 70, y: 42, width: 10, height: 4 },
    { elementType: 'PARKING_SPOT', label: '143', x: 83.5, y: 38, width: 15.5, height: 1.8 },
    { elementType: 'PARKING_SPOT', label: '142', x: 83.5, y: 46, width: 15.5, height: 1.8 }
  ]
};
assert.equal(core.resolveEntrance(routeMap).source, 'route');
assert.equal(core.routeElementKeys(routeMap).has('lane'), true);
assert.deepEqual(core.authoritativeRoutePoints(routeMap), [], 'Unvalidated coordinates must not render a route line.');
routeMap.route.validated = true;
assert.equal(core.authoritativeRoutePoints(routeMap).length, 2, 'Validated authoritative route points may render.');

for (const forbidden of ['CUSTOMER_MAP_RANGE_LABELS', 'customerMapRangeLabels', 'accessX =', 'CUSTOMER_ENTRANCE_MARKER']) assert.ok(!app.includes(forbidden), `Map must not include duplicate or invented geometry: ${forbidden}.`);
for (const marker of ['core.resolveEntrance(map)', 'core.authoritativeRoutePoints(map)', 'core.routeElementKeys', 'element.space?.publicBookable === true', 'tabindex="0"', 'data-map-zoom="fit"', 'target.scrollLeft = 0', 'core.canStartMapPan', 'core.mapKeyboardAction']) assert.ok(app.includes(marker), `Map behavior is missing ${marker}.`);
for (const marker of ['is-permitted-area', 'is-outside-area', 'Highlighted permitted parking area']) assert.ok(app.includes(marker), `Area map behavior is missing ${marker}.`);
for (const marker of ['monthlyMapElement', 'monthly-position', 'map-area-label', 'Fit lot', 'INTERNAL_SHOP_COMPANY', 'TEMPORARILY_HELD']) assert.ok(app.includes(marker) || css.includes(marker), `Monthly/full-lot map behavior is missing ${marker}.`);
for (const marker of ['.map-element.is-route', 'min-width: 44px', '.map-space.is-assigned span { visibility: visible; }', '.customer-map:not(.is-detail-zoom)', '.customer-navigation-route', '.map-space.is-permitted-area', '.map-space.is-outside-area']) assert.ok(css.includes(marker), `Map styling is missing ${marker}.`);
console.log('Customer map verified: authoritative entrance/route behavior, public labels, zoom, pan, keyboard, and assigned-space visibility.');
