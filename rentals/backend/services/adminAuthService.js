const crypto = require("crypto");
const bcrypt = require("bcrypt");

const PASSWORD_HASH_ROUNDS = 12;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function hashToken(value, pepper) {
  return crypto.createHash("sha256").update(`${pepper}:${value}`).digest("hex");
}
function randomToken() { return crypto.randomBytes(32).toString("base64url"); }
function safeUser(row) { return { id: row.id, email: row.email, role: row.role, authenticated: true }; }

async function createSession(db, user, config, userAgent = "") {
  const token = randomToken();
  const csrfToken = randomToken();
  const tokenHash = hashToken(token, config.session.tokenPepper);
  const csrfHash = hashToken(csrfToken, config.session.tokenPepper);
  const result = await db.query(
    `INSERT INTO admin_sessions (token_hash, csrf_token_hash, admin_user_id, expires_at, user_agent)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'), $5)
     RETURNING expires_at`,
    [tokenHash, csrfHash, user.id, config.session.ttlSeconds, String(userAgent || "").slice(0, 255)]
  );
  return { token, csrfToken, expiresAt: result.rows[0].expires_at };
}

async function findSession(db, token, config) {
  if (!token) return null;
  const result = await db.query(
    `SELECT s.id AS session_id, s.csrf_token_hash, s.expires_at, u.id, u.email, u.role, u.is_active
     FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`,
    [hashToken(token, config.session.tokenPepper)]
  );
  const session = result.rows[0];
  if (!session || !session.is_active) return null;
  return session;
}

async function writeAudit(db, adminUserId, action, entityType, entityId = null, metadata = {}) {
  await db.query(
    `INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [adminUserId || null, action, entityType, entityId ? String(entityId) : null, JSON.stringify(metadata)]
  );
}

module.exports = { PASSWORD_HASH_ROUNDS, bcrypt, createSession, findSession, hashToken, normalizeEmail, randomToken, safeUser, writeAudit };
