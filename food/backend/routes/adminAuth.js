const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { AppError, asyncRoute } = require("../lib/http");
const { text } = require("../lib/validation");
const { sha256, sessionCookie, clearSessionCookie, requireAdmin, requireCsrf, audit } = require("../lib/auth");

const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function buildAdminAuthRouter(database, config) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => res.status(429).json({ error: { code: "LOGIN_RATE_LIMITED", message: "Too many sign-in attempts. Try again later." } })
  });

  // A valid v1.5 session can authorize its replacement device credential once.
  router.post('/kitchen-device', loginLimiter, requireAdmin(database), requireCsrf, asyncRoute(async (req, res) => {
    const hash = req.body?.activationId;
    if (!/^[0-9a-f]{64}$/.test(hash || '')) throw new AppError(422, 'DEVICE_INVALID', 'Invalid activation ID.');
    const result = await database.query(`INSERT INTO kitchen_devices(token_hash,admin_user_id)
      VALUES ($1,$2) ON CONFLICT(token_hash) DO NOTHING RETURNING token_hash`, [hash, req.admin.id]);
    if (!result.rowCount) throw new AppError(409, 'DEVICE_EXISTS', 'An administrator must reactivate an existing device.');
    await audit(database, req, 'KITCHEN_DEVICE_ENROLLED', 'kitchen_device', hash);
    res.status(201).json({ enrolled: true });
  }));

  router.post("/login", loginLimiter, asyncRoute(async (req, res) => {
    const email = text(req.body?.email, "email", { max: 254 }).toLowerCase();
    const password = text(req.body?.password, "password", { max: 200 });
    const result = await database.query(`SELECT id, email, display_name, password_hash, role, is_active,
      failed_login_count, locked_until FROM admin_users WHERE LOWER(email) = $1`, [email]);
    const user = result.rows[0];
    if (user?.locked_until && new Date(user.locked_until) > new Date()) throw new AppError(423, "ACCOUNT_LOCKED", "This account is temporarily locked. Try again later.");
    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!user || !user.is_active || !valid) {
      if (user) {
        await database.query(`UPDATE admin_users SET failed_login_count = failed_login_count + 1,
          locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
          WHERE id = $1`, [user.id, config.loginMaxFailures, config.loginLockMinutes]);
      }
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM admin_sessions WHERE expires_at <= NOW() OR admin_user_id = $1", [user.id]);
      await client.query(`INSERT INTO admin_sessions (token_hash, admin_user_id, csrf_token, expires_at)
        VALUES ($1,$2,$3,NOW() + ($4 || ' hours')::interval)`, [sha256(sessionToken), user.id, csrfToken, config.sessionTtlHours]);
      await client.query("UPDATE admin_users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1", [user.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    req.admin = { id: String(user.id), email: user.email, displayName: user.display_name, role: user.role };
    await audit(database, req, "ADMIN_LOGIN", "admin_user", String(user.id));
    res.setHeader("Set-Cookie", sessionCookie(sessionToken, config));
    res.json({ user: req.admin, csrfToken });
  }));

  router.get("/session", requireAdmin(database), asyncRoute(async (req, res) => {
    res.json({ user: req.admin, csrfToken: req.csrfToken });
  }));

  router.post("/logout", requireAdmin(database), requireCsrf, asyncRoute(async (req, res) => {
    await audit(database, req, "ADMIN_LOGOUT", "admin_user", req.admin.id);
    await database.query("DELETE FROM admin_sessions WHERE token_hash = $1", [req.sessionTokenHash]);
    res.setHeader("Set-Cookie", clearSessionCookie(config));
    res.status(204).end();
  }));

  return router;
}

module.exports = { buildAdminAuthRouter };
