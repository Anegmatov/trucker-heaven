require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../db/connection");
const { runWorker } = require("../services/notificationWorker");
const { logFailure } = require("../utils/safeLog");

runWorker({ database: db }).catch(async (error) => {
  logFailure("notifications.worker", error);
  await db.end().catch(() => undefined);
  process.exitCode = 1;
});
