'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'render-runtime.js'), 'utf8');
const configSource = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
function evaluate(hostname, explicit) {
  const window = { location: { hostname, origin: `http://${hostname}:5180` }, ...(explicit ? { PARKING_ADMIN_RUNTIME_CONFIG: explicit } : {}) };
  vm.runInNewContext(runtimeSource, { window });
  vm.runInNewContext(configSource, { window, URL });
  return window.PARKING_ADMIN_CONFIG;
}

test('production and localhost use exact explicit host mappings', () => {
  assert.equal(evaluate('trucker-heaven-parking-admin-krfn.onrender.com').environment, 'production');
  assert.equal(evaluate('localhost').apiBase, 'http://localhost:5180/api');
  assert.equal(evaluate('localhost').customerAppUrl, 'http://localhost:5181');
});

test('preview and unknown custom hosts fail closed', () => {
  const preview = evaluate('deploy-pr-42-trucker-heaven-parking-admin-krfn.onrender.com');
  assert.equal(preview.valid, false);
  assert.match(preview.error, /no explicit runtime configuration/i);
  assert.equal(evaluate('admin.example.com').valid, false);
});

test('custom and preview hosts accept explicit valid config but reject malformed protocols', () => {
  const custom = evaluate('admin.example.com', { environment: 'custom', apiBase: 'https://api.example.com/api', customerAppUrl: 'https://parking.example.com', parentSiteUrl: 'https://example.com' });
  assert.equal(custom.valid, true);
  assert.equal(evaluate('admin.example.com', { apiBase: 'javascript:alert(1)', customerAppUrl: 'https://parking.example.com', parentSiteUrl: 'https://example.com' }).valid, false);
  assert.equal(evaluate('preview.example.com', { environment: 'preview', apiBase: 'https://trucker-heaven-parking-api-vkf9.onrender.com/api', customerAppUrl: 'https://parking.example.com', parentSiteUrl: 'https://example.com' }).valid, true);
});

test('the API, customer application, and parent site are all explicit', () => {
  const minimal = evaluate('admin.example.com', { environment: 'custom', apiBase: 'https://api.example.com/api' });
  assert.equal(minimal.valid, false);
  assert.equal(evaluate('admin.example.com', { customerAppUrl: 'https://parking.example.com' }).valid, false);
  assert.equal(evaluate('admin.example.com', { apiBase: 'https://api.example.com', customerAppUrl: 'file:///tmp/customer' }).valid, false);
});
