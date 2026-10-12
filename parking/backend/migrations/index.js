'use strict';
/*
 * Idempotent schema migrations. `runMigrations(databaseUrl)` opens its own
 * short-lived pool, applies every numbered .sql file in this folder that is
 * not yet recorded in schema_migrations, and closes the pool again. Calling
 * it repeatedly is safe: already-applied files are skipped. A pg Pool (or
 * client) may be passed instead of a URL; it is then used as-is and left open.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createDatabasePoolConfig } = require('../databaseConnection');

function migrationFiles() {
  return fs.readdirSync(__dirname).filter(file => /^\d+.*\.sql$/.test(file)).sort();
}

async function runMigrations(target, { log = () => {} } = {}) {
  const ownPool = typeof target === 'string' || target == null;
  const url = typeof target === 'string' ? target : (target == null ? require('../config').databaseUrl : null);
  if (ownPool && !url) throw new Error('PARKING_DATABASE_URL is required to run migrations.');
  const db = ownPool ? new Pool(createDatabasePoolConfig(url, { allowLocal: true })) : target;
  const applied = [];
  try {
    const identity = await db.query('SELECT current_database() database, current_schema() schema');
    if (identity.rows[0].database === 'ifta_db') throw new Error('Refusing to run ParkingOps migrations against ifta_db');
    log(`ParkingOps migration target: ${identity.rows[0].database}/${identity.rows[0].schema}`);
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of migrationFiles()) {
      const done = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
      if (done.rowCount) continue;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(__dirname, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
        log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    if (ownPool) await db.end();
  }
  return { applied, database: url ? new URL(url).pathname.replace(/^\//, '') : null };
}

module.exports = { runMigrations, migrationFiles };
