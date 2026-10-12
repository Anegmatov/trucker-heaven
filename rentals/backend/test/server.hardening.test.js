const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const { createRuntimeConfig, parseCorsAllowedOrigins, rentalPaymentMode } = require("../config/security");
const { createApp } = require("../server");
const { checkReadiness, REQUIRED_MIGRATIONS } = require("../services/readinessService");

const COMPLETE_READINESS_SCHEMA = {
  vehicles: "vehicles",
  vehiclephotos: "vehiclephotos",
  reservationsmvp: "reservationsmvp",
  admin_users: "admin_users",
  admin_sessions: "admin_sessions",
  admin_audit_logs: "admin_audit_logs",
  reservation_status_history: "reservation_status_history",
  rental_inspections: "rental_inspections",
  notification_outbox: "notification_outbox",
  notification_attempts: "notification_attempts",
  rental_documents: "rental_documents",
  rental_document_review_history: "rental_document_review_history",
  rental_agreements: "rental_agreements",
  schema_migrations: "schema_migrations",
  idempotency_key_hash_column: true,
  idempotency_request_hash_column: true,
  customer_notes_column: true,
  status_version_column: true,
  customer_access_token_column: true,
  history_immutable: true,
  history_validated_foreign_keys: 2,
  idempotency_unique_index: true,
  inspection_unique_constraint: true,
  inspection_type_constraint: true,
  inspection_odometer_constraint: true,
  inspection_fuel_constraint: true,
  inspection_foreign_keys: 3,
  inspection_immutable: true,
  inspection_indexes: 3,
  notification_attempt_immutable: true,
  notification_business_unique: true,
  notification_attempt_unique: true,
  notification_indexes: 3,
  document_review_history_immutable: true,
  document_revision_protected: true,
  document_current_unique_index: true,
  account_version_column: true,
  account_version_positive: true,
  btree_gist: true,
  constraint_name: "reservationsmvp_blocking_interval_exclusion",
  constraint_type: "x",
  constraint_validated: true,
  constraint_definition: "EXCLUDE USING gist (vehicleid WITH =, tstzrange(pickupat, returnat, '[)') WITH &&) WHERE (UPPER(status) IN ('CONFIRMED', 'READY_FOR_PICKUP', 'CHECKED_OUT', 'RETURNED_PENDING_INSPECTION'))"
};

function readinessDatabase({ schema = COMPLETE_READINESS_SCHEMA, migrations = REQUIRED_MIGRATIONS } = {}) {
  return {
    async query(sql) {
      if (sql.includes("FROM public.schema_migrations")) {
        return { rows: migrations.map((migration) => ({ migration })), rowCount: migrations.length };
      }
      return { rows: [{ ...schema }], rowCount: 1 };
    }
  };
}

function testEnvironment(overrides = {}) {
  return {
    NODE_ENV: "test",
    CORS_ALLOWED_ORIGINS: "http://localhost:5174,http://localhost:5175,https://rentals.truckerheaven.com,https://rentals-admin.truckerheaven.com",
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX: "300",
    RESERVATION_RATE_LIMIT_WINDOW_MS: "60000",
    RESERVATION_RATE_LIMIT_MAX: "10",
    ADMIN_RATE_LIMIT_WINDOW_MS: "60000",
    ADMIN_RATE_LIMIT_MAX: "120",
    ...overrides
  };
}

function activeRouteStubs() {
  const publicVehicles = express.Router();
  publicVehicles.get("/vehicles", (_req, res) => res.json({ vehicles: [] }));

  const adminVehicles = express.Router();
  adminVehicles.get("/", (_req, res) => res.json({ vehicles: [] }));

  const reservations = express.Router();
  reservations.get("/", (_req, res) => res.json({ reservations: [] }));
  reservations.post("/", (_req, res) => res.status(201).json({ accepted: true }));
  reservations.post("/:reservationId/operations/:operation", (_req, res) => res.status(204).end());

  return { publicVehicles, adminVehicles, reservations };
}

async function startApp(options = {}) {
  const app = createApp({
    env: testEnvironment(),
    routes: activeRouteStubs(),
    database: readinessDatabase(),
    ...options
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("runtime configuration parses CORS origins and rejects unsafe production settings", () => {
  assert.deepEqual(parseCorsAllowedOrigins("https://customer.example, https://admin.example"), [
    "https://customer.example",
    "https://admin.example"
  ]);
  assert.deepEqual(parseCorsAllowedOrigins("https://customer.example,https://customer.example"), ["https://customer.example"]);
  assert.throws(() => parseCorsAllowedOrigins("https://customer.example/"), /without paths/);
  assert.throws(() => parseCorsAllowedOrigins("javascript:alert(1)"), /complete http\(s\) origins/);
  assert.throws(
    () => createRuntimeConfig({ NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "" }),
    /CORS_ALLOWED_ORIGINS/
  );
  assert.throws(
    () => createRuntimeConfig({ NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "https://customer.example", ENABLE_LEGACY_ROUTES: "true" }),
    /ENABLE_LEGACY_ROUTES/
  );
  assert.equal(createRuntimeConfig(testEnvironment()).reservation.maxRentalDays, 30);
  assert.equal(createRuntimeConfig(testEnvironment()).reservation.paymentMode, "PAY_AT_PICKUP");
  assert.equal(rentalPaymentMode(), "PAY_AT_PICKUP");
  assert.equal(rentalPaymentMode("PAY_AT_LOCATION"), "PAY_AT_PICKUP");
  assert.throws(() => rentalPaymentMode("STRIPE"), /PAY_AT_PICKUP/);
  assert.equal(createRuntimeConfig(testEnvironment()).smsTimeoutMs, 5000);
  assert.throws(() => createRuntimeConfig(testEnvironment({ MAX_RENTAL_DAYS: "0" })), /MAX_RENTAL_DAYS/);
  assert.throws(() => createRuntimeConfig(testEnvironment({ SMS_TIMEOUT_MS: "invalid" })), /SMS_TIMEOUT_MS/);
});

test("active API mounts remain available while legacy routes are disabled by default", async () => {
  const api = await startApp();
  try {
    assert.equal((await fetch(`${api.baseUrl}/api/public/vehicles`)).status, 200);
    assert.equal((await fetch(`${api.baseUrl}/api/admin/vehicles`)).status, 200);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations`, { method: "POST" })).status, 201);
    assert.equal((await fetch(`${api.baseUrl}/api/rentals`)).status, 404);
  } finally {
    await api.close();
  }
});

test("public reservation throttling does not consume the admin lifecycle limit", async () => {
  const api = await startApp({
    env: testEnvironment({ RESERVATION_RATE_LIMIT_MAX: "1", ADMIN_RATE_LIMIT_MAX: "3" })
  });
  try {
    assert.equal((await fetch(`${api.baseUrl}/api/reservations`, { method: "POST" })).status, 201);
    assert.equal((await fetch(`${api.baseUrl}/api/reservations`, { method: "POST" })).status, 429);
    for (const operation of ["confirm", "ready_for_pickup", "check_out"]) {
      assert.equal((await fetch(`${api.baseUrl}/api/reservations/1/operations/${operation}`, { method: "POST" })).status, 204);
    }
  } finally {
    await api.close();
  }
});

test("CORS uses exact origins with narrow credentialed preflight permissions", async () => {
  const api = await startApp();
  try {
    for (const origin of ["http://localhost:5174", "http://localhost:5175", "https://rentals.truckerheaven.com", "https://rentals-admin.truckerheaven.com"]) {
      const allowed = await fetch(`${api.baseUrl}/api/health/live`, { headers: { Origin: origin } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
      assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
      assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");
    }

    for (const origin of ["https://denied.example", "https://eviltruckerheaven.com", "https://truckerheaven.com.evil.example", "null"]) {
      const denied = await fetch(`${api.baseUrl}/api/health/live`, { headers: { Origin: origin } });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: "Origin is not allowed" });
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
      assert.equal(denied.headers.get("access-control-allow-credentials"), null);
    }

    const approvedPreflight = await fetch(`${api.baseUrl}/api/admin/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://rentals-admin.truckerheaven.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token,x-reservation-access-token,idempotency-key"
      }
    });
    assert.equal(approvedPreflight.status, 204);
    assert.equal(approvedPreflight.headers.get("access-control-allow-origin"), "https://rentals-admin.truckerheaven.com");
    assert.equal(approvedPreflight.headers.get("access-control-allow-credentials"), "true");
    assert.equal(approvedPreflight.headers.get("access-control-allow-methods"), "GET,HEAD,POST,PATCH,DELETE");
    assert.equal(approvedPreflight.headers.get("access-control-allow-headers"), "Content-Type,X-CSRF-Token,X-Reservation-Access-Token,Idempotency-Key");

    const deniedPreflight = await fetch(`${api.baseUrl}/api/admin/auth/login`, {
      method: "OPTIONS",
      headers: { Origin: "https://eviltruckerheaven.com", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);
    assert.equal(deniedPreflight.headers.get("access-control-allow-credentials"), null);

    const noOrigin = await fetch(`${api.baseUrl}/api/health/live`);
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  } finally {
    await api.close();
  }
});

test("readiness requires the complete migrated authentication and reservation-integrity schema", async (context) => {
  const cases = [
    {
      name: "core table missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, vehicles: null } }),
      expected: { ready: false, reason: "schema_table_missing" }
    },
    {
      name: "admin authentication table missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, admin_sessions: null } }),
      expected: { ready: false, reason: "schema_table_missing" }
    },
    {
      name: "migration 003 missing",
      database: readinessDatabase({ migrations: ["004_reservation_availability.sql", "005_reservation_request_idempotency.sql"] }),
      expected: { ready: false, reason: "migration_missing" }
    },
    {
      name: "migration 004 missing",
      database: readinessDatabase({ migrations: ["003_admin_auth.sql", "005_reservation_request_idempotency.sql"] }),
      expected: { ready: false, reason: "migration_missing" }
    },
    {
      name: "migration 005 missing",
      database: readinessDatabase({ migrations: ["003_admin_auth.sql", "004_reservation_availability.sql"] }),
      expected: { ready: false, reason: "migration_missing" }
    },
    {
      name: "idempotency column missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, idempotency_request_hash_column: false } }),
      expected: { ready: false, reason: "idempotency_schema_missing" }
    },
    {
      name: "idempotency unique enforcement missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, idempotency_unique_index: false } }),
      expected: { ready: false, reason: "idempotency_constraint_missing" }
    },
    {
      name: "inspection immutability missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, inspection_immutable: false } }),
      expected: { ready: false, reason: "inspection_schema_invalid" }
    },
    {
      name: "btree_gist missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, btree_gist: false } }),
      expected: { ready: false, reason: "extension_missing" }
    },
    {
      name: "overlap exclusion constraint missing",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, constraint_name: null } }),
      expected: { ready: false, reason: "constraint_missing" }
    },
    {
      name: "overlap exclusion constraint invalid",
      database: readinessDatabase({ schema: { ...COMPLETE_READINESS_SCHEMA, constraint_validated: false } }),
      expected: { ready: false, reason: "constraint_invalid" }
    },
    {
      name: "complete migrated schema",
      database: readinessDatabase(),
      expected: { ready: true }
    }
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      assert.deepEqual(await checkReadiness(scenario.database), scenario.expected);
    });
  }
});

test("readiness and production errors do not expose database or application details", async () => {
  const api = await startApp({
    database: { query: async () => { throw new Error("postgresql://secret@example.test unavailable"); } },
    configureApp(app) {
      app.get("/api/test/error", () => { throw new Error("customer@example.test should not be exposed"); });
    }
  });
  try {
    const readiness = await fetch(`${api.baseUrl}/api/health/ready`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { ok: false, service: "driveops-api", reason: "readiness_check_failed" });

    const failure = await fetch(`${api.baseUrl}/api/test/error`);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { error: "Internal server error" });
  } finally {
    await api.close();
  }
});
