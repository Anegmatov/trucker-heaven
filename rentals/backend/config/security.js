const DEFAULT_DEVELOPMENT_ORIGINS = [
  "http://localhost:5174",
  "http://localhost:5175"
];
const { vehicleUploadDirectory } = require("../utils/imageUpload");
const { moduleEnv } = require("./env");

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parseCorsAllowedOrigins(value) {
  if (!value) return [];

  const origins = new Set();
  for (const item of String(value).split(",")) {
    const origin = item.trim();
    if (!origin) continue;

    let parsed;
    try {
      parsed = new URL(origin);
    } catch (_error) {
      throw new Error("CORS_ALLOWED_ORIGINS contains an invalid origin");
    }

    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("CORS_ALLOWED_ORIGINS must contain complete http(s) origins without paths");
    }
    origins.add(origin);
  }

  return [...origins];
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function jsonBodyLimit(value) {
  const limit = String(value || "1mb").trim().toLowerCase();
  if (!/^\d+(?:b|kb|mb)$/.test(limit)) {
    throw new Error("JSON_BODY_LIMIT must use bytes, kb, or mb (for example: 1mb)");
  }
  return limit;
}

function legacyRoutesEnabled(env = moduleEnv()) {
  return String(env.NODE_ENV || "development").toLowerCase() !== "production" && isEnabled(env.ENABLE_LEGACY_ROUTES);
}

function rentalPaymentMode(value) {
  const mode = String(value || "PAY_AT_PICKUP").trim().toUpperCase();
  if (mode === "PAY_AT_LOCATION") return "PAY_AT_PICKUP";
  if (mode !== "PAY_AT_PICKUP") {
    throw new Error("RENTAL_PAYMENT_MODE must be PAY_AT_PICKUP or PAY_AT_LOCATION for this launch");
  }
  return mode;
}

function createRuntimeConfig(env = moduleEnv()) {
  const nodeEnv = String(env.NODE_ENV || "development").toLowerCase();
  const production = nodeEnv === "production";
  const configuredOrigins = parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

  if (production && !env.CUSTOMER_SITE_URL) console.warn("[config] CUSTOMER_SITE_URL is not set; confirmation texts will not include the reservation link.");
  if (production && configuredOrigins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must be explicitly configured in production");
  }
  if (production && isEnabled(env.ENABLE_LEGACY_ROUTES)) {
    throw new Error("ENABLE_LEGACY_ROUTES cannot be enabled in production");
  }
  const cookieSecure = env.COOKIE_SECURE === undefined ? production : isEnabled(env.COOKIE_SECURE);
  const cookieSameSite = String(env.COOKIE_SAME_SITE || "lax").toLowerCase();
  if (!["lax", "strict", "none"].includes(cookieSameSite)) throw new Error("COOKIE_SAME_SITE must be lax, strict, or none");
  if (production && (!cookieSecure || !env.SESSION_TOKEN_PEPPER)) throw new Error("Production requires COOKIE_SECURE=true and SESSION_TOKEN_PEPPER");
  if (cookieSameSite === "none" && !cookieSecure) throw new Error("COOKIE_SAME_SITE=none requires COOKIE_SECURE=true");

  return {
    nodeEnv,
    production,
    corsAllowedOrigins: configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_DEVELOPMENT_ORIGINS,
    jsonBodyLimit: jsonBodyLimit(env.JSON_BODY_LIMIT),
    trustProxy: positiveInteger(env.TRUST_PROXY, 0, "TRUST_PROXY"),
    rateLimits: {
      general: {
        windowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, "RATE_LIMIT_WINDOW_MS"),
        limit: positiveInteger(env.RATE_LIMIT_MAX, 300, "RATE_LIMIT_MAX")
      },
      reservation: {
        windowMs: positiveInteger(env.RESERVATION_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000, "RESERVATION_RATE_LIMIT_WINDOW_MS"),
        limit: positiveInteger(env.RESERVATION_RATE_LIMIT_MAX, 10, "RESERVATION_RATE_LIMIT_MAX")
      },
      lookup: {
        windowMs: positiveInteger(env.LOOKUP_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, "LOOKUP_RATE_LIMIT_WINDOW_MS"),
        limit: positiveInteger(env.LOOKUP_RATE_LIMIT_MAX, 20, "LOOKUP_RATE_LIMIT_MAX")
      },
      food: {
        windowMs: positiveInteger(env.FOOD_ORDER_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000, "FOOD_ORDER_RATE_LIMIT_WINDOW_MS"),
        limit: positiveInteger(env.FOOD_ORDER_RATE_LIMIT_MAX, 20, "FOOD_ORDER_RATE_LIMIT_MAX")
      },
      admin: {
        windowMs: positiveInteger(env.ADMIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, "ADMIN_RATE_LIMIT_WINDOW_MS"),
        limit: positiveInteger(env.ADMIN_RATE_LIMIT_MAX, 120, "ADMIN_RATE_LIMIT_MAX")
      }
    },
    reservation: {
      maxRentalDays: positiveInteger(env.MAX_RENTAL_DAYS, 30, "MAX_RENTAL_DAYS"),
      paymentMode: rentalPaymentMode(env.RENTAL_PAYMENT_MODE)
    },
    smsTimeoutMs: positiveInteger(env.SMS_TIMEOUT_MS, 5000, "SMS_TIMEOUT_MS"),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || "").replace(/\/$/, "") || null,
    vehicleUploadDirectory: vehicleUploadDirectory(env),
    legacyRoutesEnabled: legacyRoutesEnabled(env),
    session: {
      cookieName: String(env.SESSION_COOKIE_NAME || "driveops_admin_session"),
      ttlSeconds: positiveInteger(env.SESSION_TTL_SECONDS, 8 * 60 * 60, "SESSION_TTL_SECONDS"),
      tokenPepper: String(env.SESSION_TOKEN_PEPPER || "development-only-session-pepper"),
      cookieSecure,
      cookieSameSite,
      csrfHeaderName: String(env.CSRF_HEADER_NAME || "x-csrf-token"),
      lockoutThreshold: positiveInteger(env.ADMIN_LOCKOUT_THRESHOLD, 5, "ADMIN_LOCKOUT_THRESHOLD"),
      lockoutSeconds: positiveInteger(env.ADMIN_LOCKOUT_SECONDS, 15 * 60, "ADMIN_LOCKOUT_SECONDS")
    },
    loginRateLimit: {
      windowMs: positiveInteger(env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, "ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS"),
      limit: positiveInteger(env.ADMIN_LOGIN_RATE_LIMIT_MAX, 10, "ADMIN_LOGIN_RATE_LIMIT_MAX")
    }
  };
}

function createCorsOptions(config) {
  const allowedOrigins = new Set(config.corsAllowedOrigins);

  return {
    // Cookies are intentionally supported for the separate static admin origin.
    // The origin callback above still restricts credentialed browser requests.
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Reservation-Access-Token", "Idempotency-Key"],
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);

      const error = new Error("CORS origin denied");
      error.statusCode = 403;
      error.code = "CORS_ORIGIN_DENIED";
      return callback(error);
    },
    optionsSuccessStatus: 204
  };
}

module.exports = {
  createCorsOptions,
  createRuntimeConfig,
  isEnabled,
  legacyRoutesEnabled,
  parseCorsAllowedOrigins,
  rentalPaymentMode
};
