'use strict';

// Checks the built customer site: hashed scripts in the right order, no mutable asset names,
// every referenced local file present, and no online-payment UI left behind.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'trucker-heaven-parking-build.json'), 'utf8'));
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const order = ['render-runtime.js', 'config.js', 'booking-core.js', 'lot-plan-data.js', 'lot-plan.js', 'my-parking.js', 'app.js'];
const positions = order.map(file => html.indexOf(`src="${manifest.assets[file]}"`));
assert.ok(positions.every(index => index > 0), 'Every customer script must be referenced by its hashed name.');
assert.ok(positions.every((index, i) => i === 0 || positions[i - 1] < index), 'Scripts must load runtime, config, core, map, app in order.');
assert.ok(!html.includes('?v='), 'Built entrypoint must use immutable asset names.');
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'No inline scripts (CSP script-src self).');
for (const ref of html.matchAll(/(?:src|href|srcset)="([^"#:]+)"/g)) {
  const file = ref[1].split(' ')[0];
  assert.ok(fs.existsSync(path.join(dist, file)), `Missing built file referenced by index.html: ${file}`);
}
const css = fs.readFileSync(path.join(dist, manifest.assets['styles.css']), 'utf8');
for (const ref of css.matchAll(/url\("([^"]+)"\)/g)) assert.ok(fs.existsSync(path.join(dist, ref[1])), `Missing file referenced by CSS: ${ref[1]}`);
const bundle = order.map(file => fs.readFileSync(path.join(dist, manifest.assets[file]), 'utf8')).join('\n') + html;
for (const forbidden of ['stripe', 'checkout-sessions', '/booking-attempts', 'card number']) assert.ok(!bundle.toLowerCase().includes(forbidden), `Online payment code must not ship: ${forbidden}`);
for (const required of ['Nothing is charged online', 'Pay at the office', 'Confirm reservation', '/bookings/lookup', '/positions', '/summary', '/documents/complete', 'data-check-in']) assert.ok(bundle.includes(required), `Customer site is missing: ${required}`);
assert.match(fs.readFileSync(path.join(dist, manifest.assets['render-runtime.js']), 'utf8'), /new Set\(\['trucker-heaven-parking-a437\.onrender\.com'\]\)/, 'Production API routing must use the exact host allowlist.');
console.log(`Customer build verified (revision ${manifest.revision}).`);
