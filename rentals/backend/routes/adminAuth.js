const express = require("express");
const { bcrypt, createSession, findSession, hashToken, normalizeEmail, randomToken, safeUser, writeAudit } = require("../services/adminAuthService");
const { parseCookies } = require("../middleware/requireAdmin");
const { logFailure } = require("../utils/safeLog");

function cookieOptions(config) {
  return { httpOnly: true, secure: config.session.cookieSecure, sameSite: config.session.cookieSameSite, path: "/api", maxAge: config.session.ttlSeconds * 1000 };
}

function loginOriginIsAllowed(req, config) {
  const origin = req.get("origin");
  // Production browser login must originate from the explicit CORS allowlist.
  // Origin-less requests remain useful for local bootstrap/test tooling only.
  return !config.production || (Boolean(origin) && config.corsAllowedOrigins.includes(origin));
}

function createAdminAuthRouter({ db, config, middleware }) {
  const router = express.Router();
  router.post("/login", async (req, res) => {
    if (!loginOriginIsAllowed(req, config)) return res.status(403).json({ error: "Origin is not allowed" });
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const generic = () => res.status(401).json({ error: "Invalid email or password" });
    if (!email || !password) return generic();
    try {
      const result = await db.query("SELECT * FROM admin_users WHERE LOWER(email) = $1 LIMIT 1", [email]);
      const user = result.rows[0];
      const locked = user?.locked_until && new Date(user.locked_until).getTime() > Date.now();
      const valid = Boolean(user && user.is_active && !locked && await bcrypt.compare(password, user.password_hash));
      if (!valid) {
        if (user) {
          const failures = Number(user.failed_login_attempts || 0) + 1;
          await db.query(`UPDATE admin_users SET failed_login_attempts = $1, locked_until = CASE WHEN $1 >= $2 THEN CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second') ELSE locked_until END, updated_at = CURRENT_TIMESTAMP WHERE id = $4`, [failures, config.session.lockoutThreshold, config.session.lockoutSeconds, user.id]);
          await writeAudit(db, user.id, "LOGIN_FAILURE", "ADMIN_USER", user.id, { reason: locked ? "locked" : "invalid_credentials" });
        }
        return generic();
      }
      await db.query("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_user_id = $1 AND revoked_at IS NULL", [user.id]);
      await db.query("UPDATE admin_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [user.id]);
      const session = await createSession(db, user, config, req.get("user-agent"));
      await writeAudit(db, user.id, "LOGIN_SUCCESS", "ADMIN_USER", user.id);
      res.cookie(config.session.cookieName, session.token, cookieOptions(config));
      return res.json({ user: safeUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    } catch (error) { logFailure("admin auth.login", error); return res.status(500).json({ error: "Unable to sign in" }); }
  });
  router.get("/session", middleware.requireAdminSession, async (req, res) => {
    try {
      const csrfToken = randomToken();
      await db.query("UPDATE admin_sessions SET csrf_token_hash = $1, last_seen_at = CURRENT_TIMESTAMP WHERE id = $2", [hashToken(csrfToken, config.session.tokenPepper), req.admin.sessionId]);
      return res.json({ user: { id: req.admin.id, email: req.admin.email, role: req.admin.role, authenticated: true }, csrfToken });
    } catch (error) { logFailure("admin auth.session", error); return res.status(500).json({ error: "Unable to restore session" }); }
  });
  router.post("/logout", async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[config.session.cookieName];
      const session = await findSession(db, token, config);
      if (!session) {
        res.clearCookie(config.session.cookieName, cookieOptions(config));
        return res.status(204).end();
      }
      req.admin = { id: session.id, email: session.email, role: session.role, sessionId: session.session_id, csrfTokenHash: session.csrf_token_hash };
      return middleware.requireCsrf(req, res, next);
    } catch (error) {
      return next(error);
    }
  }, async (req, res) => {
    try { await db.query("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1", [req.admin.sessionId]); await writeAudit(db, req.admin.id, "LOGOUT", "ADMIN_USER", req.admin.id); }
    catch (error) { logFailure("admin auth.logout", error); return res.status(500).json({ error: "Unable to sign out" }); }
    res.clearCookie(config.session.cookieName, cookieOptions(config));
    return res.status(204).end();
  });
  return router;
}
module.exports = { createAdminAuthRouter };
