'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'parkingops-admin-build.json'), 'utf8'));
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');

for (const [source, output] of Object.entries(manifest.assets)) {
  assert.ok(fs.existsSync(path.join(dist, output)), `Build is missing ${output}.`);
  assert.ok(html.includes(output) || source === 'assets/trucker-heaven-logo-nav.png', `Entrypoint does not reference ${source}.`);
}
const scripts = [...html.matchAll(/<script src="\.\/([^"?]+)"><\/script>/g)].map(match => match[1]);
assert.deepEqual(scripts, ['render-runtime.js', 'config.js', 'api.js', 'routes.js', 'admin-core.js', 'reservation-desk.js', 'advanced.js', 'app.js'].map(file => manifest.assets[file]), 'Built script order is unsafe.');

const runtime = fs.readFileSync(path.join(dist, manifest.assets['render-runtime.js']), 'utf8');
for (const required of ['https://trucker-heaven-parking-api-vkf9.onrender.com/api', 'https://trucker-heaven-parking-a437.onrender.com', 'https://truckerheaven.com']) {
  assert.ok(runtime.includes(required), `Built runtime is missing ${required}.`);
}
assert.doesNotMatch(runtime, /trucker-heaven-parking-operations\.onrender\.com|fallbackAdminUrl|operationsUrl/, 'Built runtime depends on a retired employee frontend.');
if (manifest.runtimeConfigurationSource === 'build-environment') assert.equal(/localhost|127\.0\.0\.1/i.test(runtime), false, 'Production-injected runtime contains a localhost fallback.');

const app = fs.readFileSync(path.join(dist, manifest.assets['app.js']), 'utf8');
assert.ok(app.includes(manifest.assets['assets/trucker-heaven-logo-nav.png']), 'Built application does not reference the revisioned Customer Parking logo.');
assert.ok(!app.includes('assets/trucker-heaven-logo-nav.png"'), 'Built application references the unhashed Customer Parking logo.');
assert.ok(!app.includes('trucker-heaven-logo.jpg'), 'Built application still references the legacy logo.');
const logo = fs.readFileSync(path.join(dist, manifest.assets['assets/trucker-heaven-logo-nav.png']));
const sourceLogo = fs.readFileSync(path.resolve(root, '..', 'public', 'brand', 'trucker-heaven-logo-nav.png'));
assert.deepEqual(logo, sourceLogo, 'Built admin logo must be byte-identical to the Customer Parking navigation logo.');
assert.equal(crypto.createHash('sha256').update(logo).digest('hex'), '8cb924003338c2f551332d968031d2b399bc350488299ae9eb5a3061ffe3f8f3', 'Admin logo must match the exact Customer Parking navigation logo.');
assert.doesNotMatch(app, /https?:\/\/[^"']+logo/i, 'Admin branding must not depend on an external logo host.');
const styles = fs.readFileSync(path.join(dist, manifest.assets['styles.css']), 'utf8');
for (const token of ['--brand-green:#95b85a', '--brand-blue:#2855a5', '--facility-amber:#2855a5', '--facility-ink:#071820', '--text:#071820', '--bg:#f4f7f8']) assert.ok(styles.includes(token), `Admin stylesheet is missing Trucker Heaven theme token ${token}.`);
for (const color of ['#63ad42', '#2855a5', '#7a3db8', '#f4cf23', '#d43c32', '#718089']) {
  assert.ok(styles.includes(`background:${color}!important`), `Admin build is missing official allocation fill ${color}.`);
}
assert.doesNotMatch(styles, /\.operational-map-space\.available\s*\{[^}]*background:/, 'Available status must not override the official allocation fill.');
const textAssets = ['render-runtime.js', 'config.js', 'api.js', 'routes.js', 'admin-core.js', 'reservation-desk.js', 'advanced.js', 'app.js', 'styles.css', 'advanced.css', 'reservation-desk.css'];
const artifact = [html, ...textAssets.map(file => fs.readFileSync(path.join(dist, manifest.assets[file]), 'utf8'))].join('\n');
assert.equal((html.match(/id="app"/g) || []).length, 1, 'Build must contain one application shell.');
assert.equal((artifact.match(/\/admin\/auth\/login/g) || []).length, 1, 'Build must contain one login implementation.');
assert.ok(html.includes('advancedAdminRoot') && html.includes('publishChecklistDialog') && html.includes('adminUsersPanel'), 'Build is missing OWNER tools.');
assert.ok(artifact.includes('canonicalMaintenanceLocked') && artifact.includes('physicalConfirmation: true'), 'Built Lot Setup safety wiring is incomplete.');
assert.doesNotMatch(artifact, /fallbackAdminUrl|parking-operations\.onrender\.com|sourceMappingURL|postgres(?:ql)?:\/\/|BEGIN PRIVATE KEY|service_role/i, 'Built frontend contains a retired dependency, source map, or credential marker.');
assert.equal(fs.readdirSync(dist, { recursive: true }).some(file => String(file).endsWith('.map')), false, 'Built frontend emits a source-map file.');
console.log(`Canonical ParkingOps admin build verified (revision ${manifest.revision}; runtime ${manifest.runtimeConfigurationSource}).`);
