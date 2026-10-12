// Short-lived reservation access grants: issued when a customer finds their rental by
// email + phone, so the private access token texted to them never has to be shown or rotated.
// Format: g.<reservationId>.<expiresAtSeconds>.<signature>  (signature = HMAC-SHA256 over id + expiry)
const crypto = require("crypto");
const { moduleEnv } = require("../config/env");

const GRANT_TTL_SECONDS = 24 * 60 * 60;
const GRANT_PATTERN = /^g\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/;

function pepper(env = moduleEnv()) {
  return String(env.SESSION_TOKEN_PEPPER || "development-only-session-pepper");
}

function sign(id, expiresAt, env) {
  return crypto.createHmac("sha256", pepper(env)).update(`grant:${id}:${expiresAt}`).digest("base64url").slice(0, 32);
}

function issueGrant(reservationId, { env = moduleEnv(), now = Date.now(), ttlSeconds = GRANT_TTL_SECONDS } = {}) {
  const id = Number(reservationId);
  if (!Number.isInteger(id) || id < 1) throw new Error("Invalid reservation id");
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  return `g.${id}.${expiresAt}.${sign(id, expiresAt, env)}`;
}

const isGrant = (value) => typeof value === "string" && value.startsWith("g.");

// Returns the reservation id for a valid, unexpired grant, or null.
function verifyGrant(value, { env = moduleEnv(), now = Date.now() } = {}) {
  const match = GRANT_PATTERN.exec(String(value || ""));
  if (!match) return null;
  const id = Number(match[1]);
  const expiresAt = Number(match[2]);
  if (!Number.isInteger(id) || id < 1 || expiresAt * 1000 < now) return null;
  const expected = Buffer.from(sign(id, expiresAt, env));
  const given = Buffer.from(match[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return id;
}

module.exports = { GRANT_TTL_SECONDS, isGrant, issueGrant, verifyGrant };
