// One pool for the whole module, created lazily from RENTALS_DATABASE_URL (or RENTALS_PG* parts).
// Requiring this file has no side effects: nothing connects until the first query, testConnection() or init().
const { Pool } = require("pg");
const { moduleEnv } = require("../config/env");
const { logFailure } = require("../utils/safeLog");

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function poolConfigFrom(env = moduleEnv(), { connectionString } = {}) {
  const url = connectionString || env.DATABASE_URL;
  const sslMode = String(env.PGSSLMODE || "").toLowerCase();
  const sslEnabled = isEnabled(env.DATABASE_SSL) || ["require", "verify-ca", "verify-full"].includes(sslMode);
  const config = { max: Number(env.PGPOOL_MAX || 10) };

  if (url) {
    config.connectionString = url;
  } else {
    const missing = ["PGDATABASE", "PGUSER"].filter((key) => !env[key]);
    if (missing.length > 0) console.warn(`[db] database configuration is incomplete: RENTALS_${missing.join(", RENTALS_")} (or set RENTALS_DATABASE_URL).`);
    config.host = env.PGHOST || "localhost";
    config.port = Number(env.PGPORT || 5432);
    config.database = env.PGDATABASE || "driveops";
    config.user = env.PGUSER || undefined;
    config.password = env.PGPASSWORD || undefined;
  }
  if (sslEnabled) {
    config.ssl = { rejectUnauthorized: String(env.DATABASE_SSL_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false" };
  }
  return config;
}

let pool = null;
let pendingConfig = null;

// Optional: fix the pool settings before first use (init() calls this with the module env).
function configure(env = moduleEnv(), options = {}) {
  if (pool) throw new Error("database pool is already created; configure() must run before the first query");
  pendingConfig = poolConfigFrom(env, options);
}

function getPool() {
  if (!pool) {
    pool = new Pool(pendingConfig || poolConfigFrom());
    pool.on("error", (error) => logFailure("db.pool", error));
  }
  return pool;
}

async function testConnection() {
  let client;
  try {
    client = await getPool().connect();
    await client.query("SELECT 1");
    console.log("[db] PostgreSQL connection verified.");
  } catch (error) {
    logFailure("db.startup", error);
    throw new Error("PostgreSQL connection is unavailable");
  } finally {
    client?.release();
  }
}

async function end() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

const db = {
  query: (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
  on: (...args) => getPool().on(...args),
  end,
  testConnection,
  configure,
  getPool,
  poolConfigFrom,
  get isOpen() { return pool !== null; }
};

module.exports = db;
module.exports.default = db;
