require("dotenv").config();
const { loadConfig } = require("../lib/config");
const { createPool } = require("../db/connection");
const { runMigrations } = require("../db/migrate");

async function main() {
  const pool = createPool(loadConfig());
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[migrations] failed:", error.message);
  process.exitCode = 1;
});
