/*
 * One admin sign-in for all three modules.
 *
 * The unified admin (food/frontend-admin, served at /sites/admin on this server) signs in with
 * the food (Silk Road Grill) staff account. These routes, mounted at /api/v1/admin/sso so the
 * food session cookie reaches them, then open matching parking and rentals staff sessions for
 * the same person: the parking/rentals account with the same username/email, else the first
 * active account of the same role (an OWNER signs in as the OWNER everywhere).
 *
 *   POST /api/v1/admin/sso/parking  -> sets the parking staff cookie, returns { user, csrfToken }
 *   POST /api/v1/admin/sso/rentals  -> sets the rentals staff cookie, returns { user, csrfToken }
 *   POST /api/v1/admin/sso/logout   -> revokes and clears both
 *   GET  /api/v1/admin/sso/status   -> which modules this server runs
 */
const express = require("express");
const crypto = require("node:crypto");

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function createAdminHub({ modules, food }) {
  const hub = express();
  hub.disable("x-powered-by");
  hub.use(express.json({ limit: "16kb" }));
  const enabled = (name) => Boolean(modules[name]);
  const { requireAdmin, requireCsrf } = require("../food/backend/lib/auth");
  const guard = food ? [requireAdmin(food.database), requireCsrf] : [(_req, res) => res.status(404).json({ error: { message: "Food admin is not running on this server" } })];

  const RENTALS_COOKIE_PATH = "/rentals/api";
  const rentalsParts = () => ({
    db: require("../rentals/backend/db/connection"),
    config: require("../rentals/backend/config/security").createRuntimeConfig(),
    service: require("../rentals/backend/services/adminAuthService")
  });
  const rentalsCookie = (config) => ({ httpOnly: true, secure: config.session.cookieSecure, sameSite: config.session.cookieSameSite, path: RENTALS_COOKIE_PATH });

  hub.get("/status", (_req, res) => res.json({ modules: Object.keys(modules) }));

  hub.post("/parking", guard, async (req, res, next) => {
    if (!enabled("parking")) return res.status(404).json({ error: { message: "Parking is not running on this server" } });
    try {
      const auth = require("../parking/backend/auth");
      const pool = require("../parking/backend/db");
      const client = await pool.connect();
      try {
        const handle = String(req.admin.email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").padEnd(3, "0").slice(0, 80);
        let user = (await client.query(
          `SELECT * FROM parking_admin_users WHERE active
           ORDER BY (username=$1) DESC, (role=$2) DESC, (role='OWNER') DESC, id LIMIT 1`, [handle, req.admin.role])).rows[0];
        if (!user) {
          // First sign-in on a fresh install: mirror the (already authenticated) food account. The
          // random password is never used; this person signs in through the unified admin.
          const bcrypt = require("bcrypt");
          user = (await client.query("INSERT INTO parking_admin_users(username,password_hash,role) VALUES($1,$2,$3) ON CONFLICT(username) DO UPDATE SET active=true,updated_at=now() RETURNING *",
            [handle, await bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 12), req.admin.role === "OWNER" ? "OWNER" : "STAFF"])).rows[0];
        }
        const session = await auth.createSession(client, user);
        await client.query("UPDATE parking_admin_users SET last_login_at=now(),updated_at=now() WHERE id=$1", [user.id]);
        res.cookie(auth.cookieName, session.raw, auth.settings());
        return res.json({ module: "parking", user: auth.userView(user), csrfToken: session.csrf });
      } finally { client.release(); }
    } catch (error) { return next(error); }
  });

  hub.post("/rentals", guard, async (req, res, next) => {
    if (!enabled("rentals")) return res.status(404).json({ error: { message: "Rentals is not running on this server" } });
    try {
      const { db, config, service } = rentalsParts();
      const email = String(req.admin.email || "").toLowerCase();
      let user = (await db.query(
        `SELECT * FROM admin_users WHERE is_active = TRUE
         ORDER BY (LOWER(email)=$1) DESC, (role=$2) DESC, (role='OWNER') DESC, id LIMIT 1`, [email, req.admin.role])).rows[0];
      if (!user) {
        // First sign-in on a fresh install: mirror the (already authenticated) food account.
        const hash = await service.bcrypt.hash(crypto.randomBytes(32).toString("base64url"), service.PASSWORD_HASH_ROUNDS || 12);
        user = (await db.query("INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *",
          [email.includes("@") ? email : `${email || "owner"}@truckerheaven.com`, hash, req.admin.role === "OWNER" ? "OWNER" : "STAFF"])).rows[0];
      }
      const session = await service.createSession(db, user, config, req.get("user-agent"));
      await db.query("UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [user.id]);
      await service.writeAudit(db, user.id, "LOGIN_SUCCESS", "ADMIN_USER", user.id, { via: "unified-admin" });
      res.cookie(config.session.cookieName, session.token, { ...rentalsCookie(config), maxAge: config.session.ttlSeconds * 1000 });
      return res.json({ module: "rentals", user: service.safeUser(user), csrfToken: session.csrfToken });
    } catch (error) { return next(error); }
  });

  hub.post("/logout", async (req, res) => {
    const jar = parseCookies(req.headers.cookie);
    if (enabled("parking")) {
      try {
        const auth = require("../parking/backend/auth");
        const config = require("../parking/backend/config");
        const pool = require("../parking/backend/db");
        const raw = jar[auth.cookieName];
        if (raw) await pool.query("DELETE FROM parking_admin_sessions WHERE token_hash=$1", [crypto.createHash("sha256").update(`${raw}:${config.cookie.tokenPepper}`).digest("hex")]);
        const { maxAge, ...rest } = auth.settings();
        res.clearCookie(auth.cookieName, rest);
      } catch (_) { /* best effort */ }
    }
    if (enabled("rentals")) {
      try {
        const { db, config, service } = rentalsParts();
        const session = await service.findSession(db, jar[config.session.cookieName], config);
        if (session) await db.query("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1", [session.session_id]);
        res.clearCookie(config.session.cookieName, rentalsCookie(config));
      } catch (_) { /* best effort */ }
    }
    return res.status(204).end();
  });

  hub.use((_req, res) => res.status(404).json({ error: { message: "Not found" } }));
  // eslint-disable-next-line no-unused-vars
  hub.use((error, _req, res, _next) => {
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error("[api] admin sso failed:", error.message);
    res.status(status).json({ error: { message: status >= 500 ? "Could not open the staff session" : error.message } });
  });
  return hub;
}

module.exports = { createAdminHub };
