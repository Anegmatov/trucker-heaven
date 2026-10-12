const path = require("node:path");

function integer(name, value, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function boolean(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function origins(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function productionOrigins(name, value, nodeEnv) {
  if (nodeEnv !== "production") return origins(value);
  if (!value) throw new Error(`${name} is required in production`);
  const configured = origins(value);
  if (!configured.length || configured.some((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol !== "https:" || new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
    } catch {
      return true;
    }
  })) throw new Error(`${name} must contain only exact HTTPS production origins`);
  return configured;
}

function capacitorOrigins(value) {
  const supported = new Set(["http://localhost"]);
  const configured = origins(value || "http://localhost");
  if (!configured.length || configured.some((origin) => !supported.has(origin))) {
    throw new Error("CAPACITOR_ORIGINS may contain only supported exact Capacitor origins");
  }
  return configured;
}

function uploadRoot(value) {
  return path.resolve(value || path.join(__dirname, "..", "uploads"));
}

function firebaseServiceAccount(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must be valid JSON");
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing required service-account fields");
  }
  return parsed;
}

function loadConfig(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  let databaseName;
  try {
    databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!databaseName || databaseName.toLowerCase() === "ifta_db") {
    throw new Error("DATABASE_URL must target a dedicated FoodOps database and never ifta_db");
  }

  const nodeEnv = environment.NODE_ENV || "development";
  const databaseSsl = boolean("DATABASE_SSL", environment.DATABASE_SSL || "false");
  if (nodeEnv === "production" && !databaseSsl) throw new Error("DATABASE_SSL must be true in production");
  const cookieSecure = boolean("COOKIE_SECURE", environment.COOKIE_SECURE || (nodeEnv === "production" ? "true" : "false"));
  if (nodeEnv === "production" && !cookieSecure) throw new Error("COOKIE_SECURE must be true in production");

  const sameSite = environment.COOKIE_SAME_SITE || "Lax";
  if (!new Set(["Lax", "Strict", "None"]).has(sameSite)) throw new Error("COOKIE_SAME_SITE must be Lax, Strict, or None");

  if (nodeEnv === "production" && !environment.FOODOPS_UPLOAD_ROOT) {
    throw new Error("FOODOPS_UPLOAD_ROOT must target mounted persistent storage in production");
  }
  const resolvedUploadRoot = uploadRoot(environment.FOODOPS_UPLOAD_ROOT);

  return Object.freeze({
    nodeEnv,
    port: integer("PORT", environment.PORT || "3011", 1, 65535),
    databaseUrl,
    databaseSsl,
    databasePoolMax: integer("DATABASE_POOL_MAX", environment.DATABASE_POOL_MAX || "10", 1, 50),
    publicOrigins: productionOrigins("PUBLIC_ORIGINS", environment.PUBLIC_ORIGINS || (nodeEnv === "production" ? "" : "http://localhost:5190"), nodeEnv),
    adminOrigins: productionOrigins("ADMIN_ORIGINS", environment.ADMIN_ORIGINS || (nodeEnv === "production" ? "" : "http://localhost:5191"), nodeEnv),
    capacitorOrigins: capacitorOrigins(environment.CAPACITOR_ORIGINS),
    cookieSecure,
    cookieSameSite: sameSite,
    sessionTtlHours: integer("SESSION_TTL_HOURS", environment.SESSION_TTL_HOURS || "12", 1, 168),
    loginLockMinutes: integer("LOGIN_LOCK_MINUTES", environment.LOGIN_LOCK_MINUTES || "15", 1, 1440),
    loginMaxFailures: integer("LOGIN_MAX_FAILURES", environment.LOGIN_MAX_FAILURES || "5", 2, 20),
    trustProxy: boolean("TRUST_PROXY", environment.TRUST_PROXY || "false"),
    uploadRoot: resolvedUploadRoot,
    uploadDirectory: path.join(resolvedUploadRoot, "menu-items"),
    temporaryUploadDirectory: path.join(resolvedUploadRoot, "tmp"),
    googlePlacesApiKey: environment.GOOGLE_PLACES_API_KEY || "",
    googlePlaceId: environment.GOOGLE_PLACE_ID || "",
    firebaseServiceAccount: firebaseServiceAccount(environment.FIREBASE_SERVICE_ACCOUNT_JSON)
  });
}

module.exports = { loadConfig, uploadRoot };
