const fs = require("node:fs/promises");
const path = require("node:path");

const migrationsDirectory = path.join(__dirname, "..", "migrations");
const migrationLockId = 814670311;

async function migrationFiles() {
  return (await fs.readdir(migrationsDirectory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const filename of await migrationFiles()) {
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
      const checksum = require("node:crypto").createHash("sha256").update(sql).digest("hex");
      const existing = await client.query("SELECT checksum FROM schema_migrations WHERE migration = $1", [filename]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (migration, checksum) VALUES ($1, $2)", [filename, checksum]);
        await client.query("COMMIT");
        console.log(`[migrations] applied ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationLockId]).catch(() => {});
    client.release();
  }
}

module.exports = { migrationFiles, runMigrations };
