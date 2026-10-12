const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const configPath = path.join(__dirname, '..', 'config.js');
const baseEnvironment = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  PARKING_DATABASE_URL: 'postgresql://parking:secret@example.test:5432/parkingops',
  PARKING_SESSION_TOKEN_PEPPER: '0123456789abcdef0123456789abcdef',
  PARKING_COOKIE_SECURE: 'true',
  PARKING_CORS_ALLOWED_ORIGINS: 'https://customer.example.test,https://admin.example.test'
};

function load(environment) {
  return spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(configPath)});if(!c.production||c.trustProxyHops!==1||c.corsAllowedOrigins.length!==2)process.exit(2)`], {
    cwd: os.tmpdir(), env: { ...baseEnvironment, ...environment }, encoding: 'utf8'
  });
}

test('production configuration fails closed for insecure cookies and malformed numeric settings', () => {
  const insecure = load({ PARKING_COOKIE_SECURE: 'false' });
  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /COOKIE_SECURE=true/);
  const malformed = load({ PARKING_PUBLIC_QUOTE_TTL_SECONDS: 'not-a-number' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /PUBLIC_QUOTE_TTL_SECONDS must be an integer/);
  const impossibleMonthly = load({ PARKING_PUBLIC_BOOKING_MINIMUM_MONTHLY_DAYS: '60', PARKING_PUBLIC_BOOKING_MAXIMUM_MONTHLY_DAYS: '30' });
  assert.notEqual(impossibleMonthly.status, 0);
  assert.match(impossibleMonthly.stderr, /PUBLIC_BOOKING_MINIMUM_MONTHLY_DAYS cannot exceed/);
  const invalidSameSite = load({ PARKING_COOKIE_SAME_SITE: 'sometimes' });
  assert.notEqual(invalidSameSite.status, 0);
  assert.match(invalidSameSite.stderr, /COOKIE_SAME_SITE must be lax, strict, or none/);
  const shortCheckout = load({ PARKING_STRIPE_CHECKOUT_TTL_SECONDS: '1799' });
  assert.notEqual(shortCheckout.status, 0);
  assert.match(shortCheckout.stderr, /STRIPE_CHECKOUT_TTL_SECONDS must be an integer/);
});

test('valid production configuration parses once with explicit origins and proxy trust', () => {
  const result = load({ PARKING_TRUST_PROXY_HOPS: '1', PARKING_COOKIE_SAME_SITE: 'none', PARKING_STRIPE_CHECKOUT_TTL_SECONDS: '1800' });
  assert.equal(result.status, 0, result.stderr);
});

test('demo payment bypass is disabled by default and accepts only explicit booleans', () => {
  const defaultResult = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(configPath)});if(c.demoPaymentBypass.enabled!==false||c.demoPaymentBypass.ttlSeconds!==300)process.exit(2)`], {
    cwd: os.tmpdir(), env: { PATH: process.env.PATH, NODE_ENV: 'development' }, encoding: 'utf8'
  });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  const invalid = load({ PARKING_DEMO_PAYMENT_BYPASS_ENABLED: 'yes' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /DEMO_PAYMENT_BYPASS_ENABLED must be true or false/);
});

test('development defaults allow only the customer and canonical admin origins', () => {
  const expected = [
    'http://localhost:5180', 'http://localhost:5181',
    'http://127.0.0.1:5180', 'http://127.0.0.1:5181'
  ];
  const script = `const c=require(${JSON.stringify(configPath)});const expected=${JSON.stringify(expected)};if(JSON.stringify(c.corsAllowedOrigins)!==JSON.stringify(expected))process.exit(2)`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: os.tmpdir(), env: { PATH: process.env.PATH, NODE_ENV: 'development' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
