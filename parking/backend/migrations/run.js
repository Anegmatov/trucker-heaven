#!/usr/bin/env node
// `npm run migrate` — applies pending migrations to PARKING_DATABASE_URL.
const config = require('../config');
const { runMigrations } = require('./index');
runMigrations(config.databaseUrl, { log: console.log }).catch(error => {
  const details = [error?.message, ...(Array.isArray(error?.errors) ? error.errors.map(item => item?.message) : []), error?.cause?.message].filter(Boolean);
  console.error('Migration failed:', details.join(' | ') || error?.code || String(error));
  if (process.env.NODE_ENV !== 'production') console.error(error?.stack || error);
  process.exit(1);
});
