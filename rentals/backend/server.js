// Standalone entry point: loads this module's .env, runs startup, then listens on PORT.
// The future shared parent app requires ./app and ./startup directly and never runs this file.
const http = require("http");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const app = require("./app");
const { init, shutdown } = require("./startup");
const { logFailure } = require("./utils/safeLog");

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function installShutdownHandlers(server) {
  let shuttingDown = false;

  async function stop(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received; shutting down.`);
    try {
      await closeServer(server);
      await shutdown();
      console.log("[server] shutdown complete.");
      process.exit(0);
    } catch (error) {
      logFailure("server.shutdown", error);
      process.exit(1);
    }
  }

  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

async function start() {
  await init();
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  installShutdownHandlers(server);
  console.log(`[server] Rentals API listening on port ${port}.`);
  return server;
}

if (require.main === module) {
  start().catch(async (error) => {
    logFailure("server.startup", error);
    await shutdown().catch(() => undefined);
    process.exit(1);
  });
}

module.exports = { createApp: app.createApp, createRateLimiter: app.createRateLimiter, installShutdownHandlers, livenessResponse: app.livenessResponse, start };
