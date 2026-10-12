'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..'); const dist = path.join(root, 'dist');
const repository = path.resolve(root, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'trucker-heaven-parking-build.json'), 'utf8'));
const sources = ['index.html', 'app.js', 'config.js', 'customer-core.js', 'lifecycle.js', 'render-runtime.js', 'styles.css', 'liquid-glass.css', 'brand/trucker-heaven-logo-full.png', 'brand/trucker-heaven-logo-nav.png', 'images/parking-hero.png', 'images/facility-aerial.jpg', 'images/parking-sky.jpg', 'images/parking-strip.jpg', 'images/trucker-heaven-aerial.jpg'];
for (const source of sources) { assert.equal(typeof manifest.assets[source], 'string', `Missing built ${source}.`); assert.ok(fs.existsSync(path.join(dist, manifest.assets[source])), `Built file missing: ${manifest.assets[source]}`); }
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(dist, manifest.assets['app.js']), 'utf8');
const core = fs.readFileSync(path.join(dist, manifest.assets['customer-core.js']), 'utf8');
const config = fs.readFileSync(path.join(dist, manifest.assets['config.js']), 'utf8');
const runtime = fs.readFileSync(path.join(dist, manifest.assets['render-runtime.js']), 'utf8');
const ordered = ['render-runtime.js', 'config.js', 'customer-core.js', 'lifecycle.js', 'app.js'].map(source => html.indexOf(manifest.assets[source]));
assert.ok(ordered.every(index => index >= 0) && ordered.every((index, position) => position === 0 || ordered[position - 1] < index), 'Customer scripts must load in runtime/config/core/lifecycle/app order.');
assert.equal((html.match(/<script defer/g) || []).length, 7, 'All customer scripts must defer until the DOM is parsed.');
for (const id of ['tripStep', 'parkingStep', 'driverStep', 'confirmation', 'passView', 'mapView', 'reservationsView', 'managementView', 'lookupView', 'myParkingView', 'uploadDocumentsView']) assert.ok(html.includes(`id="${id}"`), `Missing route container ${id}.`);
assert.match(runtime, /const PRODUCTION_CUSTOMER_HOSTS = new Set\(\['trucker-heaven-parking-a437\.onrender\.com'\]\);/,
  'Runtime production routing must use the exact customer host allowlist.');
assert.doesNotMatch(runtime, /\.endsWith\s*\(/, 'Runtime production routing must not use suffix-based host matching.');
assert.ok(config.includes("apiBase") && config.includes("configured"), 'Runtime config validation is missing.');
for (const forbidden of ['CUSTOMER_MAP_RANGE_LABELS', 'booking.lookupCredential || state.activeCredential', 'availability[0] || null']) assert.ok(!app.includes(forbidden), `Built app contains unsafe pattern ${forbidden}.`);
assert.ok(!html.includes('?v='), 'Built entrypoint must use immutable asset names.');
assert.ok(html.includes('brand/trucker-heaven-logo.svg') && html.includes('brand/trucker-heaven-logo-full.png'), 'Customer must use the main-site header logo and the approved full Trucker Heaven artwork.');
assert.ok(!html.includes('TRUCKER <b>HEAVEN</b>'), 'Customer header must not recreate the parent wordmark with text.');
const masterLogo = fs.readFileSync(path.join(repository, 'public', 'brand', 'trucker-heaven-logo-master.jpg'));
assert.equal(crypto.createHash('sha256').update(masterLogo).digest('hex'), '1f266c4d8cc0457a8d4ea6421f2b2fb4d71b933a3d6e55019026e9effcb4d178', 'Approved Trucker Heaven master logo must remain immutable.');
for (const name of ['trucker-heaven-logo-full.png', 'trucker-heaven-logo-nav.png']) {
  const built = fs.readFileSync(path.join(dist, 'brand', name));
  const canonical = fs.readFileSync(path.join(repository, 'public', 'brand', name));
  assert.deepEqual(built, canonical, `Built ${name} must be byte-identical to the canonical transparent derivative.`);
  assert.equal(built.subarray(1, 4).toString(), 'PNG', `${name} must remain a PNG asset.`);
}
assert.doesNotMatch(html, /https?:\/\/[^"']+logo/i, 'Customer branding must not depend on an external logo host.');
const styles = fs.readFileSync(path.join(dist, manifest.assets['styles.css']), 'utf8');
const liquidGlass = fs.readFileSync(path.join(dist, manifest.assets['liquid-glass.css']), 'utf8');
for (const token of ['color-scheme: light', '--brand-blue: #2855a5', '--page: #edf4f7', '--surface: rgb(255 255 255 / 76%)', '--text: #071820', 'url("images/trucker-heaven-aerial.jpg")']) assert.ok(liquidGlass.includes(token), `Customer stylesheet is missing daylight Liquid Glass token ${token}.`);
for (const token of ['--page: #cbd9e6', '--text: #102b42', 'rgb(6 37 70 / 92%)', 'backdrop-filter: blur(11px)', '.monthly-map-stage, .map-stage { backdrop-filter: none']) assert.ok(liquidGlass.includes(token), `Customer stylesheet is missing premium blue-glass token ${token}.`);
assert.ok(html.includes('Park your truck.') && html.includes('Keep moving.'), 'Customer hero must retain the approved daylight booking headline.');
assert.ok(!html.includes('theme-color" content="#030811'), 'Customer entrypoint must not advertise the retired dark theme.');
assert.ok(html.includes('theme-color" content="#0b3d66'), 'Customer entrypoint must advertise the premium navy browser chrome tone.');
for (const className of ['LiquidGlass', 'GlassNav', 'GlassButton', 'GlassPanel', 'GlassInput', 'GlassStep', 'GlassOffer', 'GlassModal', 'GlassActionBar']) assert.ok(`${html}\n${app}\n${liquidGlass}`.includes(className), `Customer Liquid Glass system is missing ${className}.`);
assert.ok(liquidGlass.includes('@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))'), 'Customer Liquid Glass must include a solid-surface fallback.');
assert.ok(liquidGlass.includes('@media (max-width: 430px)') && liquidGlass.includes('@media (max-width: 390px)'), 'Customer Liquid Glass must include explicit small-mobile layouts.');
assert.ok(!`${html}\n${app}`.includes('$NaN'), 'Built UI must never ship an invalid money label.');
assert.ok(core.includes("Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY'])"), 'Built customer core must declare the Daily/Weekly/Monthly product allowlist.');
assert.ok(app.includes('state.selectedDuration = duration') && app.includes('duration: state.selectedDuration'), 'Built customer must store and send an explicit selected product.');
assert.ok(app.includes('Monthly parking is not configured for this parking type'), 'Built customer must expose the honest no-Monthly state.');
assert.ok(app.includes('syncMonthlyDateFields') && core.includes("duration === 'MONTHLY'"), 'Built customer must expose start-only open-ended Monthly parking.');
assert.ok(app.includes('minimumWeeklyDays()') && app.includes("duration === 'WEEKLY'"), 'Built customer must expose and validate the Weekly product.');
assert.ok(!app.includes('durationHint') && !app.includes('derivedDuration'), 'Built customer must not derive product selection from the date interval.');
assert.ok(app.includes("WEEKLY: 'Weekly'") && core.includes("selected === 'WEEKLY'"), 'Built customer artifact must contain the explicit Weekly product label and interval rule.');
console.log(`Customer build verified (revision ${manifest.revision}) with ordered immutable assets and all route containers.`);
