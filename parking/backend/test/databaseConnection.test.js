const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabasePoolConfig } = require('../databaseConnection');
const runner = require('../scripts/runProductionRealLotImport');

const privateUrl = 'postgresql://runner:secret@dpg-cv123abc:5432/parkingops_prod';

test('Render private dpg connections preserve the healthy API default and use narrowly scoped self-signed TLS only when requested', () => {
  const plainPrivate = createDatabasePoolConfig(privateUrl, { environment: {} });
  assert.equal(plainPrivate.hostClassification, 'render-internal');
  assert.equal(plainPrivate.ssl, false);

  const selfSignedPrivate = createDatabasePoolConfig(`${privateUrl}?sslmode=require&application_name=parkingops`, { environment: {} });
  assert.deepEqual(selfSignedPrivate.ssl, { rejectUnauthorized: false });
  const normalized = new URL(selfSignedPrivate.connectionString);
  assert.equal(normalized.searchParams.has('sslmode'), false);
  assert.equal(normalized.searchParams.get('application_name'), 'parkingops');
  assert.deepEqual(runner.poolConfigFor({ connectionString: `${privateUrl}?sslmode=require`, database: 'parkingops_prod', hostClassification: 'render-internal' }, false).ssl, { rejectUnauthorized: false });
});

test('external and unknown PostgreSQL hosts always require verified TLS even when URL asks for no verification', () => {
  for (const url of [
    'postgresql://runner:secret@dpg-cv123abc-a.oregon-postgres.render.com:5432/parkingops_prod?sslmode=no-verify',
    'postgresql://runner:secret@unknown.example:5432/parkingops_prod?sslmode=no-verify'
  ]) {
    const config = createDatabasePoolConfig(url, { environment: {} });
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
  }
});

test('local factory use remains explicit and never exposes URL credentials in errors', () => {
  assert.throws(() => createDatabasePoolConfig('sqlite:///tmp/parkingops.sqlite'), /PostgreSQL scheme/);
  assert.throws(() => createDatabasePoolConfig('postgresql://runner:secret@localhost:5432/parkingops_prod'), /localhost or local service/);
  let error;
  try { createDatabasePoolConfig('postgresql://runner:secret@localhost:5432/parkingops_prod'); } catch (caught) { error = caught; }
  assert.doesNotMatch(error.message, /runner|secret|postgresql:/i);
});
