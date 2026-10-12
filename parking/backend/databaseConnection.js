/*
 * One connection policy for the API and guarded operational tools.  SSL query
 * parameters are removed from the URL before node-postgres sees it because pg
 * gives URL SSL options precedence over the explicit `ssl` object.
 */
const fs = require('fs');
const net = require('net');

const SSL_QUERY_KEYS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'];

function classifyPostgresHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipVersion = net.isIP(host);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal' || host.endsWith('.local')
    || host === '::1' || host === '0.0.0.0' || (ipVersion === 4 && host.startsWith('127.'))
    || /^(?:postgres(?:ql)?|db|database|pg|parkingops[-_]?(?:db|postgres)|trucker[-_]?heaven[-_]?postgres)$/i.test(host)) return 'local-or-service-alias';
  if (/^dpg-[a-z0-9-]+$/i.test(host)) return host.includes('pooler') ? 'render-internal-pooler' : 'render-internal';
  if (host.endsWith('.render.com')) return host.includes('pooler') ? 'render-external-pooler' : 'render-external';
  return 'unknown-remote';
}

function parsePostgresUrl(connectionString) {
  if (!connectionString) throw new Error('PARKING_DATABASE_URL is required.');
  let url; try { url = new URL(connectionString); } catch (_) { throw new Error('PARKING_DATABASE_URL is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PARKING_DATABASE_URL must use a PostgreSQL scheme.');
  return { url, database: decodeURIComponent(url.pathname.replace(/^\//, '')), hostClassification: classifyPostgresHost(url.hostname) };
}

function normalizedConnectionString(connectionString) {
  const { url, database, hostClassification } = parsePostgresUrl(connectionString);
  const sslParameters = Object.fromEntries(SSL_QUERY_KEYS.filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]));
  for (const key of SSL_QUERY_KEYS) url.searchParams.delete(key);
  return { connectionString: url.toString(), database, hostClassification, sslParameters };
}

function requestedTls(sslParameters, environment) {
  const explicit = sslParameters.sslmode || sslParameters.ssl || sslParameters.sslcert || sslParameters.sslkey || sslParameters.sslrootcert || sslParameters.sslnegotiation || environment.PARKING_DATABASE_SSL;
  if (!explicit) return null;
  return !/^(?:0|false|disable)$/i.test(String(explicit));
}

function tlsMaterial(sslParameters) {
  const material = {};
  for (const [parameter, property, label] of [['sslrootcert', 'ca', 'root certificate'], ['sslcert', 'cert', 'client certificate'], ['sslkey', 'key', 'client key']]) {
    if (!sslParameters[parameter]) continue;
    try { material[property] = fs.readFileSync(sslParameters[parameter], 'utf8'); }
    catch (_) { throw new Error(`Configured PostgreSQL ${label} is unavailable.`); }
  }
  return material;
}

function createDatabasePoolConfig(connectionString, { environment = process.env, allowLocal = false } = {}) {
  const normalized = normalizedConnectionString(connectionString);
  const { hostClassification, sslParameters } = normalized;
  if (!allowLocal && hostClassification === 'local-or-service-alias') throw new Error('Refusing a localhost or local service database host.');
  const privateRender = hostClassification === 'render-internal' || hostClassification === 'render-internal-pooler';
  const tlsRequested = requestedTls(sslParameters, environment);
  const material = tlsMaterial(sslParameters);
  let ssl;
  if (privateRender) {
    // The normal API historically makes a plain private-network connection
    // unless TLS is explicitly requested.  When Render private TLS is
    // requested without a configured CA, accept only that private endpoint's
    // self-signed certificate; public and unknown hosts never use this path.
    if (tlsRequested === null || tlsRequested === false) ssl = false;
    else ssl = material.ca ? { rejectUnauthorized: true, ...material } : { rejectUnauthorized: false, ...material };
  } else if (hostClassification === 'local-or-service-alias') {
    ssl = tlsRequested ? { rejectUnauthorized: true, ...material } : false;
  } else {
    ssl = { rejectUnauthorized: true, ...material };
  }
  const config = { connectionString: normalized.connectionString, ssl };
  if (sslParameters.sslnegotiation) config.sslnegotiation = sslParameters.sslnegotiation;
  return { ...config, database: normalized.database, hostClassification };
}

module.exports = { SSL_QUERY_KEYS, classifyPostgresHost, parsePostgresUrl, normalizedConnectionString, createDatabasePoolConfig };
