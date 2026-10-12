const crypto = require("node:crypto");
const { AppError } = require("./http");

const SESSION_COOKIE = "foodops_session";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(token, config) {
  const maxAge = config.sessionTtlHours * 60 * 60;
  const partitioned = config.cookieSecure && config.cookieSameSite === "None" ? "; Partitioned" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/v1/admin; HttpOnly; SameSite=${config.cookieSameSite}; Max-Age=${maxAge}${config.cookieSecure ? "; Secure" : ""}${partitioned}`;
}

function clearSessionCookie(config) {
  const partitioned = config.cookieSecure && config.cookieSameSite === "None" ? "; Partitioned" : "";
  return `${SESSION_COOKIE}=; Path=/api/v1/admin; HttpOnly; SameSite=${config.cookieSameSite}; Max-Age=0${config.cookieSecure ? "; Secure" : ""}${partitioned}`;
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(database) {
  return async (req, res, next) => {
    try {
      const token = cookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token || token.length > 256) throw new AppError(401, "AUTH_REQUIRED", "Sign in is required.");
      const tokenHash = sha256(token);
      const result = await database.query(`
        SELECT s.token_hash, s.csrf_token, s.expires_at,
               u.id, u.email, u.display_name, u.role, u.is_active
        FROM admin_sessions s
        JOIN admin_users u ON u.id = s.admin_user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE
      `, [tokenHash]);
      if (!result.rowCount) throw new AppError(401, "AUTH_REQUIRED", "Your session is missing or expired.");
      const row = result.rows[0];
      req.sessionTokenHash = tokenHash;
      req.admin = { id: String(row.id), email: row.email, displayName: row.display_name, role: row.role };
      req.csrfToken = row.csrf_token;
      database.query("UPDATE admin_sessions SET last_seen_at = NOW() WHERE token_hash = $1", [tokenHash]).catch(() => {});
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireCsrf(req, res, next) {
  if (!safeEqual(req.headers["x-csrf-token"], req.csrfToken)) {
    return next(new AppError(403, "CSRF_INVALID", "The security token is missing or invalid."));
  }
  next();
}

function requireOwner(req, res, next) {
  if (req.admin?.role !== "OWNER") return next(new AppError(403, "OWNER_REQUIRED", "This action requires the OWNER role."));
  next();
}

async function audit(database, req, eventType, entityType, entityIdentifier, metadata = {}) {
  const safeMetadata = JSON.parse(JSON.stringify(metadata, (key, value) => /password|token|secret|cookie/i.test(key) ? "[redacted]" : value));
  await database.query(`
    INSERT INTO audit_events (actor_user_id, actor_role, event_type, entity_type, entity_identifier, ip_address, metadata)
    VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::inet, $7::jsonb)
  `, [req.admin?.id || null, req.admin?.role || null, eventType, entityType, entityIdentifier || null,
    /^[:.0-9a-f]+$/i.test(req.ip || "") ? req.ip : "", JSON.stringify(safeMetadata)]);
}

module.exports = {
  SESSION_COOKIE, sha256, cookies, sessionCookie, clearSessionCookie,
  requireAdmin, requireCsrf, requireOwner, audit
};
