// Explicit startup for this module. Nothing here runs at require time.
//   init()                     -> verifies the pool from RENTALS_DATABASE_URL and applies pending migrations
//   runMigrations(databaseUrl) -> idempotent; applies migrations/*.sql not yet in schema_migrations (advisory-locked)
//   shutdown()                 -> closes the pool
const { Pool } = require("pg");
const db = require("./db/connection");
const { ensureSchema } = require("./db/initSchema");
const { moduleEnv } = require("./config/env");

async function runMigrations(databaseUrl) {
  if (!databaseUrl) return ensureSchema(db);
  const pool = new Pool(db.poolConfigFrom(moduleEnv(), { connectionString: databaseUrl }));
  try {
    await ensureSchema(pool);
  } finally {
    await pool.end();
  }
}

async function init({ env = moduleEnv(), migrate = true } = {}) {
  if (!db.isOpen) db.configure(env);
  await db.testConnection();
  if (migrate) await runMigrations();
  return { db };
}

async function shutdown() {
  await db.end();
}

module.exports = { init, runMigrations, shutdown };
