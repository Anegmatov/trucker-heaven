const { Pool } = require("pg");

function createPool(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: "foodops-api"
  });
  pool.on("error", (error) => console.error("[database] idle client error", error.message));
  return pool;
}

module.exports = { createPool };
