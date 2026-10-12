const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../db');
const config = require('../config');
const app = require('../app');

if (process.env.PARKING_TEST_DATABASE !== 'parkingops_test' || !String(process.env.PARKING_DATABASE_URL || '').includes('parkingops_test')) {
  throw new Error('Refusing auth concurrency tests: set PARKING_TEST_DATABASE=parkingops_test and a matching PARKING_DATABASE_URL.');
}

const password = 'ParkingOps-auth-concurrency-2031';
const wrongPassword = 'ParkingOps-auth-concurrency-wrong';
let server;
let base;
const usernames = ['auth-race-primary', 'auth-race-secondary'];

async function createUser(username) {
  await pool.query(`INSERT INTO parking_admin_users(username,password_hash,role,active,failed_login_count,locked_until)
    VALUES($1,$2,'OWNER',true,0,NULL)
    ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,active=true,failed_login_count=0,locked_until=NULL`,
  [username, await bcrypt.hash(password, 4)]);
}

function login(username, suppliedPassword) {
  return fetch(`${base}/api/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: suppliedPassword })
  });
}

async function userState(username) {
  return (await pool.query('SELECT failed_login_count,locked_until FROM parking_admin_users WHERE username=$1', [username])).rows[0];
}

async function waitForLockWaiters(minimum) {
  for (let attempts = 0; attempts < 500; attempts += 1) {
    const waiting = await pool.query(`SELECT count(*)::int count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE 'SELECT * FROM parking_admin_users WHERE username=%FOR UPDATE%'`);
    if (waiting.rows[0].count >= minimum) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${minimum} authentication row-lock waiter(s)`);
}

test.before(async () => {
  await Promise.all(usernames.map(createUser));
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await pool.query('DELETE FROM parking_admin_sessions WHERE admin_user_id IN (SELECT id FROM parking_admin_users WHERE username=ANY($1))', [usernames]);
  await pool.query('DELETE FROM parking_admin_users WHERE username=ANY($1)', [usernames]);
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test.beforeEach(async () => {
  await pool.query(`UPDATE parking_admin_users SET active=true,failed_login_count=0,locked_until=NULL
    WHERE username=ANY($1)`, [usernames]);
});

test('simultaneous invalid logins atomically reach the threshold and lock the account', async () => {
  await pool.query('UPDATE parking_admin_users SET failed_login_count=$2 WHERE username=$1',
    [usernames[0], config.adminLockout.threshold - 1]);
  const replies = await Promise.all([...Array(config.adminLockout.threshold)].map(() => login(usernames[0], wrongPassword)));
  assert.deepEqual(replies.map(reply => reply.status), Array(config.adminLockout.threshold).fill(401));
  const state = await userState(usernames[0]);
  assert.equal(state.failed_login_count, (config.adminLockout.threshold - 1) + config.adminLockout.threshold);
  assert.ok(state.locked_until > new Date());

  const correctWhileLocked = await login(usernames[0], password);
  assert.equal(correctWhileLocked.status, 401);
  assert.deepEqual(await correctWhileLocked.json(), { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });

  await pool.query("UPDATE parking_admin_users SET locked_until=now()-interval '1 second' WHERE username=$1", [usernames[0]]);
  const recovered = await login(usernames[0], password);
  assert.equal(recovered.status, 200, JSON.stringify(await recovered.json()));
  assert.equal((await userState(usernames[0])).failed_login_count, 0);
});

test('a queued success cannot erase a newer queued failure', async () => {
  await pool.query('UPDATE parking_admin_users SET failed_login_count=3 WHERE username=$1', [usernames[0]]);
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM parking_admin_users WHERE username=$1 FOR UPDATE', [usernames[0]]);
    const success = login(usernames[0], password);
    await waitForLockWaiters(1);
    const failure = login(usernames[0], wrongPassword);
    await waitForLockWaiters(2);
    await blocker.query('COMMIT');
    const [successReply, failureReply] = await Promise.all([success, failure]);
    assert.equal(successReply.status, 200, JSON.stringify(await successReply.json()));
    assert.equal(failureReply.status, 401);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
  assert.equal((await userState(usernames[0])).failed_login_count, 1,
    'the failure committed after the successful reset must remain recorded');
});

test('different accounts are isolated and normal success still works', async () => {
  const attempts = await Promise.all([
    ...Array.from({ length: 3 }, () => login(usernames[0], wrongPassword)),
    ...Array.from({ length: 2 }, () => login(usernames[1], wrongPassword))
  ]);
  assert.ok(attempts.every(reply => reply.status === 401));
  assert.equal((await userState(usernames[0])).failed_login_count, 3);
  assert.equal((await userState(usernames[1])).failed_login_count, 2);

  const successful = await login(usernames[1], password);
  assert.equal(successful.status, 200, JSON.stringify(await successful.json()));
  assert.equal((await userState(usernames[1])).failed_login_count, 0);

  const unknown = await login('auth-race-does-not-exist', wrongPassword);
  const known = await login(usernames[0], wrongPassword);
  assert.equal(unknown.status, 401);
  assert.equal(known.status, 401);
  assert.deepEqual(await unknown.json(), await known.json());
});
