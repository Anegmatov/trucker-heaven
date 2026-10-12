const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'frontend-admin/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend-admin/index.html'), 'utf8');
const adminRoutes = require(path.join(root, 'frontend-admin/routes.js'));
const lotGeometry = require(path.join(root, 'frontend-admin/lot-geometry.js'));
const backendRoutes = fs.readFileSync(path.join(root, 'backend/routes/adminParking.js'), 'utf8');

const checks = [
  ['Lot Setup is a first-class canonical route', adminRoutes.normalize('lot-setup') === 'lot-setup' && adminRoutes.panels['lot-setup'][0] === 'lotLayoutPanel'],
  ['legacy map routes normalize to Lot Setup', ['physical-map', 'parking-types'].every(route => adminRoutes.normalize(route) === 'lot-setup')],
  ['map-first editor is the deployed panel', ['lotLayoutPanel', 'lotSetupHeading', 'layoutCanvas', 'layoutProperties', 'layoutPreview'].every(marker => html.includes(marker)) && !html.includes('physicalMapPanel')],
  ['legacy advanced CRUD panels are absent from the entrypoint', ['config-zones', 'config-categories', 'config-inventory', 'Zone override (optional)'].every(marker => !html.includes(marker))],
  ['app consumes the canonical route registry', app.includes('adminRoutes.normalize(view)') && !app.includes('const aliases =')],
  ['PDF-derived geometry contains the authoritative 185 spaces only', lotGeometry.spaceNumbers.length === 185 && !lotGeometry.spaceNumbers.some(number => number >= 91 && number <= 100)],
  ['Lot Setup renders the PDF geometry without invented annotations', app.includes('lotPresentationGeometry') && ['Northbound perimeter flow', 'West perimeter drive', 'Air circulation', 'East north island', 'Southbound perimeter drive', 'Main entrance / check-in', 'Trucker Heaven west structure', 'West shop barrier', 'East company island', 'Lower boom barrier', 'Lower service structure'].every(label => !html.includes(label) && !app.includes(label))],
  ['Lot Setup uses the concise header and draft status', html.includes('<h2 id="lotSetupHeading">Lot Setup</h2>') && !html.includes('Edit Map &amp; Spaces') && app.includes('>Editing draft<')],
  ['structural maintenance remains backend fenced', backendRoutes.includes("PARKING_CANONICAL_LAYOUT_MAINTENANCE === 'true'") && backendRoutes.includes('CANONICAL_LAYOUT_LOCKED') && backendRoutes.includes('requireCanonicalLayoutMaintenance(client, locationId)')],
  ['staff cannot see owner structural navigation', app.includes("$$('[data-owner-nav]').forEach(item => { item.hidden = !isOwner(); });")]
];

for (const [name, passed] of checks) assert.ok(passed, `Admin Lot Setup verification failed: ${name}`);
console.log(`Admin Lot Setup verified: ${checks.length} checks.`);
