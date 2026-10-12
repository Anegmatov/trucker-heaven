// Module-scoped environment. This backend is one module of a shared Express process, so every
// setting it reads comes from a RENTALS_-prefixed variable (RENTALS_DATABASE_URL, RENTALS_CORS_ALLOWED_ORIGINS, ...).
// moduleEnv() strips the prefix into a plain object; the rest of the code reads that object, never process.env.
// Exceptions, by design: PORT (used only by server.js when running standalone) and NODE_ENV (process-wide by
// convention; RENTALS_NODE_ENV overrides it when set).
const PREFIX = "RENTALS_";
const PASSTHROUGH = ["PORT", "NODE_ENV"];

function moduleEnv(source = process.env) {
  const env = {};
  for (const key of PASSTHROUGH) if (source[key] !== undefined) env[key] = source[key];
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(PREFIX) && key.length > PREFIX.length) env[key.slice(PREFIX.length)] = value;
  }
  return env;
}

// Turns an internal (unprefixed) settings object back into prefixed variables, e.g. for child processes.
function prefixed(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    out[PASSTHROUGH.includes(key) ? key : `${PREFIX}${key}`] = value;
  }
  return out;
}

module.exports = { PREFIX, PASSTHROUGH, moduleEnv, prefixed };
