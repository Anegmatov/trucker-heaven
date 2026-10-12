process.env.NODE_ENV = 'test';
process.env.PARKING_DEMO_PAYMENT_BYPASS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test'
    || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing demo-bypass PostgreSQL tests: use parkingops_test only.');
}

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});

async function post(path, body) {
  const response = await fetch(`${base}/api/public/parking/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test('demo payment authorization and completion fail closed when the server flag is false', async () => {
  const before = Number((await pool.query('SELECT count(*) FROM parking_demo_payment_grants')).rows[0].count);
  for (const path of ['/payments/demo/authorization', '/payments/demo/confirm']) {
    const result = await post(path, { token: 'untrusted-browser-value-that-cannot-enable-demo-mode' });
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error.code, 'DEMO_PAYMENT_BYPASS_DISABLED');
  }
  assert.equal(Number((await pool.query('SELECT count(*) FROM parking_demo_payment_grants')).rows[0].count), before);
});
