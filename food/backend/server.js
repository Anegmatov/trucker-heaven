require("dotenv").config();
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const { loadConfig } = require("./lib/config");
const { createPool } = require("./db/connection");
const { requestLog } = require("./lib/requestLog");
const { notFound, errorHandler } = require("./lib/http");
const { buildPublicRouter } = require("./routes/public");
const { buildAdminAuthRouter } = require("./routes/adminAuth");
const { buildAdminRouter } = require("./routes/admin");
const { createPushNotifications } = require("./lib/pushNotifications");

const REQUIRED_TABLES = [
  "admin_users", "menu_categories", "menu_items", "menu_item_images", "daily_specials",
  "business_hours", "gallery_items", "lounge_features", "site_settings", "orders",
  "order_items", "order_status_history", "order_notes", "idempotency_records", "audit_events",
  "business_exceptions", "menu_modifier_groups", "menu_modifier_options", "order_item_modifiers",
  "catering_requests", "customer_order_access_sessions", "admin_push_subscriptions", "kitchen_devices"
];

function createApp({ database, config }) {
  const app = express();
  app.locals.config = config;
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(requestLog);
  const allowedOrigins = new Set([...config.publicOrigins, ...config.adminOrigins, ...config.capacitorOrigins]);
  const pushNotifications = createPushNotifications(database, config);
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      const error = new Error("Origin is not allowed");
      error.status = 403;
      error.code = "CORS_ORIGIN_DENIED";
      callback(error);
    }
  }));
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.get("/health", (req, res) => res.json({ ok: true, service: "foodops-api" }));
  app.get("/readiness", async (req, res) => {
    try {
      const result = await database.query(`SELECT unnest($1::text[]) AS name`, [REQUIRED_TABLES]);
      const names = result.rows.map((row) => row.name);
      const tables = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])", [names]);
      const found = new Set(tables.rows.map((row) => row.tablename));
      const ready = REQUIRED_TABLES.every((name) => found.has(name));
      res.status(ready ? 200 : 503).json(ready ? { ok: true, service: "foodops-api" } : { ok: false, service: "foodops-api", reason: "schema_incomplete" });
    } catch {
      res.status(503).json({ ok: false, service: "foodops-api", reason: "readiness_check_failed" });
    }
  });

  app.use("/uploads/menu-items", express.static(config.uploadDirectory, {
    dotfiles: "deny", fallthrough: false, index: false, immutable: false,
    setHeaders(res) { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "public, max-age=3600"); }
  }));
  app.use("/api/v1/public", buildPublicRouter(database, pushNotifications));
  app.use("/api/v1/admin/auth", buildAdminAuthRouter(database, config));
  app.use("/api/v1/admin", buildAdminRouter(database, config, pushNotifications));
  const publicDist = path.join(__dirname, "..", "frontend-public", "dist");
  if (fs.existsSync(path.join(publicDist, "index.html"))) {
    app.use(express.static(publicDist, { dotfiles: "deny", index: false }));
    app.get(/^(?!\/api\/|\/uploads\/|\/health$|\/readiness$).*/, (req, res) => {
      res.sendFile(path.join(publicDist, "index.html"));
    });
  }
  app.use(notFound);
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      error.status = 422;
      error.code = error.code === "LIMIT_FILE_SIZE" ? "IMAGE_TOO_LARGE" : "INVALID_UPLOAD";
      error.message = error.code === "IMAGE_TOO_LARGE" ? "Images must be 5 MB or smaller." : "The upload could not be accepted.";
    }
    if (error instanceof SyntaxError && error.type === "entity.parse.failed") {
      error.status = 400; error.code = "INVALID_JSON"; error.message = "Request body must contain valid JSON.";
    }
    errorHandler(error, req, res, next);
  });
  return app;
}

async function start() {
  const config = loadConfig();
  fs.mkdirSync(config.uploadDirectory, { recursive: true });
  fs.mkdirSync(config.temporaryUploadDirectory, { recursive: true });
  const database = createPool(config);
  const server = http.createServer(createApp({ database, config }));
  await new Promise((resolve) => server.listen(config.port, resolve));
  console.log(`[foodops-api] listening on ${config.port}`);
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[foodops-api] ${signal} received; shutting down`);
    const forceTimer = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await database.end().catch((error) => console.error("[database] closure failed", error.message));
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) start().catch((error) => {
  console.error("[foodops-api] startup failed:", error.message);
  process.exitCode = 1;
});

module.exports = { createApp, start, REQUIRED_TABLES };
