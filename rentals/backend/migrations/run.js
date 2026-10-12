// `npm run migrate`: applies pending migrations and exits. Same code path as init().
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { runMigrations, shutdown } = require("../startup");

runMigrations()
  .then(() => shutdown())
  .catch(async (error) => {
    console.error("[migrations] failed to apply tracked migrations.", error.message);
    await shutdown().catch(() => undefined);
    process.exitCode = 1;
  });
