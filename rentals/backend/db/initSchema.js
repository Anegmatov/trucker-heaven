const fs = require("fs/promises");
const path = require("path");
const db = require("./connection");

const migrationsDirectory = path.join(__dirname, "..", "migrations");
const migrationLockId = 712694231;

async function migrationFiles() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function ensureSchema(pool = db, { throughMigration = null } = {}) {
  const client = await pool.connect();

  try {
    // Application migrations and runtime queries use PostgreSQL's public schema.
    await client.query("SET search_path TO public");
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const filename of await migrationFiles()) {
      if (throughMigration && filename.localeCompare(throughMigration) > 0) continue;
      const applied = await client.query(
        "SELECT migration FROM schema_migrations WHERE migration = $1",
        [filename]
      );

      if (applied.rowCount > 0) continue;

      const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (migration) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.log(`[db] Applied migration ${filename}.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("[db] PostgreSQL schema is ready.");
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [migrationLockId]);
    } finally {
      client.release();
    }
  }
}

module.exports = { ensureSchema, migrationFiles };
