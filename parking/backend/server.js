/*
 * Standalone entry point: initialise the Parking API (connect + migrate),
 * start the background sweep and listen on PORT. A parent app that mounts
 * app.js calls init() itself and never requires this file.
 */
const app = require('./app');
const config = require('./config');

app.init({ log: console.log }).then(() => {
  const server = app.listen(config.port, () => {
    console.log(`Parking API listening on ${config.port}`);
    app.startBackgroundJobs();
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.stopBackgroundJobs();
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceTimer.unref();
    server.close(() => app.close().finally(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    }));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}).catch(error => {
  console.error('Parking API failed to start:', error.message);
  process.exit(1);
});
