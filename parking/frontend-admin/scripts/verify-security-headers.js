const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const blueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
const required = new Map([
  ['Cache-Control', 'no-store, max-age=0, must-revalidate'],
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()']
]);

assert.match(blueprint, /name:\s*trucker-heaven-parking-admin/);
for (const [name, value] of required) {
  assert.match(blueprint, new RegExp(`name: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n\\s+value: ["']?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${name} policy is missing from the admin static service`);
}
const cspRules = [...blueprint.matchAll(/name:\s*Content-Security-Policy\s*\r?\n\s*value:\s*["']?([^\r\n]+)/g)];
assert.equal(cspRules.length, 1, 'The admin must emit one authoritative CSP policy');
const csp = cspRules[0][1];
for (const directive of ["default-src 'self'", "connect-src 'self' https://trucker-heaven-parking-api-vkf9.onrender.com", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
  assert.ok(csp.includes(directive), `CSP is missing ${directive}`);
}

async function verifyDeployed(url) {
  const response = await fetch(url, { redirect: 'follow' });
  assert.equal(response.status, 200, `Deployed admin returned ${response.status}`);
  const expected = {
    'cache-control': /no-store/i,
    'content-security-policy': /frame-ancestors\s+'none'/i,
    'x-frame-options': /^DENY$/i,
    'x-content-type-options': /^nosniff$/i,
    'referrer-policy': /no-referrer/i,
    'permissions-policy': /camera=\(\).*microphone=\(\).*geolocation=\(\)/i
  };
  for (const [name, pattern] of Object.entries(expected)) {
    assert.match(response.headers.get(name) || '', pattern, `Deployed ${name} header is missing or invalid`);
  }
}

(async () => {
  if (process.env.PARKING_ADMIN_DEPLOYED_URL) await verifyDeployed(process.env.PARKING_ADMIN_DEPLOYED_URL);
  console.log(`Admin security-header contract passed${process.env.PARKING_ADMIN_DEPLOYED_URL ? ' against deployment' : ' for Render Blueprint configuration'}.`);
})().catch(error => { console.error(error.message); process.exit(1); });
