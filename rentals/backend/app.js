// Builds the rentals Express app. Requiring this file has no side effects beyond reading RENTALS_* env:
// no database connection, no migrations, no timers. Call require("./startup").init() before serving.
const cors = require("cors");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");

const db = require("./db/connection");
const { moduleEnv } = require("./config/env");
const { createCorsOptions, createRuntimeConfig } = require("./config/security");
const { checkReadiness } = require("./services/readinessService");
const { logFailure } = require("./utils/safeLog");
const { configureAdminMiddleware } = require("./middleware/requireAdmin");
const { createAdminAuthRouter } = require("./routes/adminAuth");
const { configureReservationRequestPolicy } = require("./utils/reservationRequestPolicy");
const { configureSmsService } = require("./services/smsService");

const activeRoutes = {
  publicVehicles: require("./routes/publicVehicles"),
  adminVehicles: require("./routes/adminVehicles"),
  adminUsers: require("./routes/adminUsers"),
  reservations: require("./routes/reservations"),
  reservationAccess: require("./routes/reservationAccess")
};

function createRateLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: message })
  });
}

function livenessResponse(_req, res) {
  res.json({ ok: true, service: "driveops-api" });
}

function createApp(options = {}) {
  const env = options.env || moduleEnv();
  const config = options.config || createRuntimeConfig(env);
  const database = options.database || db;
  const routes = options.routes || activeRoutes;
  const app = express();
  const generalRateLimiter = createRateLimiter({
    ...config.rateLimits.general,
    message: "Too many requests. Please try again later."
  });
  const reservationRateLimiter = createRateLimiter({
    ...config.rateLimits.reservation,
    message: "Too many reservation requests. Please try again later."
  });
  const adminRateLimiter = createRateLimiter({
    ...config.rateLimits.admin,
    message: "Too many admin requests. Please try again later."
  });
  const loginRateLimiter = createRateLimiter({ ...config.loginRateLimit, message: "Too many sign-in attempts. Please try again later." });
  const lookupRateLimiter = createRateLimiter({ ...config.rateLimits.lookup, message: "Too many lookups. Please wait a few minutes and try again." });
  const adminMiddleware = configureAdminMiddleware({ db: database, config });
  configureReservationRequestPolicy(config.reservation);
  configureSmsService({ timeoutMs: config.smsTimeoutMs });

  app.locals.driveOpsConfig = config;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors(createCorsOptions(config)));
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: config.jsonBodyLimit }));
  app.use("/uploads/vehicles", express.static(config.vehicleUploadDirectory, {
    setHeaders(response) { response.setHeader("X-Content-Type-Options", "nosniff"); }
  }));

  // /api/health is retained for current admin compatibility and represents liveness only.
  app.get("/api/health/live", livenessResponse);
  app.get("/api/health", livenessResponse);
  app.get("/api/health/ready", async (_req, res) => {
    try {
      const readiness = await checkReadiness(database);
      if (!readiness.ready) return res.status(503).json({ ok: false, service: "driveops-api", reason: readiness.reason });
      return res.json({ ok: true, service: "driveops-api" });
    } catch (error) {
      logFailure("health.ready", error);
      return res.status(503).json({ ok: false, service: "driveops-api", reason: "readiness_check_failed" });
    }
  });

  app.use("/api", generalRateLimiter);
  app.use("/api/public", routes.publicVehicles);
  const reservationAccessRoutes = routes.reservationAccess || activeRoutes.reservationAccess;
  app.use("/api/public", reservationAccessRoutes.createReservationAccessRouter({
    database,
    includeAdmin: false,
    publicMutationMiddleware: reservationRateLimiter,
    lookupMiddleware: lookupRateLimiter,
    env
  }));
  app.use("/api/admin", adminRateLimiter);
  app.use("/api/admin/auth/login", loginRateLimiter);
  app.use("/api/admin/auth", createAdminAuthRouter({ db: database, config, middleware: adminMiddleware }));
  app.use("/api/admin/vehicles", routes.adminVehicles);
  if (routes.adminUsers) app.use("/api/admin", routes.adminUsers);
  app.use("/api", reservationAccessRoutes.createReservationAccessRouter({ database, includePublic: false, env }));
  app.use("/api/reservations", (req, res, next) => {
    if (req.method === "POST" && req.path === "/") return reservationRateLimiter(req, res, next);
    return adminRateLimiter(req, res, next);
  });
  app.use("/api/reservations", routes.reservations);


  if (typeof options.configureApp === "function") options.configureApp(app);

  // Root-level status lives at /health so the module can sit beside others in one process.
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "DriveOps Car Rental API",
      office: "Trucker Heaven Rentals - Mt. Juliet",
      endpoints: {
        liveness: "/api/health/live",
        readiness: "/api/health/ready",
        publicVehicles: "/api/public/vehicles",
        adminVehicles: "/api/admin/vehicles",
        reservations: "/api/reservations"
      }
    });
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
  app.use((error, req, res, _next) => {
    logFailure(`api ${req.method} ${req.path}`, error);

    if (error.code === "CORS_ORIGIN_DENIED") {
      return res.status(403).json({ error: "Origin is not allowed" });
    }
    if (error.message === "Only image uploads are allowed") {
      return res.status(400).json({ error: "Only image uploads are allowed" });
    }
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image file is too large. Max size is 6 MB.", code: "IMAGE_TOO_LARGE" });
    }
    if (["UNSUPPORTED_IMAGE_TYPE", "INVALID_IMAGE_CONTENT", "IMAGE_DIMENSIONS_EXCEEDED", "IMAGE_TOO_LARGE"].includes(error.code)) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large" });
    }
    return res.status(500).json({ error: "Internal server error" });
  });

  return app;
}


const app = createApp();

module.exports = app;
module.exports.createApp = createApp;
module.exports.createRateLimiter = createRateLimiter;
module.exports.livenessResponse = livenessResponse;
