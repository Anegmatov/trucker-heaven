/*
 * The one connection pool for this module, built from PARKING_DATABASE_URL
 * (see config.js). Creating the pool does not open a connection; the first
 * query does, so requiring this file has no side effects.
 */
const { Pool } = require('pg');
const config = require('./config');
const { safeLog } = require('./utils');
const { createDatabasePoolConfig } = require('./databaseConnection');

if (!config.databaseUrl) throw new Error('PARKING_DATABASE_URL is required.');
const pool = new Pool(createDatabasePoolConfig(config.databaseUrl, { allowLocal: true }));
pool.on('error', (error) => safeLog('db.pool', error));
module.exports = pool;
