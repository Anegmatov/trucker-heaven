'use strict';
/*
 * Every environment variable this module reads is prefixed with PARKING_ so it
 * can live beside other modules (rentals, food, time clock) in one process.
 * `env('DATABASE_URL')` reads PARKING_DATABASE_URL. Names that already start
 * with PARKING_ are read as they are. PORT (read only by server.js) and the
 * Node convention NODE_ENV are the only unprefixed variables.
 */
const PREFIX = 'PARKING_';

function key(name) {
  const value = String(name || '');
  return value.startsWith(PREFIX) ? value : `${PREFIX}${value}`;
}

function env(name, environment = process.env) {
  return environment[key(name)];
}

module.exports = { PREFIX, key, env };
