const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const { createRuntimeConfig } = require("../config/security");
const { bcrypt, createSession, findSession, hashToken, normalizeEmail } = require("../services/adminAuthService");
const { createAdminMiddleware } = require("../middleware/requireAdmin");
const { createAdminAuthRouter } = require("../routes/adminAuth");

function authConfig(overrides = {}) {
  return createRuntimeConfig({
    NODE_ENV: "test",
    CORS_ALLOWED_ORIGINS: "http://admin.example.test",
    SESSION_TOKEN_PEPPER: "test-only-pepper",
    SESSION_TTL_SECONDS: "3600",
    ADMIN_LOCKOUT_THRESHOLD: "2",
    ADMIN_LOCKOUT_SECONDS: "60",
    ...overrides
  });
}

function cookiePathAllows(cookiePath, requestPath) {
  return requestPath === cookiePath || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"));
}

function cookieFromResponseForPath(response, requestPath) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "the response must issue a session cookie");
  const attributes = setCookie.split(";").map((attribute) => attribute.trim());
  const pathAttribute = attributes.find((attribute) => attribute.startsWith("Path="));
  assert.ok(pathAttribute, "the session cookie must declare a Path");
  return {
    attributes,
    cookie: cookiePathAllows(pathAttribute.slice("Path=".length), requestPath) ? attributes[0] : null
  };
}

function createFakeDatabase() {
  const user = {
    id: 7,
    email: "owner@example.test",
    password_hash: null,
    role: "OWNER",
    is_active: true,
    failed_login_attempts: 0,
    locked_until: null
  };
  let session = null;
  const calls = [];

  return {
    user,
    calls,
    expireSession() { if (session) session.expires_at = new Date(Date.now() - 1_000); },
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT * FROM admin_users")) return { rows: values[0] === user.email ? [user] : [], rowCount: values[0] === user.email ? 1 : 0 };
      if (sql.startsWith("UPDATE admin_users SET failed_login_attempts")) {
        user.failed_login_attempts = values[0];
        if (values[0] >= 2) user.locked_until = new Date(Date.now() + 60_000);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE admin_users SET failed_login_attempts = 0")) {
        user.failed_login_attempts = 0;
        user.locked_until = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE admin_sessions SET revoked_at") && values.length === 1) {
        if (session) session.revoked_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO admin_sessions")) {
        session = { id: 11, token_hash: values[0], csrf_token_hash: values[1], admin_user_id: values[2], expires_at: new Date(Date.now() + 3_600_000), revoked_at: null };
        return { rows: [{ expires_at: session.expires_at }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT s.id AS session_id")) {
        if (!session || session.revoked_at || session.token_hash !== values[0] || session.expires_at <= new Date()) return { rows: [], rowCount: 0 };
        return { rows: [{ session_id: session.id, csrf_token_hash: session.csrf_token_hash, expires_at: session.expires_at, id: user.id, email: user.email, role: user.role, is_active: user.is_active }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE admin_sessions SET csrf_token_hash")) {
        session.csrf_token_hash = values[0];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO admin_audit_logs")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
}

async function startAuthApp(database, config = authConfig()) {
  const app = express();
  app.use(express.json());
  const middleware = createAdminMiddleware({ db: database, config });
  app.use("/api/admin/auth", createAdminAuthRouter({ db: database, config, middleware }));
  app.get("/api/reservations", middleware.requireAdminSession, (_req, res) => res.status(200).json({ ok: true }));
  app.post("/api/reservations/:reservationId/operations/:operation", middleware.requireAdminSession, middleware.requireRole("OWNER", "STAFF"), middleware.requireCsrf, (_req, res) => res.status(204).end());
  app.get("/protected", middleware.requireAdminSession, (_req, res) => res.status(200).json({ ok: true }));
  app.post("/protected", middleware.requireAdminSession, middleware.requireRole("OWNER"), middleware.requireCsrf, (_req, res) => res.status(204).end());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("passwords use bcrypt and emails are normalized", async () => {
  const password = "CorrectHorseBattery9";
  const hash = await bcrypt.hash(password, 10);
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await bcrypt.compare(password, hash), true);
  assert.equal(await bcrypt.compare("wrong-password", hash), false);
  assert.equal(normalizeEmail(" Owner@Example.TEST "), "owner@example.test");
});

test("sessions store only hashes and reject revoked or expired records", async () => {
  const db = createFakeDatabase();
  const config = authConfig();
  const session = await createSession(db, db.user, config, "test-agent");
  const insert = db.calls.find((call) => call.sql.startsWith("INSERT INTO admin_sessions"));
  assert.notEqual(insert.values[0], session.token);
  assert.equal(insert.values[0], hashToken(session.token, config.session.tokenPepper));
  assert.notEqual(insert.values[1], session.csrfToken);
  assert.ok(await findSession(db, session.token, config));
  await db.query("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1", [11]);
  assert.equal(await findSession(db, session.token, config), null);
  const expired = await createSession(db, db.user, config);
  db.expireSession();
  assert.equal(await findSession(db, expired.token, config), null);
});

test("login, session restore, CSRF enforcement, role authorization, and idempotent logout", async () => {
  const db = createFakeDatabase();
  db.user.password_hash = await bcrypt.hash("CorrectHorseBattery9", 10);
  const api = await startAuthApp(db, authConfig({ COOKIE_SAME_SITE: "strict" }));
  try {
    const oldKeyHeader = "x-admin" + "-key";
    const oldKeyQuery = "admin" + "Key";
    const oldKeyValue = "driveops-dev" + "-admin";
    assert.equal((await fetch(`${api.baseUrl}/protected?${oldKeyQuery}=${oldKeyValue}`, { headers: { [oldKeyHeader]: oldKeyValue } })).status, 401);
    const failed = await fetch(`${api.baseUrl}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: db.user.email, password: "incorrect" }) });
    assert.equal(failed.status, 401);
    assert.deepEqual(await failed.json(), { error: "Invalid email or password" });

    const login = await fetch(`${api.baseUrl}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "OWNER@EXAMPLE.TEST", password: "CorrectHorseBattery9" }) });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.deepEqual(loginBody.user, { id: 7, email: "owner@example.test", role: "OWNER", authenticated: true });
    const reservationCookie = cookieFromResponseForPath(login, "/api/reservations");
    assert.ok(reservationCookie.attributes.includes("Path=/api"));
    assert.ok(reservationCookie.attributes.includes("HttpOnly"));
    assert.ok(reservationCookie.attributes.includes("SameSite=Strict"));
    assert.equal(cookiePathAllows("/api/admin", "/api/reservations"), false, "the legacy cookie scope must not reach reservation routes");

    const cookie = cookieFromResponseForPath(login, "/api/admin/auth/session").cookie;
    assert.ok(cookie);
    assert.ok(reservationCookie.cookie, "the browser must send the issued cookie to reservation routes");
    assert.ok(cookieFromResponseForPath(login, "/api/admin/vehicles").cookie, "the browser must send the issued cookie to admin routes");
    assert.equal((await fetch(`${api.baseUrl}/api/reservations`)).status, 401);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations`, { headers: { Cookie: reservationCookie.cookie } })).status, 200);

    const restored = await fetch(`${api.baseUrl}/api/admin/auth/session`, { headers: { Cookie: cookie } });
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json();
    assert.equal(restoredBody.user.authenticated, true);

    assert.equal((await fetch(`${api.baseUrl}/protected`, { method: "POST", headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(`${api.baseUrl}/protected`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": "wrong" } })).status, 403);
    assert.equal((await fetch(`${api.baseUrl}/protected`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": restoredBody.csrfToken } })).status, 204);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations/11/operations/confirm`, { method: "POST", headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations/11/operations/confirm`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": "wrong" } })).status, 403);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations/11/operations/confirm`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": restoredBody.csrfToken } })).status, 204);

    db.user.role = "STAFF";
    assert.equal((await fetch(`${api.baseUrl}/protected`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": restoredBody.csrfToken } })).status, 403);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations/11/operations/confirm`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": restoredBody.csrfToken } })).status, 204);
    db.user.role = "OWNER";

    const logout = await fetch(`${api.baseUrl}/api/admin/auth/logout`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": restoredBody.csrfToken } });
    assert.equal(logout.status, 204);
    assert.ok(cookieFromResponseForPath(logout, "/api/reservations").attributes.includes("Path=/api"));
    assert.equal((await fetch(`${api.baseUrl}/api/admin/auth/logout`, { method: "POST" })).status, 204);
    assert.equal((await fetch(`${api.baseUrl}/api/admin/auth/session`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await api.close();
  }
});

test("inactive and locked accounts use the same generic login failure", async () => {
  const db = createFakeDatabase();
  db.user.password_hash = await bcrypt.hash("CorrectHorseBattery9", 10);
  const api = await startAuthApp(db);
  try {
    db.user.is_active = false;
    const inactive = await fetch(`${api.baseUrl}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: db.user.email, password: "CorrectHorseBattery9" }) });
    assert.deepEqual(await inactive.json(), { error: "Invalid email or password" });
    db.user.is_active = true;
    db.user.locked_until = new Date(Date.now() + 60_000);
    const locked = await fetch(`${api.baseUrl}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: db.user.email, password: "CorrectHorseBattery9" }) });
    assert.equal(locked.status, 401);
    assert.deepEqual(await locked.json(), { error: "Invalid email or password" });
  } finally {
    await api.close();
  }
});

test("repeated invalid credentials trigger a temporary account lockout", async () => {
  const db = createFakeDatabase();
  db.user.password_hash = await bcrypt.hash("CorrectHorseBattery9", 10);
  const api = await startAuthApp(db);
  const login = (password) => fetch(`${api.baseUrl}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: db.user.email, password }) });
  try {
    assert.equal((await login("incorrect")).status, 401);
    assert.equal((await login("incorrect")).status, 401);
    assert.ok(db.user.locked_until > new Date());
    const blocked = await login("CorrectHorseBattery9");
    assert.equal(blocked.status, 401);
    assert.deepEqual(await blocked.json(), { error: "Invalid email or password" });
  } finally {
    await api.close();
  }
});

test("old API-key mechanisms and persistent admin secret storage are absent from active code", async () => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "..");
  const activeFiles = ["backend/middleware/requireAdmin.js", "backend/server.js", "frontend-admin/app.js", "frontend-admin/index.html"];
  const oldSecretTerms = ["ADMIN" + "_API_KEY", "x-admin" + "-key", "driveops-dev" + "-admin", "local" + "Storage"];
  for (const file of activeFiles) {
    const contents = await fs.readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(contents, new RegExp(oldSecretTerms.join("|"), "i"));
  }
});
