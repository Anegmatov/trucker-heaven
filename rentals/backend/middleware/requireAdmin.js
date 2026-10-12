const crypto = require("crypto");
const { findSession, hashToken } = require("../services/adminAuthService");

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function createAdminMiddleware({ db, config }) {
  async function requireAdminSession(req, res, next) {
    try {
      const token = parseCookies(req.headers.cookie)[config.session.cookieName];
      const session = await findSession(db, token, config);
      if (!session) return res.status(401).json({ error: "Authentication required" });
      req.admin = { id: session.id, email: session.email, role: session.role, sessionId: session.session_id, csrfTokenHash: session.csrf_token_hash };
      return next();
    } catch (_error) { return res.status(401).json({ error: "Authentication required" }); }
  }
  function requireRole(...roles) {
    return (req, res, next) => roles.includes(req.admin?.role) ? next() : res.status(403).json({ error: "You are not authorized to perform this action" });
  }
  function requireCsrf(req, res, next) {
    const token = req.header(config.session.csrfHeaderName);
    if (!token || !req.admin?.csrfTokenHash) return res.status(403).json({ error: "CSRF validation failed" });
    const expected = Buffer.from(req.admin.csrfTokenHash, "utf8");
    const actual = Buffer.from(hashToken(token, config.session.tokenPepper), "utf8");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return res.status(403).json({ error: "CSRF validation failed" });
    return next();
  }
  return { requireAdminSession, requireCsrf, requireRole };
}
let activeMiddleware = null;
function configureAdminMiddleware(options) { activeMiddleware = createAdminMiddleware(options); return activeMiddleware; }
function requireAdminSession(req, res, next) { return activeMiddleware ? activeMiddleware.requireAdminSession(req, res, next) : res.status(503).json({ error: "Authentication is unavailable" }); }
function requireCsrf(req, res, next) { return activeMiddleware ? activeMiddleware.requireCsrf(req, res, next) : res.status(503).json({ error: "Authentication is unavailable" }); }
function requireRole(...roles) { return (req, res, next) => activeMiddleware ? activeMiddleware.requireRole(...roles)(req, res, next) : res.status(503).json({ error: "Authentication is unavailable" }); }
module.exports = { configureAdminMiddleware, createAdminMiddleware, parseCookies, requireAdminSession, requireCsrf, requireRole };
